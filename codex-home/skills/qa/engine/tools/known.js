#!/usr/bin/env node
// known.js : 알려진 이슈 기준선(baseline). 고치지 않기로 했거나 미룬 결함을 finder 가 매번 다시 찾고
// 다시 검증하던 비용을 없앤다(2026-10-21 실측: 같은 결함이 3회씩 재보고됨).
// 프로필 `## 알려진 이슈` 표(열 이름으로 읽고, 없으면 순서로):
//   | ID | 파일 | symbol | snippet | 결정 | 메모 |
// 행마다 diff 와 대조해 셋 중 하나로 나눈다.
//   suppress  diff 가 그 snippet 줄을 건드리지 않음 → finder 는 같은 (파일, symbol) 후보를 내지 않는다
//   reeval    diff 의 + 또는 - 줄에 snippet 이 있거나 파일이 삭제됨 → 정상 후보로 다시 본다
//   stale     지금 코드에 snippet 이 없음(이미 고쳐졌거나 옮겨짐) → 프로필에서 행 정리 대상
// 앵커는 줄 번호가 아니라 snippet 이다. 코드가 움직여도 맞고, 바뀌면 억제가 풀리는 쪽으로 실패한다.
// 사용: node known.js --scope <scope.json> --profile <path> [--out <known.json>]
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib.js');
const D = require('./diffparse.js');
const R = require('./runtime.js');

const SECTION = '알려진 이슈';

function parseKnown(profilePath) {
  if (!profilePath || !fs.existsSync(profilePath)) return null;
  const sec = L.parseProfile(fs.readFileSync(profilePath, 'utf8')).sections[SECTION];
  if (!sec) return null;
  const unq = (s) => String(s || '').trim().replace(/^`|`$/g, '').trim();
  const rows = R.parseTableEscaped(sec).map((r) => {
    const v = Object.values(r);
    return { id: unq(r['ID'] ?? v[0]), file: unq(r['파일'] ?? v[1]), symbol: unq(r['symbol'] ?? v[2]), snippet: unq(r['snippet'] ?? v[3]), decision: unq(r['결정'] ?? v[4]), memo: unq(r['메모'] ?? v[5]) };
  }).filter((x) => x.id && x.file && x.snippet);
  return rows.length ? rows : null;
}

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

function classify(rows, patchText, root) {
  const files = D.parsePatch(patchText || '');
  return rows.map((k) => {
    const want = norm(k.snippet);
    const f = files.find((x) => x.path === k.file);
    if (f && (f.deleted || f.hunks.some((h) => h.lines.some((l) => l.type !== ' ' && norm(l.text).includes(want))))) return { ...k, status: 'reeval' };
    const abs = path.join(root, k.file);
    if (!fs.existsSync(abs) || !norm(fs.readFileSync(abs, 'utf8')).includes(want)) return { ...k, status: 'stale' };
    return { ...k, status: 'suppress' };
  });
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const rows = parseKnown(args.profile);
  if (!rows) { console.log(`known: 건너뜀 (프로필에 '## ${SECTION}' 절 없음)`); return; }
  const scope = L.readJson(args.scope);
  const root = L.repoRoot(process.cwd());
  const res = classify(rows, fs.readFileSync(scope.patchPath, 'utf8'), root);
  const out = args.out || path.join(scope.runDir, 'known.json');
  L.writeJson(out, res);
  const by = (s) => res.filter((x) => x.status === s).map((x) => x.id);
  console.log(`known: 억제 ${by('suppress').length} (${by('suppress').join(', ') || '-'}), 재평가 ${by('reeval').length} (${by('reeval').join(', ') || '-'}), 코드에서 사라짐 ${by('stale').length} (${by('stale').join(', ') || '-'}) → ${out}`);
}

if (require.main === module) { try { main(); } catch (e) { console.log(`known: 실패 (${e.message})`); } }
module.exports = { parseKnown, classify, SECTION };
