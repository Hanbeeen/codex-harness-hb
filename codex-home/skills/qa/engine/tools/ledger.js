#!/usr/bin/env node
// ledger.js : 프로필 제안 원장. run 마다 나오는 '프로필에 이것을 적자' 제안을 key 로 묶어 쌓는다.
// 2026-09 부터 12회에 31건이 제안됐는데 프로필 반영은 0건이었고, 같은 환경 사실을 워커가 매번 다시 알아냈다.
// 원장은 레포 밖 <runsRoot>/<레포 키>/suggestions.json 에 둔다. 프로필이 untracked 라 워크트리에는 없기 때문이다.
//   update <run.json>                  run 의 profile_suggestions 를 원장에 반영하고 반영 후보를 run 에 적는다
//   list   [--all]                     열린(open) 제안을 횟수 순으로
//   set    <key> applied|rejected|open 상태 바꾸기(승인 후 프로필에 반영했으면 applied)
//   import <json>                      { key: {section, text, runs[]} } 를 한꺼번에 넣는다(과거 기록 이관용)
// 제안 형식: { section, key, text, evidence } 객체. 문자열이면 key 를 'legacy-<해시>' 로 붙인다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./lib.js');

const FILE = 'suggestions.json';
const CANDIDATE_MIN_COUNT = 2;

function ledgerPath(dir) { return path.join(dir, FILE); }
function load(dir) { const p = ledgerPath(dir); return fs.existsSync(p) ? L.readJson(p) : {}; }
function save(dir, data) { return L.writeJson(ledgerPath(dir), data); }

function normalize(s) {
  if (s && typeof s === 'object') return { section: s.section || '', key: s.key || legacyKey(s.text || ''), text: s.text || '', evidence: s.evidence || '', blocking: !!s.blocking };
  return { section: '', key: legacyKey(String(s)), text: String(s), evidence: '', blocking: false };
}
function legacyKey(text) { return 'legacy-' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 8); }

// 반영 후보: 열린 제안 중 2회 이상 나왔거나, 이번 실행을 막은 원인(blocking)인 것
function upsert(data, suggestions, runId, today) {
  const touched = [];
  for (const raw of suggestions || []) {
    const s = normalize(raw);
    const e = data[s.key] || { section: s.section, text: s.text, count: 0, firstSeen: today, lastSeen: today, runs: [], status: 'open' };
    if (!e.runs.includes(runId)) { e.runs.push(runId); e.count++; }
    e.lastSeen = today; if (s.text) e.text = s.text; if (s.section) e.section = s.section;
    if (s.blocking) e.blocking = true;
    data[s.key] = e; touched.push(s.key);
  }
  return touched;
}
function candidates(data) {
  return Object.entries(data)
    .filter(([, e]) => e.status === 'open' && (e.count >= CANDIDATE_MIN_COUNT || e.blocking))
    .sort((a, b) => b[1].count - a[1].count)
    .map(([k, e]) => ({ key: k, section: e.section, count: e.count, text: e.text }));
}
function fmt(c) { return `[${c.key}] ${c.section ? c.section + ': ' : ''}${c.text} (${c.count}회)`; }

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const [cmd, a1, a2] = args._;
  const dir = args.dir ? path.resolve(args.dir) : L.repoRunsDir(L.repoRoot(process.cwd()));
  const data = load(dir);
  if (cmd === 'update') {
    const run = L.readJson(a1);
    const touched = upsert(data, run.profile_suggestions, run.id, L.nowIso().slice(0, 10));
    save(dir, data);
    run.suggestCandidates = candidates(data).map(fmt);
    L.writeJson(a1, run);
    console.log(`ledger: 이번 제안 ${touched.length}건 반영, 반영 후보 ${run.suggestCandidates.length}건 → ${ledgerPath(dir)}`);
    for (const c of run.suggestCandidates) console.log(`  ${c}`);
    return;
  }
  if (cmd === 'list') {
    const rows = Object.entries(data).filter(([, e]) => args.all || e.status === 'open').sort((a, b) => b[1].count - a[1].count);
    for (const [k, e] of rows) console.log(`${e.status.padEnd(8)} ${String(e.count).padStart(2)}회 [${k}] ${e.section ? e.section + ': ' : ''}${e.text}`);
    console.log(`ledger: ${rows.length}건 (${ledgerPath(dir)})`);
    return;
  }
  if (cmd === 'set') {
    if (!data[a1]) { console.log(`ledger: 실패 (key 없음: ${a1})`); return; }
    if (!['applied', 'rejected', 'open'].includes(a2)) { console.log('ledger: 실패 (상태는 applied|rejected|open)'); return; }
    data[a1].status = a2; data[a1].changedAt = L.nowIso().slice(0, 10); save(dir, data);
    console.log(`ledger: ${a1} → ${a2}`);
    return;
  }
  if (cmd === 'import') {
    const src = L.readJson(a1); let n = 0;
    for (const [k, e] of Object.entries(src)) {
      const cur = data[k] || { section: e.section || '', text: e.text || '', count: 0, firstSeen: e.firstSeen || L.nowIso().slice(0, 10), lastSeen: e.lastSeen || L.nowIso().slice(0, 10), runs: [], status: e.status || 'open' };
      for (const r of e.runs || []) if (!cur.runs.includes(r)) { cur.runs.push(r); cur.count++; }
      if (e.text) cur.text = e.text; if (e.section) cur.section = e.section; if (e.status) cur.status = e.status;
      data[k] = cur; n++;
    }
    save(dir, data);
    console.log(`ledger: ${n}개 key 이관 → ${ledgerPath(dir)}`);
    return;
  }
  console.log('사용: ledger.js update <run.json> | list [--all] | set <key> <상태> | import <json> [--dir <d>]');
}

if (require.main === module) { try { main(); } catch (e) { console.log(`ledger: 실패 (${e.message})`); } }
module.exports = { upsert, candidates, normalize, legacyKey, load, save, ledgerPath, CANDIDATE_MIN_COUNT };
