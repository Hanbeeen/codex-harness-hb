#!/usr/bin/env node
// runtime.js : QA 대상 앱을 실제로 띄운다. 런타임 QA 의 전제 조건을 스크립트가 책임진다.
//   status  프로필 `## 런타임` 의 서비스마다 살아 있는지 찍는다(판단 없음)
//   up      죽어 있는 것만 띄우고, **내가 띄운 것만** runDir/runtime-owned.json 에 적는다
//   down    runtime-owned.json 에 적힌 것만 내린다(원래 떠 있던 것은 건드리지 않는다)
//
// 기동 명령은 코어가 모른다. 프로젝트마다 다르므로 전부 프로필이 소유한다.
// 프로필에 `## 런타임` 절이 없으면 `실패 (런타임 절 없음)` 을 찍고 exit 0 메인이 사용자에게 한 번 묻고
// 답을 프로필에 적으면 다음 실행부터 자동이다.
//
// 프로필 형식(표. 열 이름이 있으면 이름으로, 없으면 이 순서로 읽는다):
//   | 서비스 | 헬스체크 | 기동 | 종료 | 대기 |
//   |:---|:---|:---|:---|:---|
//   | backend | `http://localhost:5007/` | `npm --prefix backend run dev` | - | 60 |
//   헬스체크가 http 로 시작하면 GET 해서 **응답이 오기만 하면** 살아 있음(404 도 살아 있음).
//   그 외는 셸 명령으로 보고 exit 0 이면 살아 있음.
//   종료가 `-` 면 up 이 띄운 프로세스를 직접 죽인다. 명령이 있으면 그 명령을 쓴다.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const L = require('./lib.js');

const SECTION = '런타임';
const DEFAULT_WAIT = 40;
const PIPE = String.fromCharCode(124);
const BACKSLASH = String.fromCharCode(92);
const NUL = String.fromCharCode(0);

// 프로필에 적는 명령은 POSIX 셸 문법으로 통일한다. Windows 의 기본 셸(cmd.exe)은 `VAR=x cmd` 앞붙임도,
// `&&` 체인 뒤의 따옴표도 다르게 먹어서, 같은 프로필이 개발기(Windows)와 운영기(RHEL)에서 다르게 돈다
// (2026-09-21 실측: `JWT_SECRET=qa node -e ...` 가 cmd.exe 에서 "명령이 아닙니다" 로 죽음).
// bash 가 있으면 bash 로, 없으면 기본 셸로 떨어진다.
function shellFor() {
  if (process.platform !== 'win32') return true;
  const probe = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
  return probe.status === 0 ? 'bash' : true;
}
const SHELL = shellFor();

// 마크다운 표 파서 lib.parseTable 과 같되 셀 안의 이스케이프 파이프를 구분자로 보지 않는다.
// 헬스체크, 기동 명령에 셸 파이프가 들어가는 일이 흔해서, 이 처리가 없으면 명령이 조용히 잘린다.
function parseTableEscaped(md) {
  const lines = md.split('\n').filter((l) => l.trim().startsWith(PIPE));
  if (lines.length < 2) return [];
  const split = (l) => {
    let t = l.trim().split(BACKSLASH + PIPE).join(NUL);
    if (t.startsWith(PIPE)) t = t.slice(1);
    if (t.endsWith(PIPE)) t = t.slice(0, -1);
    return t.split(PIPE).map((c) => c.trim().split(NUL).join(PIPE));
  };
  const header = split(lines[0]);
  const rows = [];
  for (const l of lines.slice(2)) {
    const cells = split(l);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows;
}

function parseServices(profilePath) {
  if (!profilePath || !fs.existsSync(profilePath)) return null;
  const sec = L.parseProfile(fs.readFileSync(profilePath, 'utf8')).sections[SECTION];
  if (!sec) return null;
  const unq = (s) => String(s || '').trim().replace(/^`|`$/g, '').trim();
  const rows = parseTableEscaped(sec).map((r) => {
    const v = Object.values(r);
    return {
      name: unq(r['서비스'] ?? v[0]),
      health: unq(r['헬스체크'] ?? v[1]),
      up: unq(r['기동'] ?? v[2]),
      down: unq(r['종료'] ?? v[3]),
      wait: parseInt(unq(r['대기'] ?? v[4]), 10) || DEFAULT_WAIT,
    };
  }).filter((s) => s.name && s.health && s.name !== '-' && !/^\[질문\]/.test(s.health));
  return rows.length ? rows : null;
}

function httpAlive(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = (url.startsWith('https:') ? https : http).get(url, { timeout: timeoutMs }, (res) => { res.resume(); fin(true); });
      req.on('error', () => fin(false));
      req.on('timeout', () => { req.destroy(); fin(false); });
    } catch { fin(false); }
  });
}

async function alive(svc, cwd) {
  if (/^https?:\/\//.test(svc.health)) return httpAlive(svc.health);
  return spawnSync(svc.health, { cwd, shell: SHELL, timeout: 15000, stdio: 'ignore' }).status === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitAlive(svc, cwd, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await alive(svc, cwd)) return true;
    await sleep(1500);
  }
  return false;
}

// 띄운 프로세스는 detached 로 두고 로그만 파일에 남긴다. 끝나고 down 이 정리한다.
function launch(svc, cwd, logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `runtime-${svc.name}.log`);
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(svc.up, { cwd, shell: SHELL, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
  child.unref();
  return { pid: child.pid, log: logPath };
}

function killTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).status === 0;
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch { return false; }
}

// pid 로 못 죽일 때의 대비책. `npm run dev` 는 셸 래퍼가 먼저 빠지고 실제 서버(vite, nodemon)가 손자
// 프로세스로 남는 일이 흔해서, 기록해 둔 pid 를 죽여도 포트가 그대로 물려 있다(2026-09-21 실측).
// **내가 띄운 서비스의 헬스체크 포트에서만** 쓴다. 남이 쓰는 포트는 애초에 owned 에 없다.
function killByPort(port) {
  if (!port) return false;
  const pids = new Set();
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
    for (const line of out.split('\n')) {
      if (!/LISTENING/.test(line)) continue;
      if (!new RegExp(':' + port + '\\s').test(line)) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
    let ok = false;
    for (const pid of pids) if (spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }).status === 0) ok = true;
    return ok;
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
  for (const pid of out.split('\n').map((x) => x.trim()).filter(Boolean)) pids.add(pid);
  let ok = false;
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); ok = true; } catch { /* 이미 죽음 */ } }
  return ok;
}

function portOf(health) {
  const m = /^https?:\/\/[^/:]+:(\d+)/.exec(health || '');
  return m ? m[1] : null;
}

const ownedPath = (runDir) => path.join(runDir, 'runtime-owned.json');

async function cmdStatus(services, cwd) {
  const out = [];
  for (const s of services) out.push({ name: s.name, up: await alive(s, cwd) });
  console.log('runtime status: ' + out.map((o) => `${o.name}=${o.up ? 'up' : 'down'}`).join(' '));
  return out;
}

async function cmdUp(services, cwd, runDir) {
  const owned = [];
  const report = [];
  for (const s of services) {
    if (await alive(s, cwd)) { report.push(`${s.name}=이미 up`); continue; }
    if (!s.up || s.up === '-') { report.push(`${s.name}=down(기동 명령 없음)`); continue; }
    const { pid, log } = launch(s, cwd, runDir);
    const ok = await waitAlive(s, cwd, s.wait);
    // 헬스체크가 안 떠도 pid 는 기록한다. 안 그러면 좀비가 남는다.
    owned.push({ name: s.name, pid, log, down: s.down, port: portOf(s.health), healthy: ok });
    report.push(`${s.name}=${ok ? 'up(내가 띄움)' : `기동 실패(${s.wait}초 내 헬스체크 실패, 로그 ${log})`}`);
  }
  if (runDir) L.writeJson(ownedPath(runDir), owned);
  console.log('runtime up: ' + report.join(', '));
  const failed = owned.filter((o) => !o.healthy).map((o) => o.name);
  if (failed.length) console.log(`runtime up 실패: ${failed.join(', ')} 이 서비스에 걸린 TC 는 skipped 로 남기고 판정은 BLOCKED`);
  return owned;
}

function cmdDown(runDir, cwd) {
  const p = ownedPath(runDir);
  if (!fs.existsSync(p)) { console.log('runtime down: 내가 띄운 것 없음(건드릴 것 없음)'); return; }
  const report = [];
  for (const o of L.readJson(p)) {
    if (o.down && o.down !== '-') {
      const r = spawnSync(o.down, { cwd, shell: SHELL, timeout: 60000, stdio: 'ignore' });
      report.push(`${o.name}=${r.status === 0 ? '종료' : '종료 명령 실패'}`);
    } else {
      // pid → 포트 순으로 시도. 둘 다 실패하면 남은 프로세스를 사용자에게 알린다(조용히 좀비를 남기지 않는다).
      const byPid = killTree(o.pid);
      const byPort = byPid ? false : killByPort(o.port);
      report.push(`${o.name}=${byPid ? '종료' : byPort ? `종료(포트 ${o.port})` : `종료 실패 pid ${o.pid}${o.port ? `/포트 ${o.port}` : ''} 를 직접 확인`}`);
    }
  }
  fs.rmSync(p, { force: true });
  console.log('runtime down: ' + (report.join(', ') || '없음'));
}

// ── 사전 점검(preflight) ──────────────────────────────────────────────────
// 워커를 띄우기 전에 환경을 확인한다. 2026-10-15 두 회차가 mongo 미기동, 시드 계정 비밀번호 만료로
// 워커를 다 띄운 뒤에야 BLOCKED 가 됐다. 무엇을 확인할지는 레포마다 달라 프로필이 소유한다.
// 프로필 형식:
//   - 매크로 `<로그인>`: `node -e "..."`          표의 명령 안 <로그인> 을 이 명령으로 바꾼다
//   | 항목 | 확인 명령 | 걸리는 것 | 필수 |
//   | admin 로그인 | `<로그인> admin 'pw'` | admin TC 전부 | 예 |
// 확인 명령은 한 번씩만 돈다. 로그인 확인을 재시도하면 잠금 카운터만 올라간다.
const PREFLIGHT_SECTION = '사전 점검';
const PREFLIGHT_TIMEOUT_MS = 30000;

function parsePreflight(profilePath) {
  if (!profilePath || !fs.existsSync(profilePath)) return null;
  const sec = L.parseProfile(fs.readFileSync(profilePath, 'utf8')).sections[PREFLIGHT_SECTION];
  if (!sec) return null;
  const macros = [];
  for (const line of sec.split('\n')) {
    const m = line.match(/^\s*[-*]\s*매크로\s*`(<[^>`]+>)`\s*:\s*`(.+)`\s*$/);
    if (m) macros.push([m[1], m[2]]);
  }
  const unq = (s) => String(s || '').trim().replace(/^`|`$/g, '').trim();
  const expand = (cmd) => macros.reduce((c, [k, v]) => c.split(k).join(v), cmd);
  const rows = parseTableEscaped(sec).map((r) => {
    const v = Object.values(r);
    return {
      item: unq(r['항목'] ?? v[0]),
      cmd: expand(unq(r['확인 명령'] ?? v[1])),
      affects: unq(r['걸리는 것'] ?? v[2]),
      required: /^(예|yes|y|필수)$/i.test(unq(r['필수'] ?? v[3])),
    };
  }).filter((x) => x.item && x.cmd && !/^\[질문\]/.test(x.cmd));
  return rows.length ? rows : null;
}

function cmdPreflight(profilePath, cwd, runDir) {
  const rows = parsePreflight(profilePath);
  if (!rows) { console.log(`preflight: 건너뜀 (프로필에 '## ${PREFLIGHT_SECTION}' 절 없음)`); return null; }
  const results = rows.map((r) => {
    const x = spawnSync(r.cmd, { cwd, shell: SHELL, timeout: PREFLIGHT_TIMEOUT_MS, encoding: 'utf8' });
    return { ...r, ok: x.status === 0, exit: x.status, tail: x.status === 0 ? '' : L.tail(`${x.stdout || ''}\n${x.stderr || ''}`.trim(), 5) };
  });
  const out = { results, requiredFailed: results.filter((r) => !r.ok && r.required).map((r) => r.item), optionalFailed: results.filter((r) => !r.ok && !r.required).map((r) => r.item) };
  if (runDir) L.writeJson(path.join(runDir, 'preflight.json'), out);
  console.log(`preflight: ${results.map((r) => `${r.item}=${r.ok ? 'ok' : '실패'}`).join(', ')}`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.required ? '필수' : '선택'} 실패: ${r.item} (걸리는 것: ${r.affects || '-'})${r.tail ? ` / ${r.tail.replace(/\n+/g, ' ').slice(0, 160)}` : ''}`);
  if (out.requiredFailed.length) console.log('preflight: 필수 항목 실패. 워커를 띄우지 않고 BLOCKED. 로그인 실패면 다음 실행 전에 프로필의 계정 값을 먼저 고칠 것(5회 실패 시 잠금)');
  return out;
}

async function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const cwd = L.repoRoot(process.cwd());
  if (cmd === 'down') return cmdDown(args.run, cwd);
  if (cmd === 'preflight') return void cmdPreflight(args.profile, cwd, args.run);

  const services = parseServices(args.profile);
  if (!services) {
    console.log(`runtime: 실패 (프로필에 '## ${SECTION}' 절 없음). 서비스, 헬스체크, 기동 명령을 프로필에 적으면 다음 실행부터 자동으로 띄운다.`);
    return;
  }
  if (cmd === 'status') return void (await cmdStatus(services, cwd));
  if (cmd === 'up') return void (await cmdUp(services, cwd, args.run));
  console.log('runtime: 실패 (사용: runtime.js status|up|down|preflight)');
}

if (require.main === module) main().catch((e) => console.log(`runtime: 실패 (${e.message})`));
module.exports = { parseServices, parseTableEscaped, parsePreflight, cmdPreflight, cmdStatus, cmdUp, cmdDown, alive, ownedPath, shellFor, SHELL, SECTION };
