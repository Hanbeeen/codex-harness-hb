#!/usr/bin/env node
// corpus.js : 회귀 코퍼스 실행. 운영에서 한 번이라도 샌 결함을 diff 와 무관하게 매 실행 다시 확인한다.
//
// 왜 diff 와 무관한가: 변경분만 보는 QA 는 "이번에 안 건드린 곳이 이번 변경 때문에 깨지는" 경우를 못 본다.
// 실제 사고는 대부분 예전에 한 번 샜던 자리에서 모양만 바꿔 다시 샌다. 업계에서 escaped defect feedback
// loop 라고 부르는 것이 이것이고, 사후분석의 실행 항목 중 가장 효과가 큰 한 줄이 "회귀 테스트 추가" 다.
//
// 프로필 `## 회귀 코퍼스` 표(열 이름으로 읽고, 없으면 순서로):
//   | ID | 사고 | 무엇이 샜나 | 검증 | 실행 |
//   | REG-01 | 2026-09-01 BD 이름 연속공백 | 이름 검증 부재 | `cd backend && node -e "..."` | node |
//   검증 칸은 셸 명령이고 exit 0 이면 pass. 실행 칸은 http, ui, cli, node (런타임 게이트의 입력).
//
// 사용:
//   corpus.js run  --profile <P> [--out <tcs.json>]   전부 실행하고 tcs 모양 JSON 을 낸다
//   corpus.js list --profile <P>                       실행 없이 목록만
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const L = require('./lib.js');
const R = require('./runtime.js');

const SECTION = '회귀 코퍼스';
const TIMEOUT_MS = 180000;

function parseCorpus(profilePath) {
  if (!profilePath || !fs.existsSync(profilePath)) return null;
  const sec = L.parseProfile(fs.readFileSync(profilePath, 'utf8')).sections[SECTION];
  if (!sec) return null;
  const unq = (s) => String(s || '').trim().replace(/^`|`$/g, '').trim();
  const rows = R.parseTableEscaped(sec).map((r) => {
    const v = Object.values(r);
    return {
      tc_id: unq(r['ID'] ?? v[0]),
      사고: unq(r['사고'] ?? v[1]),
      샌것: unq(r['무엇이 샜나'] ?? v[2]),
      cmd: unq(r['검증'] ?? v[3]),
      실행: (unq(r['실행'] ?? v[4]) || 'node').toLowerCase(),
    };
  }).filter((x) => /^REG-/i.test(x.tc_id) && x.cmd && !/^\[질문\]/.test(x.cmd));
  return rows.length ? rows : null;
}

function runOne(row, cwd) {
  const t0 = Date.now();
  const r = spawnSync(row.cmd, { cwd, shell: R.SHELL, timeout: TIMEOUT_MS, encoding: 'utf8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  return {
    tc_id: row.tc_id,
    실행: row.실행,
    result: r.status === 0 ? 'pass' : 'fail',
    note: `${row.사고} (${row.샌것})`,
    seconds: Math.round((Date.now() - t0) / 1000),
    evidence: r.status === 0 ? '' : L.tail(out.trim(), 20),
  };
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const cwd = L.repoRoot(process.cwd());
  const rows = parseCorpus(args.profile);
  if (!rows) {
    console.log(`corpus: 실패 (프로필에 '## ${SECTION}' 절 없음). 운영에서 샌 결함마다 한 행씩 적으면 매 실행 상시 확인한다.`);
    return;
  }
  if (cmd === 'list') {
    console.log(`corpus: ${rows.length}건`);
    for (const r of rows) console.log(`  ${r.tc_id} ${r.사고}`);
    return;
  }
  const results = rows.map((r) => runOne(r, cwd));
  const failed = results.filter((x) => x.result === 'fail');
  if (args.out) L.writeJson(args.out, results);
  console.log(`corpus: ${results.length}건 실행, pass ${results.length - failed.length}, fail ${failed.length}`);
  for (const x of failed) console.log(`  FAIL ${x.tc_id} ${x.note}`);
  if (failed.length) console.log('회귀 코퍼스 실패는 과거 사고의 재발이다. 판정은 FAIL 로 간다.');
  if (args.out) console.log(`corpus tcs: ${args.out}`);
}

if (require.main === module) { try { main(); } catch (e) { console.log(`corpus: 실패 (${e.message})`); } }
module.exports = { parseCorpus, SECTION };
