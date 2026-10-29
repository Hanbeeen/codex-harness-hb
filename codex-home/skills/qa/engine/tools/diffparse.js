// diffparse.js : unified diff 파싱 + 변경 심볼 추출(정규식 휴리스틱, JS/TS/Vue 중심).
const TEST_FN = new Set(['describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach']);
// 심볼로 잡히면 안 되는 이름: 언어 키워드 + 어느 파일에나 나오는 내장, 전역.
// hunk 헤더에서 `const x = require('y')` 의 `require(` 를 심볼로 오인해 "호출자 485곳" 같은
// 무의미한 blast radius 를 내던 것을 막는다(2026-09-17 실측).
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'new', 'await', 'typeof', 'import', 'export', 'default', 'constructor',
  'require', 'module', 'exports', 'console', 'process', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set', 'Date', 'RegExp', 'Error',
  'parseInt', 'parseFloat', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Buffer', 'Symbol', 'BigInt',
]);

function parsePatch(patch) {
  const files = [];
  let cur = null, hunk = null, newLine = 0;
  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    const fh = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fh) { cur = { path: fh[2], hunks: [], deleted: false, binary: false }; files.push(cur); hunk = null; continue; }
    if (!cur) continue;
    if (/^deleted file mode/.test(raw)) cur.deleted = true;
    if (/^Binary files/.test(raw)) cur.binary = true;
    const hh = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (hh) { hunk = { oldStart: +hh[1], newStart: +hh[3], newCount: hh[4] ? +hh[4] : 1, ctx: hh[5].trim(), lines: [] }; cur.hunks.push(hunk); newLine = +hh[3]; continue; }
    if (!hunk) continue;
    if (raw.startsWith('+')) { hunk.lines.push({ type: '+', text: raw.slice(1), newLine }); newLine++; }
    else if (raw.startsWith('-')) hunk.lines.push({ type: '-', text: raw.slice(1), newLine: null });
    else if (raw.startsWith(' ') || raw === '') { hunk.lines.push({ type: ' ', text: raw.slice(1), newLine }); newLine++; }
  }
  return files;
}

const SYM_RULES = [
  { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'method', re: /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[\w<>\[\]|, ]+)?\s*\{\s*$/, filter: (n) => !KEYWORDS.has(n) },
  { kind: 'route', re: /(?:router|app)\.(get|post|put|patch|delete|use)\(\s*['"`]([^'"`]+)/, pick: (m) => `${m[1].toUpperCase()} ${m[2]}` },
  { kind: 'env', re: /process\.env\.([A-Z][A-Z0-9_]+)/ },
  { kind: 'storage', re: /localStorage\.(?:getItem|setItem|removeItem)\(\s*['"`]([^'"`]+)/ },
  { kind: 'field', re: /^\s*([A-Za-z_$][\w$]*)\s*:\s*\{\s*type\s*:/ },
];

function extractSymbols(files) {
  const out = [];
  const seen = new Set();
  for (const f of files) {
    if (/\.(spec|test)\.[jt]sx?$/.test(f.path)) continue;   // 테스트 파일은 심볼 대상 아님
    const isConst = /status|constant|enum|permission/i.test(f.path);
    for (const h of f.hunks) {
      if (h.ctx) {
        const m = h.ctx.match(/(?:function\s+)?([A-Za-z_$][\w$]*)\s*\(/);
        if (m && !KEYWORDS.has(m[1]) && !TEST_FN.has(m[1])) push(f.path, 'context', m[1], h.newStart);
      }
      for (const l of h.lines) {
        if (l.type !== '+') continue;
        for (const r of SYM_RULES) {
          const m = l.text.match(r.re);
          if (!m) continue;
          const name = r.pick ? r.pick(m) : m[1];
          if (r.filter && !r.filter(name)) continue;
          if (r.kind === 'const' && /^\s+/.test(l.text) && !/^\s*export\b/.test(l.text)) continue;   // 함수 안 지역 const 제외
          if (r.kind === 'method' && /^\s{6,}/.test(l.text)) continue;
          push(f.path, r.kind, name, l.newLine);
        }
        if (isConst) { const q = l.text.match(/^\s*['"]([a-z][a-z0-9-]{2,})['"]\s*,?\s*$/); if (q) push(f.path, 'enum-value', q[1], l.newLine); }
      }
    }
  }
  return out;
  function push(path, kind, name, line) { const k = `${path}|${kind}|${name}`; if (seen.has(k)) return; seen.add(k); out.push({ path, kind, name, line }); }
}

module.exports = { parsePatch, extractSymbols };
