#!/usr/bin/env bash
# /recommit 1-2 단계: 사전 점검 + 겹침, 흔적 분석
#
# 출력은 LLM 이 읽어 그룹 계획을 세우는 입력이다.
# diff 본문은 절대 출력하지 않는다(토큰 절약이 이 스크립트의 존재 이유).
#
# 사용법: analyze.sh [base-ref]
#   base-ref 생략 시 origin/main → main 순으로 merge-base 자동 감지.

set -uo pipefail

die() { printf 'RECOMMIT-ABORT: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1) 사전 점검

git rev-parse --git-dir >/dev/null 2>&1 || die "git 저장소가 아님"

BRANCH=$(git branch --show-current)
[ -n "$BRANCH" ] || die "detached HEAD 상태. 브랜치로 체크아웃 후 재시도"
case "$BRANCH" in
  main|master) die "$BRANCH 에서는 실행 불가. feature 브랜치에서 실행" ;;
esac

DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
if [ "$DIRTY" != "0" ]; then
  die "미커밋 변경 $DIRTY 건. 먼저 커밋하거나 stash 후 재시도 (재구성은 커밋된 것만 다룸)"
fi

if [ $# -ge 1 ] && [ -n "${1:-}" ]; then
  BASE=$(git merge-base HEAD "$1" 2>/dev/null) || die "base '$1' 을 못 찾음"
else
  BASE=$(git merge-base HEAD origin/main 2>/dev/null) \
    || BASE=$(git merge-base HEAD main 2>/dev/null) \
    || die "base 자동 감지 실패. 인자로 지정할 것"
fi

HEAD_SHA=$(git rev-parse HEAD)
[ "$BASE" != "$HEAD_SHA" ] || die "base 와 HEAD 가 같음. 정리할 커밋이 없음"

N_COMMITS=$(git rev-list --count "$BASE"..HEAD)
[ "$N_COMMITS" -ge 2 ] || die "커밋이 $N_COMMITS 개뿐. 정리할 것이 없음"

# 시크릿 혼입 점검
SECRETS=$(git diff --name-only "$BASE"..HEAD \
  | grep -Ei '(^|/)\.env($|\.)|\.(key|pem|p12|pfx)$|secret|credential' || true)

# 원격 상태
UPSTREAM=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || true)
if [ -n "$UPSTREAM" ]; then
  AHEAD=$(git rev-list --count "$UPSTREAM"..HEAD 2>/dev/null || echo '?')
  BEHIND=$(git rev-list --count HEAD.."$UPSTREAM" 2>/dev/null || echo '?')
  REMOTE_DESC="$UPSTREAM (ahead $AHEAD / behind $BEHIND)"
else
  REMOTE_DESC="없음 (로컬 전용)"
fi

# ---------------------------------------------------------- 2) 커밋, 파일 수집

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git rev-list --reverse "$BASE"..HEAD > "$TMP/order"
: > "$TMP/pairs"      # "<번호> <파일>" 한 줄씩

IDX=0
while read -r SHA; do
  IDX=$((IDX + 1))
  printf '%s %s\n' "$IDX" "$SHA" >> "$TMP/idx2sha"
  git show --name-only --format='' "$SHA" | grep -v '^$' \
    | while read -r F; do printf '%s %s\n' "$IDX" "$F" >> "$TMP/pairs"; done
done < "$TMP/order"

sha_of() { awk -v i="$1" '$1==i{print $2}' "$TMP/idx2sha"; }
idx_of() { awk -v s="$1" '$2==s{print $1}' "$TMP/idx2sha"; }

# --------------------------------------------- 3) 흔적 판정 (브랜치 내부 수정)
#
# 각 커밋이 "지운 줄"의 원래 주인을 blame 으로 조회한다.
# 주인이 같은 브랜치의 앞선 커밋이면 = 브랜치 안에서 자기가 만든 것을 고친 것 = 흔적.
# 주인이 base 이전 커밋이면 = 원래 있던 버그를 고친 것 = 정상 커밋.

: > "$TMP/trace"      # "<고친번호> <고쳐진번호> <줄수>"

while read -r SHA; do
  C_IDX=$(idx_of "$SHA")
  git show "$SHA" -U0 --format='' 2>/dev/null | awk '
    /^diff --git/ { f=""; next }
    /^--- / {
      f = substr($0, 5)
      if (f == "/dev/null") { f = "" } else { sub(/^a\//, "", f) }
      next
    }
    /^@@ / {
      if (f == "") next
      s = $2; sub(/^-/, "", s)
      n = split(s, p, ",")
      start = p[1] + 0
      cnt = (n > 1 ? p[2] + 0 : 1)
      if (cnt > 0 && start > 0) print f "\t" start "\t" cnt
    }' > "$TMP/dels"

  [ -s "$TMP/dels" ] || continue

  while IFS=$'\t' read -r F S N; do
    git blame -l "$SHA^" -L "$S,+$N" -- "$F" 2>/dev/null \
      | sed -E 's/^\^?([0-9a-f]{40}).*/\1/' \
      | grep -E '^[0-9a-f]{40}$' || true
  done < "$TMP/dels" | sort | uniq -c | while read -r CNT OWNER; do
    O_IDX=$(idx_of "$OWNER")
    [ -n "$O_IDX" ] && printf '%s %s %s\n' "$C_IDX" "$O_IDX" "$CNT" >> "$TMP/trace"
  done
done < "$TMP/order"

# ------------------------------------------------------------------- 4) 출력

echo "== BRANCH =="
echo "name:    $BRANCH"
echo "base:    $(git rev-parse --short "$BASE")  $(git log -1 --format=%s "$BASE" | cut -c1-50)"
echo "commits: $N_COMMITS"
echo "remote:  $REMOTE_DESC"
echo "final:   $(git diff --shortstat "$BASE"..HEAD)"
if [ -n "$SECRETS" ]; then
  echo "SECRET-WARNING:"
  echo "$SECRETS" | sed 's/^/  /'
fi
echo

echo "== COMMITS =="
while read -r SHA; do
  I=$(idx_of "$SHA")
  printf '%2s. %s  %s\n' "$I" "$(git rev-parse --short "$SHA")" "$(git log -1 --format=%s "$SHA")"
  awk -v i="$I" '$1==i{ $1=""; sub(/^ /,""); print "      " $0 }' "$TMP/pairs"
done < "$TMP/order"
echo

echo "== FILE SHARING (한 파일을 건드린 커밋 번호) =="
awk '{ f=$2; $1=$1; a[f] = a[f] " " $1 } END { for (f in a) print length(a[f]), f, a[f] }' "$TMP/pairs" \
  | sort -rn | while read -r _ F LIST; do
      CNT=$(echo "$LIST" | wc -w | tr -d ' ')
      [ "$CNT" -ge 2 ] && printf '  %-52s %s\n' "$F" "$LIST"
    done
echo

echo "== TRACE (브랜치 안에서 자기 코드를 고친 관계 = 흔적) =="
if [ -s "$TMP/trace" ]; then
  sort -k1,1n -k3,3rn "$TMP/trace" | while read -r C O CNT; do
    printf '  %2s(%s) 가 %2s(%s) 의 %s줄을 고침   |  %s\n' \
      "$C" "$(git rev-parse --short "$(sha_of "$C")")" \
      "$O" "$(git rev-parse --short "$(sha_of "$O")")" \
      "$CNT" "$(git log -1 --format=%s "$(sha_of "$C")" | cut -c1-40)"
  done
  echo
  echo "  → 위 관계의 두 커밋은 같은 그룹 후보. 묶이면 '고쳤다' 는 사실이 사라짐."
else
  echo "  없음. 이 브랜치는 앞 커밋을 되돌린 적이 없음(합칠 이유가 파일 공유뿐)."
fi
echo

echo "== SOLO FILE COMMITS (파일 1개짜리: 앞 기능에 붙을 후보) =="
awk '{ c[$1]++ } END { for (i in c) if (c[i] == 1) print i }' "$TMP/pairs" | sort -n \
  | while read -r I; do
      F=$(awk -v i="$I" '$1==i{ $1=""; sub(/^ /,""); print }' "$TMP/pairs")
      OTHERS=$(awk -v f="$F" -v i="$I" '$2==f && $1!=i { printf "%s ", $1 }' "$TMP/pairs")
      printf '  %2s. %-46s  같은 파일: %s\n' "$I" "$F" "${OTHERS:-없음(단독)}"
    done
echo

echo "== NEXT =="
echo "이 신호로 그룹 계획을 세운 뒤 rebuild.sh 로 넘긴다."
echo "plan 형식: 한 줄 = 한 그룹.  <메시지파일명> <커밋번호...>"
echo "base=$BASE"
