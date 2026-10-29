#!/usr/bin/env node
// context.js : qa-context 워커 대체. 커밋 전문, 통계, 변경 심볼, 매뉴얼 관련 절, 카탈로그 해당 행 → context.md
// 사용: node context.js --scope <scope.json> [--profile <path>] [--out <file>]
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');
const D = require('./diffparse.js');

const STOP = new Set(['있음', '없음', '수정', '추가', '제거', '변경', '으로', '에서', '하는', '되는', '했음', '기존', '이후', '경우', '처리', '문제', '적용', '사용', '위해', '통해', '대한', '관련', '이번', '해당', '전체', '이제', 'fix', 'feat', 'chore', 'refactor', 'docs', 'test', 'the', 'and', 'for', 'with', 'from', 'this', 'that']);

function keywordsFrom(scope, symbols, minLen) {
  const set = new Set();
  for (const s of symbols) { set.add(s.name); const parts = s.name.split(/(?=[A-Z])|[_\-\s]/).filter((p) => p.length >= 3); parts.forEach((p) => set.add(p.toLowerCase())); }
  for (const c of scope.commits) {
    for (const tok of c.subject.split(/[^\p{L}\p{N}_]+/u)) {
      const t = tok.trim(); if (t.length < minLen || STOP.has(t) || /^\d+$/.test(t)) continue;
      set.add(t);
    }
  }
  for (const f of scope.files) { const b = path.basename(f.path).replace(/\.[^.]+$/, ''); if (b.length >= 3) set.add(b); }
  return [...set];
}

function expandGlobs(root, globs) {
  const out = [];
  for (const g of globs) {
    const dir = path.join(root, path.dirname(g)); const re = L.globToRegExp(path.basename(g));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push(path.join(dir, f));
  }
  return out;
}

function manualSections(root, profileSections, keywords, opts) {
  const spec = profileSections['명세 출처'] || '';
  const line = spec.split('\n').find((l) => /라이브 매뉴얼/.test(l)) || '';
  const globs = [...line.matchAll(/`([^`]+\.md)`/g)].map((m) => m[1]);
  const files = expandGlobs(root, globs);
  const hits = [];
  const kw = keywords.filter((k) => k.length >= 2).map((k) => k.toLowerCase());
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    let heading = '(머리)', buf = [];
    const flush = () => {
      if (!buf.length) return;
      const body = buf.join('\n'); const low = (heading + '\n' + body).toLowerCase();
      const matched = kw.filter((k) => low.includes(k));
      if (matched.length >= 2 || (matched.length === 1 && matched[0].length >= 5)) hits.push({ file: path.relative(root, f).replace(/\\/g, '/'), heading, body: buf.slice(0, opts.manualSectionMaxLines).join('\n'), matched });
      buf = [];
    };
    for (const l of lines) { const h = l.match(/^#{1,6}\s+(.+)$/); if (h) { flush(); heading = h[1].trim(); } else buf.push(l); }
    flush();
  }
  hits.sort((a, b) => b.matched.length - a.matched.length);
  return { files: files.map((f) => path.relative(root, f).replace(/\\/g, '/')), hits: hits.slice(0, opts.manualSectionsMax) };
}

function catalogRows(profileSections, keywords) {
  const out = [];
  const kw = keywords.map((k) => k.toLowerCase());
  for (const name of ['환경 차이 카탈로그', '대상 다양성 카탈로그']) {
    const sec = profileSections[name]; if (!sec) continue;
    for (const l of sec.split('\n')) {
      if (!l.trim().startsWith('|') || /^\|\s*:?-+/.test(l.trim())) continue;
      const low = l.toLowerCase();
      if (kw.some((k) => k.length >= 3 && low.includes(k))) out.push({ catalog: name, row: l.trim() });
    }
  }
  return out;
}

function build(scope, profilePath, manifest) {
  const root = L.repoRoot(process.cwd());
  const patch = fs.readFileSync(scope.patchPath, 'utf8');
  const files = D.parsePatch(patch);
  const symbols = D.extractSymbols(files);
  const keywords = keywordsFrom(scope, symbols, manifest.tools.contextKeywordMinLen);
  let profileSections = {};
  if (profilePath && fs.existsSync(profilePath)) profileSections = L.parseProfile(fs.readFileSync(profilePath, 'utf8')).sections;
  const manual = manualSections(root, profileSections, keywords, manifest.tools);
  const rows = catalogRows(profileSections, keywords);

  const md = [];
  md.push('## context 묶음', '', `### 커밋 메시지 (${scope.commits.length}개)`);
  for (const c of scope.commits) md.push(`**${c.sha}** ${c.subject}`, c.body ? c.body : '', '');
  md.push('### 변경 통계');
  for (const f of scope.files) md.push(`- ${f.path} (+${f.added}/-${f.deleted})`);
  md.push(`- 합계 +${scope.totalAdded ?? ''}/-${scope.totalDeleted ?? ''}, 미커밋 ${scope.uncommitted ? '포함' : '없음'}`, '');
  md.push('### 변경 심볼 (파일별)');
  const byFile = {}; for (const s of symbols) (byFile[s.path] ||= []).push(s);
  for (const [p, arr] of Object.entries(byFile)) { md.push(`**${p}**`); for (const s of arr) md.push(`- ${s.kind}: \`${s.name}\`${s.line ? ` (L${s.line})` : ''}`); md.push(''); }
  if (!symbols.length) md.push('(정규식으로 잡힌 심볼 없음. finder 가 diff 에서 직접 읽을 것)', '');
  md.push('### 매뉴얼 관련 절 (파일:heading)');
  if (!manual.files.length) md.push('(프로필에 라이브 매뉴얼 경로 없음)');
  else if (!manual.hits.length) md.push(`매뉴얼 해당 절 없음 (검색 파일: ${manual.files.join(', ')})`);
  for (const h of manual.hits) md.push(`**${h.file}:${h.heading}** (키워드: ${h.matched.slice(0, 4).join(', ')})`, h.body.trim().split('\n').map((l) => '> ' + l).join('\n'), '');
  md.push('### 카탈로그 해당 행');
  if (!rows.length) md.push('(해당 행 없음)');
  for (const r of rows) md.push(`- [${r.catalog}] ${r.row}`);
  md.push('', `### 키워드 (${keywords.length})`, keywords.slice(0, 60).join(', '));
  return { md: md.join('\n') + '\n', symbols, keywords, manualHits: manual.hits.length, rows: rows.length };
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const m = L.loadManifest();
  const scope = L.readJson(args.scope);
  const r = build(scope, args.profile, m);
  const out = args.out || path.join(scope.runDir, 'context.md');
  L.writeText(out, r.md);
  L.writeJson(path.join(scope.runDir, 'symbols.json'), r.symbols);
  console.log(`context: 커밋 ${scope.commits.length}, 심볼 ${r.symbols.length}, 매뉴얼 절 ${r.manualHits}, 카탈로그 행 ${r.rows}, 키워드 ${r.keywords.length} → ${out} (${Buffer.byteLength(r.md)}B)`);
}

if (require.main === module) { try { main(); } catch (e) { console.log(`context: 실패 (${e.message})`); } }
module.exports = { build, keywordsFrom, manualSections, catalogRows };
