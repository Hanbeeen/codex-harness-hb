#!/usr/bin/env node
// qa.js : /qa 진입 스크립트. 메인이 부르던 스크립트 17번 안팎을 명령 4개로 묶는다.
// 메인 호출 하나하나가 메인 컨텍스트 전체를 다시 읽으므로, 호출 수가 곧 비용이다(2026-10-21 실측: 캐시읽기의 68%).
//  start   [--base <ref>] [--base-ok] [--tier t] [--recheck latest|<run.json>] [--here] [--static] [--no-profile] [focus...]
//  p0      <state.json>                     결정론 단계 + 런타임 기동 + 사전 점검 + 워커 전달 묶음
//  collect <state.json> --phase p1|p2       워커 결과를 세션 기록에서 꺼내 후보, TC 파일로 합친다
//  finish  <state.json> <fields.json>       병합, 원장, 런타임 정리, 보고
// 실패해도 exit 0 으로 '실패 (이유)' 를 찍는다. 메인은 stdout 만 읽는다.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const L = require('./lib.js');
const P = require('./profile.js');
const REC = require('./record.js');
const LED = require('./ledger.js');

const P1_TYPES = ['qa-logic', 'qa-scenario', 'qa-security', 'qa-upgrade'];
const P2_TYPES = ['qa-http', 'qa-ui', 'qa-verify'];
const SEV = { critical: 0, important: 1, minor: 2 };

function tool(name, args, cwd) {
  const r = spawnSync(process.execPath, [path.join(__dirname, name), ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env });
  const out = `${r.stdout || ''}${r.stderr ? r.stderr : ''}`.replace(/\r\n/g, '\n').trimEnd();
  if (out) console.log(out);
  return out;
}
function readJsonIf(p) { try { return fs.existsSync(p) ? L.readJson(p) : null; } catch { return null; } }
function saveState(st) { L.writeJson(st.statePath, st); }

// ── guard ─────────────────────────────────────────────────────────────────
// 지금 메인 세션의 마지막 호출 컨텍스트(천 토큰). 세션 id 가 없으면(다른 하네스) 판정하지 않는다.
// 가장 최근 세션 파일로 추측하지 않는 이유: 다른 세션이 동시에 돌면 남의 세션을 재게 된다.
function mainContextK() {
  const f = REC.findSessionById(process.env.CLAUDE_CODE_SESSION_ID);
  if (!f) return null;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try { const e = JSON.parse(lines[i]); const u = e.message?.usage; if (e.type === 'assistant' && u) return Math.round(((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)) / 1000); } catch {}
  }
  return null;
}

function argString(args, drop = []) {
  const parts = [];
  for (const [k, v] of Object.entries(args)) { if (k === '_' || drop.includes(k)) continue; parts.push(v === true ? `--${k}` : `--${k} ${v}`); }
  return [...parts, ...args._.slice(1)].join(' ');
}

// ── start ─────────────────────────────────────────────────────────────────
function findRecheckSource(branchDir, spec) {
  if (spec && spec !== true && spec !== 'latest') return fs.existsSync(spec) ? spec : null;
  const all = [];
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/^\d{8}-\d{6}\.json$/.test(e.name)) all.push(p); } };
  walk(branchDir);
  const withFail = all.map((p) => ({ p, j: readJsonIf(p) })).filter((x) => x.j && x.j.endedAt && (x.j.tcs || []).some((t) => t.result === 'fail'));
  withFail.sort((a, b) => Date.parse(b.j.endedAt) - Date.parse(a.j.endedAt));
  return withFail[0]?.p || null;
}

function cmdStart(args) {
  // --repo: 메인 세션의 작업 폴더가 아닌 체크아웃(재실행용 워크트리 등)을 대상으로. 이후 단계는 state 의 repoRoot 를 쓴다.
  const root = L.repoRoot(args.repo ? path.resolve(String(args.repo)) : process.cwd());
  const m = L.loadManifest();
  const warnK = m.guard?.mainCtxWarnK ?? 200;
  const ctxK = mainContextK();
  if (!args.here && ctxK != null && ctxK > warnK) {
    console.log(`guard: 메인 컨텍스트 ${ctxK}k (기준 ${warnK}k). run 을 만들지 않고 멈춤`);
    console.log(`  새 세션에서: /qa ${argString(args)}`.trimEnd());
    console.log(`  여기서 계속: node qa.js start --here ${argString(args)}`.trimEnd());
    console.log('  메인은 사용자에게 한 번 묻는다(계속 / 새 세션). 중단하면 남는 기록이 없다.');
    return;
  }
  const profile = P.detect(root);
  if (!profile && !args['no-profile']) {
    console.log('start: 중단 (프로필 없음). qa-bootstrap 으로 프로필을 만든 뒤 start 를 다시 부른다. 거절하면 --no-profile(자동 탐색 모드)');
    return;
  }
  const id = L.stamp();
  const branch = L.branchSlug(root);
  const branchDir = L.runsDir(root, branch);
  const runDir = path.join(branchDir, id);
  fs.mkdirSync(path.join(runDir, 'scratch'), { recursive: true });

  let recheck = null;
  if (args.recheck) {
    const src = findRecheckSource(branchDir, args.recheck);
    if (!src) { console.log('start: 중단 (재검증할 fail TC 가 있는 기록을 못 찾음)'); return; }
    const prev = L.readJson(src);
    recheck = { from: src, tier: prev.tier, tcs: (prev.tcs || []).filter((t) => t.result === 'fail') };
  }

  const scopeArgs = ['--run-dir', runDir];
  if (args.base) scopeArgs.push('--base', String(args.base));
  if (profile) scopeArgs.push('--profile', profile);
  tool('scope.js', scopeArgs, root);
  const scopePath = path.join(runDir, 'scope.json');
  const scope = readJsonIf(scopePath);
  if (!scope || scope.reason) { console.log('start: 중단 (범위를 정하지 못함. 위 scope 줄 참고)'); return; }
  if (scope.baseCheck === 'confirm' && !args['base-ok']) {
    console.log(`start: 중단 (기준 확인). 기준이 ${scope.baseRef} 와의 갈림점. 맞으면 --base-ok 를 붙여 다시, 아니면 --base <ref>`);
    return;
  }

  const tierArgs = ['--scope', scopePath];
  if (profile) tierArgs.push('--profile', profile);
  const forced = args.tier || (recheck ? String(recheck.tier).split(' ')[0] : null);
  if (forced) tierArgs.push('--force', String(forced));
  tool('tier.js', tierArgs, root);
  const tierPath = path.join(runDir, 'tier.json');
  const tier = readJsonIf(tierPath) || { tier: 'full', activate: {}, softTurns: 12, maxFindings: 10 };

  let profileStatus = 'none';
  if (profile) {
    const s = P.stale(profile, root, m.watchPaths || []);
    profileStatus = s.reason ? '판정 불가' : s.changed.length ? '갱신 권장' : 'OK';
    console.log(`profile: ${profile} (${profileStatus}${s.changed && s.changed.length ? `: ${s.changed.slice(0, 6).join(', ')}` : ''})`);
  }
  if (profile && !args.static) tool('runtime.js', ['status', '--profile', profile], root);
  tool('record.js', ['init', '--scope', scopePath, '--tier', tierPath, '--profile', profileStatus, '--id', id], root);
  const runPath = path.join(runDir, `${id}.json`);
  const run = L.readJson(runPath);
  Object.assign(run, { static: !!args.static, focus: args._.slice(1).join(' ') || null, guard: { ctxK, warnK, decision: args.here ? 'here' : 'pass' }, recheckFrom: recheck?.from || null });
  L.writeJson(runPath, run);

  const st = {
    id, statePath: path.join(runDir, 'state.json'), runPath, repoRoot: root, repoKey: L.repoKey(root), branch, runDir, branchDir,
    base: scope.base, head: scope.head, commits: scope.commits.length, files: scope.files.length, uncommitted: scope.uncommitted,
    tier: tier.tier, activate: tier.activate || {}, softTurns: tier.softTurns, maxFindings: tier.maxFindings,
    static: !!args.static, focus: run.focus, profile, profileStatus, recheck, phase: 'start', startedAt: run.startedAt,
    paths: { scope: scopePath, tier: tierPath, patch: scope.patchPath, scratch: path.join(runDir, 'scratch') },
  };
  saveState(st);
  console.log(`start: 완료. 다음은 node qa.js p0 "${st.statePath}"`);
}

// ── p0 ────────────────────────────────────────────────────────────────────
function plan(st) {
  if (st.recheck) {
    const ui = st.recheck.tcs.some((t) => REC.tcRun(t) === 'ui');
    return { p1: [], p2: ['qa-http', ...(ui ? ['qa-ui'] : [])] };
  }
  const p = REC.plannedWorkers(st.tier, st.activate);
  return { p1: p.p1, p2: st.static ? [] : p.p2 };
}

function sliceFor(st, worker, m) {
  if (!st.profile) return null;
  const headings = (m.slices || {})[worker];
  if (!headings || !headings.length) return null;
  const r = P.slice(st.profile, headings);
  const p = path.join(st.runDir, `slice-${worker.replace(/^qa-/, '')}.md`);
  L.writeText(p, r.text);
  return p;
}

function knownLines(st) {
  const known = readJsonIf(path.join(st.runDir, 'known.json')) || [];
  const fmt = (k) => `${k.id} ${k.file} ${k.symbol || '(최상위)'}`;
  const sup = known.filter((k) => k.status === 'suppress').map(fmt);
  const re = known.filter((k) => k.status === 'reeval').map(fmt);
  const out = [];
  if (sup.length) out.push(`- 알려진 이슈(억제. 같은 파일, symbol 의 후보는 내지 않는다): ${sup.join('; ')}`);
  if (re.length) out.push(`- 알려진 이슈(재평가. diff 가 건드렸으니 정상 후보로 본다): ${re.join('; ')}`);
  return out;
}

function unavailableLine(st) {
  const pf = readJsonIf(path.join(st.runDir, 'preflight.json'));
  if (!pf || !pf.optionalFailed.length) return [];
  const items = pf.results.filter((r) => !r.ok && !r.required).map((r) => `${r.item}(걸리는 것: ${r.affects || '-'})`);
  return [`- 쓸 수 없는 계정, 자원: ${items.join('; ')}. 여기에 걸리는 TC 는 설계는 하되 skipped 로 둔다`];
}

function bundle(st, worker, m, extra = []) {
  const slice = sliceFor(st, worker, m);
  const lines = [
    `## 전달 묶음 (${worker})`,
    `- 레포 루트: ${st.repoRoot} (첫 명령으로 cd)`,
    `- base/head: ${String(st.base).slice(0, 8)}..${String(st.head).slice(0, 8)} (커밋 ${st.commits}, 미커밋 ${st.uncommitted ? '포함' : '없음'}, 파일 ${st.files}개)`,
    `- tier: ${st.tier} / max_findings: ${st.maxFindings} / 탐색 상한: ${st.softTurns}회 / focus: ${st.focus || '없음'}`,
    `- diff: ${st.paths.patch}`,
  ];
  if (P1_TYPES.includes(worker) && st.paths.pack) lines.push(`- pack: ${st.paths.pack}`);
  if (['qa-logic', 'qa-scenario'].includes(worker) && st.paths.context) lines.push(`- context: ${st.paths.context}`);
  if (slice) lines.push(`- 프로필 절: ${slice}`);
  if (worker === 'qa-upgrade') lines.push(`- 기준 커밋: ${st.base}`);
  if (worker === 'qa-logic' && st.tier === 'light') lines.push('- 앵글: light 티어라 A 만, hunk 안에서');
  lines.push(`- 임시 파일: ${st.paths.scratch} (레포 안에 만들지 않는다)`);
  if (P1_TYPES.includes(worker)) lines.push(...knownLines(st));
  if (['qa-scenario', 'qa-upgrade', 'qa-http', 'qa-ui'].includes(worker)) lines.push(...unavailableLine(st));
  lines.push(...extra);
  lines.push('- 출력: 마지막 메시지에 JSON 객체 하나. 앞 메시지에 쓴 내용은 메인이 받지 못한다');
  const text = lines.join('\n') + '\n';
  const p = path.join(st.runDir, `bundle-${worker}.md`);
  L.writeText(p, text);
  return text;
}

function cmdP0(statePath) {
  const st = L.readJson(statePath); const m = L.loadManifest(); const root = st.repoRoot;
  const rec = (...a) => spawnSync(process.execPath, [path.join(__dirname, 'record.js'), ...a], { cwd: root, encoding: 'utf8' });
  rec('phase', st.runPath, 'p0', 'start');
  const prof = st.profile ? ['--profile', st.profile] : [];
  const sc = ['--scope', st.paths.scope];
  if (!st.static && !st.recheck && st.profile) tool('tests.js', [...sc, ...prof], root);
  if (!st.recheck) {
    tool('context.js', [...sc, ...prof], root); st.paths.context = path.join(st.runDir, 'context.md');
    if (['full', 'max'].includes(String(st.tier).split(' ')[0])) tool('blast.js', sc, root);
    tool('pack.js', sc, root); st.paths.pack = path.join(st.runDir, 'pack', 'index.md');
  }
  if (!st.static && st.profile) tool('corpus.js', ['run', ...prof, '--out', path.join(st.runDir, 'corpus-tcs.json')], root);
  if (!st.static && st.profile) {
    tool('runtime.js', ['up', ...prof, '--run', st.runDir], root);
    tool('runtime.js', ['preflight', ...prof, '--run', st.runDir], root);
  }
  if (!st.recheck && st.profile) tool('known.js', [...sc, ...prof, '--out', path.join(st.runDir, 'known.json')], root);

  const tests = readJsonIf(path.join(st.runDir, 'tests.json'));
  const pf = readJsonIf(path.join(st.runDir, 'preflight.json'));
  const corpus = readJsonIf(path.join(st.runDir, 'corpus-tcs.json')) || [];
  if (tests && tests.overall === 'fail') st.blocked = '검증 명령 실패(tests.json)';
  else if (pf && pf.requiredFailed.length) st.blocked = `사전 점검 필수 실패: ${pf.requiredFailed.join(', ')}`;
  if (corpus.some((x) => x.result === 'fail')) st.corpusFail = corpus.filter((x) => x.result === 'fail').map((x) => x.tc_id);

  const pl = plan(st);
  st.plan = pl;
  rec('phase', st.runPath, 'p0', 'end');
  st.phase = 'p0'; st.p0EndedAt = L.nowIso();
  if (st.recheck) {
    writeTcs(st, st.recheck.tcs.map((t) => ({ ...t, result: null })));
  }
  saveState(st);

  if (st.blocked) { console.log(`p0: BLOCKED (${st.blocked}). 워커를 띄우지 말고 verdict BLOCKED 로 finish`); return; }
  if (st.corpusFail) console.log(`p0: 회귀 코퍼스 실패 ${st.corpusFail.join(', ')}. 판정은 FAIL 로 가고 이 행이 발견 1번`);
  const workers = st.recheck ? pl.p2 : pl.p1;
  console.log(`p0: 완료. 띄울 워커 ${workers.join(', ') || '없음'}${st.recheck ? ' (재검증: P2 만)' : ''}. 아래 묶음을 그대로 각 워커 프롬프트로 쓴다`);
  for (const w of workers) console.log('\n' + bundle(st, w, m, st.recheck ? p2Extra(st, w) : []));
}

// ── collect ───────────────────────────────────────────────────────────────
// 워커 결과를 Claude Code 세션 기록(subagents/agent-<id>.jsonl)의 마지막 handback 에서 꺼낸다.
// 내부 형식에 기대므로 필요한 것만 꺼내고 나머지는 무시한다(Tolerant Reader). 못 꺼내면 그 워커만
// '수집 실패' 로 찍고 메인이 붙여 넣는다. Codex 하네스에는 이 파일이 없어 항상 그 경로로 간다.
function lastText(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type !== 'assistant') continue;
    const c = e.message?.content || [];
    const hb = c.find((x) => x.type === 'tool_use' && x.name === 'SubagentHandback');
    if (hb && hb.input && typeof hb.input.message === 'string') return hb.input.message;
    const t = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    if (t.trim()) return t;
  }
  return '';
}
function lastJson(text) {
  if (!text) return null;
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].map((x) => x[1]).reverse();
  for (const c of [...fences, text]) {
    const t = c.trim();
    try { return JSON.parse(t); } catch {}
    const s = Math.min(...['{', '['].map((ch) => { const i = t.indexOf(ch); return i < 0 ? Infinity : i; }));
    const e = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (s !== Infinity && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  }
  return null;
}
// 새 형식(객체)과 옛 형식(finding 배열, tc-result lens) 모두 받는다.
function asResult(obj) {
  if (!obj) return null;
  const r = Array.isArray(obj) ? { findings: obj, tcs: [], checks: [], unreviewed: [] } : { findings: obj.findings || [], tcs: obj.tcs || [], checks: obj.checks || [], unreviewed: obj.unreviewed || [] };
  for (const f of r.findings.filter((x) => x && x.lens === 'tc-result' && x.tc_id)) r.tcs.push({ id: f.tc_id, run: f.실행 || f.run, result: f.result, evidence: f.evidence, note: f.summary });
  r.findings = r.findings.filter((x) => x && x.lens !== 'tc-result');
  return r;
}

function sessionFor(st) {
  const run = readJsonIf(st.runPath) || {};
  const f = REC.findSessionById(process.env.CLAUDE_CODE_SESSION_ID);
  if (f) return f;
  return run.sessionFile && fs.existsSync(run.sessionFile) ? run.sessionFile : null;
}

function collectOutputs(st, types, sinceIso) {
  const session = sessionFor(st);
  if (!session) return { error: '세션 기록을 찾지 못함(CLAUDE_CODE_SESSION_ID 없음)', outputs: [] };
  const subDir = path.join(session.replace(/\.jsonl$/, ''), 'subagents');
  const run = readJsonIf(st.runPath) || {};
  const found = REC.discoverWorkers(subDir, { agents: run.agents || [] }, Date.parse(sinceIso), null);
  const outputs = [];
  for (const [id, w] of found) {
    if (!types.includes(w.name)) continue;
    const f = path.join(subDir, `agent-${id}.jsonl`);
    const res = asResult(lastJson(lastText(f)));
    outputs.push({ agentId: id, worker: w.name, ok: !!res, ...(res || {}) });
  }
  return { outputs };
}

function writeTcs(st, tcs) {
  const http = tcs.filter((t) => REC.tcRun(t) !== 'ui');
  const ui = tcs.filter((t) => REC.tcRun(t) === 'ui');
  st.paths.tcsHttp = L.writeJson(path.join(st.runDir, 'tcs-http.json'), http);
  st.paths.tcsUi = L.writeJson(path.join(st.runDir, 'tcs-ui.json'), ui);
  return { http, ui };
}

function p2Extra(st, worker) {
  if (worker === 'qa-http') return [`- TC 목록: ${st.paths.tcsHttp} (run 이 http, cli, node 인 것. result 가 이미 skipped 인 것은 실행하지 않는다)`];
  if (worker === 'qa-ui') return [`- TC 목록: ${st.paths.tcsUi}`];
  return [];
}

// 메인이 profile_suggestions 의 key 를 붙일 때 같은 사실에는 기존 key 를 다시 쓰도록 보여 준다
function ledgerKeysLine(st) {
  const keys = Object.entries(LED.load(L.repoRunsDir(st.repoRoot))).filter(([, e]) => e.status !== 'rejected').map(([k]) => k).filter((k) => !k.startsWith('legacy-'));
  return keys.length ? `원장 key(같은 사실이면 이 key 를 다시 쓴다): ${keys.slice(0, 40).join(', ')}` : '원장 key: 없음';
}

function mergeCandidates(outputs) {
  const by = new Map();
  for (const o of outputs) for (const f of o.findings || []) {
    const key = `${f.file || ''}|${f.symbol || ''}|${f.lens === 'catalog-proposal' ? f.summary : ''}`;
    const prev = by.get(key);
    if (!prev) { by.set(key, { ...f, sources: [o.worker.replace(/^qa-/, '')] }); continue; }
    if ((SEV[f.severity] ?? 3) < (SEV[prev.severity] ?? 3)) Object.assign(prev, { ...f, sources: prev.sources });
    const s = o.worker.replace(/^qa-/, ''); if (!prev.sources.includes(s)) prev.sources.push(s);
  }
  const list = [...by.values()].sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3));
  list.forEach((c, i) => { c.cid = `C-${String(i + 1).padStart(2, '0')}`; });
  return list;
}

function cmdCollect(statePath, phase) {
  const st = L.readJson(statePath); const m = L.loadManifest();
  const since = phase === 'p2' ? (st.p1CollectedAt || st.p0EndedAt) : st.p0EndedAt;
  if (!since) { console.log('collect: 실패 (p0 를 먼저 끝낼 것)'); return; }
  const types = phase === 'p2' ? P2_TYPES : P1_TYPES;
  const { outputs, error } = collectOutputs(st, types, since);
  if (error) { console.log(`collect: 실패 (${error}). 워커 결과를 메인이 직접 붙여 넣는다`); return; }
  const failed = outputs.filter((o) => !o.ok);
  for (const o of outputs) console.log(`collect: ${o.worker} (${o.agentId}) ${o.ok ? `후보 ${o.findings.length}, TC ${o.tcs.length}` : '수집 실패. 이 워커 결과는 메인이 붙여 넣는다'}`);
  const run = L.readJson(st.runPath);
  const now = L.nowIso();
  if (phase === 'p1') {
    const cands = mergeCandidates(outputs.filter((o) => o.ok));
    L.writeJson(path.join(st.runDir, 'candidates.json'), cands);
    const pf = readJsonIf(path.join(st.runDir, 'preflight.json'));
    const bad = pf ? pf.results.filter((r) => !r.ok) : [];
    const tcs = outputs.filter((o) => o.ok).flatMap((o) => o.tcs.map((t) => ({ ...t, from: o.worker })));
    for (const t of tcs) {
      if (t.destructive === true || t.파괴 === 'yes') { t.result = 'skipped'; t.note = 'skipped: 파괴 경로'; }
      const hit = t.account && bad.find((r) => r.item.includes(t.account));
      if (hit && !t.result) { t.result = 'skipped'; t.note = `skipped: ${hit.item} 실패`; }
    }
    writeTcs(st, tcs);
    const unrev = [...new Set(outputs.flatMap((o) => o.unreviewed || []))];
    if (unrev.length && unrev.length * 3 > st.files) console.log(`collect: 미검토 ${unrev.length}개(변경 파일의 1/3 초과). 그 파일만 범위로 같은 워커 1회 보충: ${unrev.slice(0, 10).join(', ')}`);
    run.phases.p1 = { startedAt: st.p0EndedAt, endedAt: now, seconds: Math.round((Date.parse(now) - Date.parse(st.p0EndedAt)) / 1000) };
    L.writeJson(st.runPath, run);
    st.p1CollectedAt = now; st.phase = 'p1-collected'; saveState(st);
    console.log(`\n후보 ${cands.length}건 → ${path.join(st.runDir, 'candidates.json')}`);
    for (const c of cands.slice(0, 30)) console.log(`${c.cid} [${c.severity}] ${c.file || '-'} ${c.symbol || ''}: ${String(c.summary || '').replace(/\s+/g, ' ').slice(0, 140)} (${c.sources.join(', ')}${c.in_diff === false ? ', in_diff:false' : ''})`);
    if (cands.length > 30) console.log(`(외 ${cands.length - 30}건은 파일에)`);
    const p2 = (st.plan?.p2 || []).filter((w) => w !== 'qa-ui' || readJsonIf(st.paths.tcsUi)?.length);
    console.log(`\nTC: http ${readJsonIf(st.paths.tcsHttp).length}, ui ${readJsonIf(st.paths.tcsUi).length}. 다음은 선별 verify(full 이상)와 P2: ${p2.join(', ') || '없음'}`);
    if (!p2.length) console.log(ledgerKeysLine(st));
    for (const w of p2) console.log('\n' + bundle(st, w, m, p2Extra(st, w)));
    return;
  }
  // p2: TC 결과와 probe, 콘솔, 네트워크 발견, verify 판정
  const results = new Map();
  for (const o of outputs.filter((x) => x.ok && x.worker !== 'qa-verify')) for (const t of o.tcs) results.set(t.id || t.tc_id, { ...t, id: t.id || t.tc_id, run: t.run || t.실행 || (o.worker === 'qa-ui' ? 'ui' : 'http'), by: o.worker });
  const tcs = [...results.values()];
  L.writeJson(path.join(st.runDir, 'tcs-results.json'), tcs);
  const extra = outputs.filter((x) => x.ok && x.worker !== 'qa-verify').flatMap((o) => o.findings.map((f) => ({ ...f, sources: [o.worker.replace(/^qa-/, '')] })));
  L.writeJson(path.join(st.runDir, 'candidates-p2.json'), extra);
  const verify = outputs.filter((x) => x.ok && x.worker === 'qa-verify').flatMap((o) => o.findings);
  L.writeJson(path.join(st.runDir, 'verify.json'), verify);
  run.phases.p2 = { startedAt: st.p1CollectedAt, endedAt: now, seconds: Math.round((Date.parse(now) - Date.parse(st.p1CollectedAt || now)) / 1000) };
  L.writeJson(st.runPath, run);
  st.phase = 'p2-collected'; saveState(st);
  const cnt = (r) => tcs.filter((t) => t.result === r).length;
  console.log(`\nTC 결과: pass ${cnt('pass')}, fail ${cnt('fail')}, skipped ${cnt('skipped')} → tcs-results.json`);
  for (const t of tcs.filter((x) => x.result === 'fail')) console.log(`  fail ${t.id} (${t.run}): ${String(t.note || t.evidence || '').replace(/\s+/g, ' ').slice(0, 160)}`);
  if (extra.length) console.log(`P2 발견 ${extra.length}건(probe, 콘솔, 네트워크) → candidates-p2.json`);
  if (verify.length) console.log(`verify: ${verify.map((v) => `${v.verdict || '?'} ${v.file || ''} ${v.symbol || ''}`.trim()).join('; ')}`);
  if (failed.length) console.log(`수집 실패 ${failed.length}건: 메인이 그 워커 결과를 fields.json 에 직접 넣는다`);
  console.log(ledgerKeysLine(st));
  console.log(`다음: ${path.join(st.runDir, 'fields.json')} 을 쓰고 node qa.js finish "${statePath}" "${path.join(st.runDir, 'fields.json')}"`);
}

// ── finish ────────────────────────────────────────────────────────────────
function cmdFinish(statePath, fieldsPath) {
  const st = L.readJson(statePath); const root = st.repoRoot;
  const fields = L.readJson(fieldsPath);
  if (!fields.tcs) {
    const res = readJsonIf(path.join(st.runDir, 'tcs-results.json')) || [];
    const corpus = readJsonIf(path.join(st.runDir, 'corpus-tcs.json')) || [];
    fields.tcs = [...res, ...corpus];
  }
  if (st.static && !fields.runtimeWaived) fields.runtimeWaived = '정적 재실행(검증용)';
  const known = readJsonIf(path.join(st.runDir, 'known.json'));
  if (known) fields.known = { suppressed: known.filter((k) => k.status === 'suppress').length, reeval: known.filter((k) => k.status === 'reeval').length, stale: known.filter((k) => k.status === 'stale').length };
  const merged = path.join(st.runDir, 'fields.json');
  L.writeJson(merged, fields);
  tool('record.js', ['merge', st.runPath, merged], root);
  tool('ledger.js', ['update', st.runPath, '--dir', L.repoRunsDir(root)], root);
  if (!st.static) tool('runtime.js', ['down', '--run', st.runDir], root);
  tool('record.js', ['finish', st.runPath], root);
  st.phase = 'done'; saveState(st);
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const [cmd, a1, a2] = args._;
  if (cmd === 'start') return cmdStart(args);
  if (cmd === 'p0') return cmdP0(a1);
  if (cmd === 'collect') return cmdCollect(a1, args.phase || 'p1');
  if (cmd === 'finish') return cmdFinish(a1, a2);
  console.log('사용: qa.js start [인자] | p0 <state> | collect <state> --phase p1|p2 | finish <state> <fields.json>');
}

if (require.main === module) { try { main(); } catch (e) { console.log(`qa: 실패 (${e.message})`); } }
module.exports = { mainContextK, lastJson, lastText, asResult, mergeCandidates, findRecheckSource, argString, plan };
