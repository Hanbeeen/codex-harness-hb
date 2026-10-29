#!/bin/sh
# Codex 하네스 설치 스크립트 (POSIX sh)
#
# 사용
#   curl -fsSL https://raw.githubusercontent.com/Hanbeeen/codex-harness-hb/v0.1.0/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/Hanbeeen/codex-harness-hb/v0.1.0/install.sh | sh -s -- --name <호칭>
# 옵션
#   --dry           바꿀 내용만 보여 주고 아무것도 바꾸지 않음
#   --name <호칭>    전역 지침의 호칭 자리에 넣을 이름('님' 은 붙이지 않음). 빈 값이면 호칭 없이 씀.
#                   생략하면 지난 설치 때 쓴 값을 그대로 씀
# 환경 변수
#   HARNESS_SOURCE  GitHub 대신 쓸 로컬 폴더 또는 tar.gz(시험용)
#   HARNESS_TAG     HARNESS_SOURCE 를 쓸 때 src/<tag> 자리에 쓸 이름(기본 local)
#   CODEX_HOME      Codex 홈 폴더(기본 $HOME/.codex)
# 필요한 것: sh, curl, tar, codex 0.164.0 이상. git, node 는 있으면 씀.
# 하네스가 만든 파일은 모두 $CODEX_HOME/harness 아래에 둔다.

set -u

REPO_SLUG='Hanbeeen/codex-harness-hb'
REPO_TAG='v0.1.0'
MIN_CODEX='0.164.0'
DOC_BYTES=65536
HOOK_NAMES='applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-auto-gc post-rewrite sendemail-validate push-to-checkout pre-receive update post-receive post-update reference-transaction post-index-change'

CODEX_DIR=${CODEX_HOME:-$HOME/.codex}
H=$CODEX_DIR/harness
STATE=$H/state
INST=$H/installed
CFG=$CODEX_DIR/config.toml
# node 가 필요한 스킬(recommit, qa)은 plugin 이 아니라 사용자 스킬 폴더에 둔다. 스킬 안 경로가 이 위치를 가리킨다
USER_SKILLS=$HOME/.agents/skills
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=$H/backup/$TS

DRY=0
NAME=
NAME_GIVEN=0
BACKED_UP=0
MERGE_PATH=
HOOK_CHANGED=0
WORK=

# ---------------------------------------------------------------- 출력

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '오류: %s\n' "$*" >&2; exit 1; }
is_dry() { [ "$DRY" = 1 ]; }

add_done() {
  printf '%s\n' "$*" >> "$WORK/done"
  if is_dry; then info "[dry] 설치 예정: $*"; else info "설치/갱신: $*"; fi
}
add_same() { printf '%s\n' "$*" >> "$WORK/same"; info "변경 없음: $*"; }
add_skip() { printf '건너뜀: %s, %s\n' "$1" "$2" >> "$WORK/skip"; info "건너뜀: $1, $2"; }
add_note() { printf '%s\n' "$*" >> "$WORK/note"; }

# 명령 출력에서 사유 한 줄을 뽑는다
reason_of() {
  _r=$(sed -n 's/^Error: //p' "$1" | head -n 1)
  [ -n "$_r" ] || _r=$(grep -v '^[[:space:]]*$' "$1" | tail -n 1)
  printf '%s' "$_r" | cut -c 1-160
}

usage() {
  cat <<'EOF'
사용: install.sh [--dry] [--name <호칭>]
  --dry          바꿀 내용만 보여 주고 아무것도 바꾸지 않음
  --name <호칭>   전역 지침의 호칭 자리에 넣을 이름('님' 은 붙이지 않음)
환경 변수: HARNESS_SOURCE(로컬 폴더 또는 tar.gz), HARNESS_TAG, CODEX_HOME
EOF
}

# ---------------------------------------------------------------- 상태 기록

state_has_line() { [ -f "$STATE/$1" ] && grep -qxF -- "$2" "$STATE/$1"; }
state_add_line() {
  is_dry && return 0
  mkdir -p "$STATE" || die "상태 폴더를 만들지 못함: $STATE"
  state_has_line "$1" "$2" || printf '%s\n' "$2" >> "$STATE/$1"
}

# key|값 형식 목록 파일에서 key 의 값을 읽고 쓴다
kv_get() { [ -f "$STATE/$1" ] || return 0; awk -F'|' -v k="$2" '$1==k {v=$2} END {if (v != "") print v}' "$STATE/$1"; }
kv_set() {
  mkdir -p "$STATE" || die "상태 폴더를 만들지 못함: $STATE"
  { [ -f "$STATE/$1" ] && awk -F'|' -v k="$2" '$1!=k' "$STATE/$1"; printf '%s|%s\n' "$2" "$3"; } > "$STATE/$1.tmp" \
    && mv -f "$STATE/$1.tmp" "$STATE/$1"
}
kv_del() {
  [ -f "$STATE/$1" ] || return 0
  awk -F'|' -v k="$2" '$1!=k' "$STATE/$1" > "$STATE/$1.tmp" && mv -f "$STATE/$1.tmp" "$STATE/$1"
}

# ---------------------------------------------------------------- 파일 배치

copy_into() {
  mkdir -p "$(dirname "$2")" || return 1
  # 심볼릭 링크(dotfiles 관리 등)는 끊지 않고 가리키는 파일에 쓴다
  if [ -L "$2" ]; then cat "$1" > "$2"; return; fi
  cp "$1" "$2.harness-tmp" && mv -f "$2.harness-tmp" "$2"
}

# 사용자 파일을 이번 백업 폴더에 둔다. 직전 백업과 내용이 같으면 새로 만들지 않는다
backup_user_file() { # key 경로
  _bk=$(kv_get restore.list "$1")
  if [ -n "$_bk" ] && [ -f "$_bk/$1" ] && cmp -s "$_bk/$1" "$2"; then return 0; fi
  BACKED_UP=1
  if is_dry; then info "[dry] 백업: $2 -> $BACKUP_DIR/$1"; return 0; fi
  mkdir -p "$(dirname "$BACKUP_DIR/$1")" && cp -p "$2" "$BACKUP_DIR/$1" || die "백업 실패: $2"
  kv_set restore.list "$1" "$BACKUP_DIR"
  info "백업: $2 -> $BACKUP_DIR/$1"
}

# 되돌릴 때 쓰지 않는 참고용 백업(config.toml, core.hooksPath)
backup_copy() { # 이름 경로
  is_dry && return 0
  [ -f "$BACKUP_DIR/$1" ] && return 0
  mkdir -p "$BACKUP_DIR" && cp -p "$2" "$BACKUP_DIR/$1" || die "백업 실패: $2"
  BACKED_UP=1
}

# 하네스 파일을 사용자 영역에 둔다. 결과는 PLACED(same, new, update, replace)
place_managed() { # key 새파일 대상
  _key=$1 _new=$2 _dest=$3 _inst=$INST/$1
  if [ -f "$_dest" ] && cmp -s "$_new" "$_dest"; then
    PLACED=same
    is_dry && return 0
    { [ -f "$_inst" ] && cmp -s "$_new" "$_inst"; } || copy_into "$_new" "$_inst" || die "파일을 쓰지 못함: $_inst"
    kv_set managed.list "$_key" "$_dest"
    return 0
  fi
  PLACED=new
  if [ -f "$_dest" ]; then
    if [ -f "$_inst" ] && cmp -s "$_inst" "$_dest"; then
      PLACED=update
    else
      backup_user_file "$_key" "$_dest"
      PLACED=replace
    fi
  fi
  is_dry && return 0
  copy_into "$_new" "$_dest" || die "파일을 쓰지 못함: $_dest"
  copy_into "$_new" "$_inst" || die "파일을 쓰지 못함: $_inst"
  kv_set managed.list "$_key" "$_dest"
}

# 이번 버전에서 빠진 하네스 파일을 걷어 내고 원래 파일을 되돌린다
retire_managed() { # key 대상
  _key=$1 _dest=$2 _inst=$INST/$1
  _bk=$(kv_get restore.list "$_key")
  if is_dry; then info "[dry] 걷어 냄: $_dest"; return 0; fi
  if [ -f "$_dest" ] && ! { [ -f "$_inst" ] && cmp -s "$_inst" "$_dest"; }; then
    info "수정된 파일이라 그대로 둠: $_dest"
  elif [ -n "$_bk" ] && [ -f "$_bk/$_key" ]; then
    copy_into "$_bk/$_key" "$_dest" && info "되돌림: $_dest"
  else
    rm -f "$_dest" && info "지움: $_dest"
  fi
  rm -f "$_inst"
  kv_del managed.list "$_key"
  kv_del restore.list "$_key"
}

# ---------------------------------------------------------------- 환경 확인

ver_ge() { # $1 >= $2
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { p = x[i] + 0; q = y[i] + 0; if (p > q) exit 0; if (p < q) exit 1 }
    exit 0 }'
}

check_env() {
  step "환경 확인"
  command -v codex >/dev/null 2>&1 || die "codex 명령을 찾지 못함. Codex CLI 를 먼저 설치"
  CODEX_VER=$(codex --version </dev/null 2>/dev/null | awk '{print $NF}' | head -n 1)
  [ -n "$CODEX_VER" ] || die "codex --version 결과를 읽지 못함"
  ver_ge "$CODEX_VER" "$MIN_CODEX" || die "Codex $CODEX_VER 은 지원하지 않음. $MIN_CODEX 이상으로 올린 뒤 다시 실행(codex update)"
  info "codex $CODEX_VER"
  command -v tar >/dev/null 2>&1 || die "tar 가 없음"
  HAVE_CURL=0; command -v curl >/dev/null 2>&1 && HAVE_CURL=1
  HAVE_GIT=0;  command -v git  >/dev/null 2>&1 && HAVE_GIT=1
  HAVE_NODE=0; command -v node >/dev/null 2>&1 && HAVE_NODE=1
  HAVE_CHROME=0
  for _c in google-chrome google-chrome-stable chromium chromium-browser chrome; do
    command -v "$_c" >/dev/null 2>&1 && { HAVE_CHROME=1; break; }
  done
  [ -d "/Applications/Google Chrome.app" ] && HAVE_CHROME=1
  info "curl=$HAVE_CURL git=$HAVE_GIT node=$HAVE_NODE chrome=$HAVE_CHROME"
}

# ---------------------------------------------------------------- 원본

fetch_source() {
  step "원본 가져오기"
  _x=$WORK/src
  mkdir -p "$_x" || die "임시 폴더를 만들지 못함"
  if [ -n "${HARNESS_SOURCE:-}" ]; then
    if [ -d "$HARNESS_SOURCE" ]; then
      cp -R "$HARNESS_SOURCE/." "$_x/" || die "원본 폴더를 복사하지 못함: $HARNESS_SOURCE"
    elif [ -f "$HARNESS_SOURCE" ]; then
      tar -xzf "$HARNESS_SOURCE" -C "$_x" || die "원본 tar.gz 를 풀지 못함: $HARNESS_SOURCE"
    else
      die "HARNESS_SOURCE 경로가 없음: $HARNESS_SOURCE"
    fi
    TAG=${HARNESS_TAG:-local}
    info "로컬 원본: $HARNESS_SOURCE"
  else
    case "$REPO_SLUG$REPO_TAG" in
      *'<'*) die "레포 주소가 비어 있는 install.sh 임. 공개 레포의 태그 주소로 받거나 HARNESS_SOURCE 를 지정" ;;
    esac
    [ "$HAVE_CURL" = 1 ] || die "curl 이 없음"
    _url="https://github.com/$REPO_SLUG/archive/refs/tags/$REPO_TAG.tar.gz"
    curl -fsSL "$_url" -o "$WORK/src.tar.gz" </dev/null || die "내려받기 실패: $_url"
    tar -xzf "$WORK/src.tar.gz" -C "$_x" || die "tarball 을 풀지 못함: $_url"
    TAG=$REPO_TAG
    info "GitHub 원본: $_url"
  fi
  case "$TAG" in ''|.|..|*/*) die "쓸 수 없는 태그 이름: $TAG" ;; esac

  SRC_ROOT=
  if [ -f "$_x/.agents/plugins/marketplace.json" ]; then
    SRC_ROOT=$_x
  else
    for _d in "$_x"/*/; do
      if [ -f "${_d}.agents/plugins/marketplace.json" ]; then SRC_ROOT=${_d%/}; break; fi
    done
  fi
  [ -n "$SRC_ROOT" ] || die "원본에 .agents/plugins/marketplace.json 이 없음"
  for _f in codex-home/AGENTS.md codex-home/hooks.json codex-home/reminder.json codex-home/plugins.txt \
            plugins/harness/.codex-plugin/plugin.json; do
    [ -f "$SRC_ROOT/$_f" ] || die "원본에 $_f 가 없음"
  done
  MKT=$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC_ROOT/.agents/plugins/marketplace.json" | head -n 1)
  case "$MKT" in ''|*[!A-Za-z0-9._-]*) die "marketplace.json 의 name 을 읽지 못함: '$MKT'" ;; esac
  info "태그 $TAG, 마켓플레이스 $MKT"
}

install_src() {
  _dest=$H/src/$TAG
  if [ -d "$_dest" ] && diff -r "$SRC_ROOT" "$_dest" >/dev/null 2>&1; then
    SRC_CHANGED=0
    add_same "원본 $_dest"
    return 0
  fi
  SRC_CHANGED=1
  add_done "원본 $_dest"
  is_dry && return 0
  mkdir -p "$H/src" || die "폴더를 만들지 못함: $H/src"
  rm -rf "$_dest.part"
  cp -R "$SRC_ROOT" "$_dest.part" && rm -rf "$_dest" && mv "$_dest.part" "$_dest" || die "원본을 두지 못함: $_dest"
}

# ---------------------------------------------------------------- Codex 설정 읽기

mkt_configured() { [ -f "$CFG" ] && grep -qF "[marketplaces.$1]" "$CFG"; }
plugin_installed() { [ -f "$CFG" ] && grep -qF "[plugins.\"$1\"]" "$CFG"; }

mkt_source() {
  [ -f "$CFG" ] || return 0
  awk -v sec="[marketplaces.$1]" -v sq="'" '
    /^[[:space:]]*\[\[?[^]]*\]\]?[[:space:]]*(#.*)?$/ { h = $0; sub(/[[:space:]]*#.*$/, "", h); sub(/^[[:space:]]+/, "", h); sub(/[[:space:]]+$/, "", h); ins = (h == sec); next }
    ins && /^[[:space:]]*source[[:space:]]*=/ {
      v = $0; sub(/^[^=]*=[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v)
      c = substr(v, 1, 1)
      if (c == "\"" || c == sq) v = substr(v, 2, length(v) - 2)
      print v; exit }' "$CFG"
}

# ---------------------------------------------------------------- 스킬 plugin

install_harness_plugin() {
  step "스킬 plugin (harness@$MKT)"
  _root=$H/src/$TAG
  _id="harness@$MKT"
  _cur=$(mkt_source "$MKT")
  if is_dry; then
    if [ "$_cur" = "$_root" ] && [ "$SRC_CHANGED" = 0 ] && plugin_installed "$_id"; then
      add_same "$_id"
    else
      info "[dry] codex plugin marketplace add $_root"
      add_done "$_id (스킬)"
    fi
    return 0
  fi
  _changed=0
  if [ "$_cur" != "$_root" ]; then
    if [ -n "$_cur" ]; then
      codex plugin marketplace remove "$MKT" </dev/null >"$WORK/out" 2>&1 \
        || { add_skip "harness" "마켓플레이스 교체 실패: $(reason_of "$WORK/out")"; return 0; }
    fi
    codex plugin marketplace add "$_root" </dev/null >"$WORK/out" 2>&1 \
      || { add_skip "harness" "마켓플레이스 등록 실패: $(reason_of "$WORK/out")"; return 0; }
    state_add_line added-marketplaces "$MKT"
    _changed=1
  fi
  if [ "$_changed" = 1 ] || [ "$SRC_CHANGED" = 1 ] || ! plugin_installed "$_id"; then
    codex plugin add "$_id" </dev/null >"$WORK/out" 2>&1 \
      || { add_skip "harness" "plugin 설치 실패: $(reason_of "$WORK/out")"; return 0; }
    state_add_line added-plugins "$_id"
    add_done "$_id (스킬)"
  else
    add_same "$_id"
  fi
  # 지난 태그의 원본은 마켓플레이스가 더는 가리키지 않으므로 지운다
  for _d in "$H"/src/*; do
    [ -d "$_d" ] && [ "$_d" != "$_root" ] && rm -rf "$_d"
  done
  return 0
}

# ---------------------------------------------------------------- 전역 지침

render_agents() { # 원본 결과
  HARNESS_NAME_VALUE=$NAME awk '
    function rep(s, a, b,   i, out) {
      out = ""
      while ((i = index(s, a)) > 0) { out = out substr(s, 1, i - 1) b; s = substr(s, i + length(a)) }
      return out s
    }
    BEGIN { nm = ENVIRON["HARNESS_NAME_VALUE"]; tick = sprintf("%c", 96) }
    {
      line = $0
      if (nm != "") { print rep(line, "{{NAME}}", nm); next }
      # 호칭 규칙 줄은 호칭 없이 쓰는 규칙으로 바꾼다
      if (index(line, tick "{{NAME}} 님" tick) > 0) {
        match(line, /^[[:space:]]*([-*][[:space:]]+)?/)
        print substr(line, 1, RLENGTH) "**[호칭] 2인칭 호칭을 쓰지 않는다.** 이름, 님, 당신, 사용자 같은 말로 상대를 부르지 않고 주어를 생략해 쓴다."
        next
      }
      line = rep(line, "{{NAME}} 님이", "사용자가")
      line = rep(line, "{{NAME}} 님은", "사용자는")
      line = rep(line, "{{NAME}} 님을", "사용자를")
      line = rep(line, "{{NAME}} 님과", "사용자와")
      line = rep(line, "{{NAME}} 님께", "사용자에게")
      line = rep(line, "{{NAME}} 님", "사용자")
      line = rep(line, "{{NAME}}", "사용자")
      print line
    }' "$1" > "$2"
}

install_agents_md() {
  step "전역 지침 (AGENTS.md)"
  if [ "$NAME_GIVEN" = 0 ] && [ -f "$STATE/name" ]; then
    NAME=$(cat "$STATE/name")
  fi
  case "$NAME" in *'
'*) die "--name 에 줄바꿈을 넣을 수 없음" ;; esac
  render_agents "$SRC_ROOT/codex-home/AGENTS.md" "$WORK/AGENTS.md" || die "AGENTS.md 를 만들지 못함"
  place_managed AGENTS.md "$WORK/AGENTS.md" "$CODEX_DIR/AGENTS.md"
  if [ -n "$NAME" ]; then _who="호칭 $NAME 님"; else _who="호칭 없음"; fi
  if [ "$PLACED" = same ]; then add_same "$CODEX_DIR/AGENTS.md ($_who)"; else add_done "$CODEX_DIR/AGENTS.md ($_who)"; fi
  if ! is_dry; then
    mkdir -p "$STATE" && printf '%s\n' "$NAME" > "$STATE/name"
  fi
  return 0
}

# ---------------------------------------------------------------- 훅

install_owned_file() { # 원본 대상 이름
  if [ -f "$2" ] && cmp -s "$1" "$2"; then add_same "$3"; return 0; fi
  add_done "$3"
  is_dry && return 0
  copy_into "$1" "$2" || die "파일을 쓰지 못함: $2"
}

install_hooks() {
  step "훅 (hooks.json)"
  install_owned_file "$SRC_ROOT/codex-home/reminder.json" "$H/reminder.json" "$H/reminder.json"
  install_owned_file "$SRC_ROOT/codex-home/hooks.json" "$H/hooks.json" "$H/hooks.json (병합용 원본)"
  _new=$SRC_ROOT/codex-home/hooks.json
  _dest=$CODEX_DIR/hooks.json
  if [ ! -f "$_dest" ] || cmp -s "$_new" "$_dest" || { [ -f "$INST/hooks.json" ] && cmp -s "$INST/hooks.json" "$_dest"; }; then
    place_managed hooks.json "$_new" "$_dest"
    case $PLACED in
      same) add_same "$_dest" ;;
      update) add_done "$_dest"; HOOK_CHANGED=1 ;;
      *) add_done "$_dest" ;;
    esac
  elif grep -q 'harness/reminder.json' "$_dest"; then
    add_same "$_dest (하네스 훅이 합쳐져 있음)"
    is_dry || kv_set managed.list hooks.json "$_dest"
  else
    backup_user_file hooks.json "$_dest"
    is_dry || kv_set managed.list hooks.json "$_dest"
    MERGE_PATH=$_dest
    info "기존 hooks.json 이 있어 합치기가 필요함: $_dest"
  fi
  return 0
}

# ---------------------------------------------------------------- 외부 plugin

cond_ok() { # 조건
  COND_REASON=
  for _c in $(printf '%s' "$1" | tr ',' ' '); do
    case $_c in
      -) ;;
      node)   [ "$HAVE_NODE" = 1 ]   || { COND_REASON="node 없음"; return 1; } ;;
      git)    [ "$HAVE_GIT" = 1 ]    || { COND_REASON="git 없음"; return 1; } ;;
      chrome) [ "$HAVE_CHROME" = 1 ] || { COND_REASON="Chrome 없음"; return 1; } ;;
      *) COND_REASON="알 수 없는 조건 $_c"; return 1 ;;
    esac
  done
  return 0
}

# git 주소에서 GitHub owner/repo 를 뽑는다
github_slug() {
  case $1 in
    https://github.com/*) _s=${1#https://github.com/} ;;
    git@github.com:*)     _s=${1#git@github.com:} ;;
    *) return 1 ;;
  esac
  _s=${_s%.git}
  case $_s in */*) printf '%s' "$_s" ;; *) return 1 ;; esac
}

fetch_github_tarball() { # git주소 ref 대상폴더
  _slug=$(github_slug "$1") || { FAIL_REASON="git 없음, GitHub 가 아닌 주소라 tarball 로 받을 수 없음"; return 1; }
  [ "$HAVE_CURL" = 1 ] || { FAIL_REASON="curl 없음"; return 1; }
  _url="https://github.com/$_slug/archive/$2.tar.gz"
  rm -rf "$3.part" && mkdir -p "$3.part" || { FAIL_REASON="폴더를 만들지 못함: $3.part"; return 1; }
  if ! curl -fsSL "$_url" </dev/null 2>"$WORK/out" | tar -xzf - -C "$3.part" --strip-components=1 2>>"$WORK/out"; then
    rm -rf "$3.part"
    FAIL_REASON="tarball 내려받기 실패($_url): $(reason_of "$WORK/out")"
    return 1
  fi
  rm -rf "$3" && mv "$3.part" "$3" || { FAIL_REASON="폴더를 옮기지 못함: $3"; return 1; }
  info "tarball 받음: $_url"
}

# harness-ext 같은 감싼 마켓플레이스의 목록 파일을 plugins/ 아래 폴더로 다시 쓴다
write_wrapper_manifest() { # 폴더 이름
  mkdir -p "$1/.agents/plugins" || return 1
  {
    printf '{\n  "name": "%s",\n  "interface": { "displayName": "Harness external plugins" },\n  "plugins": [' "$2"
    _first=1
    for _p in "$1"/plugins/*/; do
      [ -d "$_p" ] || continue
      _n=$(basename "$_p")
      [ "$_first" = 1 ] || printf ','
      _first=0
      printf '\n    { "name": "%s", "source": { "source": "local", "path": "./plugins/%s" }, "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" }, "category": "Developer Tools" }' "$_n" "$_n"
    done
    printf '\n  ]\n}\n'
  } > "$1/.agents/plugins/marketplace.json"
}

ensure_marketplace() { # 종류 마켓플레이스 출처 plugin이름
  FAIL_REASON=
  _kind=$1 _mkt=$2 _src=$3 _pname=$4
  _ref=HEAD
  case $_src in *'#'*) _ref=${_src#*#}; _src=${_src%%#*} ;; esac
  case $_kind in
    builtin)
      return 0 ;;
    marketplace)
      mkt_configured "$_mkt" && return 0
      if [ "$HAVE_GIT" = 1 ]; then
        if [ "$_ref" = HEAD ]; then
          codex plugin marketplace add "$_src" </dev/null >"$WORK/out" 2>&1
        else
          codex plugin marketplace add "$_src" --ref "$_ref" </dev/null >"$WORK/out" 2>&1
        fi || { FAIL_REASON="마켓플레이스 등록 실패: $(reason_of "$WORK/out")"; return 1; }
      else
        _dir=$H/marketplaces/$_mkt
        fetch_github_tarball "$_src" "$_ref" "$_dir" || return 1
        codex plugin marketplace add "$_dir" </dev/null >"$WORK/out" 2>&1 \
          || { FAIL_REASON="마켓플레이스 등록 실패: $(reason_of "$WORK/out")"; return 1; }
      fi
      mkt_configured "$_mkt" || { FAIL_REASON="등록한 마켓플레이스 이름이 $_mkt 가 아님"; return 1; }
      state_add_line added-marketplaces "$_mkt"
      info "마켓플레이스 등록: $_mkt"
      return 0 ;;
    plugin)
      _dir=$H/marketplaces/$_mkt
      if [ ! -d "$_dir/plugins/$_pname" ]; then
        mkdir -p "$_dir/plugins" || { FAIL_REASON="폴더를 만들지 못함: $_dir"; return 1; }
        fetch_github_tarball "$_src" "$_ref" "$_dir/plugins/$_pname" || return 1
      fi
      write_wrapper_manifest "$_dir" "$_mkt" || { FAIL_REASON="목록 파일을 쓰지 못함: $_dir"; return 1; }
      if ! mkt_configured "$_mkt"; then
        codex plugin marketplace add "$_dir" </dev/null >"$WORK/out" 2>&1 \
          || { FAIL_REASON="마켓플레이스 등록 실패: $(reason_of "$WORK/out")"; return 1; }
        state_add_line added-marketplaces "$_mkt"
        info "마켓플레이스 등록: $_mkt"
      fi
      return 0 ;;
    *)
      FAIL_REASON="알 수 없는 종류 $_kind"; return 1 ;;
  esac
}

# dry 에서 builtin 마켓플레이스에 plugin 이 보이는지 읽기만 한다
builtin_lists() { # plugin@마켓플레이스
  codex plugin list --marketplace "${1#*@}" </dev/null 2>/dev/null | grep -q "^$1[[:space:]]"
}

ext_finish_group() {
  [ -n "$G_NAME" ] || return 0
  [ "$G_DONE" = 1 ] && return 0
  add_skip "$G_NAME" "$G_REASON"
}

install_external() {
  step "외부 plugin"
  _list=$SRC_ROOT/codex-home/plugins.txt
  # 이미 설치된 묶음을 먼저 찾아 두어, 다른 후보로 두 번 설치하지 않게 한다
  : > "$WORK/have"
  while IFS= read -r _line || [ -n "$_line" ]; do
    case $_line in ''|'#'*) continue ;; esac
    set -f; set -- $_line; set +f
    [ $# -ge 2 ] || continue
    if plugin_installed "$2" && ! grep -q "^$1 " "$WORK/have"; then printf '%s %s\n' "$1" "$2" >> "$WORK/have"; fi
  done < "$_list"

  G_NAME= G_DONE=0 G_REASON=
  while IFS= read -r _line || [ -n "$_line" ]; do
    case $_line in ''|'#'*) continue ;; esac
    set -f; set -- $_line; set +f
    if [ $# -lt 4 ]; then info "형식이 맞지 않아 무시한 줄: $_line"; continue; fi
    _g=$1 _sel=$2 _kind=$3 _src=$4 _cond=${5:--}
    if [ "$_g" != "$G_NAME" ]; then
      ext_finish_group
      G_NAME=$_g G_DONE=0 G_REASON="설치할 후보 없음"
      _have=$(awk -v g="$_g" '$1==g {print $2; exit}' "$WORK/have")
      if [ -n "$_have" ]; then add_same "$_have"; G_DONE=1; fi
    fi
    [ "$G_DONE" = 1 ] && continue
    [ "$_kind" = detect ] && continue
    if ! cond_ok "$_cond"; then G_REASON=$COND_REASON; continue; fi
    _pname=${_sel%@*} _mkt=${_sel#*@}
    if is_dry; then
      if [ "$_kind" = builtin ] && ! builtin_lists "$_sel"; then G_REASON="$_mkt 에 없음"; continue; fi
      add_done "$_sel ($_kind)"
      G_DONE=1
      continue
    fi
    if ! ensure_marketplace "$_kind" "$_mkt" "$_src" "$_pname"; then G_REASON=$FAIL_REASON; continue; fi
    if codex plugin add "$_sel" </dev/null >"$WORK/out" 2>&1; then
      state_add_line added-plugins "$_sel"
      add_done "$_sel"
      G_DONE=1
    else
      G_REASON="plugin 설치 실패: $(reason_of "$WORK/out")"
    fi
  done < "$_list"
  ext_finish_group
  return 0
}

# ---------------------------------------------------------------- config.toml

# 첫 table 앞의 project_doc_max_bytes 줄 번호와 값을 "줄 값" 으로 출력한다
doc_bytes_info() {
  [ -f "$CFG" ] || return 0
  # 줄 전체가 [..] 인 것만 table 머리로 본다. 여러 줄 배열의 요소 줄(  ["a"],)은 머리가 아니다
  awk '
    /^[[:space:]]*\[\[?[^]]*\]\]?[[:space:]]*(#.*)?$/ { exit }
    /^[[:space:]]*project_doc_max_bytes[[:space:]]*=/ {
      v = $0; sub(/^[^=]*=[[:space:]]*/, "", v); sub(/[[:space:]]*#.*$/, "", v); sub(/[[:space:]]+$/, "", v)
      print NR " " v; exit }' "$CFG"
}

install_config() {
  step "설정 (config.toml)"
  _info=$(doc_bytes_info)
  if [ -n "$_info" ]; then
    _ln=${_info%% *} _val=${_info#* }
    _num=$(printf '%s' "$_val" | tr -d '_')
    case $_num in ''|*[!0-9]*) add_skip "project_doc_max_bytes" "기존 값을 읽지 못함($_val)"; return 0 ;; esac
    if [ "$_num" -ge "$DOC_BYTES" ]; then add_same "project_doc_max_bytes = $_val"; return 0; fi
    # 되돌릴 때 원래 표기(밑줄 포함)를 그대로 쓰도록 읽은 값을 남긴다
    _prev=$_val
  else
    _ln=0 _prev=absent
  fi
  add_done "project_doc_max_bytes = $DOC_BYTES (이전: $_prev)"
  is_dry && return 0
  mkdir -p "$STATE" "$CODEX_DIR" || die "폴더를 만들지 못함: $CODEX_DIR"
  [ -f "$STATE/doc-bytes.prev" ] || printf '%s\n' "$_prev" > "$STATE/doc-bytes.prev"
  if [ -f "$CFG" ]; then
    backup_copy config.toml "$CFG"
    if [ "$_ln" -gt 0 ]; then
      awk -v n="$_ln" -v t="$DOC_BYTES" 'NR == n { sub(/=.*/, "= " t) } { print }' "$CFG" > "$WORK/config.toml"
    else
      awk -v t="$DOC_BYTES" '
        !done && /^[[:space:]]*\[\[?[^]]*\]\]?[[:space:]]*(#.*)?$/ { print "project_doc_max_bytes = " t; print ""; done = 1 }
        { print }
        END { if (!done) print "project_doc_max_bytes = " t }' "$CFG" > "$WORK/config.toml"
    fi
    cat "$WORK/config.toml" > "$CFG" || die "config.toml 을 쓰지 못함"
  else
    printf 'project_doc_max_bytes = %s\n' "$DOC_BYTES" > "$CFG" || die "config.toml 을 쓰지 못함"
  fi
}

# ---------------------------------------------------------------- node 가 필요한 것

install_qa_agents() {
  step "qa 에이전트"
  [ "$HAVE_NODE" = 1 ] || { add_skip "qa 에이전트" "node 없음"; return 0; }
  _n=0 _changed=0
  : > "$WORK/agents"
  for _f in "$SRC_ROOT"/codex-home/agents/*.toml; do
    [ -f "$_f" ] || continue
    _b=$(basename "$_f")
    printf 'agents/%s\n' "$_b" >> "$WORK/agents"
    place_managed "agents/$_b" "$_f" "$CODEX_DIR/agents/$_b"
    _n=$((_n + 1))
    [ "$PLACED" = same ] || _changed=$((_changed + 1))
  done
  # 지난 버전에만 있던 에이전트를 걷어 낸다
  if [ -f "$STATE/managed.list" ]; then
    grep '^agents/' "$STATE/managed.list" | while IFS='|' read -r _k _d; do
      grep -qxF "$_k" "$WORK/agents" || retire_managed "$_k" "$_d"
    done
  fi
  if [ "$_n" = 0 ]; then add_skip "qa 에이전트" "원본에 파일 없음"; return 0; fi
  if [ "$_changed" = 0 ]; then add_same "qa 에이전트 ${_n}개 ($CODEX_DIR/agents)"
  else add_done "qa 에이전트 ${_n}개 중 ${_changed}개 ($CODEX_DIR/agents)"; fi
}

install_node_skills() {
  step "node 가 필요한 스킬 (recommit, qa)"
  [ "$HAVE_NODE" = 1 ] || { add_skip "recommit, qa 스킬" "node 없음"; return 0; }
  _src=$SRC_ROOT/codex-home/skills
  [ -d "$_src" ] || { add_skip "recommit, qa 스킬" "원본에 폴더 없음"; return 0; }
  (cd "$_src" && find . -type f) | sed 's|^\./|skills/|' | sort > "$WORK/nodeskills"
  _n=0 _changed=0
  while IFS= read -r _k; do
    place_managed "$_k" "$SRC_ROOT/codex-home/$_k" "$USER_SKILLS/${_k#skills/}"
    _n=$((_n + 1))
    [ "$PLACED" = same ] || _changed=$((_changed + 1))
  done < "$WORK/nodeskills"
  # 지난 버전에만 있던 파일을 걷어 낸다
  if [ -f "$STATE/managed.list" ]; then
    grep '^skills/' "$STATE/managed.list" | while IFS='|' read -r _k _d; do
      grep -qxF "$_k" "$WORK/nodeskills" || retire_managed "$_k" "$_d"
    done
  fi
  _names=$(sed -n 's|^skills/\([^/]*\)/SKILL\.md$|\1|p' "$WORK/nodeskills" | tr '\n' ' ')
  if [ "$_changed" = 0 ]; then add_same "스킬 ${_names}($USER_SKILLS, 파일 ${_n}개)"
  else add_done "스킬 ${_names}($USER_SKILLS, 파일 ${_n}개 중 ${_changed}개)"; fi
}

write_dispatcher() {
  cat > "$1" <<'EOF'
#!/bin/sh
# codex-harness git 훅 분배기. 전역 core.hooksPath 가 이 폴더를 가리킬 때 git 이 부른다.
# 순서: 레포의 .git/hooks/<이름>, 하네스 설치 전 core.hooksPath 의 같은 훅, 하네스 훅(own/<이름>).
# 하나라도 실패하면 그 종료 코드로 멈춘다.
name=${0##*/}
here=$(cd "$(dirname "$0")" && pwd -P)
prev=
[ -f "$here/.prev-hooks-path" ] && prev=$(cat "$here/.prev-hooks-path")
gitdir=$(git rev-parse --git-common-dir 2>/dev/null) || gitdir=
t1= t2= t3= n=0
if [ -n "$gitdir" ] && [ -f "$gitdir/hooks/$name" ] && [ -x "$gitdir/hooks/$name" ]; then
  t1=$gitdir/hooks/$name; n=$((n + 1))
fi
if [ -n "$prev" ] && [ "$prev" != "$here" ] && [ -f "$prev/$name" ] && [ -x "$prev/$name" ]; then
  t2=$prev/$name; n=$((n + 1))
fi
if [ -f "$here/own/$name" ] && [ -x "$here/own/$name" ]; then
  t3=$here/own/$name; n=$((n + 1))
fi
[ "$n" -eq 0 ] && exit 0
# 하나뿐이면 표준 입력을 그대로 넘긴다
[ "$n" -eq 1 ] && exec "$t1$t2$t3" "$@"
tmp=
case $name in
  pre-push|post-rewrite|pre-receive|post-receive|reference-transaction)
    tmp=$(mktemp) || exit 1
    trap 'rm -f "$tmp"' EXIT
    cat > "$tmp" ;;
esac
for t in "$t1" "$t2" "$t3"; do
  [ -n "$t" ] || continue
  if [ -n "$tmp" ]; then "$t" "$@" < "$tmp"; else "$t" "$@"; fi
  rc=$?
  [ "$rc" -eq 0 ] || exit "$rc"
done
exit 0
EOF
  chmod 755 "$1"
}

install_githooks() {
  step "git 훅 (commit-msg)"
  [ "$HAVE_NODE" = 1 ] || { add_skip "commit-msg 훅" "node 없음"; return 0; }
  [ "$HAVE_GIT" = 1 ]  || { add_skip "commit-msg 훅" "git 없음"; return 0; }
  _own=$SRC_ROOT/codex-home/githooks/commit-msg
  [ -f "$_own" ] || { add_skip "commit-msg 훅" "원본에 파일 없음"; return 0; }
  _gh=$H/githooks
  # _raw 는 되돌릴 때 쓰는 원래 표기, _cur 는 git 이 펼친 실제 경로
  _raw=$(git config --global --get core.hooksPath </dev/null 2>/dev/null) || _raw=
  _cur=$(git config --global --type=path --get core.hooksPath </dev/null 2>/dev/null) \
    || _cur=$(git config --global --path --get core.hooksPath </dev/null 2>/dev/null) || _cur=$_raw

  # 하네스 설치 전 값을 기록해 두고, 분배기가 그 폴더의 훅도 이어서 부르게 한다
  if [ "$_cur" != "$_gh" ]; then
    if is_dry; then
      info "[dry] 이전 core.hooksPath 기록: ${_raw:-(없음)}"
    else
      mkdir -p "$STATE" || die "상태 폴더를 만들지 못함"
      if [ -n "$_raw" ]; then
        printf '%s\n' "$_raw" > "$STATE/hooks-path.prev"
        printf '%s\n' "$_cur" > "$STATE/hooks-path.prev-path"
        rm -f "$STATE/hooks-path.unset"
      else
        : > "$STATE/hooks-path.unset"
        rm -f "$STATE/hooks-path.prev" "$STATE/hooks-path.prev-path"
      fi
      printf '%s\n' "${_raw:-(unset)}" > "$WORK/hookspath"
      backup_copy git-core-hooksPath "$WORK/hookspath"
    fi
  fi
  _prev=
  [ -f "$STATE/hooks-path.prev-path" ] && _prev=$(cat "$STATE/hooks-path.prev-path")
  is_dry && [ "$_cur" != "$_gh" ] && _prev=$_cur

  _b=$WORK/githooks
  mkdir -p "$_b/own" || die "임시 폴더를 만들지 못함"
  for _n in $HOOK_NAMES; do write_dispatcher "$_b/$_n"; done
  cp "$_own" "$_b/own/commit-msg" && chmod 755 "$_b/own/commit-msg"
  [ -n "$_prev" ] && printf '%s\n' "$_prev" > "$_b/.prev-hooks-path"

  if [ -d "$_gh" ] && diff -r "$_b" "$_gh" >/dev/null 2>&1 && [ "$_cur" = "$_gh" ]; then
    add_same "commit-msg 훅 (core.hooksPath = $_gh)"
    return 0
  fi
  add_done "commit-msg 훅 (core.hooksPath = $_gh, 레포의 .git/hooks 도 이어서 실행)"
  is_dry && return 0
  rm -rf "$_gh.part" && cp -R "$_b" "$_gh.part" && rm -rf "$_gh" && mv "$_gh.part" "$_gh" \
    || die "git 훅 폴더를 두지 못함: $_gh"
  if [ "$_cur" != "$_gh" ]; then
    git config --global core.hooksPath "$_gh" </dev/null || die "git config --global core.hooksPath 설정 실패"
  fi
}

# ---------------------------------------------------------------- 마무리

install_uninstaller() {
  [ -f "$SRC_ROOT/uninstall.sh" ] || return 0
  if [ -f "$H/uninstall.sh" ] && cmp -s "$SRC_ROOT/uninstall.sh" "$H/uninstall.sh"; then return 0; fi
  is_dry && return 0
  copy_into "$SRC_ROOT/uninstall.sh" "$H/uninstall.sh" && chmod 755 "$H/uninstall.sh"
}

print_list() { # 파일 머리말
  [ -s "$1" ] || return 0
  say "$2"
  while IFS= read -r _l; do say "  - $_l"; done < "$1"
}

summary() {
  is_dry || printf '%s\n' "$TAG" > "$STATE/version"
  say ""
  if is_dry; then say "==== 하네스 설치 요약 ($TAG, --dry: 아무것도 바꾸지 않음) ===="
  else say "==== 하네스 설치 요약 ($TAG) ===="; fi
  if is_dry; then print_list "$WORK/done" "설치 예정:"; else print_list "$WORK/done" "설치/갱신:"; fi
  print_list "$WORK/same" "변경 없음:"
  [ -s "$WORK/skip" ] && cat "$WORK/skip"
  if [ "$BACKED_UP" = 1 ]; then say "백업: $BACKUP_DIR"; else say "백업: 이번 실행에서 새로 만든 백업 없음"; fi
  if [ -n "$MERGE_PATH" ]; then
    _mb=$(kv_get restore.list hooks.json)
    say "MERGE_NEEDED $MERGE_PATH"
    say "  합칠 내용: $H/hooks.json, 원래 파일 백업: ${_mb:-$BACKUP_DIR}/hooks.json"
  fi
  [ -s "$WORK/note" ] && cat "$WORK/note"
  if [ -s "$WORK/done" ] || [ -n "$MERGE_PATH" ]; then
    say "다음: codex 를 다시 켠 뒤 /hooks 에서 하네스 훅을 승인"
  else
    say "다음: 바뀐 것이 없음. 훅을 아직 승인하지 않았다면 codex 의 /hooks 에서 승인"
  fi
  say "제거: sh $H/uninstall.sh"
  say "===="
}

main() {
  while [ $# -gt 0 ]; do
    case $1 in
      --dry) DRY=1 ;;
      --name) [ $# -ge 2 ] || die "--name 뒤에 호칭이 필요함"; NAME=$2; NAME_GIVEN=1; shift ;;
      --name=*) NAME=${1#--name=}; NAME_GIVEN=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "알 수 없는 옵션: $1" ;;
    esac
    shift
  done

  WORK=$(mktemp -d 2>/dev/null) || WORK=$(mktemp -d -t harness) || die "임시 폴더를 만들지 못함"
  trap 'rm -rf "$WORK"' EXIT
  trap 'exit 130' INT TERM
  : > "$WORK/done"; : > "$WORK/same"; : > "$WORK/skip"; : > "$WORK/note"

  check_env
  fetch_source
  is_dry || mkdir -p "$H" || die "폴더를 만들지 못함: $H"
  install_src
  install_harness_plugin
  install_agents_md
  install_hooks
  install_external
  install_config
  install_qa_agents
  install_node_skills
  install_githooks
  install_uninstaller
  [ "$HOOK_CHANGED" = 1 ] && add_note "훅 내용이 바뀌었음. 예전에 승인했어도 /hooks 에서 다시 승인해야 실행됨"
  summary
}

main "$@"
