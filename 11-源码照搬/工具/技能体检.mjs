#!/usr/bin/env node
/**
 * 技能体检.mjs —— 技能是否符合「一技能一场景 / frontmatter 齐 / 不超线」（照搬《04/自检清单》+ 参照的 技能完整性体检）
 *
 * 治什么：技能目录里堆着**没人用的技能**（没有对应场景），frontmatter 缺字段会被引擎**静默忽略**，
 * 长的 SKILL.md 会把每轮注入的目录摘要撑大。这三件都不会报错 —— 只会"看着有，其实没用"。
 *
 * 判据（唯一出处 = 本文件）：
 *   ① **frontmatter**：首行必须是 `---`，且含 `name:` 与 `description:`（⛔ 缺一个整条技能被引擎忽略）
 *   ② **一技能一场景**：技能的 `name` 必须被某个场景 json 的 `skill` 字段引用
 *      → 没被引用的叫**孤儿技能**（⚠ 不阻断，但要列出来 —— 它每轮都在花 token）
 *   ③ **体积**：`SKILL.md` ≤ 12 KB（⛔ 超了必须拆子技能，不是硬压）
 *   ④ **指针带触发句**：`SKILL.md` 里若写了 `读 xxx.md`（引用参考件），同段必须出现
 *      「时 / 前 / 若 / 当 / 遇到 / 需要」之一 → 否则 ⚠（只写路径 = 等于没写）
 *
 * 用法：
 *   node 工具\技能体检.mjs            # 检查（⛔ ⇒ exit 1；孤儿只 ⚠）
 *   node 工具\技能体检.mjs --quiet    # 一行
 *   node 工具\技能体检.mjs --strict   # 孤儿也算 ⛔（场景还没建的阶段别开）
 *   node 工具\技能体检.mjs --selftest # 反例：缺 frontmatter / 超线 / 孤儿 必须能报
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const SKILLS = process.env.DSH_SKILLS_DIR || path.join(ROOT, '引擎数据', '.dsh', 'skills');
const SCEN = path.join(ROOT, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MAX_BYTES = 12 * 1024;

/** 收集场景里声明的主技能 */
export function sceneSkills() {
  const map = new Map();   // skillName -> [场景名…]
  if (!fs.existsSync(SCEN)) return map;
  for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8').replace(/^\uFEFF/, ''));
      if (j && j.skill) {
        const arr = map.get(j.skill) || [];
        arr.push(j.name || j.id || f);
        map.set(j.skill, arr);
      }
    } catch { /* 坏 json 交给场景体检 */ }
  }
  return map;
}

/** 判一个技能目录 */
export function checkOne(dir, name, skillsByScene, strict) {
  const bad = [], warn = [], ok = [];
  const f = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(f)) { bad.push('缺 SKILL.md'); return { name, bad, warn, ok }; }
  const text = fs.readFileSync(f, 'utf8');
  const size = Buffer.byteLength(text);

  // ① frontmatter
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') bad.push('首行不是 ---（frontmatter 缺失 ⇒ 引擎忽略整条技能）');
  else {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end < 0) bad.push('frontmatter 没有结束的 ---');
    else {
      const fm = lines.slice(1, end).join('\n');
      if (!/^name:\s*\S/m.test(fm)) bad.push('frontmatter 缺 name:（引擎会忽略整条）');
      if (!/^description:\s*\S/m.test(fm)) bad.push('frontmatter 缺 description:（引擎会忽略整条）');
      if (/^name:/m.test(fm) && !bad.length) ok.push('frontmatter 齐');
    }
  }

  // ② 一技能一场景
  const owners = skillsByScene.get(name);
  if (owners && owners.length) ok.push('归 ' + owners.join(' / '));
  else {
    const msg = '孤儿技能（没有场景 json 的 skill 字段引用它）—— 每轮都在花 token 但没人用';
    if (strict) bad.push(msg); else warn.push(msg);
  }

  // ③ 体积
  if (size > MAX_BYTES) bad.push(`SKILL.md ${(size / 1024).toFixed(1)} KB 超 12 KB（拆子技能，⛔ 别硬压）`);
  else ok.push((size / 1024).toFixed(1) + ' KB');

  // ④ 指针带触发句
  const refLines = text.split(/\r?\n/).filter((l) => /读\s*`?[\w\\/.-]+\.md/.test(l));
  for (const l of refLines) {
    if (!/时|前|若|当|遇到|需要/.test(l)) warn.push('指针没写「什么时候读」：' + l.trim().slice(0, 80));
  }
  if (refLines.length && !warn.some((w) => w.startsWith('指针'))) ok.push('参考件指针 ' + refLines.length + ' 处（都带触发句）');

  return { name, bad, warn, ok };
}

export function run(strict = false) {
  if (!fs.existsSync(SKILLS)) return [];
  const map = sceneSkills();
  const dirs = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return dirs.map((d) => checkOne(path.join(SKILLS, d), d, map, strict));
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });
  const tmp = path.join(ROOT, '_临时', 'scrap', '技能体检自测');
  const mk = (name, text) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), text, 'utf8'); return d; };
  fs.rmSync(tmp, { recursive: true, force: true });

  const good = '---\nname: t1\ndescription: x\n---\n\n# T\n';
  const map = new Map([['t1', ['某场景']]]);

  // ① 缺 frontmatter
  {
    const d = mk('a', '没有 frontmatter\n');
    const r = checkOne(d, 'a', map, false);
    add(r.bad.some((b) => b.includes('首行')), '反例① 缺 frontmatter ⇒ ⛔', r.bad.join(' | '));
  }
  // ② 缺 name
  {
    const d = mk('b', '---\ndescription: x\n---\n');
    const r = checkOne(d, 'b', map, false);
    add(r.bad.some((b) => b.includes('name:')), '反例② frontmatter 缺 name ⇒ ⛔', r.bad.join(' | '));
  }
  // ③ 超 12 KB
  {
    const d = mk('c', good + 'x'.repeat(13000));
    const r = checkOne(d, 'c', map, false);
    add(r.bad.some((b) => b.includes('超 12 KB')), '反例③ SKILL.md 超 12 KB ⇒ ⛔', r.bad.join(' | '));
  }
  // ④ 孤儿技能（非 strict ⇒ ⚠；strict ⇒ ⛔）
  {
    const d = mk('orphan', good.replace('name: t1', 'name: orphan').replace('description: x', 'description: x'));
    const r1 = checkOne(d, 'orphan', map, false);
    const r2 = checkOne(d, 'orphan', map, true);
    add(r1.warn.some((w) => w.includes('孤儿')) && r2.bad.some((b) => b.includes('孤儿')), '反例④ 孤儿技能：默认 ⚠、--strict 时 ⛔', 'warn=' + r1.warn.length + ' bad=' + r2.bad.length);
  }
  // ⑤ 指针没写触发句
  {
    const d = mk('p', good + '\n读 `reference\\x.md`\n');
    const r = checkOne(d, 'p', map, false);
    add(r.warn.some((w) => w.startsWith('指针')), '反例⑤ 引用参考件但没写「什么时候读」⇒ ⚠', r.warn.join(' | '));
  }
  // ⑥ 正例
  {
    const d = mk('t1', good + '\n要 换会话 时，读 `reference\\x.md`\n');
    const r = checkOne(d, 't1', map, false);
    add(r.bad.length === 0 && r.ok.some((o) => o.includes('归')), '正例 齐且被引用 ⇒ 通过', r.bad.join(' | '));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- 入口 ---------------- */
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();

if (isMain) {
  if (has('--selftest')) process.exit(selftest());
  if (has('--help') || has('-h')) {
    console.log([
      '技能体检.mjs —— 一技能一场景 / frontmatter / 体积',
      '  node 工具\\技能体检.mjs           检查',
      '  node 工具\\技能体检.mjs --quiet   一行',
      '  node 工具\\技能体检.mjs --strict  孤儿也当 ⛔',
      '  node 工具\\技能体检.mjs --selftest 反例自证',
    ].join('\n'));
    process.exit(0);
  }
  const rows = run(has('--strict'));
  const badN = rows.filter((r) => r.bad.length).length;
  const warnN = rows.filter((r) => !r.bad.length && r.warn.length).length;

  if (has('--quiet')) {
    console.log(badN ? `⛔ 技能体检：${badN}/${rows.length} 个技能有问题（跑 node 工具\\技能体检.mjs 看明细）`
      : `✓ 技能体检：${rows.length} 个技能合规${warnN ? '（⚠ ' + warnN + ' 个有告警）' : ''}`);
    process.exit(badN ? 1 : 0);
  }
  for (const r of rows) {
    console.log('\n' + r.name + '：' + (r.bad.length ? '✗ ' + r.bad.length : '✓') + (r.warn.length ? ' · ⚠ ' + r.warn.length : ''));
    for (const b of r.bad) console.log('   ✗ ' + b);
    for (const w of r.warn) console.log('   ⚠ ' + w);
    if (!has('--verbose')) continue;
    for (const o of r.ok) console.log('   ✓ ' + o);
  }
  console.log('\n' + (badN ? `⛔ ${badN}/${rows.length} 个技能有问题` : `✓ ${rows.length} 个技能全部合规`) + (warnN ? ` · ⚠ ${warnN} 个有告警` : ''));
  process.exit(badN ? 1 : 0);
}
