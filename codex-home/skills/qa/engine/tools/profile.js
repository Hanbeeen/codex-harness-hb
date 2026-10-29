#!/usr/bin/env node
// profile.js : 프로필 탐지, 헤딩 절단, 낡음 판정.
// detect [--cwd]                → 경로 또는 "none"
// slice <path> <헤딩,헤딩> [--out f] → 절 텍스트(바이트 정규화). 없는 헤딩은 "(없음)"
// stale <path> [--cwd]           → baseCommit 이후 watchPaths 변경 목록
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');

const CANDIDATES = ['.claude/skills/qa-profile/SKILL.md', '.codex/skills/qa-profile/SKILL.md', '.qa/profile.md'];

// 프로필은 보통 untracked 라 워크트리에는 없다. 현재 체크아웃에 없으면 본 체크아웃에서 찾는다.
function detect(root) {
  const roots = [root];
  const main = L.mainCheckout(root);
  if (path.resolve(main) !== path.resolve(root)) roots.push(main);
  for (const r of roots) for (const c of CANDIDATES) { const p = path.join(r, c); if (fs.existsSync(p)) return p; }
  return null;
}

// 헤딩 비교: 공백을 무시하고, 나열 기호(가운뎃점 류, 슬래시, 쉼표)를 같은 것으로 본다.
// 템플릿은 '배포/업그레이드', 옛 프로필은 가운뎃점 표기라 이름이 달라 절이 빠지던 것을 막는다.
const LIST_MARKS = new RegExp('[' + [0xB7, 0x30FB, 0x2219].map((c) => String.fromCharCode(c)).join('') + '/,]', 'g');
function headingKey(s) { return s.replace(/\s+/g, '').replace(LIST_MARKS, '/'); }

function slice(profilePath, headings) {
  const { meta, sections } = L.parseProfile(fs.readFileSync(profilePath, 'utf8'));
  const parts = [];
  const missing = [];
  for (const h of headings) {
    const key = Object.keys(sections).find((k) => k === h || headingKey(k) === headingKey(h));
    if (key) parts.push(`## ${key}\n${sections[key]}`);
    else { parts.push(`## ${h}\n(없음)`); missing.push(h); }
  }
  return { text: L.normalizeText(parts.join('\n\n')), meta, missing };
}

function stale(profilePath, root, watchPaths) {
  const { meta } = L.parseProfile(fs.readFileSync(profilePath, 'utf8'));
  const base = meta['baseCommit'] || meta['qa.baseCommit'];
  if (!base) return { base: null, changed: [], reason: 'baseCommit 없음' };
  const ok = L.git(['rev-parse', '--verify', `${base}^{commit}`], { cwd: root, allowFail: true }).trim();
  if (!ok) return { base, changed: [], reason: `baseCommit ${base} 를 이 레포에서 찾지 못함` };
  const files = L.git(['diff', '--name-only', `${base}..HEAD`], { cwd: root }).split('\n').filter(Boolean);
  const changed = files.filter((f) => L.matchAny(f, watchPaths));
  return { base, changed, reason: null };
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const [cmd, a1, a2] = args._;
  const root = L.repoRoot(args.cwd || process.cwd());
  if (cmd === 'detect') { const p = detect(root); console.log(p || 'none'); return; }
  if (cmd === 'slice') {
    const r = slice(a1, (a2 || '').split(',').map((s) => s.trim()).filter(Boolean));
    if (args.out) { L.writeText(args.out, r.text); console.log(`slice: ${args.out} (${Buffer.byteLength(r.text)}B)${r.missing.length ? ' 없는 헤딩: ' + r.missing.join(', ') : ''}`); }
    else process.stdout.write(r.text);
    return;
  }
  if (cmd === 'stale') {
    const m = L.loadManifest();
    const r = stale(a1, root, m.watchPaths || []);
    if (r.reason) console.log(`stale: 판정 불가 (${r.reason})`);
    else console.log(r.changed.length ? `stale: 갱신 권장. ${r.base} 이후 변경: ${r.changed.join(', ')}` : `stale: OK (${r.base} 이후 감시 경로 변경 없음)`);
    return;
  }
  console.log('사용: profile.js detect | slice <path> <헤딩,…> [--out f] | stale <path>');
}

if (require.main === module) { try { main(); } catch (e) { console.log(`profile: 실패 (${e.message})`); } }
module.exports = { detect, slice, stale, headingKey, CANDIDATES };
