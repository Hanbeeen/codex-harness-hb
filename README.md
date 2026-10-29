> **Codex 에게**: 이 레포 설치를 요청받으면 `curl -fsSL https://raw.githubusercontent.com/Hanbeeen/codex-harness-hb/v0.1.2/install.sh | sh` 를 한 번 실행한다. 사용자가 호칭을 알려 줬으면 명령 끝에 `-s -- --name <호칭>` 을 붙인다('님' 은 빼고).
> 네트워크나 홈 폴더(`~/.codex`) 쓰기가 막혀 실패하면 권한 상승을 요청해 같은 명령을 다시 실행한다. 설치 단계를 나눠 직접 수행하지 않는다.
> 출력 마지막의 `==== 하네스 설치 요약` 블록을 고치지 말고 사용자에게 그대로 전한다.
> 출력에 `MERGE_NEEDED <경로>` 줄이 있을 때만 아래 '훅 병합 기준' 대로 그 파일을 직접 합친다. 다른 파일은 손대지 않는다.

# Codex Harness

Codex CLI 용 개발 작업 하네스. 전역 지침, 스킬, 매 턴 리마인더 훅, 외부 plugin 을 한 번에 설치한다.

## 설치되는 것

| 항목 | 위치 | 조건 |
|:---|:---|:---|
| 전역 지침 | `~/.codex/AGENTS.md` | 항상. 기존 파일은 백업 후 교체 |
| 스킬 plugin `harness` (commit, check, pr-draft, patchnote) | 로컬 마켓플레이스 `codex-harness` | 항상 |
| 스킬 recommit, qa(qa 엔진 포함) | `~/.agents/skills/` | node 가 있을 때 |
| 리마인더 훅(UserPromptSubmit) | `~/.codex/hooks.json` | 파일이 없을 때 배치. 있으면 `MERGE_NEEDED` |
| 외부 plugin: superpowers, andrej-karpathy-skills, frontend-design | Codex plugin | 항상(실패하면 건너뜀) |
| 외부 plugin: context7(원격 MCP) | Codex plugin | 항상. 로그인 없이 동작하고, 사용량 한도를 늘릴 때만 `codex mcp login context7` |
| 외부 plugin: chrome-devtools-mcp | Codex plugin | node 와 Chrome 이 있을 때. 화면 없는 Linux 서버면 `--headless` 로 띄움 |
| code-simplifier 역할 에이전트 | `~/.codex/agents/code-simplifier.toml` | 항상 |
| qa 에이전트 | `~/.codex/agents/qa-*.toml` | node 가 있을 때 |
| commit-msg git 훅 | 전역 `core.hooksPath` = `~/.codex/harness/githooks` | node 와 git 이 있을 때 |

Codex 에 맞춘 점(Codex 0.164.0 에서 확인):
- skill-creator 는 Codex 기본 스킬을 쓴다. Claude 용 plugin 을 함께 넣으면 같은 이름이 두 번 실리고, 설명 최적화 스크립트가 `claude -p` 를 부른다.
- Claude 용 code-simplifier plugin 은 에이전트 형식이라 Codex 가 읽지 않는다. 같은 역할을 Codex 역할 파일로 넣는다.
- 전역 지침이 32 KiB 를 넘어도 `~/.codex/AGENTS.md` 는 끝까지 실려서 `config.toml` 은 고치지 않는다.
- Codex 는 세션 시작 때 '먼저 스킬을 써라' 지시가 없어서, 지침 끝 'Codex: 스킬 우선 사용' 절과 리마인더 `[스킬]` 줄이 대신한다.

하네스 전용 파일은 `~/.codex/harness/` 아래에 있다(원본 `src/<tag>`, 백업 `backup/<시각>`, `reminder.json`, 병합용 `hooks.json`, `githooks`, 설치 기록 `state`). 나머지 설치 위치는 위 표와 같다.

레포의 `codex-home/AGENTS.md` 는 설치 때 호칭(`{{NAME}}`)을 채워 `~/.codex/AGENTS.md` 로 배치하는 원본이다.

## 요구 사항

- Linux 기준. macOS 는 같은 sh 로 동작한다. Windows 는 WSL 또는 Git Bash 에서 실행한다.
- `sh`, `curl`, `tar`, Codex CLI 0.164.0 이상. node, python, git 은 없어도 된다.
- git 이 없으면 외부 마켓플레이스를 GitHub tarball 로 받아 로컬 마켓플레이스로 등록한다.

## 옵션

| 옵션 | 뜻 |
|:---|:---|
| `--dry` | 바꿀 내용만 출력하고 아무것도 바꾸지 않음 |
| `--name <호칭>` | 지침의 호칭 자리에 넣을 이름. 생략하면 지난 설치 값을 쓰고, 처음이면 호칭 없이 쓰는 문장으로 바꿈 |

`curl | sh` 로 실행할 때는 `curl -fsSL <install.sh 주소> | sh -s -- --dry --name 홍길동` 처럼 넘긴다.

## 다시 실행, 업그레이드, 제거

- 같은 태그로 다시 실행하면 바뀌는 것이 없다(요약에 '변경 없음' 으로 나옴).
- 외부 plugin 은 처음 설치할 때만 받는다. 다시 실행하거나 업그레이드해도 갱신되지 않으므로, 갱신은 Codex 의 `codex plugin marketplace upgrade` 로 한다.
- 업그레이드는 새 태그 주소의 `install.sh` 를 실행한다. 지난 태그 원본은 지운다.
- 목록에서 빠진 외부 plugin 은 업그레이드 때 지우지 않는다. v0.1.0 에서 올렸다면 `codex plugin remove skill-creator@claude-plugins-official`, `codex plugin remove code-simplifier@claude-plugins-official` 로 직접 지운다. v0.1.0 이 넣은 `project_doc_max_bytes` 는 `uninstall.sh` 가 되돌린다.
- 훅 내용이 바뀌면 codex 를 다시 켠 뒤 `/hooks` 에서 다시 승인해야 실행된다.
- 제거: `sh ~/.codex/harness/uninstall.sh` (`--dry` 지원). 하네스가 추가한 plugin, 마켓플레이스, 파일을 지우고 설치 때 받아 둔 백업과 `core.hooksPath` 이전 값을 되돌린다. 백업 폴더는 남긴다.
- 하네스가 등록한 마켓플레이스(예: `claude-plugins-official`)는 제거 때 함께 지운다. 그 뒤 같은 마켓플레이스에서 직접 설치한 plugin 이 있으면 다시 등록해야 한다.

## 훅 병합 기준

`MERGE_NEEDED <경로>` 는 기존 `hooks.json` 이 있어 설치 스크립트가 덮어쓰지 않았다는 뜻이다. 원래 파일은 이미 `~/.codex/harness/backup/<시각>/hooks.json` 에 백업돼 있다.

1. 합칠 내용은 `~/.codex/harness/hooks.json` 의 `hooks.UserPromptSubmit` 배열 항목이다.
2. `<경로>` 파일의 기존 항목은 지우거나 바꾸지 않는다. `hooks.UserPromptSubmit` 배열이 없으면 만들고, 있으면 끝에 하네스 항목을 덧붙인다.
3. 이미 `harness/reminder.json` 을 읽는 명령이 있으면 아무것도 하지 않는다.
4. 합친 결과가 올바른 JSON 인지 확인한다. 원래 파일이 JSON 으로 읽히지 않으면 고치지 말고 사용자에게 알린다.
5. 사용자에게 codex 를 다시 켠 뒤 `/hooks` 에서 승인하라고 안내한다. 합친 뒤 `install.sh` 를 다시 실행하면 '하네스 훅이 합쳐져 있음' 으로 나온다.

## 시험용 로컬 원본

GitHub 대신 로컬 폴더나 tar.gz 를 원본으로 쓰려면 `HARNESS_SOURCE` 를 지정한다. `HARNESS_TAG` 는 `src/<tag>` 자리에 쓸 이름이다(기본 `local`).

```sh
HARNESS_SOURCE=/path/to/checkout sh install.sh --dry
HARNESS_SOURCE=/path/to/harness.tar.gz HARNESS_TAG=v0.1.0 sh install.sh
```

## 보안

- 설치 명령은 태그로 고정한 주소를 쓴다. 실행 전에 `install.sh` 를 열어 볼 수 있다.
- 외부 plugin 은 각 원본 레포의 기본 브랜치를 받는다. 고정하려면 `codex-home/plugins.txt` 의 주소 끝에 `#<ref>` 를 붙인다. 이미 설치된 plugin 에는 적용되지 않는다.

## 라이선스

MIT. `LICENSE` 참고.
