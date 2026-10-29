#!/usr/bin/env node
// record.js : 실행 기록, 페이즈 타이머, 토큰 계정, 예측, 보고 렌더.
//  init    --scope <scope.json> --tier <tier.json> [--profile <상태>] [--id <id>]  → run.json 생성 + 예측 + 마커 출력
//  phase   <run.json> <name> start|end
//  agents  <run.json> add <worker> <agentId> [model]
//  merge   <run.json> <fields.json>                          → 최상위 필드 병합(findings, verdict, tcs, coverage 등)
//  account <run.json>                                        → 세션 기록에서 메인, 워커 토큰과 시간 합산
//  render  <run.json> [--out <md>]                           → 보고 마크다운
//  finish  <run.json>                                        → endedAt + account + render
//  recount [--root <dir>]                                    → 끝난 run 전부의 계정을 지금 규칙으로 다시 계산
//  estimate --tier <light|full|max> [--activate security,upgrade,ui]
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');

// 테스트가 실제 폴더를 건드리지 않게 환경변수로 바꿀 수 있다. 호출 시점에 읽는다.
function projectsRoot() { return process.env.QA_PROJECTS_ROOT ? path.resolve(process.env.QA_PROJECTS_ROOT) : L.expandHome('~/.claude/projects'); }
const ACCOUNT_VERSION = 2;
const MIN_SAMPLES = 3;

// ── 예측 ──────────────────────────────────────────────────────────────────
// 계정 v2(응답 id 기준 집계)만 쓴다. v1 은 내용 블록마다 사용량을 더해 2배 이상 부풀어 있다.
// BLOCKED 와 재검증 run 은 워커 구성이 정상 run 과 달라 예측을 낮게 끌어내리므로 뺀다.
function loadHistory(root = L.runsRoot()) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/^\d{8}-\d{6}\.json$/.test(e.name)) { try { const j = L.readJson(p); if (j.account && j.account.v === ACCOUNT_VERSION && j.tier && j.verdict !== 'BLOCKED' && !j.recheckFrom && !j.static) out.push(j); } catch {} } } };
  walk(root);
  return out;
}
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
// 표본이 MIN_SAMPLES 미만이면 시드값을 쓴다(1-2건의 우연한 값이 예측을 흔들지 않게).
function medianOrSeed(values, seed) { return values.length >= MIN_SAMPLES ? median(values) : seed; }
function plannedWorkers(tier, activate) {
  const t = (tier || '').split(' ')[0];
  if (t === 'skip') return { p0: [], p1: [], p15: [], p2: [] };
  const p1 = ['qa-logic', 'qa-scenario'];
  if (t !== 'light') { if (activate.security) p1.push('qa-security'); if (activate.upgrade) p1.push('qa-upgrade'); }
  const p2 = ['qa-http']; if (activate.ui) p2.push('qa-ui');
  return { p0: ['scripts'], p1, p15: t === 'light' ? [] : ['qa-verify'], p2 };
}
function estimate(manifest, tier, activate, history) {
  const t = (tier || 'full').split(' ')[0];
  const defaults = manifest.estimate.defaults[t] || manifest.estimate.defaults.full;
  const same = history.filter((h) => (h.tier || '').split(' ')[0] === t);
  const per = (w) => {
    const secs = same.map((h) => h.account?.workers?.[w]?.seconds).filter(Number.isFinite);
    const toks = same.map((h) => h.account?.workers?.[w]?.fresh).filter(Number.isFinite);
    return { seconds: medianOrSeed(secs, defaults[w]?.seconds ?? 300), fresh: medianOrSeed(toks, defaults[w]?.tokens ?? 120000), samples: secs.length };
  };
  const plan = plannedWorkers(t, activate);
  const scriptsSec = medianOrSeed(same.map((h) => h.phases?.p0?.seconds).filter(Number.isFinite), 90);
  const p1 = plan.p1.map(per), p2 = plan.p2.map(per);
  const verify = plan.p15.length ? per('qa-verify') : null;
  const verifyN = t === 'max' ? 4 : 2; // qa.md 의 선별 verify 상한(4)과 실측 평균
  // 메인 시간 시드는 '워커가 안 돌 때 메인 혼자 쓴 시간' 이다. 계정의 main.seconds 는 run 전체에 걸친 구간이라
  // 페이즈 합에 더하면 두 번 센다. 그래서 기록이 충분하면 합산 대신 run 전체 시간과 전체 신규 토큰의 중앙값을 쓴다.
  const phases = {
    p0: { seconds: scriptsSec, fresh: 0 },
    p1: { seconds: Math.max(0, ...p1.map((x) => x.seconds)), fresh: p1.reduce((s, x) => s + x.fresh, 0) },
    p15: verify ? { seconds: verify.seconds, fresh: verify.fresh * verifyN } : { seconds: 0, fresh: 0 },
    main: { seconds: defaults.main?.seconds ?? 300, fresh: defaults.main?.tokens ?? 0 },
    p2: { seconds: Math.max(0, ...p2.map((x) => x.seconds)), fresh: p2.reduce((s, x) => s + x.fresh, 0) },
  };
  const totalSec = medianOrSeed(same.map((h) => h.phases?.total?.seconds).filter(Number.isFinite), Object.values(phases).reduce((s, p) => s + p.seconds, 0));
  const totalFresh = medianOrSeed(same.map((h) => h.account?.totals?.fresh).filter(Number.isFinite), Object.values(phases).reduce((s, p) => s + p.fresh, 0));
  const samples = Math.min(...[...p1, ...p2].map((x) => x.samples), same.length);
  return { tier: t, workers: plan, phases, totalSeconds: totalSec, range: [Math.round(totalSec * 0.65), Math.round(totalSec * 1.35)], totalFresh, samples: Number.isFinite(samples) ? samples : 0, basis: same.length >= MIN_SAMPLES ? `기록 ${same.length}건 중앙값` : `표본 부족(${same.length}건) → 시드 기본값` };
}
function fmtMin(s) { return s < 120 ? `${s}초` : `${Math.round(s / 60)}분`; }
function fmtTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }

// ── 계정 ──────────────────────────────────────────────────────────────────
function* jsonlEntries(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { yield JSON.parse(line); } catch {} }
}
function findSessionById(sid) {
  if (!sid || !fs.existsSync(projectsRoot())) return null;
  for (const proj of fs.readdirSync(projectsRoot())) { const p = path.join(projectsRoot(), proj, `${sid}.jsonl`); if (fs.existsSync(p)) return p; }
  return null;
}
function findSessionByMarker(marker, sinceMs) {
  if (!fs.existsSync(projectsRoot())) return null;
  const cands = [];
  for (const proj of fs.readdirSync(projectsRoot())) {
    const pd = path.join(projectsRoot(), proj);
    if (!fs.statSync(pd).isDirectory()) continue;
    for (const f of fs.readdirSync(pd)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(pd, f); const st = fs.statSync(fp);
      if (st.mtimeMs < sinceMs - 60_000) continue;
      cands.push({ fp, mtime: st.mtimeMs });
    }
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  for (const c of cands) { if (fs.readFileSync(c.fp, 'utf8').includes(marker)) return c.fp; }
  return null;
}
// 세션 찾기: 기록된 경로 → 지금 세션 id(CLAUDE_CODE_SESSION_ID) → 마커 문자열 검색 순.
function sessionFileFor(run, marker) {
  if (run.sessionFile && fs.existsSync(run.sessionFile)) return run.sessionFile;
  const byId = findSessionById(process.env.CLAUDE_CODE_SESSION_ID);
  if (byId && fs.readFileSync(byId, 'utf8').includes(marker)) return byId;
  return findSessionByMarker(marker, Date.parse(run.startedAt));
}

// 세션 기록은 응답 하나를 내용 블록(thinking, 도구 호출, 텍스트)마다 한 줄씩 쓰고 줄마다 같은 usage 를 붙인다.
// 줄마다 더하면 2배 이상 부푼다(2026-10-21 실측: 신규 2.4배, 캐시읽기 2.1배). 응답 id 로 묶어 한 번만 센다.
// 입력, 캐시 생성, 캐시 읽기는 같은 id 안에서 같고, 출력은 스트리밍 중 늘어나므로 최댓값을 쓴다.
function sumUsage(entries, fromTs, toTs) {
  const byId = new Map();
  let i = 0;
  for (const e of entries) {
    i++;
    if (e.type !== 'assistant' || !e.message?.usage) continue;
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (fromTs && ts && ts < fromTs) continue;
    if (toTs && ts && ts > toTs) continue;
    const id = e.message.id || e.uuid || `idx-${i}`;
    const u = e.message.usage;
    const p = byId.get(id);
    if (!p) byId.set(id, { input: u.input_tokens || 0, cc: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0, model: e.message.model || null, t0: ts, t1: ts });
    else { p.out = Math.max(p.out, u.output_tokens || 0); if (ts) { p.t0 = p.t0 ? Math.min(p.t0, ts) : ts; p.t1 = p.t1 ? Math.max(p.t1, ts) : ts; } }
  }
  const acc = { input: 0, cache_creation: 0, cache_read: 0, output: 0, calls: 0, models: {}, first: null, last: null, ctxStart: null };
  for (const p of byId.values()) {
    acc.input += p.input; acc.cache_creation += p.cc; acc.cache_read += p.cr; acc.output += p.out; acc.calls++;
    if (acc.ctxStart === null) acc.ctxStart = p.input + p.cc + p.cr;
    if (p.model) acc.models[p.model] = (acc.models[p.model] || 0) + 1;
    if (p.t0) acc.first = acc.first ? Math.min(acc.first, p.t0) : p.t0;
    if (p.t1) acc.last = acc.last ? Math.max(acc.last, p.t1) : p.t1;
  }
  acc.turns = acc.calls; // 옛 필드 이름 호환
  acc.fresh = acc.input + acc.cache_creation + acc.output;
  acc.seconds = acc.first && acc.last ? Math.round((acc.last - acc.first) / 1000) : null;
  acc.model = Object.entries(acc.models).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return acc;
}

// 이 run 의 워커 찾기: 등록 목록(run.agents) ∪ subagents/*.meta.json 중 qa- 워커이면서 run 구간에 시작한 것.
// 등록을 빠뜨린 워커가 계정에서 사라지던 것을 막는다(090905: Agent 9회 호출, 계정 4개).
function discoverWorkers(subDir, run, fromTs, toTs) {
  const found = new Map();
  for (const a of run.agents || []) found.set(a.agentId, { name: a.worker, model: a.model || null });
  if (!fs.existsSync(subDir)) return found;
  for (const f of fs.readdirSync(subDir)) {
    const m = f.match(/^agent-(.+)\.meta\.json$/); if (!m) continue;
    const id = m[1]; if (found.has(id)) continue;
    let meta; try { meta = L.readJson(path.join(subDir, f)); } catch { continue; }
    const type = meta.agentType || '';
    if (!type.startsWith('qa-')) continue;
    const jf = path.join(subDir, `agent-${id}.jsonl`); if (!fs.existsSync(jf)) continue;
    const first = fs.readFileSync(jf, 'utf8').split('\n').find((l) => l.includes('"timestamp"'));
    const ts = first ? Date.parse((first.match(/"timestamp":"([^"]+)"/) || [])[1]) : NaN;
    if (!Number.isFinite(ts) || ts < fromTs - 5_000 || (toTs && ts > toTs)) continue;
    found.set(id, { name: type, model: null });
  }
  return found;
}

function account(run) {
  const marker = `QA-RUN ${run.id}`;
  const session = sessionFileFor(run, marker);
  if (!session) return { reason: '마커가 든 세션 기록을 찾지 못함(메인이 init 의 마커 줄을 출력했는지 확인)' };
  run.sessionFile = session;
  const entries = [...jsonlEntries(session)];
  const markerEntry = entries.find((e) => JSON.stringify(e).includes(marker));
  const fromTs = markerEntry?.timestamp ? Date.parse(markerEntry.timestamp) : Date.parse(run.startedAt);
  const toTs = run.endedAt ? Date.parse(run.endedAt) + 5_000 : null;
  const main = sumUsage(entries, fromTs, toTs);
  const subDir = path.join(session.replace(/\.jsonl$/, ''), 'subagents');
  const found = discoverWorkers(subDir, run, fromTs, toTs);
  // 등록도 meta 도 없던 옛 기록: 마커 이후 본문에 나온 agentId 로 찾는다
  if (!found.size) for (const e of entries) { const ts = e.timestamp ? Date.parse(e.timestamp) : null; if (ts && ts < fromTs) continue; for (const m of JSON.stringify(e).matchAll(/"agentId":"(a[0-9a-f]{8,})"/g)) found.set(m[1], { name: null, model: null }); }
  const workers = {};
  for (const [id, reg] of found) {
    const f = path.join(subDir, `agent-${id}.jsonl`); if (!fs.existsSync(f)) continue;
    let name = reg.name;
    if (!name) { const meta = path.join(subDir, `agent-${id}.meta.json`); if (fs.existsSync(meta)) { try { const mj = L.readJson(meta); name = mj.agentType || mj.name || mj.description || null; } catch {} } }
    name = name || id;
    const u = sumUsage([...jsonlEntries(f)]);
    const key = workers[name] ? `${name}#${Object.keys(workers).filter((k) => k.startsWith(name)).length + 1}` : name;
    workers[key] = { agentId: id, model: reg.model || u.model, calls: u.calls, turns: u.calls, input: u.input, cache_creation: u.cache_creation, cache_read: u.cache_read, output: u.output, fresh: u.fresh, seconds: u.seconds };
  }
  const tot = { fresh: main.fresh, cache_read: main.cache_read, output: main.output, calls: main.calls };
  for (const w of Object.values(workers)) { tot.fresh += w.fresh; tot.cache_read += w.cache_read; tot.output += w.output; tot.calls += w.calls; }
  tot.turns = tot.calls;
  return { v: ACCOUNT_VERSION, main: { model: main.model, calls: main.calls, turns: main.calls, input: main.input, cache_creation: main.cache_creation, cache_read: main.cache_read, output: main.output, fresh: main.fresh, seconds: main.seconds, ctxStart: main.ctxStart }, workers, totals: tot, sessionFile: session };
}

// ── 렌더 ──────────────────────────────────────────────────────────────────
function phaseLine(run) {
  const ph = run.phases || {};
  const parts = Object.entries(ph).map(([k, v]) => `${k} ${v.seconds != null ? fmtMin(v.seconds) : '-'}`);
  const total = run.endedAt && run.startedAt ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000) : null;
  const est = run.estimate ? ` (예측 ${fmtMin(run.estimate.range[0])}-${fmtMin(run.estimate.range[1])})` : '';
  return `시간: ${parts.join(', ')}${total != null ? `, 총 ${fmtMin(total)}` : ''}${est}`;
}
function tokenLine(run) {
  const a = run.account; if (!a || a.reason) return `토큰: 계정 실패(${a?.reason || '없음'})`;
  const calls = (x) => x.calls ?? x.turns;
  const w = Object.entries(a.workers).map(([n, v]) => `${n}(${(v.model || '').replace('claude-', '')} ${calls(v)}회 ${fmtTok(v.fresh)}+캐시읽기 ${fmtTok(v.cache_read)})`).join(', ');
  const estTok = run.estimate ? ` (예측 신규 ${fmtTok(run.estimate.totalFresh)})` : '';
  return `토큰: 신규 ${fmtTok(a.totals.fresh)}, 캐시읽기 ${fmtTok(a.totals.cache_read)}, 출력 ${fmtTok(a.totals.output)}, 호출 ${calls(a.totals)}${estTok}\n  메인 ${calls(a.main)}회 신규 ${fmtTok(a.main.fresh)}, ${w || '워커 없음'}`;
}
// TC 의 실행 수단. 옛 기록은 '실행', 새 워커 출력은 'run' 필드를 쓴다.
function tcRun(t) { return String(t.실행 || t.run || t.kind || '').toLowerCase(); }
// 런타임 게이트 : 실제로 앱을 돌린 TC 가 하나도 없으면 PASS 를 낼 수 없다.
// /qa 의 목적이 런타임 QA 인데 정적 추적만으로 PASS 가 나가던 구멍을 여기서 막는다(2026-09-21).
// 런타임 표면이 정말 없는 변경(순수 라이브러리 정리 등)은 merge 의 runtimeWaived 에 사유를 적으면 통과한다.
function runtimeGate(run) {
  const tcs = run.tcs || [];
  const ran = tcs.filter((t) => t && t.result && t.result !== 'skipped' && ['http', 'ui', 'cli'].includes(tcRun(t)));
  const nodeOnly = tcs.filter((t) => t && t.result && t.result !== 'skipped').length - ran.length;
  const waived = (run.runtimeWaived || '').trim();
  const blocked = run.verdict === 'PASS' && ran.length === 0 && run.tier !== 'skip' && !waived;
  return { ran: ran.length, nodeOnly, waived, blocked };
}

// 보고는 사람이 훑는 화면이다. 한 줄에 여러 항목을 이어 붙이면 글자 수는 줄어도 못 읽는다
// (2026-09-21 실측: 세 항목을 한 줄에 이은 것이 화면 4줄로 접혀 뭉갬).
// 규칙 세 가지: 블록마다 소제목, 나열은 한 항목 한 줄, 발견은 표가 아니라 블록(열이 7개면 표가 깨진다).
const bullets = (title, arr, limit = 8) => {
  if (!arr || !arr.length) return [];
  const out = ['', `### ${title}`, ''];
  for (const x of arr.slice(0, limit)) out.push(`- ${String(typeof x === 'object' && x ? (x.text || JSON.stringify(x)) : x).replace(/\n+/g, ' ')}`);
  if (arr.length > limit) out.push(`- (외 ${arr.length - limit}건은 기록 파일에)`);
  return out;
};

function render(run, manifest = L.loadManifest()) {
  const f = run.findings || [];
  const cov = run.coverage || {};
  const g = runtimeGate(run);
  const verdict = g.blocked ? 'BLOCKED' : (run.verdict || '미기록');
  const md = [];

  md.push(`## QA: ${run.branch}`, '');
  md.push(`\`BASE ${(run.base || '').slice(0, 8)}\`, ${run.commits ?? '?'} 커밋${run.uncommitted ? ' + 미커밋' : ''}, 티어 ${run.tier}${run.tierReason ? ` (${run.tierReason})` : ''}, 프로필 ${run.profileStatus || '?'}${run.static ? ', 정적 재실행' : ''}`, '');

  md.push(`### 판정: ${verdict}`, '');
  md.push('| | |', '|:---|:---|');
  md.push(`| 런타임 실행 | ${g.ran}건${g.nodeOnly ? ` (그 외 함수 단위 ${g.nodeOnly}건)` : ''}${g.waived ? `, 면제: ${g.waived}` : ''} |`);
  md.push(`| 커버리지 | 워커 ${cov.workers ?? Object.keys(run.account?.workers || {}).length}, TC ${cov.tcs ?? (run.tcs || []).length}, probe ${cov.probes ?? 0} |`);
  md.push(`| 후보 | ${cov.candidates ?? f.length} → 생존 ${cov.survived ?? f.filter((x) => x.verdict !== 'REFUTED').length} |`);
  const am = run.account?.main;
  if (am && !run.account.reason) {
    const budget = manifest.budget?.[String(run.tier || '').split(' ')[0]];
    const calls = am.calls ?? am.turns;
    md.push(`| 메인 | 시작 컨텍스트 ${am.ctxStart != null ? fmtTok(am.ctxStart) : '?'}, 호출 ${calls}회${budget ? ` (예산 ${budget}${calls > budget ? ', 초과' : ''})` : ''} |`);
  }
  if (run.known) md.push(`| 알려진 이슈 | 억제 ${run.known.suppressed ?? 0}건, 재평가 ${run.known.reeval ?? 0}건${run.known.stale ? `, 코드에서 사라짐 ${run.known.stale}건` : ''} |`);
  if (g.blocked) md.push('', '> 앱을 한 번도 돌리지 않아 PASS 를 낼 수 없다. 런타임 표면이 없는 변경이면 `runtimeWaived` 에 사유를 적는다.');

  // 발견: 건마다 블록. 1행 = 번호, 심각도, 근거, 위치. 2행 = 요약. 그 아래 재현과 제안.
  const sev = { critical: 0, important: 1, minor: 2 };
  const sorted = [...f].sort((a, b) => (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3)).slice(0, 15);
  md.push('', `### 발견${f.length ? ` ${f.length}건` : ' 없음'}`, '');
  sorted.forEach((x, i) => {
    const where = [x.file, x.symbol].filter(Boolean).map((s) => `\`${s}\``).join(' ');
    md.push(`**${i + 1}. ${x.severity}**, ${x.tc_id ? '실측' : '추적'}, ${where}`, '');
    md.push(x.summary, '');
    if (x.repro || x.tc_id) md.push(`- 재현: ${String(x.repro || x.tc_id).replace(/\n+/g, ' ')}`);
    md.push(`- ${x.action || '제안 없음'}`, '');
  });
  if (f.length > sorted.length) md.push(`(외 ${f.length - sorted.length}건은 기록 파일에)`, '');

  // TC 결과: 실행 수단과 결과를 한눈에. 이 표가 런타임 게이트의 근거이기도 하다.
  const tcs = (run.tcs || []).filter((t) => t && (t.tc_id || t.id || t.목적));
  if (tcs.length) {
    md.push('', `### TC ${tcs.length}건`, '');
    md.push('| TC | 실행 | 결과 | 메모 |', '|:---|:---|:---|:---|');
    for (const t of tcs.slice(0, 20)) {
      md.push(`| ${t.tc_id || t.id || '-'} | ${tcRun(t) || '-'} | ${t.result || '-'} | ${String(t.note || t.목적 || t.expect || '').replace(/\n+/g, ' ').replace(/\|/g, '/').slice(0, 90)} |`);
    }
    if (tcs.length > 20) md.push(`| ... | | | 외 ${tcs.length - 20}건은 기록 파일에 |`);
  }

  md.push(...bullets('매뉴얼 불일치', run.manualMismatch));
  md.push(...bullets('실행 안 한 것', run.skipped, 12));
  if (run.suggestCandidates) md.push(...bullets('프로필 반영 후보(승인하면 프로필에 적용)', run.suggestCandidates));
  else md.push(...bullets('프로필 갱신 제안', run.profile_suggestions));

  md.push('', '---', '');
  md.push(phaseLine(run), '');
  md.push(tokenLine(run), '');
  md.push(`기록: \`${run.path}\``);
  return md.join('\n') + '\n';
}

// ── 재계산 ────────────────────────────────────────────────────────────────
// 끝난 run 만 다시 센다. endedAt 이 없는 run 은 다른 세션이 진행 중일 수 있어 건드리지 않는다.
function recount(root) {
  const rows = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/^\d{8}-\d{6}\.json$/.test(e.name)) rows.push(p); } };
  if (fs.existsSync(root)) walk(root);
  const report = [];
  for (const p of rows.sort()) {
    let run; try { run = L.readJson(p); } catch { continue; }
    if (!run.id || !run.account) continue;
    if (!run.endedAt) { report.push(`${run.id}: 진행 중이라 건너뜀`); continue; }
    const before = run.accountV1 || run.account;
    const next = account(run);
    if (next.reason) { report.push(`${run.id}: 건너뜀(${next.reason})`); continue; }
    // 옛 계정에 있던 워커의 기록 파일이 지금은 지워졌으면 다시 세면 워커가 통째로 빠진다. 옛 값을 둔다.
    const subDir = path.join(next.sessionFile.replace(/\.jsonl$/, ''), 'subagents');
    const gone = Object.values(before.workers || {}).filter((w) => w.agentId && !fs.existsSync(path.join(subDir, `agent-${w.agentId}.jsonl`)));
    if (gone.length) { report.push(`${run.id}: 건너뜀(워커 기록 ${gone.length}개가 지워져 다시 셀 수 없음. 옛 계정 유지)`); continue; }
    if (!run.accountV1 && run.account.v !== ACCOUNT_VERSION) run.accountV1 = run.account;
    run.account = next;
    L.writeJson(p, run);
    const bt = before.totals || {};
    report.push(`${run.id}: 신규 ${fmtTok(bt.fresh || 0)} → ${fmtTok(next.totals.fresh)}, 캐시읽기 ${fmtTok(bt.cache_read || 0)} → ${fmtTok(next.totals.cache_read)}, 호출 ${bt.turns ?? '?'} → ${next.totals.calls}`);
  }
  return report;
}

// ── 명령 ──────────────────────────────────────────────────────────────────
function save(run) { L.writeJson(run.path, run); }
function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const [cmd, a1, a2, a3, a4, a5] = args._;
  const manifest = L.loadManifest();
  if (cmd === 'estimate') {
    const act = Object.fromEntries((args.activate || '').split(',').filter(Boolean).map((k) => [k, true]));
    const e = estimate(manifest, args.tier || 'full', act, loadHistory());
    console.log(`예측(${e.tier}): ${fmtMin(e.range[0])}-${fmtMin(e.range[1])} (중앙 ${fmtMin(e.totalSeconds)}), 신규 토큰 약 ${fmtTok(e.totalFresh)}, ${e.basis}`);
    for (const [k, v] of Object.entries(e.phases)) console.log(`  ${k}: ${fmtMin(v.seconds)}, ${fmtTok(v.fresh)}`);
    return;
  }
  if (cmd === 'recount') {
    const lines = recount(args.root ? path.resolve(args.root) : L.runsRoot());
    for (const l of lines) console.log(l);
    console.log(`recount: ${lines.length}건 처리`);
    return;
  }
  if (cmd === 'init') {
    const scope = L.readJson(args.scope); const tier = args.tier ? L.readJson(args.tier) : { tier: 'full', activate: {}, reasons: [] };
    const id = args.id || L.stamp();
    const root = L.repoRoot(process.cwd());
    const run = { id, path: path.join(scope.runDir, `${id}.json`), startedAt: L.nowIso(), endedAt: null, repo: L.repoKey(root), branch: scope.branch, base: scope.base, head: scope.head, commits: scope.commits.length, uncommitted: scope.uncommitted, tier: tier.tier, tierReason: (tier.reasons || [])[0] || '', activate: tier.activate, profileStatus: args.profile || null, phases: {}, agents: [], findings: [], tcs: [], fixes: [], verify: [], coverage: {}, profile_suggestions: [], verdict: null };
    run.estimate = estimate(manifest, run.tier, run.activate || {}, loadHistory());
    save(run);
    console.log(`QA-RUN ${id}`);
    console.log(`run.json: ${run.path}`);
    console.log(`예측: ${fmtMin(run.estimate.range[0])}-${fmtMin(run.estimate.range[1])}, 신규 토큰 약 ${fmtTok(run.estimate.totalFresh)}, ${run.estimate.basis}`);
    return;
  }
  const run = L.readJson(a1); run.path = a1;
  if (cmd === 'phase') {
    const ph = (run.phases[a2] ||= {}); const now = L.nowIso();
    if (a3 === 'start') ph.startedAt = now; else { ph.endedAt = now; if (ph.startedAt) ph.seconds = Math.round((Date.parse(now) - Date.parse(ph.startedAt)) / 1000); }
    save(run); console.log(`phase ${a2} ${a3}${ph.seconds != null ? ` (${ph.seconds}s)` : ''}`); return;
  }
  if (cmd === 'agents') { run.agents.push({ worker: a3, agentId: a4, model: a5 || null }); save(run); console.log(`agents: ${a3} ← ${a4}`); return; }
  if (cmd === 'merge') { const patch = L.readJson(a2); Object.assign(run, patch); save(run); console.log(`merge: ${Object.keys(patch).join(', ')}`); return; }
  if (cmd === 'account') { run.account = account(run); save(run); console.log(run.account.reason ? `account: 실패 (${run.account.reason})` : tokenLine(run)); return; }
  if (cmd === 'render') { const md = render(run, manifest); const out = args.out || run.path.replace(/\.json$/, '.md'); L.writeText(out, md); console.log(md); return; }
  if (cmd === 'finish') {
    run.endedAt = L.nowIso();
    if (run.phases.total === undefined) run.phases.total = { seconds: Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000) };
    const gate = runtimeGate(run);
    if (gate.blocked) { run.verdictRequested = run.verdict; run.verdict = 'BLOCKED'; run.blockedReason = '런타임 TC 0건. 앱을 돌리지 않은 QA'; }
    run.runtimeGate = gate;
    run.account = account(run); save(run);
    const md = render(run, manifest); L.writeText(run.path.replace(/\.json$/, '.md'), md); console.log(md); return;
  }
  console.log('사용: record.js init|phase|agents|merge|account|render|finish|recount|estimate');
}

if (require.main === module) { try { main(); } catch (e) { console.log(`record: 실패 (${e.message})`); } }
module.exports = { estimate, sumUsage, render, plannedWorkers, median, medianOrSeed, runtimeGate, account, discoverWorkers, findSessionById, recount, loadHistory, tcRun, ACCOUNT_VERSION };
