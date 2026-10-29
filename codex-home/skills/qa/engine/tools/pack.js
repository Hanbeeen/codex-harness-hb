#!/usr/bin/env node
// pack.js : finder 입력 사전 포장. 파일당 하나씩 쪼개 저장하고 목차(index.md)를 만든다.
//  <runDir>/pack/index.md            목차(파일, 증감, 줄수, 태그, 경로)
//  <runDir>/pack/NN-<경로>.md        파일 1개의 diff, 둘러싼 함수, 호출자, (작으면) 전문
// 워커는 index 를 읽고 필요한 파일만 Read 한다. 한 파일이 커도 다른 파일 읽기에 영향을 주지 않는다.
// 사용: node pack.js --scope <scope.json> [--outdir <dir>]
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');
const D = require('./diffparse.js');

const FN_START = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b|(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|(?!(?:if|for|while|switch|catch|return|typeof|new|await|do|else)\b)[\w$]+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$|(?:public|private|protected|static)\s+[\w$]+\s*\()/;

function scriptRange(lines, isVue) {
  if (!isVue) return [0, lines.length - 1];
  const s = lines.findIndex((l) => /^<script\b/.test(l)); const e = lines.findIndex((l, i) => i > s && /^<\/script>/.test(l));
  return s >= 0 && e > s ? [s + 1, e - 1] : [0, lines.length - 1];
}

// 중괄호 매칭으로 line(0-based) 을 둘러싼 함수의 [start,end] 를 찾는다. 실패 시 null.
function enclosingFunction(lines, line, range) {
  const [lo, hi] = range;
  for (let s = Math.min(line, hi); s >= lo; s--) {
    if (!FN_START.test(lines[s])) continue;
    let depth = 0, opened = false;
    for (let e = s; e <= hi; e++) {
      for (const ch of lines[e]) { if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--; }
      if (opened && depth === 0) { if (e >= line) return [s, e]; break; }
    }
  }
  return null;
}

function mergeRanges(ranges) {
  ranges.sort((a, b) => a[0] - b[0]); const out = [];
  for (const r of ranges) { const last = out[out.length - 1]; if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([...r]); }
  return out;
}

function fileDiffText(patch, filePath) {
  const parts = patch.split(/^(?=diff --git )/m);
  return parts.find((p) => p.startsWith(`diff --git a/${filePath} b/${filePath}`)) || '';
}

function slugify(p) { return p.replace(/[\\/]/g, '-').replace(/[^\w.\-가-힣]/g, '_').slice(-80); }

// manifest.rules.activate 로 파일 태그를 붙인다. 규칙이 안 맞으면 태그가 없을 뿐(워커는 전체를 봄).
function tagsFor(p, rules) {
  if (!rules || !rules.activate) return [];
  return Object.entries(rules.activate).filter(([, globs]) => L.matchAny(p, globs)).map(([k]) => k);
}

// compact=true 면 문맥과 호출자를 좁혀 다시 만든다(파일당 상한 초과 시 2차 시도).
// 잘린 만큼은 워커가 원본을 직접 읽으면 되므로, 좁혀도 도달 가능성은 유지된다.
function buildOne(f, patch, root, m, symbols, compact = false) {
  const md = [`# ${f.path}`, ''];
  const notes = [];
  const ctxPad = compact ? 15 : 40;
  const callerLines = compact ? 5 : 20;
  if (f.binary) { md.push('(binary)'); return { md: md.join('\n') + '\n', notes }; }
  const abs = path.join(root, f.path);
  md.push('## diff', '```diff', fileDiffText(patch, f.path).trimEnd(), '```', '');
  if (f.deleted || !fs.existsSync(abs)) { md.push('(삭제된 파일. diff 만)'); return { md: md.join('\n') + '\n', notes }; }
  if (/\.(spec|test)\.[jt]sx?$/.test(f.path)) { md.push('(테스트 파일: diff 만 포장. 전문이 필요하면 직접 Read)'); return { md: md.join('\n') + '\n', notes }; }

  const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines.length < m.tools.packMaxLines) {
    md.push(`## 전문 (${lines.length}줄)`, '```', ...lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`), '```', '');
  } else {
    const isVue = f.path.endsWith('.vue');
    const range = scriptRange(lines, isVue);
    const ranges = [];
    for (const h of f.hunks) {
      const plus = h.lines.filter((l) => l.type === '+' && l.newLine);
      const target = (plus[0] ? plus[0].newLine : h.newStart) - 1;
      if (isVue && (target < range[0] || target > range[1])) { ranges.push([Math.max(0, target - ctxPad), Math.min(lines.length - 1, target + ctxPad)]); notes.push(`L${target + 1}: template hunk ±${ctxPad}줄`); continue; }
      let enc = compact ? null : enclosingFunction(lines, target, range);
      if (enc && enc[1] - enc[0] > m.tools.packMaxFnLines) { notes.push(`L${target + 1}: 둘러싼 함수 ${enc[1] - enc[0] + 1}줄 > 상한 → ±30줄`); enc = [Math.max(enc[0], target - 30), Math.min(enc[1], target + 30)]; }
      if (enc) ranges.push(enc); else { ranges.push([Math.max(0, target - ctxPad), Math.min(lines.length - 1, target + ctxPad)]); if (!compact) notes.push(`L${target + 1}: 둘러싼 함수 못 찾음 → ±${ctxPad}줄`); }
    }
    md.push(`## 둘러싼 문맥 (전체 ${lines.length}줄 중 발췌${compact ? ', 축소 모드 ±' + ctxPad + '줄' : ''}. 더 필요하면 원본을 직접 Read)`, '');
    for (const [s, e] of mergeRanges(ranges)) md.push(`### L${s + 1}-L${e + 1}`, '```', ...lines.slice(s, e + 1).map((l, i) => `${String(s + i + 1).padStart(4)}| ${l}`), '```', '');
  }
  const mine = symbols.filter((s) => s.path === f.path && ['function', 'const', 'class', 'method', 'context'].includes(s.kind)).slice(0, compact ? 12 : 60);
  if (mine.length) {
    md.push(`## 호출자 (git grep -n -w, 심볼당 상위 ${callerLines}줄)`);
    for (const s of mine) {
      const out = L.git(['grep', '-n', '-w', '-I', '--', s.name, '--', '*.js', '*.ts', '*.vue', ':!node_modules', ':!dist'], { cwd: root, allowFail: true })
        .split('\n').filter(Boolean).filter((l) => !l.startsWith(f.path + ':')).slice(0, callerLines);
      md.push(`- \`${s.name}\`: ${out.length ? '' : '(다른 파일에서 호출 없음)'}`);
      for (const l of out) md.push(`  - ${l.slice(0, 160)}`);
    }
    md.push('');
  }
  if (notes.length) md.push('## 포장 메모', ...notes.map((n) => '- ' + n));
  return { md: md.join('\n') + '\n', notes };
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const m = L.loadManifest();
  const scope = L.readJson(args.scope);
  const root = L.repoRoot(process.cwd());
  const patch = fs.readFileSync(scope.patchPath, 'utf8');
  const files = D.parsePatch(patch);
  const symbols = D.extractSymbols(files);
  const outDir = args.outdir ? path.resolve(args.outdir) : path.join(scope.runDir, 'pack');
  fs.rmSync(outDir, { recursive: true, force: true });

  const stat = new Map(scope.files.map((f) => [f.path, f]));
  const rows = [];
  let totalBytes = 0, noteCount = 0;
  const maxBytes = (m.tools.packFileMaxKb || 40) * 1024;
  files.forEach((f, i) => {
    let { md, notes } = buildOne(f, patch, root, m, symbols);
    let compacted = false;
    if (Buffer.byteLength(md) > maxBytes) {
      const c = buildOne(f, patch, root, m, symbols, true);
      // 축소본이 실제로 작을 때만 채택(작은 파일 전문은 축소해도 그대로다)
      if (Buffer.byteLength(c.md) < Buffer.byteLength(md)) { md = c.md; notes = c.notes; compacted = true; }
      // 2차: 그래도 넘으면 둘러싼 문맥을 통째로 뺀다. diff 에 이미 전후 3줄이 있고, 더 필요하면
      // 워커가 원본을 Read 하면 된다. diff 와 호출자는 QA 의 1차 입력이라 남긴다.
      if (Buffer.byteLength(md) > maxBytes) {
        const head = '\n## 둘러싼 문맥';
        const i = md.indexOf(head);
        if (i >= 0) {
          const j = md.indexOf('\n## ', i + head.length);
          const stripped = md.slice(0, i) + head + '\n(상한 초과로 생략. 원본 파일을 직접 Read)\n' + (j >= 0 ? md.slice(j) : '');
          if (Buffer.byteLength(stripped) < Buffer.byteLength(md)) md = stripped;
        }
      }
    }
    const name = `${String(i + 1).padStart(2, '0')}-${slugify(f.path)}.md`;
    L.writeText(path.join(outDir, name), md);
    const s = stat.get(f.path) || { added: 0, deleted: 0 };
    const bytes = Buffer.byteLength(md);
    totalBytes += bytes; noteCount += notes.length;
    rows.push({ n: i + 1, path: f.path, added: s.added, deleted: s.deleted, kb: Math.max(1, Math.round(bytes / 1024)), tags: tagsFor(f.path, m.rules), file: name, compacted });
  });

  const idx = [];
  idx.push(`# pack 목차 (BASE ${String(scope.base).slice(0, 8)} .. ${String(scope.head).slice(0, 8)}, 파일 ${rows.length})`, '');
  idx.push('각 행의 pack 파일에 그 파일의 diff, 둘러싼 함수, 호출자 grep 결과가 들어 있다(작은 파일은 전문).');
  idx.push('**필요한 행만 Read 한다.** 태그는 참고용 우선순위이며, 태그가 비어 있어도 볼 가치가 없다는 뜻은 아니다.', '');
  idx.push('| # | 파일 | +/- | 크기 | 태그 | pack 파일 |', '|---:|:---|:---|---:|:---|:---|');
  for (const r of rows) idx.push(`| ${r.n} | ${r.path} | +${r.added}/-${r.deleted} | ${r.kb}KB${r.compacted ? '*' : ''} | ${r.tags.join(',') || '-'} | ${r.file} |`);
  idx.push('', `합계 ${Math.round(totalBytes / 1024)}KB, 포장 메모 ${noteCount}건, 별표(*) = 상한 초과로 축소. 원본을 직접 읽으면 전부 볼 수 있다.`);
  const idxPath = L.writeText(path.join(outDir, 'index.md'), idx.join('\n') + '\n');

  console.log(`pack: 파일 ${rows.length}, 심볼 ${symbols.length}, 합계 ${Math.round(totalBytes / 1024)}KB (최대 ${Math.max(...rows.map((r) => r.kb))}KB) → ${outDir}`);
  console.log(`pack index: ${idxPath}`);
}

if (require.main === module) { try { main(); } catch (e) { console.log(`pack: 실패 (${e.message})`); } }
module.exports = { enclosingFunction, mergeRanges, FN_START, slugify, tagsFor };
