#!/usr/bin/env node
// scope.js : QA 범위 산출. main 을 이름으로 참조하지 않는다.
// 사용: node scope.js [--base <ref>] [--run-dir <dir>] [--cwd <repo>] [--profile <path>]
// 출력: <runDir>/scope.json 저장 + stdout 요약. 실패해도 exit 0 + reason.
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');

const DEFAULT_BASE_BRANCHES = ['main', 'master', 'develop', 'release/*', 'release-*'];

// refs/heads/x, refs/remotes/<원격>/x → x
function shortRef(ref) { return ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, ''); }
function isBaseBranch(ref, patterns) { const s = shortRef(ref); return (patterns || DEFAULT_BASE_BRANCHES).some((g) => L.globToRegExp(g).test(s)); }

// 프로필 `## 티어 규칙` 의 "- 기준 브랜치: `main`, `release/*`" 줄이 있으면 그것을 쓴다.
function baseBranchesFrom(profilePath, fallback) {
  if (!profilePath || !fs.existsSync(profilePath)) return fallback;
  const sec = L.parseProfile(fs.readFileSync(profilePath, 'utf8')).sections['티어 규칙'] || '';
  const line = sec.split('\n').find((l) => /^\s*[-*]\s*기준 브랜치\s*:/.test(l));
  const globs = line ? [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [];
  return globs.length ? globs : fallback;
}

// 반환: base, source, ref(고른 브랜치), check('ok' | 'confirm')
// confirm = merge-base 로 고른 기준 브랜치가 main/release 류가 아님. 스택 브랜치이거나, 내 브랜치 중간에서
// 갈라진 남의 브랜치에 기준을 뺏긴 것일 수 있어 사람이 확인한다.
function findBase(root, branch, explicit, baseBranches) {
  if (explicit) {
    const sha = L.git(['rev-parse', explicit], { cwd: root, allowFail: true }).trim();
    if (sha) return { base: sha, source: `--base ${explicit}`, ref: explicit, check: 'ok' };
    return { base: null, source: `--base ${explicit} 해석 실패`, ref: null, check: 'ok' };
  }
  // 1) reflog 생성 기록. "Created from HEAD" 처럼 sha 가 아닌 토큰은 지금의 HEAD 로 풀려 쓸모없으므로 sha 만 신뢰.
  const head = L.git(['rev-parse', 'HEAD'], { cwd: root }).trim();
  const reflog = L.git(['reflog', 'show', branch, '--format=%gs'], { cwd: root, allowFail: true });
  const created = [...reflog.matchAll(/Created from ([0-9a-f]{7,40})\b/g)].pop();
  if (created) {
    const sha = L.git(['rev-parse', created[1]], { cwd: root, allowFail: true }).trim();
    if (sha && sha !== head) return { base: sha, source: `reflog "Created from ${created[1]}"`, ref: created[1], check: 'ok' };
  }
  // 2) 다른 모든 ref 와의 merge-base 중 HEAD 에 가장 가까운 것.
  // 거리 0(merge-base 가 HEAD 자신)은 버린다. 내 브랜치 끝에서 이어서 만든 브랜치가 있으면 그 브랜치와의
  // merge-base 가 HEAD 가 되어 범위가 비어 버린다(2026-10-21 실측: feature/mfa-totp-fixes 가 BASE 를 가져감).
  const refs = L.git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd: root })
    .split('\n').filter(Boolean)
    .filter((r) => !r.endsWith('/' + branch) && !r.endsWith('/HEAD'));
  let best = null, bestN = Infinity;
  for (const r of refs) {
    const mb = L.git(['merge-base', 'HEAD', r], { cwd: root, allowFail: true }).trim();
    if (!mb || mb === head) continue;
    const n = parseInt(L.git(['rev-list', '--count', `${mb}..HEAD`], { cwd: root }).trim(), 10);
    // 같은 거리면 기준 브랜치(main 류)를 우선한다
    const std = isBaseBranch(r, baseBranches);
    if (n < bestN || (n === bestN && std && best && !best.std)) { bestN = n; best = { base: mb, source: `merge-base with ${r}`, ref: r, std }; }
  }
  if (!best) return { base: null, source: 'reflog 없음, 거리 0 이 아닌 공유 ref 없음', ref: null, check: 'ok' };
  return { base: best.base, source: best.source, ref: best.ref, check: best.std ? 'ok' : 'confirm' };
}

function parseNumstat(text) {
  return text.split('\n').filter(Boolean).map((l) => {
    const [a, d, p] = l.split('\t');
    return { path: p, added: a === '-' ? 0 : parseInt(a, 10), deleted: d === '-' ? 0 : parseInt(d, 10) };
  });
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const root = L.repoRoot(args.cwd || process.cwd());
  const branch = L.branchSlug(root);
  const head = L.git(['rev-parse', 'HEAD'], { cwd: root }).trim();
  const manifest = L.loadManifest();
  const baseBranches = baseBranchesFrom(args.profile, manifest.baseBranches || DEFAULT_BASE_BRANCHES);
  const { base, source, ref, check } = findBase(root, branch, args.base, baseBranches);
  const runDir = args['run-dir'] ? path.resolve(args['run-dir']) : L.runsDir(root, branch);
  const out = { branch, base, baseSource: source, baseRef: ref, baseCheck: check, head, commits: [], files: [], uncommitted: false, patchPath: null, commitsPath: null, runDir, reason: null };
  if (!base) { out.reason = 'BASE 를 정하지 못함. --base <ref> 를 주세요.'; L.writeJson(path.join(runDir, 'scope.json'), out); console.log(`scope: 실패 (${out.reason})`); return; }

  const log = L.git(['log', `${base}..HEAD`, '--format=%h%x1f%s%x1f%b%x1e'], { cwd: root });
  out.commits = log.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => { const [sha, subject, body] = rec.split('\x1f'); return { sha, subject, body: (body || '').trim() }; });
  const committed = parseNumstat(L.git(['diff', '--numstat', `${base}...HEAD`], { cwd: root }));
  const working = parseNumstat(L.git(['diff', '--numstat', 'HEAD'], { cwd: root }));
  out.uncommitted = working.length > 0;
  const byPath = new Map();
  for (const f of [...committed, ...working]) {
    const prev = byPath.get(f.path) || { path: f.path, added: 0, deleted: 0 };
    byPath.set(f.path, { path: f.path, added: prev.added + f.added, deleted: prev.deleted + f.deleted });
  }
  out.files = [...byPath.values()];
  const ts = L.stamp();
  const patch = L.git(['diff', `${base}...HEAD`], { cwd: root }) + (out.uncommitted ? '\n' + L.git(['diff', 'HEAD'], { cwd: root }) : '');
  out.patchPath = L.writeText(path.join(runDir, `diff-${ts}.patch`), patch);
  out.commitsPath = L.writeText(path.join(runDir, `commits-${ts}.txt`), out.commits.map((c) => `${c.sha} ${c.subject}\n${c.body}\n`).join('\n'));
  out.totalAdded = out.files.reduce((s, f) => s + f.added, 0);
  out.totalDeleted = out.files.reduce((s, f) => s + f.deleted, 0);
  // 범위가 비면 "변경 없음" 으로 조용히 skip 하지 않고 실패로 알린다. 기준을 잘못 잡았을 가능성이 크다.
  if (!out.commits.length && !out.uncommitted) out.reason = `범위가 비어 있음(커밋 0, 미커밋 없음). 기준 ${source} 가 맞는지 확인하고 필요하면 --base <ref> 를 주세요.`;
  L.writeJson(path.join(runDir, 'scope.json'), out);
  if (out.reason) { console.log(`scope: 실패 (${out.reason})`); return; }
  console.log(`scope: ${branch} BASE ${base.slice(0, 8)} (${source}) .. ${head.slice(0, 8)}, 커밋 ${out.commits.length}, 파일 ${out.files.length} (+${out.totalAdded}/-${out.totalDeleted}), 미커밋 ${out.uncommitted ? '있음' : '없음'}`);
  if (check === 'confirm') console.log(`scope: 기준 확인 필요. 고른 기준 ${ref} 가 기준 브랜치(${baseBranches.join(', ')})가 아님. 스택 브랜치면 그대로, 아니면 --base <ref>`);
  console.log(`scope.json: ${path.join(runDir, 'scope.json')}`);
  console.log(`patch: ${out.patchPath}`);
}

if (require.main === module) { try { main(); } catch (e) { console.log(`scope: 실패 (${e.message})`); } }
module.exports = { findBase, parseNumstat, isBaseBranch, baseBranchesFrom, shortRef, DEFAULT_BASE_BRANCHES };
