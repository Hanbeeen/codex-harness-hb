#!/usr/bin/env node
// blast.js : qa-perf-side 워커 대체. 변경 심볼의 호출자 수(blast radius) + 추가 비용 패턴 열거. 판단 없음.
// 사용: node blast.js --scope <scope.json> [--out <file>]
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');
const D = require('./diffparse.js');

function grade(n) { return n <= 5 ? 'LOW' : n <= 20 ? 'MEDIUM' : n <= 50 ? 'HIGH' : 'CRITICAL'; }

function callers(root, name, definingPath) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return { count: 0, files: [] };
  const out = L.git(['grep', '-n', '-w', '-I', '--', name, '--', '*.js', '*.ts', '*.vue', '*.mjs', '*.cjs', ':!node_modules', ':!*.spec.*', ':!*.test.*', ':!dist'], { cwd: root, allowFail: true });
  const lines = out.split('\n').filter(Boolean).filter((l) => !/^(.+?):\d+:\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+/.test(l) || !l.startsWith(definingPath + ':'));
  const files = [...new Set(lines.map((l) => l.split(':')[0]))];
  return { count: lines.length, files };
}

const COST_RULES = [
  { tag: 'sync-io', re: /\b(execSync|readFileSync|writeFileSync|spawnSync|readdirSync)\s*\(/ },
  { tag: 'timer', re: /\b(setInterval|setTimeout)\s*\(/ },
  { tag: 'cache', re: /\b(cache|Cache|invalidate|localStorage\.(set|remove)Item)\b/ },
  { tag: 'global-state', re: /^\s*(?:global|window|process)\.\w+\s*=/ },
  { tag: 'db-call', re: /\.(find|findOne|findById|updateOne|updateMany|aggregate|countDocuments|insertMany|deleteMany)\s*\(/ },
  { tag: 'http-call', re: /\b(fetch|axios|got|request)\s*[.(]/ },
];
const LOOP_RE = /\b(for|while)\s*\(|\.(forEach|map|reduce)\s*\(/;

function addedCost(files) {
  const rows = [];
  for (const f of files) for (const h of f.hunks) {
    let loopDepth = 0, loopStartIdx = -1;
    h.lines.forEach((l, i) => {
      if (l.type === '+' && LOOP_RE.test(l.text)) { loopDepth = 1; loopStartIdx = i; }
      if (l.type === '+') {
        const inLoop = loopDepth > 0 && i - loopStartIdx <= 12;
        if (inLoop && /\bawait\b/.test(l.text)) rows.push({ path: f.path, line: l.newLine, tag: 'await-in-loop', text: l.text.trim() });
        for (const r of COST_RULES) if (r.re.test(l.text)) rows.push({ path: f.path, line: l.newLine, tag: inLoop ? r.tag + '(loop)' : r.tag, text: l.text.trim() });
      }
      if (l.type === '-' && /\b(clear|invalidate|removeEventListener|unsubscribe|close|dispose|cleanup|off)\s*\(/.test(l.text)) rows.push({ path: f.path, line: null, tag: 'removed-cleanup', text: l.text.trim() });
    });
  }
  return rows;
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const scope = L.readJson(args.scope);
  const root = L.repoRoot(process.cwd());
  const files = D.parsePatch(fs.readFileSync(scope.patchPath, 'utf8'));
  const symbols = D.extractSymbols(files).filter((s) => ['function', 'const', 'class', 'method', 'context'].includes(s.kind));
  const md = ['## blast radius (변경 심볼 → 호출자 수)', '', '| 심볼 | 정의 파일 | 호출 줄 수 | 등급 | 호출 파일 |', '|:---|:---|---:|:---|:---|'];
  const findings = [];
  for (const s of symbols) {
    const c = callers(root, s.name, s.path);
    md.push(`| \`${s.name}\` | ${s.path} | ${c.count} | ${grade(c.count)} | ${c.files.slice(0, 6).join(', ')}${c.files.length > 6 ? ' …' : ''} |`);
    findings.push({ worker: 'blast.js', lens: 'blast-radius', severity: grade(c.count) === 'LOW' ? 'minor' : grade(c.count) === 'MEDIUM' ? 'minor' : grade(c.count) === 'HIGH' ? 'important' : 'critical', file: s.path, line: s.line, symbol: s.name, snippet: '', summary: `호출자 ${c.count}곳 (${grade(c.count)})`, failure_scenario: `호출 파일: ${c.files.join(', ')}`, evidence: 'git grep -n -w', in_diff: true, verdict: null, tc_id: null });
  }
  const cost = addedCost(files);
  md.push('', '## 추가 비용 패턴 (`+` 줄, 판단 없음)', '');
  if (!cost.length) md.push('(해당 없음)');
  for (const r of cost) { md.push(`- [${r.tag}] ${r.path}${r.line ? ':' + r.line : ''} \`${r.text.slice(0, 120)}\``); findings.push({ worker: 'blast.js', lens: 'added-cost', severity: 'minor', file: r.path, line: r.line, symbol: '', snippet: r.text, summary: r.tag, failure_scenario: '사실만: 패턴 일치', evidence: 'diff + 줄', in_diff: true, verdict: null, tc_id: null }); }
  const out = args.out || path.join(scope.runDir, 'blast.md');
  L.writeText(out, md.join('\n') + '\n');
  L.writeJson(path.join(scope.runDir, 'blast.json'), findings);
  console.log(`blast: 심볼 ${symbols.length}, 비용 패턴 ${cost.length} → ${out}`);
}

if (require.main === module) { try { main(); } catch (e) { console.log(`blast: 실패 (${e.message})`); } }
module.exports = { grade, addedCost };
