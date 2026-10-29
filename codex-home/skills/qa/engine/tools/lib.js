// lib.js : tools/ 공용 헬퍼. 무의존.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CORE_ROOT = path.resolve(__dirname, '..');

function expandHome(p) { return p.replace(/^~(?=\/|$)/, os.homedir()); }
function loadManifest() { return JSON.parse(fs.readFileSync(path.join(CORE_ROOT, 'manifest.json'), 'utf8')); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeText(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8'); return p; }
function writeJson(p, obj) { return writeText(p, JSON.stringify(obj, null, 2) + '\n'); }
function normalizeText(t) { return t.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n').trim() + '\n'; }

function git(args, { cwd = process.cwd(), allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} 실패: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').replace(/\r\n/g, '\n');
}
function repoRoot(cwd = process.cwd()) { return git(['rev-parse', '--show-toplevel'], { cwd }).trim(); }

// 워크트리와 본 체크아웃은 git common dir(.git) 을 공유한다. 레포 식별과 프로필 폴백의 기준.
// 워크트리 폴더명을 레포 이름으로 쓰면 같은 레포의 기록이 워크트리마다 갈린다(2026-10-21 실측: qa-mfa-totp).
function mainCheckout(root) {
  const common = git(['rev-parse', '--git-common-dir'], { cwd: root, allowFail: true }).trim();
  if (!common) return root;
  return path.dirname(path.resolve(root, common));
}
function repoKey(root) { return path.basename(mainCheckout(root)); }

// 브랜치 폴더 이름. detached HEAD 는 커밋마다 갈라 서로 덮어쓰지 않게 한다.
function branchSlug(root) {
  const b = git(['branch', '--show-current'], { cwd: root, allowFail: true }).trim();
  if (b) return b;
  const sha = git(['rev-parse', '--short=8', 'HEAD'], { cwd: root, allowFail: true }).trim();
  return sha ? `detached-${sha}` : 'detached';
}

// 아주 작은 glob: ** = 아무 경로, * = 슬래시 제외, 나머지는 리터럴. 경로는 / 기준.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
function matchAny(p, globs) { const s = p.replace(/\\/g, '/'); return (globs || []).some((g) => globToRegExp(g).test(s) || globToRegExp('**/' + g).test(s)); }

// 프로필 마크다운을 "## 헤딩" 단위로 나눈다. frontmatter 는 meta 로.
function parseProfile(text) {
  const t = text.replace(/\r\n/g, '\n');
  let meta = {}, body = t;
  const fm = t.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    body = t.slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z_.]+):\s*"?([^"\n]*)"?\s*$/);
      if (m) meta[m[1]] = m[2];
    }
  }
  const sections = {};
  let cur = null;
  for (const line of body.split('\n')) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { cur = h[1]; sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join('\n').trim();
  return { meta, sections };
}

// 마크다운 표 파싱: 헤더 행 + 구분선 + 데이터 행 → [{col: value}]
function parseTable(md) {
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const split = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const header = split(lines[0]);
  const rows = [];
  for (const l of lines.slice(2)) {
    const cells = split(l);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const row = {}; header.forEach((h, i) => { row[h] = cells[i] ?? ''; }); rows.push(row);
  }
  return rows;
}

function nowIso() { return new Date().toISOString(); }
function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
// QA_RUNS_ROOT 는 테스트가 실제 기록 폴더를 건드리지 않게 하는 용도.
function runsRoot() { return process.env.QA_RUNS_ROOT ? path.resolve(process.env.QA_RUNS_ROOT) : expandHome('~/.qa-runs'); }
function repoRunsDir(root) { return path.join(runsRoot(), repoKey(root)); }
function runsDir(root, branch) { return path.join(repoRunsDir(root), branch.replace(/\//g, '-')); }
function tail(text, n) { const a = text.replace(/\r\n/g, '\n').split('\n'); return a.slice(Math.max(0, a.length - n)).join('\n'); }

// 인자 파서: --k v / --flag
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true; }
    else out._.push(a);
  }
  return out;
}

module.exports = { CORE_ROOT, expandHome, loadManifest, readJson, writeText, writeJson, normalizeText, git, repoRoot, mainCheckout, repoKey, branchSlug, globToRegExp, matchAny, parseProfile, parseTable, nowIso, stamp, runsRoot, repoRunsDir, runsDir, tail, parseArgs, execFileSync, spawnSync };
