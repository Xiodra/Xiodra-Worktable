#!/usr/bin/env node
/**
 * 场景体检.mjs —— 场景「六件套」齐全性（照搬《08-升级与改造清单》例 4）
 *
 * 治的坑：新场景"看着有、其实缺" —— 标签栏里能点，但没有记忆、没有定位卡、
 *   身份索引里没登记、技能缺 frontmatter。人眼看不出来，直到新会话开场迷路。
 *
 * 判据（唯一出处，全部来自**配置文件**，不猜）：
 *   `外壳\scenarios\*.json`（`_` 开头的是模板，跳过）里的每个场景，必须齐：
 *     ① 场景 json 本身能解析，且至少有一个 `harness` 面板绑了 `sessionId`
 *     ② 记忆目录 `引擎数据\.dsh\场景记忆\<场景名>\` 下：`场景私有记忆.md` / `身份卡.md` / `场景画像.md` / `_文件索引.md` / `项目记忆\` / `归档\`
 *     ③ 定位卡 `外壳\scenarios\<场景id>-context.md`
 *     ④ 身份索引 `外壳\scenarios\_场景身份索引.md` 里有这个面板 id，且会话 id 与 json 一致
 *     ⑤ 「场景即人的一面」在 `_共享记忆\场景即人的一面.md` 里有这一行（没有 ⇒ ⚠ 不阻断）
 *     ⑥ 主技能（若 json 声明了 `skill`）文件存在且首行是 `---`、含 `name:`
 *
 * 用法：
 *   node 工具\场景体检.mjs            # 全场景，有 ✗ 就 exit 1
 *   node 工具\场景体检.mjs --场景 DSH·GUI
 *   node 工具\场景体检.mjs --quiet    # 一行结论（挂进机制体检）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const GUI = process.env.DSH_GUI_DIR || path.join(ROOT, '外壳');
const SCEN = path.join(GUI, 'scenarios');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆', '场景即人的一面.md');
const IDX_FILE = path.join(SCEN, '_场景身份索引.md');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
/**
 * 读出所有场景 json。
 * ⛔ 跳过 `_` 开头的模板。
 * ⛔ **也跳过 `tmp-` / `test-` 开头的测试场景** —— 约定（见定位卡与 建会话.mjs）：
 *    临时验收场景一律用 `tmp-*` 前缀，**验完即删**。
 *    2026-11-19 事故：GUI改造 建了 `tmp-pc` 验收电脑族面板，场景体检把它当真场景报 3 条 ✗
 *    ⇒ 机制体检 `scene-six` 变红 ⇒ 审计/验证闸连锁报警。**那是它在正常干活，不是故障。**
 *    判据：测试场景缺记忆/定位卡/身份索引是**预期**的，不该进体检。
 *    想强行检查加 `--with-tmp`。
 */
const WITH_TMP = process.argv.includes('--with-tmp');
export function readScenes() {
  const out = [];
  if (!fs.existsSync(SCEN)) return out;
  for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json')) continue;
    if (f.startsWith('_')) continue;
    if (!WITH_TMP && /^(tmp-|test-)/i.test(f)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { out.push({ __file: f, __bad: e.message }); continue; }
    out.push({ ...j, __file: f });
  }
  return out;
}

/** 身份索引表：面板 id → { sessionId, sessionName } */
export function readIdentityIndex() {
  const map = new Map();
  if (!fs.existsSync(IDX_FILE)) return map;
  const txt = fs.readFileSync(IDX_FILE, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    if (cells.length < 7) continue;
    const panelId = cells[2].replace(/`/g, '');
    const sessionName = cells[4].replace(/`/g, '');
    const sessionId = cells[5].replace(/`/g, '');
    if (!panelId || panelId === '面板 id') continue;
    map.set(panelId, { sessionId, sessionName });
  }
  return map;
}

/** 检查一个场景，返回 { id, name, bad: [], warn: [] } */
export function checkScene(s) {
  const bad = [], warn = [];
  if (s.__bad) { bad.push('场景 json 解析失败：' + s.__bad); return { id: s.__file, name: s.__file, bad, warn }; }
  const id = s.id || '', name = s.name || '';
  if (!id) bad.push('json 缺 id');
  if (!name) bad.push('json 缺 name（记忆目录名靠它）');

  const panels = (s.panels || []).filter(Boolean);
  const harness = panels.filter((p) => p.type === 'harness' && p.sessionId);
  if (!harness.length) bad.push('没有一个 harness 面板绑了 sessionId（标签栏能点，但 AI 面板不钉会话）');
  // 三字段要么齐全要么都没有（半套最容易串台）
  for (const p of harness) {
    const miss = ['sessionId', 'sessionTitle', 'pinTarget'].filter((k) => !p[k] || (Array.isArray(p[k]) && !p[k].length));
    if (miss.length) bad.push(`面板 ${p.id} 绑定三字段缺：${miss.join(' / ')}`);
  }
  // 同一场景内两条会话不许同名（同名 ⇒ 必串台）
  const titles = harness.map((p) => p.sessionTitle).filter(Boolean);
  const dup = titles.filter((t, i) => titles.indexOf(t) !== i);
  if (dup.length) bad.push('两条面板会话同名：' + [...new Set(dup)].join(' / ') + '（会串台）');

  // 记忆目录六件套
  if (name) {
    const dir = path.join(MEM, name);
    if (!fs.existsSync(dir)) bad.push('没有记忆目录 ' + path.relative(ROOT, dir) + '（跑 场景记忆.mjs init）');
    else {
      for (const f of ['场景私有记忆.md', '身份卡.md', '场景画像.md', '_文件索引.md']) {
        if (!fs.existsSync(path.join(dir, f))) bad.push('记忆缺 ' + f);
      }
      for (const d of ['项目记忆', '归档']) if (!fs.existsSync(path.join(dir, d))) bad.push('记忆缺目录 ' + d + '\\');
    }
  }

  // 定位卡
  if (id && !fs.existsSync(path.join(SCEN, id + '-context.md'))) bad.push('缺定位卡 scenarios/' + id + '-context.md');

  // 身份索引
  const idx = readIdentityIndex();
  for (const p of harness) {
    const row = idx.get(p.id);
    if (!row) { bad.push('身份索引里没有面板 ' + p.id); continue; }
    if (row.sessionId && row.sessionId !== p.sessionId) bad.push(`身份索引与 json 打架：${p.id} 表里 ${row.sessionId} / json ${p.sessionId}（以 json 为准，回来改表）`);
    if (row.sessionName && p.sessionTitle && row.sessionName !== p.sessionTitle) bad.push(`身份索引会话名打架：${p.id} 表里「${row.sessionName}」/ json「${p.sessionTitle}」`);
  }
  // json 里的面板在索引里有、但 json 里没了这个面板 ⇒ 表过期
  const jsonPanelIds = new Set(panels.map((p) => p.id));
  for (const pid of idx.keys()) {
    if (pid.startsWith(id + '-') && !jsonPanelIds.has(pid)) warn.push('身份索引多出一行 ' + pid + '（json 里已没有这个面板 ⇒ 表过期）');
  }

  // 场景即人的一面（共享层有一行；表里写的是「场景名 · 面板id」，所以按名字包含判）
  if (fs.existsSync(SHARED) && name) {
    const t = fs.readFileSync(SHARED, 'utf8');
    if (!t.includes('| ' + name + ' ·') && !t.includes('| ' + name + ' |')) warn.push('共享层「场景即人的一面」没有本场景那一行');
  } else if (!fs.existsSync(SHARED)) warn.push('缺 _共享记忆\\场景即人的一面.md');

  // 主技能（可选）
  if (s.skill) {
    const cands = [
      path.join(ROOT, '引擎数据', '.dsh', 'skills', s.skill, 'SKILL.md'),
      path.join(ROOT, '技能', s.skill, 'SKILL.md'),
    ];
    const f = cands.find((p) => fs.existsSync(p));
    if (!f) bad.push('主技能目录找不到：' + s.skill);
    else {
      const head = fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(0, 8).join('\n');
      if (!head.startsWith('---')) bad.push('主技能缺 frontmatter（首行必须是 ---）');
      else if (!/^name:/m.test(head)) bad.push('主技能 frontmatter 缺 name:');
    }
  }
  return { id, name, file: s.__file, bad, warn };
}

/* ---------------- CLI ---------------- */
if (isMain) {
  const only = val('--场景') || val('--scene');
  let scenes = readScenes();
  if (only) scenes = scenes.filter((s) => s.id === only || s.name === only || s.__file === only + '.json');
  const rows = scenes.map(checkScene);
  const badN = rows.filter((r) => r.bad.length).length;
  const warnN = rows.filter((r) => !r.bad.length && r.warn.length).length;

  if (has('--quiet')) {
    console.log(badN ? `⛔ 场景体检：${badN}/${rows.length} 个场景不齐（跑 node 工具\\场景体检.mjs 看明细）` : `✓ 场景体检：${rows.length} 个场景全部齐全${warnN ? '（⚠ ' + warnN + '）' : ''}`);
    process.exit(badN ? 1 : 0);
  }
  for (const r of rows) {
    console.log(`\n${r.name}（${r.id || '?'}）${r.bad.length ? '✗ ' + r.bad.length : '✓'}`);
    for (const b of r.bad) console.log('   ✗ ' + b);
    for (const w of r.warn) console.log('   ⚠ ' + w);
  }
  console.log('\n' + (badN ? `⛔ ${badN}/${rows.length} 个场景不齐` : `✓ ${rows.length} 个场景全部齐全`) + (warnN ? ` · ⚠ ${warnN} 个有告警` : ''));
  process.exit(badN ? 1 : 0);
}
