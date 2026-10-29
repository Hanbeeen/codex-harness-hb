#!/usr/bin/env bash
# /recommit 6 단계: A 를 숨김 ref 로 보존하고 B 를 A 이름으로 갈아 끼움
#
# 이 스크립트가 이 스킬에서 유일하게 되돌리기 어려운 단계다.
# 실행 전 트리 동일성을 다시 확인하고, 원격에 올라간 브랜치는 기본으로 막는다.
#
# 사용법: B 브랜치에 체크아웃한 상태에서
#   finalize.sh <A브랜치명> [--pushed-ok]
#
#   --pushed-ok : A 가 원격에 있어도 진행 (다음 push 가 force-push 가 됨을 인지)

set -uo pipefail

die() { printf 'RECOMMIT-ABORT: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

A_BRANCH="${1:-}"
[ -n "$A_BRANCH" ] || die "A 브랜치명을 인자로 줄 것"
git rev-parse --verify "$A_BRANCH" >/dev/null 2>&1 || die "브랜치 '$A_BRANCH' 없음"

PUSHED_OK=0
for arg in "$@"; do [ "$arg" = "--pushed-ok" ] && PUSHED_OK=1; done

B_BRANCH=$(git branch --show-current)
[ -n "$B_BRANCH" ] || die "detached HEAD 상태. B 브랜치에 체크아웃하고 실행할 것"
[ "$B_BRANCH" != "$A_BRANCH" ] || die "지금 A 에 있음. B 브랜치로 체크아웃하고 실행할 것"
[ -z "$(git status --porcelain)" ] || die "미커밋 변경이 있음"

# ------------------------------------------------------------ 게이트 1: 트리

A_TREE=$(git rev-parse "$A_BRANCH^{tree}")
B_TREE=$(git rev-parse "$B_BRANCH^{tree}")
if [ "$A_TREE" != "$B_TREE" ]; then
  say "트리가 다름. 교체하지 않음."
  say "  A $A_BRANCH  $A_TREE"
  say "  B $B_BRANCH  $B_TREE"
  git diff --stat "$A_BRANCH" "$B_BRANCH" | sed 's/^/  /'
  die "최종 내용이 달라 교체 불가"
fi
say "게이트 1 통과: 트리 동일 ($A_TREE)"

# ---------------------------------------------- 게이트 2: 다른 워크트리 점유

OCCUPIED=$(git worktree list --porcelain | awk -v b="refs/heads/$A_BRANCH" '
  /^worktree /{ w=$2 }
  /^branch /{ if ($2 == b) print w }')
if [ -n "$OCCUPIED" ]; then
  say "브랜치 '$A_BRANCH' 를 다른 작업 폴더가 쓰고 있음:"
  echo "$OCCUPIED" | sed 's/^/  /'
  die "그 폴더에서 다른 브랜치로 옮긴 뒤 재시도"
fi
say "게이트 2 통과: A 를 점유한 다른 작업 폴더 없음"

# ---------------------------------------------------------- 게이트 3: 원격

A_UPSTREAM=$(git for-each-ref --format='%(upstream:short)' "refs/heads/$A_BRANCH")
if [ -n "$A_UPSTREAM" ] && git rev-parse --verify "$A_UPSTREAM" >/dev/null 2>&1; then
  if [ "$PUSHED_OK" != "1" ]; then
    say ""
    say "STOP: A 가 원격에 올라가 있음 ($A_UPSTREAM)"
    say "  교체하면 다음 push 는 force-push 가 되고, 그 사이 누가 pull 했으면 충돌함."
    say "  원격 최신: $(git log -1 --format='%h %s' "$A_UPSTREAM" | cut -c1-60)"
    say ""
    say "  진행하려면 --pushed-ok 를 붙일 것."
    exit 7
  fi
  say "게이트 3: 원격에 있으나 --pushed-ok 로 진행 ($A_UPSTREAM)"
else
  say "게이트 3 통과: 원격 없음 (로컬 전용)"
fi

# ------------------------------------------------------------------- 실행

STAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="refs/recommit-archive/${A_BRANCH}-${STAMP}"
A_SHA=$(git rev-parse "$A_BRANCH")
BASE_SHA=$(git merge-base "$A_BRANCH" "$B_BRANCH")
A_COUNT=$(git rev-list --count "$BASE_SHA".."$A_BRANCH")
B_COUNT=$(git rev-list --count "$BASE_SHA".."$B_BRANCH")

git update-ref "$ARCHIVE" "$A_SHA" || die "보존 ref 생성 실패"
git branch -D "$A_BRANCH" >/dev/null || { git update-ref -d "$ARCHIVE"; die "A 삭제 실패"; }
git branch -m "$B_BRANCH" "$A_BRANCH" || die "B 이름 변경 실패 (A 는 $ARCHIVE 에 있음)"

if [ -n "$A_UPSTREAM" ]; then
  git branch --set-upstream-to="$A_UPSTREAM" "$A_BRANCH" >/dev/null 2>&1 \
    && say "upstream 재설정: $A_UPSTREAM"
fi

# ------------------------------------------------------------------- 보고

say ""
say "== 교체 완료 =="
say "브랜치:   $A_BRANCH  ($A_COUNT 커밋 → $B_COUNT 커밋)"
say "원본 보존: $ARCHIVE"
say "          (git branch 목록, IDE 브랜치 메뉴에 안 보임)"
say ""
say "새 커밋 열:"
git log --oneline "$BASE_SHA"..HEAD | sed 's/^/  /'
say ""
say "원본을 다시 보려면:"
say "  git log --oneline $ARCHIVE"
say "원본으로 되돌리려면:"
say "  git branch -f $A_BRANCH $ARCHIVE   # 현재 브랜치가 아닐 때만"
say "쌓인 보존본을 보거나 지우려면 (glob 은 별 두 개라야 하위 경로까지 잡음):"
say "  git for-each-ref 'refs/recommit-archive/**' --format='%(refname) %(objectname:short)'"
say "  git update-ref -d <refname>"
if [ -n "$A_UPSTREAM" ]; then
  say ""
  say "원격 반영은 사용자가 직접:"
  say "  git push --force-with-lease"
fi
