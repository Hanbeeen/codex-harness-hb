#!/usr/bin/env node
// tier.js : 티어 제안 + 조건부 워커 발동. manifest.rules 의 glob 규칙. 메인이 덮어쓸 수 있는 "제안".
// 사용: node tier.js --scope <scope.json> [--profile <path>] [--force light|full|max]
// 규칙은 manifest.rules 가 기본이고, 프로필에 `## 티어 규칙` 절이 있으면 그것이 이긴다.
// 레포 구조가 기본 glob 과 다른 프로젝트는 프로필만 고치면 되고 코어는 손대지 않는다.
const fs = require('node:fs');
const L = require('./lib.js');

// 프로필 형식(전부 선택):
//   - skip: `**/*.md`, `docs/**`
//   - max: `**/models/**`, `**/migrate*`
//   - security: `**/routes/**`
//   - upgrade: `**/models/**`
//   - ui: `frontend/**`
//   - light 상한: 파일 2개, 80줄
function rulesFromProfile(text, base) {
  const sec = L.parseProfile(text).sections['티어 규칙'];
  if (!sec) return { rules: base, source: 'manifest 기본값' };
  const rules = JSON.parse(JSON.stringify(base));
  for (const line of sec.split('\n')) {
    const m = line.match(/^\s*[-*]\s*([^:]+):\s*(.*)$/); if (!m) continue;
    const key = m[1].trim(); const globs = [...m[2].matchAll(/`([^`]+)`/g)].map((g) => g[1]);
    if (key === 'skip' && globs.length) rules.skip = globs;
    else if (key === 'max' && globs.length) rules.max = globs;
    else if (['security', 'upgrade', 'ui'].includes(key) && globs.length) rules.activate[key] = globs;
    else if (/light/.test(key)) { const n = m[2].match(/(\d+)\D+(\d+)/); if (n) { rules.lightMaxFiles = +n[1]; rules.lightMaxLines = +n[2]; } }
  }
  return { rules, source: '프로필 ## 티어 규칙' };
}

function decide(scope, rules) {
  const files = scope.files.map((f) => f.path);
  const reasons = [];
  const nonSkip = files.filter((p) => !L.matchAny(p, rules.skip));
  const activate = {
    security: files.some((p) => L.matchAny(p, rules.activate.security)),
    upgrade: files.some((p) => L.matchAny(p, rules.activate.upgrade)),
    ui: files.some((p) => L.matchAny(p, rules.activate.ui)),
  };
  let tier;
  if (nonSkip.length === 0) { tier = 'skip'; reasons.push('실행 코드 변경 없음(문서, 설정, 타입선언만)'); }
  else if (files.some((p) => L.matchAny(p, rules.max))) {
    tier = 'max';
    reasons.push('고위험 경로 변경: ' + files.filter((p) => L.matchAny(p, rules.max)).slice(0, 4).join(', '));
  } else {
    const codeFiles = nonSkip.filter((p) => !/\.(spec|test)\.[jt]sx?$/.test(p));
    const lines = scope.files.filter((f) => codeFiles.includes(f.path)).reduce((s, f) => s + f.added + f.deleted, 0);
    if (codeFiles.length <= rules.lightMaxFiles && lines <= rules.lightMaxLines) { tier = 'light'; reasons.push(`국소 수정: 코드 파일 ${codeFiles.length}개, ${lines}줄`); }
    else { tier = 'full'; reasons.push(`코드 파일 ${codeFiles.length}개, ${lines}줄(light 상한 ${rules.lightMaxFiles}파일, ${rules.lightMaxLines}줄 초과)`); }
  }
  const caps = { skip: 0, light: 4, full: 10, max: 15 };
  return { tier, reasons, activate, maxFindings: caps[tier], nonSkipFiles: nonSkip };
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const m = L.loadManifest();
  const scope = L.readJson(args.scope);
  let rules = m.rules, rulesSource = 'manifest 기본값';
  if (args.profile && fs.existsSync(args.profile)) ({ rules, source: rulesSource } = rulesFromProfile(fs.readFileSync(args.profile, 'utf8'), m.rules));
  const r = decide(scope, rules);
  r.rulesSource = rulesSource;
  // 탐색 상한(소프트): 워커가 이 횟수에 닿으면 탐색을 멈추고 결과를 정리한다. 하드 한도(maxTurns)는
  // 이보다 넉넉해, 상한에 닿아도 결과를 낼 여지가 남는다.
  const b = m.tools.softTurns || { base: 8, perFiles: 4, cap: 20 };
  r.softTurns = Math.min(b.cap, b.base + Math.ceil(scope.files.length / b.perFiles));
  if (args.force && ['light', 'full', 'max', 'skip'].includes(args.force)) { r.reasons.unshift(`--tier ${args.force} 강제(제안은 ${r.tier})`); r.tier = args.force; r.maxFindings = { skip: 0, light: 4, full: 10, max: 15 }[args.force]; }
  if (r.tier === 'max') { r.activate.security = true; r.activate.upgrade = true; }
  const out = scope.runDir ? L.writeJson(require('node:path').join(scope.runDir, 'tier.json'), r) : null;
  console.log(`tier: ${r.tier} (${r.reasons.join(' / ')}), 발동: security=${r.activate.security} upgrade=${r.activate.upgrade} ui=${r.activate.ui}, 후보 상한 ${r.maxFindings}, 탐색 상한 ${r.softTurns}회, 규칙 ${r.rulesSource}`);
  if (out) console.log(`tier.json: ${out}`);
}

if (require.main === module) { try { main(); } catch (e) { console.log(`tier: 실패 (${e.message})`); } }
module.exports = { decide, rulesFromProfile };
