---
name: qa
description: "브랜치 변경분(분기 뿌리..HEAD + 미커밋)을 경량 워커들로 정적/런타임 QA 한다. 프로필 없으면 첫 실행에 생성. 발견을 보고만 하고 코드는 고치지 않는다. 인자: [--tier light|full|max] [--base <ref>] [--recheck latest|<기록 경로>] [강조점]"
---
<!-- 생성 파일: $HOME/.agents/skills/qa/engine 의 소스를 고치고 node build.js 로 재생성. 직접 수정 금지 -->

# /qa : 브랜치 변경분 정적/런타임 QA (오케스트레이터)

당신은 이 세션의 메인 모델이고 QA 의 오케스트레이터다. 기계적인 일은 **스크립트**(`$HOME/.agents/skills/qa/engine/tools/*.js`, 무의존 node)가, 읽고 판단하는 일은 경량 워커가, 판정과 병합은 당신이 한다. 워커 띄우기: 같은 이름의 커스텀 에이전트(`$HOME/.codex/agents/<이름>.toml`)를 서브에이전트로 띄운다. 동시 스레드 상한(기본 6)을 넘는 fan-out 은 6개씩 배치. 워커에는 아래 "전달 묶음" 만 넘긴다.

**QA 는 발견만 낸다. 코드를 고치지 않는다.** 수정은 이 결과를 보고 사람이 따로 한다.

**QA 는 앱을 실제로 돌려 보는 일이다.** 코드 추적은 후보를 고르는 수단이고, 판정의 근거는 실행 결과다.
앱을 한 번도 안 띄운 실행은 PASS 를 낼 수 없다(`record.js` 가 막는다). 띄울 수 없으면 그 사실이 보고의 결론이다.

인자 `$ARGUMENTS`: `--tier light|full|max`, `--base <ref>`, `--recheck latest|<기록 경로>`, `--static`(검증용 정적 재실행), `--repo <경로>`(이 세션 폴더가 아닌 체크아웃이나 워크트리 대상), 나머지는 강조점(`focus`).

## 비용 규칙

메인 호출 하나가 메인 컨텍스트 전체를 다시 읽는다. 호출 수가 곧 비용이다(2026-10-21 재계산: 캐시읽기의 68% 가 메인).
- 아래 순서의 명령 말고는 Bash, Read 를 줄인다. 스크립트가 만든 파일을 통독하지 않고 stdout 만 읽는다.
- 워커 완료는 알림으로 받는다. TaskOutput 폴링, sleep 금지.
- 후보 확인 grep 은 여러 건을 한 Bash 에 묶는다.
- 메인이 TC 를 대신 돌리지 않는다. 직접 돌리면 tcs 가 안 남아 보고와 실제가 어긋난다(2026-09-17, 09-21 실측).

```
Q=$HOME/.agents/skills/qa/engine/tools/qa.js
```

## 1. start (Bash 1회)

`node $Q start $ARGUMENTS`

- `guard:` 가 찍히면 run 은 아직 없다. 사용자에게 한 번 묻는다(새 세션에서 / 여기서 계속). 계속이면 같은 인자에 `--here` 를 붙여 다시.
- `start: 중단 (기준 확인)` 이면 고른 기준 브랜치를 보여 주고 묻는다. 맞으면 `--base-ok`, 아니면 사용자가 정한 `--base`.
- `start: 중단 (프로필 없음)` 이면 부트스트랩: `qa-bootstrap` 에 템플릿(`$HOME/.agents/skills/qa/engine/templates/qa-profile.md`)을 채우게 하고 → `[질문]` 이 남은 것만 최대 5개 묻고 → `.claude/skills/qa-profile/SKILL.md` 로 저장(커밋은 사용자 몫) → start 다시. 거절하면 `--no-profile`(자동 탐색 모드).
- `scope: 실패` 면 멈추고 `--base` 를 요청한다.
- 티어는 tier 줄의 제안을 따르되, diff 를 보고 올릴 이유가 있으면 `--tier` 를 붙여 다시 start 하고 이유를 첫 줄에 1문장.
- `QA-RUN <id>` 줄은 그대로 둔다(토큰 계정의 기준점). 예측 줄을 보고 첫 줄에 쓴다.

## 2. p0 (Bash 1회)

`node $Q p0 <state.json>` : 검증 명령, context, blast, pack, 회귀 코퍼스, 런타임 기동, 사전 점검, 알려진 이슈 대조.

- `p0: BLOCKED` 면 워커를 띄우지 않고 5절로 간다(verdict BLOCKED, skipped 에 이유).
- 회귀 코퍼스 실패가 찍히면 과거 사고의 재발이다. 판정은 FAIL, 그 행이 발견 1번.
- 출력 끝의 `## 전달 묶음 (<워커>)` 블록을 **그대로** 각 워커 프롬프트로 쓴다. 손으로 다시 쓰지 않는다.

## 3. 페이즈 1: 탐색 워커 (한 메시지에 병렬)

| 티어 | 페이즈 1 | verify | 페이즈 2 | 후보 상한 |
|:---|:---|:---|:---|:---|
| skip | 없음(사유 1줄) | | | |
| light | qa-logic(앵글 A), qa-scenario(TC ≤3) | 없음 | qa-http | 4 |
| full | qa-logic, qa-scenario, 조건부 qa-security, 조건부 qa-upgrade | 선별 | qa-http, 조건부 qa-ui | 10 |
| max | full + security/upgrade 강제 | 선별 + sweep | 같음 | 15 |

- 띄울 워커는 p0 가 찍은 목록이다. 모두 끝나면 `node $Q collect <state.json> --phase p1` (Bash 1회). 후보표(C-01 부터)와 P2 전달 묶음이 나온다.
- `수집 실패: <워커>` 면 그 워커의 마지막 결과를 당신이 fields 에 직접 반영한다.
- `미검토 ... 보충` 이 찍히면 그 파일만 범위로 같은 워커를 1회 더(2회까지) 띄우고, 끝나면 collect p1 을 다시 부른다.
- 워커가 결과 없이 멈추면 **곧바로**(워커 캐시 수명 5분 안) SendMessage 로 "추가 탐색 없이 지금까지의 결과로 JSON 객체 하나만" 을 요청한다. 늦게 이어받으면 컨텍스트 전체를 다시 쓴다.

## 4. 선별 verify, 페이즈 2

- 후보마다 (1) 내 말로 재서술(못 하면 기각) (2) 브로카드(위협 모델 없음 / 필요 권한이 얻는 것 이상 / 실제 사용 밖 / 문서화된 동작 / 치료가 병보다 나쁨) (3) dedup(같은 파일, symbol 은 collect 가 이미 합침).
- full 이상: 남은 것 중 `important` 이상이거나 근거를 확인 못 한 것만 `qa-verify` 로(최대 4, 후보당 1개, 렌즈는 REACHABILITY, IMPACT, DEFENSES 중 쟁점에 맞게). 전달 묶음 = 레포 루트 + 후보 JSON 1건 + 렌즈 + 출력 형식 한 줄. 나머지는 당신 판정으로 확정한다.
- max: sweep = `qa-logic` 을 "검증된 목록을 받은 새 리뷰어, 소스를 먼저 읽고 목록은 나중에, 새 결함만 ≤8" 로 재호출.
- 페이즈 2(생략 불가, `--static` 은 없음): collect p1 이 찍은 `qa-http`, `qa-ui` 묶음으로 띄운다. verify 와 같은 메시지에 병렬로 띄워도 된다.
- 다 끝나면 `node $Q collect <state.json> --phase p2` (Bash 1회). TC 결과, P2 발견, verify 판정이 정리된다. `--static` 이면 collect p1 뒤 바로 5절.

## 5. 마무리: fields.json → finish

collect 가 찍은 경로에 fields.json 을 Write 1회로 쓴다.

```
{"verdict":"PASS|FAIL|BLOCKED|SKIP",
 "findings":[{"severity":"...","summary":"...","file":"...","symbol":"...","repro":"...","action":"제안: <어디를 어떻게>","tc_id":null}],
 "verify":[...],"coverage":{...},"manualMismatch":[...],"skipped":[...],
 "profile_suggestions":[{"section":"환경","key":"짧은-영문-slug","text":"프로필에 적을 문장","evidence":"근거","blocking":false}]}
```

- `tcs` 는 비워 두면 finish 가 TC 결과와 회귀 코퍼스로 채운다. 수집 실패한 실행 워커의 TC 만 직접 넣는다.
- `profile_suggestions` 의 key 는 collect 가 찍은 원장 key 중 같은 사실이 있으면 그것을 쓴다. 이번 실행을 막은 원인이면 `blocking: true`.
- 그다음 `node $Q finish <state.json> <fields.json>` (Bash 1회). 찍힌 보고를 **그대로** 사용자에게 보인다.

판정 `PASS | FAIL | BLOCKED | SKIP`, 부분 PASS 없음, 애매하면 FAIL.
**런타임 게이트**: `run` 이 http, ui, cli 인 TC 가 하나도 없으면 finish 가 PASS 를 BLOCKED 로 내린다. 런타임 표면이 정말 없는 변경이면 fields 에 `runtimeWaived: "<사유>"`. 사유 없이 우회하지 않는다. `--static` 은 자동으로 면제 사유가 붙는다.
발견의 `근거` 는 `tc_id` 가 있으면 실측, 없으면 추적이다. 발견 15건 상한(심각도 순). 증거, 실패 시나리오, 워커 원문은 기록 파일에만.
`action` 은 항상 제안이다. 고칠 곳과 방법을 한 줄로 적되 **고치지 않는다**.

보고 뒤에 이어서 할 것(각각 사용자에게 한 번씩만 묻는다):
- **프로필 반영 후보**: 보고에 이 블록이 있으면 묻고, 승인한 것만 프로필에 쓴 뒤 `node $HOME/.agents/skills/qa/engine/tools/ledger.js set <key> applied`. 거절은 `rejected`(다시 안 올라온다). 프로필이 '갱신 권장' 이면 바뀐 감시 경로를 보여 주고, 확인받은 뒤에만 baseCommit 을 HEAD 로 올린다.
- **알려진 이슈 등록**: 이번 발견 중 사용자가 '안 고침' 으로 고른 것은 프로필 `## 알려진 이슈` 에 행(ID, 파일, symbol, snippet 원문, 결정, 메모)으로 넣자고 제안한다.
- **회귀 코퍼스 적립**: 운영까지 샜을 결함이면 프로필 `## 회귀 코퍼스` 에 넣을 `REG-NN` 행을 제안한다(파이프 없는 한 줄 명령).

보고 꼬리의 시간/토큰 줄은 `finish` 가 세션 기록에서 응답 id 기준으로 실측한다. **신규** = 입력+캐시 생성+출력, **캐시읽기** = 호출마다 다시 읽은 누적 컨텍스트. 판정표의 `메인` 행에 시작 컨텍스트와 호출 수가 예산과 함께 나온다.

## 6. 재검증 (`--recheck`)

start 에 `--recheck latest|<기록 경로>`. 원 기록의 `result: fail` TC 만 `qa-http`/`qa-ui` 로 다시 돌린다. 시나리오를 새로 짜지 않는다. p0 가 P2 묶음을 바로 낸다. 보고 첫 줄에 `재검증(<원 기록 파일명>)`.

## 7. 하지 않는 것

**코드 수정**(발견만 낸다). 커밋, push, 브랜치 생성. 프로필 커밋. 보고에 워커 원문 붙이기. 스크립트가 만든 파일 통독. 후보 전수 verify. 워커 폴링.
**QA 가 띄우지 않은 서비스를 내리는 것**(`runtime-owned.json` 에 적힌 것만 내린다). DB 초기화, 시드, 마이그레이션 같은 파괴 명령. 남이 쓰는 포트 kill.

## 출력
이 절은 형식 검사용 표식이다. 보고 형식은 위 5절.
