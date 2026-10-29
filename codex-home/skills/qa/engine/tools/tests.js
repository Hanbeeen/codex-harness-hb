#!/usr/bin/env node
// tests.js : qa-tests 워커 대체. 프로필 "검증 명령" 표를 실행하고 exit, 꼬리, 소요, 상태를 기록.
// 사용: node tests.js --scope <scope.json> --profile <path> [--all] [--out <file>]
//  기본은 diff 가 닿은 서브시스템만 실행(--all 이면 전부).
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');

function firstBacktick(cell) { const m = (cell || '').match(/`([^`]+)`/); return m ? m[1] : null; }
function isSkip(cell) { return !cell || /^(없음|생략|-|)$/.test(cell.trim()) || !firstBacktick(cell); }
function isMutating(cmd) { return /--fix\b|--write\b/.test(cmd); }

function parseVerifyCommands(sectionText) {
  const rows = L.parseTable(sectionText);
  const cmds = [];
  for (const r of rows) {
    const sub = (r['서브시스템'] || '').trim(); if (!sub) continue;
    for (const col of ['테스트', '타입체크', '구문검사']) {
      if (isSkip(r[col])) continue;
      const cmd = firstBacktick(r[col]);
      if (isMutating(cmd)) continue;
      cmds.push({ subsystem: sub, kind: col, command: cmd });
    }
  }
  const flakyLine = sectionText.split('\n').find((l) => /flaky/i.test(l)) || '';
  const flaky = [...flakyLine.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return { cmds, flaky };
}

function failingTestFiles(output) {
  const set = new Set();
  for (const l of output.split('\n')) if (/✖|FAIL|×|failing|not ok|^\s*test at |^\s+at /.test(l)) for (const m of l.matchAll(/[\w./\\-]+\.(?:test|spec)\.[jt]sx?/g)) set.add(m[0].replace(/\\/g, '/'));
  return [...set];
}

function run(cmd, cwd, timeoutSec) {
  const t0 = Date.now();
  const r = L.spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
  const out = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
  return { exit: r.status === null ? (r.error ? 'error:' + r.error.code : -1) : r.status, seconds: Math.round((Date.now() - t0) / 1000), output: out };
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const m = L.loadManifest();
  const scope = L.readJson(args.scope);
  const root = L.repoRoot(process.cwd());
  const prof = L.parseProfile(fs.readFileSync(args.profile, 'utf8'));
  const { cmds, flaky } = parseVerifyCommands(prof.sections['검증 명령'] || '');
  const touched = new Set(scope.files.map((f) => f.path.split('/')[0]));
  const changedFiles = scope.files.map((f) => f.path);
  const runs = [];
  for (const c of cmds) {
    const subDir = path.join(root, c.subsystem);
    const cwd = fs.existsSync(subDir) ? subDir : root;
    if (!args.all && fs.existsSync(subDir) && !touched.has(c.subsystem)) { runs.push({ ...c, cwd: c.subsystem, status: 'skipped', reason: 'diff 가 이 서브시스템을 건드리지 않음' }); continue; }
    let command = c.command;
    if (/<변경 파일>/.test(command)) {
      const files = changedFiles.filter((p) => p.startsWith(c.subsystem + '/') && /\.[cm]?js$/.test(p)).map((p) => path.relative(c.subsystem, p).replace(/\\/g, '/'));
      if (!files.length) { runs.push({ ...c, cwd: c.subsystem, status: 'skipped', reason: '해당 서브시스템에 변경 JS 파일 없음' }); continue; }
      command = files.map((f) => command.replace('<변경 파일>', f)).join(' && ');
    }
    const r1 = run(command, cwd, m.tools.testTimeoutSec);
    const rec = { subsystem: c.subsystem, kind: c.kind, command, cwd: path.relative(root, cwd) || '.', exit: r1.exit, seconds: r1.seconds, tail: L.tail(r1.output, m.tools.tail), rerun: null, status: r1.exit === 0 ? 'pass' : 'fail', failingFiles: [] };
    if (r1.exit !== 0) {
      rec.failingFiles = failingTestFiles(r1.output);
      const knownFail = rec.failingFiles.length > 0 && rec.failingFiles.every((f) => flaky.some((g) => L.matchAny(f, [g]) || f.endsWith(g.replace(/^\*+\//, '')) || g.includes(path.basename(f).replace(/\..*$/, ''))));
      const touchedTests = rec.failingFiles.some((f) => changedFiles.some((p) => f.endsWith(p) || p.endsWith(f)));
      if (knownFail) rec.status = 'known-fail';
      else if (!touchedTests) {
        const r2 = run(command, cwd, m.tools.testTimeoutSec);
        rec.rerun = { exit: r2.exit, seconds: r2.seconds, tail: L.tail(r2.output, m.tools.tail) };
        rec.status = r2.exit === 0 ? 'flaky' : 'fail';
      }
    }
    runs.push(rec);
  }
  const overall = runs.some((r) => r.status === 'fail') ? 'fail' : 'pass';
  const result = { worker: 'tests.js', runs, overall, flakyList: flaky, generatedAt: L.nowIso() };
  const out = args.out || path.join(scope.runDir, 'tests.json');
  L.writeJson(out, result);
  const line = runs.map((r) => `${r.subsystem}/${r.kind}:${r.status}${r.seconds !== undefined ? '(' + r.seconds + 's)' : ''}`).join(', ');
  console.log(`tests: overall ${overall}, ${line} → ${out}`);
}

if (require.main === module) { try { main(); } catch (e) { console.log(`tests: 실패 (${e.message})`); } }
module.exports = { parseVerifyCommands, failingTestFiles, isMutating };
