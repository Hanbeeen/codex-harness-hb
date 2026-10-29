#!/usr/bin/env bash
# /recommit 4-5 단계: B 브랜치 생성 + cherry-pick 누적 재구성 + 정합성 검증
#
# A 브랜치는 절대 건드리지 않는다. 실패하면 B 만 지우면 원상복구가 끝난다.
#
# 사용법: rebuild.sh <plan디렉터리> [B브랜치명] [--keep-on-fail]
#
# plan디렉터리 구성:
#   plan.txt        # "b: <base sha>" 헤더 + "<메시지파일> <커밋번호...>" 줄들
#   <메시지파일>     # 각 그룹의 커밋 메시지 (UTF-8)

set -uo pipefail

die() { printf 'RECOMMIT-ABORT: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

PLAN_DIR="${1:-}"
[ -n "$PLAN_DIR" ] && [ -d "$PLAN_DIR" ] || die "plan 디렉터리를 지정할 것"
PLAN="$PLAN_DIR/plan.txt"
[ -f "$PLAN" ] || die "$PLAN 없음"

A_BRANCH=$(git branch --show-current)
[ -n "$A_BRANCH" ] || die "detached HEAD 상태"
B_BRANCH="${2:-}"
case "$B_BRANCH" in ''|--*) B_BRANCH="${A_BRANCH}-recommit" ;; esac

KEEP_ON_FAIL=0
for arg in "$@"; do [ "$arg" = "--keep-on-fail" ] && KEEP_ON_FAIL=1; done

[ -z "$(git status --porcelain)" ] || die "미커밋 변경이 있음"
git rev-parse --verify "$B_BRANCH" >/dev/null 2>&1 \
  && die "브랜치 '$B_BRANCH' 가 이미 있음. 지우거나 다른 이름을 줄 것"

BASE=$(awk '/^b:/{print $2; exit}' "$PLAN")
[ -n "$BASE" ] || die "plan.txt 에 'b: <base sha>' 헤더가 없음"
git rev-parse --verify "$BASE^{commit}" >/dev/null 2>&1 || die "base '$BASE' 가 잘못됨"

A_TREE=$(git rev-parse "$A_BRANCH^{tree}")
mapfile -t ORDER < <(git rev-list --reverse "$BASE".."$A_BRANCH")
N=${#ORDER[@]}
[ "$N" -ge 2 ] || die "커밋이 $N 개뿐"

# merge 커밋은 cherry-pick 으로 재생할 수 없다
for SHA in "${ORDER[@]}"; do
  if [ "$(git rev-list --parents -n1 "$SHA" | wc -w)" -gt 2 ]; then
    die "merge 커밋 $(git rev-parse --short "$SHA") 이 섞여 있음. 이 스킬은 선형 이력만 다룸"
  fi
done

sha_of() { echo "${ORDER[$(( $1 - 1 ))]}"; }

# ----------------------------------------------------- 계획 검증 (빠짐, 중복)

USED=""
GROUP_COUNT=0
while read -r LINE; do
  case "$LINE" in ''|'#'*|'b:'*) continue ;; esac
  GROUP_COUNT=$((GROUP_COUNT + 1))
  set -- $LINE
  MSGFILE="$1"; shift
  [ -f "$PLAN_DIR/$MSGFILE" ] || die "메시지 파일 없음: $MSGFILE"
  [ -s "$PLAN_DIR/$MSGFILE" ] || die "메시지 파일이 비어 있음: $MSGFILE"
  [ $# -ge 1 ] || die "그룹 '$MSGFILE' 에 커밋 번호가 없음"
  for I in "$@"; do
    case "$I" in *[!0-9]*) die "커밋 번호가 숫자가 아님: '$I'" ;; esac
    [ "$I" -ge 1 ] && [ "$I" -le "$N" ] || die "커밋 번호 범위 밖: $I (1..$N)"
    case " $USED " in *" $I "*) die "커밋 $I 가 두 번 나옴" ;; esac
    USED="$USED $I"
  done
done < "$PLAN"

for I in $(seq 1 "$N"); do
  case " $USED " in *" $I "*) ;; *) die "커밋 $I 가 계획에서 빠짐 (전부 한 번씩 나와야 함)" ;; esac
done

say "계획 검증 통과: 커밋 $N 개 → 그룹 $GROUP_COUNT 개"
say ""

# --------------------------------------------------------- B 생성 + 재구성

cleanup_fail() {
  git cherry-pick --abort >/dev/null 2>&1
  git reset --hard >/dev/null 2>&1
  if [ "$KEEP_ON_FAIL" = "1" ]; then
    say "B 브랜치 '$B_BRANCH' 는 남겨둠 (--keep-on-fail). 확인 후 직접 삭제할 것."
  else
    git switch "$A_BRANCH" >/dev/null 2>&1
    git branch -D "$B_BRANCH" >/dev/null 2>&1 && say "B 브랜치 삭제함. A 는 그대로."
  fi
}

git switch -c "$B_BRANCH" "$BASE" >/dev/null 2>&1 || die "B 브랜치 생성 실패"
say "B 브랜치 '$B_BRANCH' 생성 (base: $(git rev-parse --short "$BASE"))"
say ""

COMMIT_LOG=$(mktemp)
trap 'rm -f "$COMMIT_LOG"' EXIT

SYNTAX_FAILED=""
G=0
while read -r LINE; do
  case "$LINE" in ''|'#'*|'b:'*) continue ;; esac
  G=$((G + 1))
  set -- $LINE
  MSGFILE="$1"; shift
  # 그룹 안은 원래 순서(번호 오름차순)로 적용해야 충돌이 안 난다
  SORTED=$(printf '%s\n' "$@" | sort -n | tr '\n' ' ')

  for I in $SORTED; do
    SHA=$(sha_of "$I")
    if ! git cherry-pick -n "$SHA" >/dev/null 2>&1; then
      say ""
      say "CONFLICT: 그룹 $G ($MSGFILE) 의 커밋 $I ($(git rev-parse --short "$SHA")) 적용 중 충돌"
      say "  제목: $(git log -1 --format=%s "$SHA")"
      say "  충돌 파일:"
      git diff --name-only --diff-filter=U | sed 's/^/    /'
      say ""
      say "  원인: 이 그룹이 원래 순서보다 앞으로 당겨졌고, 사이 커밋과 같은 영역을 건드림."
      say "  대응: 계획에서 이 그룹의 묶음을 풀거나, 사이 커밋까지 함께 묶을 것."
      cleanup_fail
      exit 2
    fi
  done

  if git diff --cached --quiet; then
    say ""
    say "EMPTY: 그룹 $G ($MSGFILE) 가 아무 변경도 만들지 않음 (커밋: $SORTED)"
    say "  앞 그룹이 이 내용을 이미 가져갔을 가능성. 계획에서 이 그룹을 지우거나 합칠 것."
    cleanup_fail
    exit 3
  fi

  # commit-msg 훅을 그대로 통과시킨다. 메시지 표기 규칙은 여기서도 지켜져야 한다.
  if ! git commit -F "$PLAN_DIR/$MSGFILE" > "$COMMIT_LOG" 2>&1; then
    say ""
    say "COMMIT-FAIL: 그룹 $G ($MSGFILE)"
    sed 's/^/    /' "$COMMIT_LOG"
    say ""
    say "  commit-msg 훅이 거부했을 가능성이 큼. 메시지 표기 규칙을 고쳐 재시도할 것"
    say "  (완결형 종결, em-dash, 물결표 쌍, 분량 상한). 검사: node ~/.codex/harness/githooks/commit-msg $PLAN_DIR/$MSGFILE"
    cleanup_fail
    exit 4
  fi

  NEW=$(git rev-parse --short HEAD)
  say "  [$G/$GROUP_COUNT] $NEW  ← 커밋 $SORTED"

  # 커밋별 문법 검사: 이 커밋이 건드린 .js 만
  while read -r F; do
    case "$F" in *.js|*.mjs|*.cjs) ;; *) continue ;; esac
    [ -f "$F" ] || continue
    if ! node --check "$F" >/dev/null 2>&1; then
      SYNTAX_FAILED="$SYNTAX_FAILED\n    $NEW  $F"
    fi
  done < <(git show --name-only --format='' HEAD | grep -v '^$')
done < "$PLAN"

say ""

# ----------------------------------------------------------------- 검증

B_TREE=$(git rev-parse "$B_BRANCH^{tree}")
say "== 검증 =="
if [ "$A_TREE" = "$B_TREE" ]; then
  say "  트리 일치: A 와 B 의 최종 내용이 한 바이트도 다르지 않음"
  say "    A $A_TREE"
  say "    B $B_TREE"
else
  say "  트리 불일치. 재구성 실패."
  say "    A $A_TREE"
  say "    B $B_TREE"
  say "  차이:"
  git diff --stat "$A_BRANCH" "$B_BRANCH" | sed 's/^/    /'
  cleanup_fail
  exit 5
fi

if [ -n "$SYNTAX_FAILED" ]; then
  say "  문법 검사 실패 (중간 커밋이 깨짐):"
  printf '%b\n' "$SYNTAX_FAILED"
  say "  → 그 커밋 시점에 코드가 파싱되지 않음. 계획에서 해당 그룹을 합치면 해소됨."
  say "  A 는 그대로이므로 B 를 지우고 계획을 고쳐 재시도할 것."
  exit 6
else
  say "  문법 검사: 커밋 $GROUP_COUNT 개 전부 통과"
fi

say ""
say "== 결과 =="
say "A: $A_BRANCH  ($N 커밋, 원본 그대로)"
say "B: $B_BRANCH  ($GROUP_COUNT 커밋)"
say ""
git log --oneline "$BASE".."$B_BRANCH" | sed 's/^/  /'
say ""
say "다음: finalize.sh 로 교체하거나, 마음에 안 들면 git branch -D $B_BRANCH"
