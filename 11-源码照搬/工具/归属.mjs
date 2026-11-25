#!/usr/bin/env node
/**
 * 归属.mjs —— 「我要改的这个东西，属于哪一档？该不该我改？」
 *
 * 照搬《05-协作与规矩/二-标准化规范》§6.8「共享件 / 专属件的修改权（五档）」。
 * 原文判据一句话：**「这份文件属于哪一档？」**
 *   A/C ⇒ 停手，报规则负责人；B ⇒ 只写自己的行；D ⇒ 自由改，但「改自己的规矩」要通知；E ⇒ 一个字都不许写。
 *
 * 为什么要有工具：人是凭感觉记档的，AI 更是 —— 一旦"顺手帮你改好"，就是 10-17 那次互相覆盖污染。
 * 把档位表变成**一条命令**，比背五档可靠。
 *
 * 用法：
 *   node 工具\归属.mjs 引擎数据\.dsh\场景记忆\控制器\场景私有记忆.md
 *   node 工具\归属.mjs 外壳\scenarios\dsh-gui.json --面板 dsh-gui-p3
 *   node 工具\归属.mjs --表                       # 只看五档表
 *   node 工具\归属.mjs --selftest                 # 5 档各一个样本 + 1 个"表外"
 *
 * 退出码：0 = 你这一档能改 / 1 = 不许改（必须提请求）/ 2 = 用法错
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

/**
 * 五档表 —— 唯一出处。`match` 按顺序判，第一条命中即停。
 * owner 写"谁"，因为光有档位 AI 还是会问"那我找谁"。
 */
export const TIERS = [
  {
    tier: 'A',
    name: '共享·宪法',
    match: [/^99-工作区[\\/]AGENTS\.md$/i, /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]协作规矩\.md$/i, /^05-协作与规矩[\\/]/i, /^00-核心机制[\\/]/i,
      // ⚠ 2026-11-23 补（冲突 C4 由 Xiodra 裁决「方案 A + 按生成方细分」）：
      //   这些是**工具生成的判据状态**，人手改会破坏判据（改了基线、改了体检结果，
      //   下次比对的对象就成了"已经被人手改过的状态"，真问题再也比不出来）。
      //   ⇒ 归 A 档：只能改工具，不许手改文件。
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]_体检-latest\.json$/i,
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]体检报告\.md$/i,
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]_入口基线\.json$/i,
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]_回执记录\.jsonl$/i,
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]_宪法状态\.json$/i,
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]机主画像\.md$/i,
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]机主画像参考\.md$/i],
    owner: '规则负责人（Xiodra 指定）',
    rule: '⛔ 只有规则负责人在 Xiodra 指令下能改。你只能提请求。工具生成的状态文件 ⛔ 不许手改（改工具）。',
  },
  {
    tier: 'C',
    name: '共享·工具与运行时',
    match: [/^工具[\\/][^\\/]+\.mjs$/i, /^外壳[\\/]main\.js$/i, /^外壳[\\/]preload\.js$/i, /^外壳[\\/]renderer[\\/]/i, /^config\.json$/i, /^引擎[\\/]/i],
    owner: '工具归属场景（默认 dsh-gui）',
    rule: '⛔ 只能报需求/报 bug，由归属场景改。⛔ 引擎\\ 是上游，改了下次同步会丢。',
  },
  {
    tier: 'B',
    name: '共享·板与台账',
    match: [/^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]索引\.md$/i,
      // ⚠ 2026-11-21 补：`索引.json` 与 `索引.md` **同档**（冲突 C1 由 Xiodra 裁决：
      //   "各场景在 索引.json 的 areas 里登记/维护自己那一条，⛔ 不许删改别人的行（与 索引.md 同档同规矩）"）。
      //   原来漏了它 ⇒ 被判成 D 档 → 再判成 E（"别人的专属，一个字不许写"），
      //   于是"各写自己行"这条裁决在工具里根本执行不了。**裁决与判据打架，以裁决为准。**
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]索引\.json$/i,
      // ⚠ 2026-11-23 补（冲突 C4，Xiodra 裁决「方案 A + 按生成方细分」）：
      //   这三份是**各场景各写自己那行/那条**的共享台账，不是任何单一场景的专属。
      //   其中 `场景即人的一面.md` 参照《00-核心机制/六》§2/§4 原文明确要求
      //   「每个场景在共享层维护自己那一行」「只改自己那行」——与"一个字不许写"直接打架。
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]场景即人的一面\.md$/i,
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]项目\.json$/i,
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]记忆地图\.json$/i,
      /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]派单台账\.json$/i, /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]_待办\.md$/i, /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]_跨场景通知\.md$/i, /^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/]_共享记忆[\\/]冲突\.md$/i, /^工具[\\/]_体检待办\.md$/i],
    owner: '各场景各写自己那些行',
    rule: '✓ 能写自己的行；⛔ 不许删改别人的行；⛔ 结构性改动要提请求。',
  },
  {
    tier: 'D',
    name: '自己的专属',
    // ⚠ 2026-11-23 修根因（冲突 C4，Xiodra 裁决「方案 A」）：
    //   原来第二段是 `[^\\/]+`，把 `_共享记忆` 也当成"场景目录" ⇒ 判 D 档，
    //   再判 `_共享记忆 !== 我` ⇒ 判 E「一个字不许写」。
    //   结果共享层 17 个文件里 10 个被误判 E，连工具自己生成的文件都写不了。
    //   ⇒ 场景名不许以 `_` 开头（与 `_场景身份索引.md`「_ 开头是共享件」这条既有约定一致）。
    match: [/^引擎数据[\\/]\.dsh[\\/]场景记忆[\\/][^_\\/][^\\/]*[\\/]/i, /^外壳[\\/]scenarios[\\/][^\\/]+\.(json|md)$/i, /^外壳[\\/]captures[\\/]/i,
      // ⚠ 2026-11-19 补：**技能目录按"自己名下的技能"归 D 档**（参照 §6.8 D 档原文含"自己名下的技能"）。
      //   原来漏了 ⇒ `skills\command\SKILL.md` 被判成"表外"，差点让我以为要"先登记后动手"。
      //   真正归属由 `sceneSkills()` 决定（谁家场景的 skill 字段引用它），所以这里只认"在 skills\ 下"，
      //   具体是谁的要在输出里另判（见下文 whoOwnsSkill）。
      /^引擎数据[\\/]\.dsh[\\/]skills[\\/][^\\/]+[\\/]/i],
    owner: '该场景自己（技能归属看谁家场景的 skill 字段引用它）',
    rule: '✓ 自由改。⚠ 但改「自己的规矩」（铁律/判据/阈值/必须/禁止）要通知规则负责人并记一行。',
  },
];

/** 判一个路径属于哪一档。返回 {tier,name,owner,rule,hit} 或 null（表外）。 */
export function tierOf(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  for (const t of TIERS) {
    if (t.match.some((re) => re.test(p.replace(/\//g, '\\')) || re.test(p))) {
      return { ...t, hit: t.match.find((re) => re.test(p.replace(/\//g, '\\')) || re.test(p)).source };
    }
  }
  return null;
}

/** 是不是「别人的专属」（E 档）：D 档但场景目录不是我能认领的那个 */
export function isOthersPrivate(relPath, myScene) {
  const t = tierOf(relPath);
  if (!t || t.tier !== 'D') return false;
  const p = String(relPath).replace(/\\/g, '/');

  // ① 场景记忆目录：路径第二段就是场景名
  const m = p.match(/引擎数据\/\.dsh\/场景记忆\/([^/]+)\//);
  if (m) {
    // ⚠ 2026-11-23 修（冲突 C4）：`_` 开头的是共享层，不是场景目录 ⇒ 不按"别人的专属"判。
    //   双保险：D 档正则已经不放它进来，这里再挡一次，免得以后正则又被改宽。
    if (/^_/.test(m[1])) return false;
    if (!myScene) return 'unknown';           // 没说是谁 ⇒ 需要人确认
    return m[1] !== myScene;
  }

  // ② 技能目录：归属看**谁家场景 json 的 skill 字段引用它**（不是看目录名）
  const own = whoOwnsSkill(relPath);
  if (own) {
    if (!myScene) return 'unknown';
    if (!own.scenes.length) return 'orphan';   // 孤儿技能：没有场景认领 ⇒ 谁都不该擅自改
    return !own.scenes.includes(myScene);
  }

  /**
   * ③ 场景配置与定位卡：`外壳\scenarios\<id>.json` / `<id>-context.md`
   *    ⚠ 2026-11-21 修（真漏洞）：原来这两类**直接落到 return false** ⇒
   *      任何场景都被判成"能改"，实测 `归属.mjs 外壳\scenarios\self-review.json` 对
   *      「DSH·GUI」和「自我复盘」**都返回 exit 0** ⇒ 等于谁都能改别人的场景。
   *
   *    判据：**文件名就是归属场景**（`self-review.json` 归 自我复盘）。
   *    例外：`dsh-gui.json` 有两个会话共用（DSH改造 / GUI改造），两个都算自己人。
   */
  const m2 = p.match(/外壳\/scenarios\/([^/]+?)(-context)?\.(json|md)$/);
  if (m2) {
    const id = m2[1];
    if (!myScene) return 'unknown';
    // 先按场景 id 直接比
    if (id === myScene) return false;
    // 再按场景「name → id」映射比（DSH·GUI 的 name 里有 `·`，id 是 dsh-gui）
    const hit = sceneList().find((s) => s.id === id || s.name === myScene);
    if (hit && (hit.id === id || hit.name === myScene)) {
      // 同一个场景的两种写法 ⇒ 算自己的
      if (hit.id === id && (hit.name === myScene || hit.id === myScene)) return false;
    }
    // `_场景身份索引.md` 这类以 _ 开头的是共享件，不在这条判
    if (/^_/.test(id)) return false;
    return true;
  }

  return false;
}

/** 场景清单（id ↔ name），用于把 name 映射成 id */
function sceneList() {
  const out = [];
  const dir = path.join(ROOT, '外壳', 'scenarios');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
      if (j && j.id) out.push({ id: j.id, name: j.name || j.id });
    }
  } catch { /* */ }
  return out;
}

function table() {
  console.log('五档修改权（唯一出处 = 工具\\归属.mjs，照搬 05-协作与规矩/二-标准化规范 §6.8）\n');
  for (const t of TIERS) {
    console.log(`${t.tier}  ${t.name}`);
    console.log(`   谁改：${t.owner}`);
    console.log(`   规矩：${t.rule}`);
    console.log(`   范围：${t.match.map((r) => r.source).join('  |  ')}`);
    console.log('');
  }
  console.log('E  别人的专属');
  console.log('   谁改：⛔ 谁都别改（D 档里属于别人的东西）');
  console.log('   规矩：只能写请求；⛔ 一个字都不许写，也不许「顺手帮你改好」。');
  console.log('\n判据一句话：「这东西改了会影响别人吗？」会影响 ⇒ A/C/B；不会 ⇒ D。');
}

function selftest() {
  const cases = [
    ['99-工作区\\AGENTS.md', 'A'],
    ['引擎数据\\.dsh\\场景记忆\\_共享记忆\\协作规矩.md', 'A'],
    ['工具\\派单.mjs', 'C'],
    ['引擎\\apps\\web\\src\\index.ts', 'C'],
    ['引擎数据\\.dsh\\场景记忆\\_共享记忆\\_待办.md', 'B'],
    ['引擎数据\\.dsh\\场景记忆\\DSH·GUI\\场景私有记忆.md', 'D'],
    ['外壳\\scenarios\\dsh-gui.json', 'D'],
    ['08-升级与改造清单\\机制清单.md', null],
  ];
  let pass = 0;
  for (const [p, want] of cases) {
    const got = tierOf(p);
    const g = got ? got.tier : null;
    const ok = g === want;
    if (ok) pass++;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + p + ' ⇒ ' + (g || '表外') + (ok ? '' : `（期望 ${want || '表外'}）`));
  }
  // E 档：别的场景的私有记忆
  const e1 = isOthersPrivate('引擎数据\\.dsh\\场景记忆\\控制器\\场景私有记忆.md', 'DSH·GUI');
  const e2 = isOthersPrivate('引擎数据\\.dsh\\场景记忆\\DSH·GUI\\场景私有记忆.md', 'DSH·GUI');
  if (e1 === true) pass++; console.log('  ' + (e1 === true ? '✓' : '✗') + ' 别人的私有记忆 ⇒ 判 E（不许写）');
  if (e2 === false) pass++; console.log('  ' + (e2 === false ? '✓' : '✗') + ' 自己的私有记忆 ⇒ 不算 E');

  // 技能归属：按"谁家场景的 skill 字段引用它"判，不是按目录名
  const sk = '引擎数据\\.dsh\\skills\\command\\SKILL.md';
  const t3 = tierOf(sk);
  if (t3 && t3.tier === 'D') pass++; console.log('  ' + (t3 && t3.tier === 'D' ? '✓' : '✗') + ' 技能路径 ⇒ 判 D 档（参照 §6.8"自己名下的技能"）');
  const e3 = isOthersPrivate(sk, '控制器');
  if (e3 === false) pass++; console.log('  ' + (e3 === false ? '✓' : '✗') + ' 控制器改自己名下的技能 ⇒ 不算 E');
  const e4 = isOthersPrivate(sk, 'DSH·GUI');
  if (e4 === true) pass++; console.log('  ' + (e4 === true ? '✓' : '✗') + ' DSH·GUI 改控制器的技能 ⇒ 判 E（不许写）');

  // 索引.json 必须与 索引.md 同档（B）——冲突 C1 由 Xiodra 裁决，裁决优先于工具原来的判据
  {
    const tIdx = tierOf('引擎数据\\.dsh\\场景记忆\\_共享记忆\\索引.json');
    const okIdx = tIdx && tIdx.tier === 'B';
    if (okIdx) pass++;
    console.log('  ' + (okIdx ? '✓' : '✗') + ' 索引.json ⇒ 判 B 档（与 索引.md 同档；C1 裁决"各写自己行"）');
    const tMd = tierOf('引擎数据\\.dsh\\场景记忆\\_共享记忆\\索引.md');
    const okMd = tMd && tMd.tier === 'B';
    if (okMd) pass++;
    console.log('  ' + (okMd ? '✓' : '✗') + ' 索引.md ⇒ 判 B 档（作为对照）');
  }
  // ★场景 json / 定位卡的归属★（2026-11-21 修的真漏洞：原来谁都能改别人的场景）
  {
    const p = '外壳\\scenarios\\self-review.json';
    const t1 = tierOf(p);
    if (t1 && t1.tier === 'D') pass++;
    console.log('  ' + (t1 && t1.tier === 'D' ? '✓' : '✗') + ' 场景 json ⇒ 判 D 档');

    const other = isOthersPrivate(p, 'DSH·GUI');
    if (other === true) pass++;
    console.log('  ' + (other === true ? '✓' : '✗') + ' DSH·GUI 改「自我复盘」的场景 json ⇒ 判 E（⛔ 漏洞修复点）');

    const mine = isOthersPrivate(p, '自我复盘');
    if (mine === false) pass++;
    console.log('  ' + (mine === false ? '✓' : '✗') + ' 自我复盘改自己的场景 json ⇒ 不算 E');

    const ctx = isOthersPrivate('外壳\\scenarios\\self-review-context.md', 'DSH·GUI');
    if (ctx === true) pass++;
    console.log('  ' + (ctx === true ? '✓' : '✗') + ' 别人的定位卡 ⇒ 也判 E（同场景 json 一视同仁）');
  }
  // ★冲突 C4（2026-11-23 Xiodra 裁决「方案 A + 按生成方细分」）★
  //   共享层 `_共享记忆` 不是场景目录，不许被当成"别人的专属"。
  {
    const SHARED = '引擎数据\\.dsh\\场景记忆\\_共享记忆\\';
    // ① 根因：`_共享记忆` 下任何文件都不许判 E（哪怕它没进 B/A 档）
    let allNotE = true;
    for (const f of ['场景即人的一面.md', '项目.json', '记忆地图.json', '_待办.md', '冲突.md']) {
      if (isOthersPrivate(SHARED + f, 'DSH·GUI') !== false) allNotE = false;
    }
    if (allNotE) pass++;
    console.log('  ' + (allNotE ? '✓' : '✗') + ' `_共享记忆` 下文件 ⇒ 都不判 E（共享层不是场景目录，C4 根因）');

    // ② 工具生成的状态文件 ⇒ A 档（人手改会破坏判据）
    const aFiles = ['_体检-latest.json', '体检报告.md', '_入口基线.json', '_回执记录.jsonl', '_宪法状态.json', '机主画像.md', '机主画像参考.md'];
    const aOk = aFiles.every((f) => tierOf(SHARED + f)?.tier === 'A');
    if (aOk) pass++;
    console.log('  ' + (aOk ? '✓' : '✗') + ' 工具生成的 7 份状态文件 ⇒ 判 A 档（⛔ 不许手改，改工具）');

    // ③ 各场景各写自己那行的 ⇒ B 档
    const bFiles = ['场景即人的一面.md', '项目.json', '记忆地图.json'];
    const bOk = bFiles.every((f) => tierOf(SHARED + f)?.tier === 'B');
    if (bOk) pass++;
    console.log('  ' + (bOk ? '✓' : '✗') + ' 各写自己那行的 3 份台账 ⇒ 判 B 档（C4 原争议对象在此）');

    // ④ 真·别人的私有记忆仍然必须判 E（别把 C4 修成"谁都能改别人"）
    const stillE = isOthersPrivate('引擎数据\\.dsh\\场景记忆\\控制器\\场景私有记忆.md', 'DSH·GUI');
    if (stillE === true) pass++;
    console.log('  ' + (stillE === true ? '✓' : '✗') + ' 修完仍判：别人场景的私有记忆 ⇒ E（⛔ 别修过头）');

    // ⑤ `_` 开头的其他共享文件也不许判 E
    const underscore = isOthersPrivate('引擎数据\\.dsh\\场景记忆\\_共享记忆\\记忆地图.json', '控制器');
    if (underscore === false) pass++;
    console.log('  ' + (underscore === false ? '✓' : '✗') + ' 换别的场景看共享层 ⇒ 也判"不算 E"（共享件对谁都一样）');
  }
  const total = cases.length + 16;
  console.log('  selftest: ' + (pass === total ? `PASS ${pass}/${total}` : `FAIL ${pass}/${total}`));
  return pass === total ? 0 : 1;
}

/**
 * 技能归属哪个场景：读所有场景 json 的 `skill` 字段。
 * 返回 `{ skill, scenes: [场景名…] }`；不是技能路径则返回 null。
 * ⚠ 这是"技能是谁的"的**唯一判据**（和 技能体检.mjs 同源逻辑，但那边只管检查不管判档）。
 */
export function whoOwnsSkill(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  const m = p.match(/引擎数据\/\.dsh\/skills\/([^/]+)\//);
  if (!m) return null;
  const skill = m[1];
  const scen = path.join(ROOT, '外壳', 'scenarios');
  const scenes = [];
  try {
    for (const f of fs.readdirSync(scen)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      const j = JSON.parse(fs.readFileSync(path.join(scen, f), 'utf8').replace(/^\uFEFF/, ''));
      if (j && j.skill === skill) scenes.push(j.name || j.id || f);
    }
  } catch { /* ignore */ }
  return { skill, scenes };
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();

if (isMain) {
  if (has('--selftest')) process.exit(selftest());
  if (has('--表') || has('--table')) { table(); process.exit(0); }
  const target = argv.find((a) => !a.startsWith('--')) || '';
  if (!target) {
    console.error('用法：node 工具\\归属.mjs <文件路径> [--我已经是 <场景名>]\n      node 工具\\归属.mjs --表\n      node 工具\\归属.mjs --selftest');
    process.exit(2);
  }
  const rel = path.isAbsolute(target) ? path.relative(ROOT, target) : target;
  const t = tierOf(rel);
  console.log('路径：' + rel);
  if (!t) {
    console.log('档位：表外（这份文件不在五档表里）');
    console.log('怎么办：⛔ 先在定位卡 §六 登记一行再动手（跨层），或在 §四 给对方提请求（跨场景）。**先登记后动手，不许先斩后奏。**');
    process.exit(1);
  }
  console.log(`档位：${t.tier} · ${t.name}`);
  console.log('谁改：' + t.owner);
  console.log('规矩：' + t.rule);
  const me = val('--我已经是') || process.env.DSH_SCENE_NAME || '';
  const others = isOthersPrivate(rel, me);
  if (t.tier === 'D' && others === 'orphan') {
    const own = whoOwnsSkill(rel);
    console.log('\n⚠ 这是**孤儿技能**（' + (own ? own.skill : '') + '）：没有场景 json 的 skill 字段引用它。');
    console.log('   ⇒ 谁都不该擅自改。要么先在场景 json 里挂上 `skill: ' + (own ? own.skill : '<名>') + '`，要么问 Xiodra。');
    process.exit(1);
  }
  if (t.tier === 'D' && others === true) {
    const own = whoOwnsSkill(rel);
    console.log('\n⛔ 这是**别人**的专属（你的场景是「' + me + '」' + (own ? '；该技能归 ' + own.scenes.join('/') : '') + '）⇒ E 档：只能写请求，一个字都不许写。');
    console.log('请求写法：现象 / 该谁做 / 怎么做（唯一出处）/ 做完怎么验');
    process.exit(1);
  }
  if (t.tier === 'A' || t.tier === 'C') {
    console.log('\n⛔ 这一档不许你改 ⇒ 提请求（写法：现象 / 该谁做 / 怎么做 / 做完怎么验）。');
    process.exit(1);
  }
  console.log('\n✓ 这一档你能改（B 只写自己的行 / D 自由改）。');
  if (t.tier === 'D') console.log('  ⚠ 若这次改的是「自己的规矩」（铁律/判据/阈值/必须/禁止）⇒ 改完通知规则负责人，并记一行台账。');
  process.exit(0);
}
