#!/bin/sh
# Codex 하네스 제거 스크립트 (POSIX sh)
#
# 사용
#   sh "$HOME/.codex/harness/uninstall.sh" [--dry]
# install.sh 가 남긴 기록($CODEX_HOME/harness/state)대로 되돌린다.
#   - 하네스가 추가한 plugin 과 마켓플레이스를 지운다
#   - AGENTS.md, hooks.json, qa 에이전트는 설치 때 받아 둔 마지막 백업으로 되돌리고, 백업이 없으면 지운다
#   - config.toml 의 project_doc_max_bytes, git 전역 core.hooksPath 를 설치 전 값으로 되돌린다
#   - 백업 폴더($CODEX_HOME/harness/backup)는 남긴다

set -u

CODEX_DIR=${CODEX_HOME:-$HOME/.codex}
H=$CODEX_DIR/harness
STATE=$H/state
INST=$H/installed
CFG=$CODEX_DIR/config.toml
DOC_BYTES=65536
TS=$(date +%Y%m%d-%H%M%S)
UBK=$H/backup/$TS-uninstall
DRY=0
WORK=

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '오류: %s\n' "$*" >&2; exit 1; }
is_dry() { [ "$DRY" = 1 ]; }

add_done() { printf '%s\n' "$*" >> "$WORK/done"; if is_dry; then info "[dry] $*"; else info "$*"; fi; }
add_keep() { printf '%s\n' "$*" >> "$WORK/keep"; info "그대로 둠: $*"; }
add_fail() { printf '%s\n' "$*" >> "$WORK/fail"; info "실패: $*"; }

reason_of() {
  _r=$(sed -n 's/^Error: //p' "$1" | head -n 1)
  [ -n "$_r" ] || _r=$(grep -v '^[[:space:]]*$' "$1" | tail -n 1)
  printf '%s' "$_r" | cut -c 1-160
}

kv_get() { [ -f "$STATE/$1" ] || return 0; awk -F'|' -v k="$2" '$1==k {v=$2} END {if (v != "") print v}' "$STATE/$1"; }

copy_into() {
  mkdir -p "$(dirname "$2")" || return 1
  # 심볼릭 링크는 끊지 않고 가리키는 파일에 쓴다
  if [ -L "$2" ]; then cat "$1" > "$2"; return; fi
  cp -p "$1" "$2.harness-tmp" && mv -f "$2.harness-tmp" "$2"
}

usage() {
  cat <<'EOF'
사용: uninstall.sh [--dry]
  --dry   되돌릴 내용만 보여 주고 아무것도 바꾸지 않음
EOF
}

# ---------------------------------------------------------------- plugin

remove_plugins() {
  step "plugin, 마켓플레이스"
  if ! command -v codex >/dev/null 2>&1; then
    add_fail "codex 명령이 없어 plugin 을 지우지 못함"
    return 0
  fi
  if [ -f "$STATE/added-plugins" ]; then
    while IFS= read -r _id; do
      [ -n "$_id" ] || continue
      if is_dry; then add_done "plugin 제거: $_id"; continue; fi
      if codex plugin remove "$_id" </dev/null >"$WORK/out" 2>&1; then
        add_done "plugin 제거: $_id"
        # codex 가 남기는 빈 캐시 폴더만 지운다
        rmdir "$CODEX_DIR/plugins/cache/${_id#*@}/${_id%@*}" "$CODEX_DIR/plugins/cache/${_id#*@}" 2>/dev/null
      else
        add_fail "plugin 제거: $_id, $(reason_of "$WORK/out")"
      fi
    done < "$STATE/added-plugins"
  fi
  if [ -f "$STATE/added-marketplaces" ]; then
    while IFS= read -r _m; do
      [ -n "$_m" ] || continue
      if ! { [ -f "$CFG" ] && grep -qF "[marketplaces.$_m]" "$CFG"; }; then info "이미 없음: 마켓플레이스 $_m"; continue; fi
      if is_dry; then add_done "마켓플레이스 제거: $_m"; continue; fi
      if codex plugin marketplace remove "$_m" </dev/null >"$WORK/out" 2>&1; then
        add_done "마켓플레이스 제거: $_m"
      else
        add_fail "마켓플레이스 제거: $_m, $(reason_of "$WORK/out")"
      fi
    done < "$STATE/added-marketplaces"
  fi
  return 0
}

# ---------------------------------------------------------------- 파일

restore_file() { # key 대상
  _key=$1 _dest=$2 _inst=$INST/$1
  _bk=$(kv_get restore.list "$_key")
  _src=
  [ -n "$_bk" ] && [ -f "$_bk/$_key" ] && _src=$_bk/$_key

  if [ ! -f "$_dest" ]; then
    if [ -n "$_src" ]; then
      is_dry || copy_into "$_src" "$_dest" || { add_fail "되돌림: $_dest"; return 0; }
      add_done "되돌림: $_dest (백업 $_src)"
    fi
    return 0
  fi
  if [ -f "$_inst" ] && cmp -s "$_inst" "$_dest"; then
    # 하네스가 둔 그대로인 파일
    if [ -n "$_src" ]; then
      is_dry || copy_into "$_src" "$_dest" || { add_fail "되돌림: $_dest"; return 0; }
      add_done "되돌림: $_dest (백업 $_src)"
    else
      is_dry || rm -f "$_dest" || { add_fail "지움: $_dest"; return 0; }
      add_done "지움: $_dest"
    fi
    return 0
  fi
  # 설치 뒤 바뀐 파일(직접 고쳤거나 hooks.json 을 합친 경우)
  if [ -n "$_src" ]; then
    if cmp -s "$_src" "$_dest"; then
      add_keep "$_dest (설치 전과 같음)"
      return 0
    fi
    if ! is_dry; then
      copy_into "$_dest" "$UBK/$_key" || { add_fail "현재 파일 보관: $_dest"; return 0; }
      copy_into "$_src" "$_dest" || { add_fail "되돌림: $_dest"; return 0; }
    fi
    add_done "되돌림: $_dest (백업 $_src, 지금 내용은 $UBK/$_key 에 남김)"
  else
    add_keep "$_dest (설치 뒤 바뀌었고 설치 전 백업이 없음. 하네스 내용만 직접 지울 것)"
  fi
  return 0
}

restore_files() {
  step "AGENTS.md, hooks.json, qa 에이전트"
  [ -f "$STATE/managed.list" ] || return 0
  while IFS='|' read -r _k _d; do
    [ -n "$_k" ] && [ -n "$_d" ] || continue
    restore_file "$_k" "$_d"
  done < "$STATE/managed.list"
}

# ---------------------------------------------------------------- config.toml

doc_bytes_info() {
  [ -f "$CFG" ] || return 0
  awk '
    /^[[:space:]]*\[\[?[^]]*\]\]?[[:space:]]*(#.*)?$/ { exit }
    /^[[:space:]]*project_doc_max_bytes[[:space:]]*=/ {
      v = $0; sub(/^[^=]*=[[:space:]]*/, "", v); sub(/[[:space:]]*#.*$/, "", v); sub(/[[:space:]]+$/, "", v)
      print NR " " v; exit }' "$CFG"
}

revert_config() {
  step "설정 (config.toml)"
  [ -f "$STATE/doc-bytes.prev" ] || return 0
  _prev=$(cat "$STATE/doc-bytes.prev")
  _info=$(doc_bytes_info)
  if [ -z "$_info" ]; then add_keep "project_doc_max_bytes (이미 없음)"; return 0; fi
  _ln=${_info%% *} _val=${_info#* }
  _num=$(printf '%s' "$_val" | tr -d '_')
  if [ "$_num" != "$DOC_BYTES" ]; then
    add_keep "project_doc_max_bytes = $_val (설치 뒤 바뀐 값)"
    return 0
  fi
  if [ "$_prev" = absent ]; then
    add_done "project_doc_max_bytes 줄 지움"
    is_dry && return 0
    # 설치 때 함께 넣은 빈 줄도 지운다
    awk -v n="$_ln" 'NR == n { skip = 1; next } skip && /^[[:space:]]*$/ { skip = 0; next } { skip = 0; print }' "$CFG" > "$WORK/config.toml"
  else
    add_done "project_doc_max_bytes = $_prev 로 되돌림"
    is_dry && return 0
    awk -v n="$_ln" -v t="$_prev" 'NR == n { sub(/=.*/, "= " t) } { print }' "$CFG" > "$WORK/config.toml"
  fi
  cat "$WORK/config.toml" > "$CFG" || add_fail "config.toml 을 쓰지 못함"
}

# ---------------------------------------------------------------- git

revert_hooks_path() {
  step "git 전역 core.hooksPath"
  [ -f "$STATE/hooks-path.prev" ] || [ -f "$STATE/hooks-path.unset" ] || return 0
  if ! command -v git >/dev/null 2>&1; then add_fail "git 이 없어 core.hooksPath 를 되돌리지 못함"; return 0; fi
  _gh=$H/githooks
  _cur=$(git config --global --type=path --get core.hooksPath </dev/null 2>/dev/null) \
    || _cur=$(git config --global --path --get core.hooksPath </dev/null 2>/dev/null) \
    || _cur=$(git config --global --get core.hooksPath </dev/null 2>/dev/null) || _cur=
  if [ "$_cur" != "$_gh" ]; then
    add_keep "core.hooksPath = ${_cur:-(없음)} (설치 뒤 바뀐 값)"
    return 0
  fi
  if [ -f "$STATE/hooks-path.prev" ]; then
    _prev=$(cat "$STATE/hooks-path.prev")
    is_dry || git config --global core.hooksPath "$_prev" </dev/null || { add_fail "core.hooksPath 되돌림"; return 0; }
    add_done "core.hooksPath = $_prev 로 되돌림"
  else
    is_dry || git config --global --unset core.hooksPath </dev/null || { add_fail "core.hooksPath 지움"; return 0; }
    add_done "core.hooksPath 지움(설치 전에 없었음)"
  fi
}

# ---------------------------------------------------------------- 정리

remove_owned() {
  step "하네스 폴더"
  add_done "지움: $H 아래 하네스 파일(backup 폴더는 남김)"
  is_dry && return 0
  rm -rf "$H/src" "$H/marketplaces" "$H/installed" "$H/githooks" \
         "$H/reminder.json" "$H/hooks.json" "$H/uninstall.sh" "$H/tools/check_korean_output.py" "$STATE"
  rmdir "$H/tools" 2>/dev/null
  rmdir "$H" 2>/dev/null
  return 0
}

summary() {
  say ""
  if is_dry; then say "==== 하네스 제거 요약 (--dry: 아무것도 바꾸지 않음) ===="
  else say "==== 하네스 제거 요약 ===="; fi
  if [ -s "$WORK/done" ]; then say "처리:"; while IFS= read -r _l; do say "  - $_l"; done < "$WORK/done"; fi
  if [ -s "$WORK/keep" ]; then say "그대로 둠:"; while IFS= read -r _l; do say "  - $_l"; done < "$WORK/keep"; fi
  if [ -s "$WORK/fail" ]; then say "실패:"; while IFS= read -r _l; do say "  - $_l"; done < "$WORK/fail"; fi
  if [ -d "$H/backup" ]; then say "백업 폴더(남겨 둠): $H/backup"; fi
  say "다음: codex 를 다시 켜면 반영됨"
  say "===="
}

main() {
  while [ $# -gt 0 ]; do
    case $1 in
      --dry) DRY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "알 수 없는 옵션: $1" ;;
    esac
    shift
  done
  if [ ! -d "$STATE" ]; then
    say "설치 기록이 없어 할 일이 없음: $STATE"
    exit 0
  fi
  WORK=$(mktemp -d 2>/dev/null) || WORK=$(mktemp -d -t harness) || die "임시 폴더를 만들지 못함"
  trap 'rm -rf "$WORK"' EXIT
  trap 'exit 130' INT TERM
  : > "$WORK/done"; : > "$WORK/keep"; : > "$WORK/fail"

  remove_plugins
  restore_files
  revert_config
  revert_hooks_path
  if [ -s "$WORK/fail" ]; then
    printf '%s\n' "실패가 있어 설치 기록($STATE)을 남김. 원인을 해결한 뒤 다시 실행" >> "$WORK/keep"
  else
    remove_owned
  fi
  summary
  [ -s "$WORK/fail" ] && exit 1
  exit 0
}

main "$@"
