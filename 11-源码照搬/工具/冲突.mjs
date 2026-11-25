#!/usr/bin/env node
/**
 * 冲突.mjs —— 地盘重叠时的唯一通道（照搬拓扑 C4「场景 → 共享层：上行 areas / 冲突」）
 *
 * 参照的原始判据（《05-协作与规矩/三-跨场景协作》§三 表末两行，最关键）：
 *   · 「**没列到的**」⇒ 谁的定位卡写了它，就是谁的；两张卡都写了 ⇒ 看谁的"资产地图"路径更具体
 *   · 「**都没写的**」⇒ ⛔ **先在定位卡 §六 登记一行再动手**（跨层）或在 §四 给对方提请求（跨场景）；
 *     先登记后动手，**不许先斩后奏**
 *
 * ⚠ 我们**不照抄那张 18 行手写表**，两个原因：
 *   ① 我们只有 2 个场景 + MCP，手写 18 行是过度设计；
 *   ② 手写表**一定会漂**（我们已经踩过：`_场景身份索引.md` 与场景 json 打架）。
 *   ⇒ 「听谁的」用 `归属.mjs` + `areas\*.md` **机械推导**，「待定的」才进 `冲突.md` 等拍板。
 *
 * ⛔ 本工具**不裁决**。裁决权只有两种：机主本人 / 机主指定的规则负责人。
 *   AI 能做的是：把冲突**记清楚**、把**判据出处**摆出来、把**该问谁**标明。
 *   （铁律 5：规则只认 Xiodra —— AI 自己推断的"该归谁"不算数。）
 *
 * 用法：
 *   node 工具\冲突.mjs --list                    # 看所有冲突（未裁决的排前面）
 *   node 工具\冲突.mjs --who <路径>              # 「这东西归谁」机械推导（不写表）
 *   node 工具\冲突.mjs --declare --paths A,B --sides 场景1,场景2 --what "现象"
 *   node 工具\冲突.mjs --decide <id> --ruling "归谁" --by "Xiodra" --why "依据"
 *   node 工具\冲突.mjs --check [--quiet]         # 体检：未裁决超 24h ⇒ ⚠；裁决缺依据 ⇒ ⛔
 *   node 工具\冲突.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierOf, whoOwnsSkill } from './归属.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
const FILE = path.join(SHARED, '冲突.md');
const SCEN = path.join(ROOT, '外壳', 'scenarios');
const AREAS = path.join(SHARED, 'areas');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const DAY = 86400000;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

/** 场景清单（id / name / 面板 / 卡） */
export function scenes() {
  const out = [];
  if (!fs.existsSync(SCEN)) return out;
  for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const j = readJson(path.join(SCEN, f));
    if (j && j.id) out.push({ id: j.id, name: j.name || j.id, file: f });
  }
  return out;
}

/**
 * 「这东西归谁」——**机械推导，不查手写表**。判据顺序（唯一出处）：
 *   ① `归属.mjs` 判 A/C ⇒ 不归任何场景（共享件，只有规则负责人/工具归属场景能改）
 *   ② 判 D ⇒ 看是不是别人的专属：
 *      · 在场景记忆目录下 ⇒ 路径第二段就是归宿
 *      · 在 skills 下 ⇒ 看谁家场景 json 的 skill 字段引用它
 *      · 在 scenarios 下 ⇒ 看文件名对应的场景 id
 *   ③ 判 B ⇒ 板与台账：各写自己行，不归单一场景
 *   ④ 表外 ⇒ 去 `areas\*.md` 找："谁的资产地图里路径更具体，就是谁的"（参照原文）
 *   ⑤ areas 也没写 ⇒ **没人认领** ⇒ 按参照规矩「先登记后动手」
 */
export function whoOwns(relPath) {
  const t = tierOf(relPath);
  const p = String(relPath).replace(/\\/g, '/');
  const sc = scenes();
  const byName = (n) => sc.find((s) => s.name === n || s.id === n);

  if (t && (t.tier === 'A' || t.tier === 'C')) {
    return { owner: null, kind: 'shared', tier: t.tier, why: t.name + '：不归任何场景（' + t.owner + '）' };
  }
  if (t && t.tier === 'B') {
    return { owner: null, kind: 'board', tier: 'B', why: '板与台账：各写自己那些行，不归单一场景' };
  }
  if (t && t.tier === 'D') {
    const m = p.match(/引擎数据\/\.dsh\/场景记忆\/([^/]+)\//);
    if (m) {
      const s = byName(m[1]);
      return { owner: s ? s.name : m[1], kind: 'private', tier: 'D', why: '场景记忆目录：路径第二段就是归宿' };
    }
    const own = whoOwnsSkill(relPath);
    if (own) {
      if (!own.scenes.length) return { owner: null, kind: 'orphan', tier: 'D', why: '孤儿技能：没有场景 json 引用它 ⇒ 谁都不该擅自改' };
      return { owner: own.scenes[0], kind: 'skill', tier: 'D', why: '技能归属：' + own.scenes.join('/') + ' 的场景 json 引用了它' };
    }
    const m2 = p.match(/外壳\/scenarios\/([^/]+)\.(json|md)$/);
    if (m2) {
      const s = byName(m2[1].replace(/-context$/, ''));
      return { owner: s ? s.name : m2[1], kind: 'scene-file', tier: 'D', why: '场景配置/定位卡：文件名就是场景 id' };
    }
    return { owner: null, kind: 'private-unknown', tier: 'D', why: 'D 档但没认出是哪个场景' };
  }

  // 表外：去 areas 找谁的地盘
  if (fs.existsSync(AREAS)) {
    const needle = p.toLowerCase();
    for (const f of fs.readdirSync(AREAS)) {
      if (!f.endsWith('.md')) continue;
      const txt = fs.readFileSync(path.join(AREAS, f), 'utf8').toLowerCase();
      if (!txt.includes(needle)) continue;
      const sid = f.replace(/\.md$/, '');
      const s = byName(sid);
      return { owner: s ? s.name : sid, kind: 'area', tier: '表外', why: 'areas\\' + f + ' 的资产地图写了这个路径' };
    }
  }
  return { owner: null, kind: 'nobody', tier: '表外', why: '五档表与 areas 都没写 ⇒ 没人认领，**先登记后动手**（不许先斩后奏）' };
}

/* ---------------- 读写 冲突.md ---------------- */

/** 解析冲突条目：`### [open|decided] C<n> · 标题` */
export function parse(txt) {
  const items = [];
  const lines = txt.split(/\r?\n/);
  let cur = null;
  for (const l of lines) {
    const m = l.match(/^###\s*\[(open|decided)\]\s*(C\d+)\s*·\s*(.+)$/);
    if (m) {
      if (cur) items.push(cur);
      cur = { state: m[1], id: m[2], title: m[3].trim(), lines: [] };
      continue;
    }
    if (cur) {
      if (/^##\s/.test(l)) { items.push(cur); cur = null; continue; }
      cur.lines.push(l);
    }
  }
  if (cur) items.push(cur);

  return items.map((it) => {
    const body = it.lines.join('\n');
    const g = (re) => (body.match(re) || [])[1] || '';
    return {
      state: it.state, id: it.id, title: it.title,
      at: g(/登记：\s*(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)/),
      sides: g(/涉及：\s*(.+)/).split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
      paths: g(/路径：\s*(.+)/).split(/[、,，]/).map((s) => s.trim().replace(/`/g, '')).filter(Boolean),
      what: g(/现象：\s*(.+)/),
      ruling: g(/裁决：\s*(.+)/),
      by: g(/裁决人：\s*(.+)/),
      why: g(/依据：\s*(.+)/),
      body,
    };
  });
}

const ageHours = (s) => {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return Math.floor((Date.now() - t) / 3600000);
};

export function check(txt) {
  const bad = [], warn = [], ok = [];
  const items = parse(txt);
  if (!items.length) { ok.push('没有冲突登记（正常）'); return { bad, warn, ok, items }; }

  const open = items.filter((i) => i.state === 'open');
  const decided = items.filter((i) => i.state === 'decided');
  ok.push('共 ' + items.length + ' 条（未裁决 ' + open.length + ' / 已裁决 ' + decided.length + '）');

  for (const i of items) {
    // 每条都必须有：涉及 / 路径 / 现象
    if (!i.sides.length) bad.push(i.id + ' 缺「涉及」（哪两个场景/面板）');
    if (!i.paths.length) bad.push(i.id + ' 缺「路径」（到底撞的是哪个文件/目录）');
    if (!i.what) bad.push(i.id + ' 缺「现象」（要可观察，不是形容词）');
    if (!i.at) bad.push(i.id + ' 缺「登记」时间');

    if (i.state === 'decided') {
      // 裁决必须有：裁决 / 裁决人 / 依据 —— 缺依据 = 没有判据出处，等于拍脑袋
      if (!i.ruling) bad.push(i.id + ' 已裁决但缺「裁决」');
      if (!i.by) bad.push(i.id + ' 已裁决但缺「裁决人」');
      if (!i.why) bad.push(i.id + ' 已裁决但缺「依据」（⛔ 没依据的裁决等于拍脑袋）');
    } else {
      const h = ageHours(i.at);
      if (h !== null && h >= 24) warn.push(i.id + ' 未裁决已 ' + h + ' 小时（>24h）⇒ 该找人拍了：' + i.title);
    }
  }
  return { bad, warn, ok, items };
}

/* ---------------- 写 ---------------- */
const HEAD = [
  '# 冲突与待定（C4 上行通道）',
  '',
  '> **这张表只放"两边都说是自己的 / 谁都没认领"的事。** 一般归属别往这写 —— 跑 `node 工具\\冲突.mjs --who <路径>` 机械推导即可。',
  '> 判据出处：《05-协作与规矩/三-跨场景协作》§三 表末两行 + 本工具 `--who`。',
  '>',
  '> ⛔ **裁决权只有两种**：Xiodra 本人 / Xiodra 指定的规则负责人。AI 只能登记与摆判据，**不许自己裁**（铁律 5）。',
  '> ⛔ **先登记后动手**：登记前不许改那个路径（不许先斩后奏）。',
  '',
  '## 未裁决',
  '',
  '（没有就写「（无）」）',
  '',
  '## 已裁决（只追加）',
  '',
  '（没有就写「（无）」）',
  '',
].join('\n');

function ensure() {
  fs.mkdirSync(SHARED, { recursive: true });
  if (!fs.existsSync(FILE)) { fs.writeFileSync(FILE, HEAD, 'utf8'); return; }
  const t = fs.readFileSync(FILE, 'utf8');
  // 旧模板（只有标题+"没有冲突就空着"）⇒ 升级成规范格式（原内容保留在末尾）
  if (!/##\s*未裁决/.test(t)) {
    fs.writeFileSync(FILE, HEAD + '\n---\n\n> 以下是升级前的旧内容（保留不丢）：\n\n' + t, 'utf8');
  }
}

function nextId(items) {
  const n = items.map((i) => Number((i.id.match(/\d+/) || [0])[0])).filter((x) => x > 0);
  return 'C' + (n.length ? Math.max(...n) + 1 : 1);
}

function appendItem(state, id, title, fields) {
  let t = fs.readFileSync(FILE, 'utf8');
  const block = [
    '### [' + state + '] ' + id + ' · ' + title,
    '',
    ...fields.map((f) => '- ' + f),
    '',
  ].join('\n');

  const secName = state === 'open' ? '## 未裁决' : '## 已裁决（只追加）';
  const i = t.indexOf(secName);
  if (i < 0) { t += '\n' + secName + '\n\n' + block; }
  else {
    const next = t.indexOf('\n## ', i + secName.length);
    const end = next < 0 ? t.length : next;
    const sec = t.slice(i, end);
    const cleaned = sec.replace(/（没有就写「（无）」）|（无）\s*$/m, '').replace(/\s+$/, '');
    t = t.slice(0, i) + cleaned + '\n\n' + block + (next < 0 ? '' : t.slice(next));
  }
  fs.writeFileSync(FILE, t.replace(/\n{3,}/g, '\n\n'), 'utf8');
}

/* ---------------- 命令 ---------------- */
function declare() {
  ensure();
  const paths = val('--paths').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const sides = val('--sides').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const what = val('--what');
  if (!paths.length || !what) { console.error('用法：--declare --paths A[,B] --sides 场景1,场景2 --what "现象"'); process.exit(2); }
  const txt = fs.readFileSync(FILE, 'utf8');
  const items = parse(txt);
  // 去重：同一个路径已经登记且未裁决 ⇒ 不重复登记
  const dup = items.find((i) => i.state === 'open' && i.paths.some((p) => paths.includes(p)));
  if (dup) { console.log('· 该路径已有未裁决条目 ' + dup.id + '，不重复登记'); process.exit(0); }

  const id = nextId(items);
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const guesses = paths.map((p) => p + ' ⇒ 机械推导：' + (whoOwns(p).owner || '（没人认领）'));
  appendItem('open', id, what.slice(0, 40), [
    '登记：' + now,
    '涉及：' + (sides.length ? sides.join('、') : '（未注明）'),
    '路径：' + paths.map((p) => '`' + p + '`').join('、'),
    '现象：' + what,
    '机械推导：' + guesses.join('；'),
    '待谁拍板：Xiodra',
  ]);
  console.log('✓ 已登记 ' + id + '（未裁决）');
  for (const g of guesses) console.log('  ' + g);
  console.log('  ⛔ 登记前不许改这些路径（先登记后动手）');
}

function decide() {
  ensure();
  const id = val('--decide');
  const ruling = val('--ruling');
  const by = val('--by');
  const why = val('--why');
  if (!id || !ruling || !by || !why) { console.error('用法：--decide C1 --ruling "归 X" --by "Xiodra" --why "依据"（四项都必填）'); process.exit(2); }
  if (!/Xiodra|机主|规则负责人/i.test(by)) {
    console.error('⛔ 裁决人必须是 Xiodra 本人或他指定的规则负责人（当前写的是「' + by + '」）。AI 不许自己裁决。');
    process.exit(2);
  }
  let txt = fs.readFileSync(FILE, 'utf8');
  const items = parse(txt);
  const it = items.find((x) => x.id === id);
  if (!it) { console.error('✗ 没有 ' + id); process.exit(2); }

  /**
   * 搬移逻辑（⛔ 之前写错了两次，记下来）：
   *   ① 原来的字段行必须**原样保留**（尤其「登记」时间）—— 不能只搬标题；
   *   ② 字段之间要用换行分隔，不能把多行 join 成一个字符串再拼（会串成一行）。
   *   ⇒ 直接从原文里截出该块的「字段行」，追加裁决三件套，整块搬到「已裁决」。
   */
  const openTitle = '### [open] ' + id + ' · ' + it.title;
  const i = txt.indexOf(openTitle);
  if (i < 0) { console.error('✗ 在文件里定位不到 ' + openTitle); process.exit(2); }
  const nextH = txt.indexOf('\n### ', i + openTitle.length);
  const nextSec = txt.indexOf('\n## ', i + openTitle.length);
  const cands = [nextH, nextSec].filter((x) => x > 0);
  const end = cands.length ? Math.min(...cands) : txt.length;
  const rawBlock = txt.slice(i, end).replace(/\s+$/, '');

  // 取出字段行（去掉标题与空行）
  const fieldLines = rawBlock.split(/\r?\n/).slice(1).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const decidedBlock = [
    '### [decided] ' + id + ' · ' + it.title,
    '',
    ...fieldLines,
    '- 裁决：' + ruling,
    '- 裁决人：' + by,
    '- 依据：' + why,
    '- 裁决时间：' + now,
    '',
  ].join('\n');

  // 从原文删掉 open 块
  txt = (txt.slice(0, i) + txt.slice(end)).replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(FILE, txt, 'utf8');

  // 追加到「已裁决」段
  let t2 = fs.readFileSync(FILE, 'utf8');
  const secName = '## 已裁决（只追加）';
  const j = t2.indexOf(secName);
  if (j < 0) t2 += '\n' + secName + '\n\n' + decidedBlock;
  else {
    const nx = t2.indexOf('\n## ', j + secName.length);
    const e2 = nx < 0 ? t2.length : nx;
    const sec = t2.slice(j, e2).replace(/（没有就写「（无）」）|（无）\s*$/m, '').replace(/\s+$/, '');
    t2 = t2.slice(0, j) + sec + '\n\n' + decidedBlock + (nx < 0 ? '' : t2.slice(nx));
  }
  fs.writeFileSync(FILE, t2.replace(/\n{3,}/g, '\n\n'), 'utf8');

  console.log('✓ ' + id + ' 已裁决：' + ruling + '（' + by + '）');
  console.log('  ⚠ 记得同步改：相关定位卡 §六 / areas / 归属判据（别让下一个人再撞一次）');
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① --who 机械推导：C 档不归场景
  {
    const w = whoOwns('工具\\派单.mjs');
    add(w.kind === 'shared' && w.owner === null, '反例① 工具\\*.mjs ⇒ A/C 共享件，不归任何场景', w.kind);
  }
  // ② 场景记忆目录 ⇒ 第二段就是归宿
  {
    const w = whoOwns('引擎数据\\.dsh\\场景记忆\\控制器\\场景私有记忆.md');
    add(w.owner === '控制器', '正例 场景记忆目录 ⇒ 归宿=路径第二段（控制器）', String(w.owner));
  }
  // ③ 技能 ⇒ 看谁家 json 引用
  {
    const w = whoOwns('引擎数据\\.dsh\\skills\\command\\SKILL.md');
    add(w.kind === 'skill' && w.owner === '控制器', '正例 技能 ⇒ 看谁家场景的 skill 字段（command 归控制器）', w.kind + '/' + w.owner);
  }
  // ④ 表外且 areas 没写 ⇒ 没人认领（先登记后动手）
  {
    const w = whoOwns('08-升级与改造清单\\机制清单.md');
    add(w.kind === 'nobody' || w.kind === 'area', '反例② 表外路径 ⇒ 要么 areas 认领、要么"没人认领（先登记）"', w.kind);
  }
  // ⑤ 体检：已裁决但缺依据 ⇒ ⛔
  {
    const txt = ['## 未裁决', '', '## 已裁决（只追加）', '', '### [decided] C1 · 某冲突', '', '- 登记：2026-11-19 10:00', '- 涉及：A、B', '- 路径：`x`', '- 现象：y', '- 裁决：归 A', '- 裁决人：Xiodra'].join('\n');
    const r = check(txt);
    add(r.bad.some((b) => b.includes('缺「依据」')), '反例③ 已裁决但缺依据 ⇒ ⛔（没依据=拍脑袋）', r.bad.join(' | '));
  }
  // ⑥ 体检：未裁决超 24h ⇒ ⚠
  {
    const old = new Date(Date.now() - 30 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
    const txt = ['## 未裁决', '', '### [open] C1 · 某冲突', '', '- 登记：' + old, '- 涉及：A、B', '- 路径：`x`', '- 现象：y'].join('\n');
    const r = check(txt);
    add(r.warn.some((w) => w.includes('小时')), '反例④ 未裁决超 24h ⇒ ⚠ 该找人拍了', r.warn.join(' | '));
  }
  // ⑦ 裁决人不认 AI ⇒ ⛔（这条靠 decide 的守卫，这里验正则）
  {
    add(!/Xiodra|机主|规则负责人/i.test('DSH改造'), '反例⑤ 裁决人写 AI（DSH改造）⇒ 必须拒绝', '');
  }
  // ⑧ 空表 ⇒ 通过
  {
    const r = check(HEAD);
    add(r.bad.length === 0, '正例 空表（还没冲突）⇒ 通过', r.bad.join(' | '));
  }

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
      '冲突.mjs —— 地盘重叠的唯一通道（C4 上行）',
      '  node 工具\\冲突.mjs --list',
      '  node 工具\\冲突.mjs --who <路径>         「这东西归谁」机械推导',
      '  node 工具\\冲突.mjs --declare --paths A,B --sides 场景1,场景2 --what "现象"',
      '  node 工具\\冲突.mjs --decide C1 --ruling "归 X" --by Xiodra --why "依据"',
      '  node 工具\\冲突.mjs --check [--quiet]',
      '  node 工具\\冲突.mjs --selftest',
      '⛔ 裁决权只在 Xiodra / 他指定的规则负责人；AI 只登记与摆判据。',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--who')) {
    const p = val('--who');
    if (!p) { console.error('用法：--who <路径>'); process.exit(2); }
    const w = whoOwns(p);
    console.log(p);
    console.log('  归属：' + (w.owner ? '**' + w.owner + '**' : '（不归单一场景）'));
    console.log('  判据：' + w.why);
    console.log('  档位：' + w.tier + ' · 类型 ' + w.kind);
    if (w.kind === 'nobody') console.log('\n  ⛔ 没人认领 ⇒ 先登记后动手：node 工具\\冲突.mjs --declare --paths "' + p + '" --what "…"');
    process.exit(0);
  }

  if (has('--declare')) { declare(); process.exit(0); }
  if (has('--decide')) { decide(); process.exit(0); }

  ensure();
  const txt = fs.readFileSync(FILE, 'utf8');
  const r = check(txt);

  if (has('--check') || has('--quiet')) {
    if (has('--quiet')) {
      console.log(r.bad.length ? `⛔ 冲突登记：${r.bad.length} 个问题` : `✓ 冲突登记：${r.items.filter((i) => i.state === 'open').length} 条未裁决${r.warn.length ? '（⚠ ' + r.warn.length + ' 超 24h）' : ''}`);
      process.exit(r.bad.length ? 1 : 0);
    }
    for (const s of r.ok) console.log('  ✓ ' + s);
    for (const w of r.warn) console.log('  ⚠ ' + w);
    for (const b of r.bad) console.log('  ⛔ ' + b);
    process.exit(r.bad.length ? 1 : 0);
  }

  // --list
  if (!r.items.length) { console.log('✓ 没有冲突登记（' + FILE + '）'); process.exit(0); }
  const open = r.items.filter((i) => i.state === 'open');
  const done = r.items.filter((i) => i.state === 'decided');
  console.log('冲突登记：' + FILE + '\n');
  console.log('── 未裁决 ' + open.length + ' 条 ──');
  if (!open.length) console.log('  （无）');
  for (const i of open) {
    const h = ageHours(i.at);
    console.log('  ' + i.id + ' · ' + i.title + '　[' + (h !== null ? h + 'h' : '?') + ']');
    console.log('      涉及：' + i.sides.join('、') + '　路径：' + i.paths.join('、'));
    console.log('      待：Xiodra 拍板（⛔ 登记前不许改）');
  }
  console.log('\n── 已裁决 ' + done.length + ' 条 ──');
  if (!done.length) console.log('  （无）');
  for (const i of done) console.log('  ' + i.id + ' · ' + i.title + ' ⇒ ' + i.ruling + '（' + i.by + '）');
  process.exit(0);
}
