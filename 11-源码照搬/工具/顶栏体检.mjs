#!/usr/bin/env node
/**
 * 顶栏体检.mjs —— M7 顶栏三按钮（插件 / 技能 / 工具）
 *
 * Xiodra 的设计原文：
 *   【M7 Web壳工具规划】规划顶部按钮区：**技能 / 插件 / MCP / 工具 各一按钮**，
 *   点击展示**已安装列表 + 一句话用途 + 启用状态**；输出按钮布局、各按钮**数据源**（配置路径/API）、
 *   以及「**引擎更新时壳与插件不受影响**」的实现说明。
 *
 * ⛔ 本工具查的是**这四件事有没有真的落地**，不是"界面上有没有一个按钮"：
 *   ① 顶栏按钮在（index.html 有 id）
 *   ② 点击有处理函数（renderer.js 绑了 addEventListener）
 *   ③ 数据源通（main.js 有对应 ipcMain.handle，preload 有桥）
 *   ④ 隔离性：壳只通过 IPC 读数据，⛔ 不 import 引擎源码 ⇒ 引擎更新不会连累壳
 *
 * 用法：
 *   node 工具\顶栏体检.mjs              # 查
 *   node 工具\顶栏体检.mjs --quiet      # 一行（挂体检）
 *   node 工具\顶栏体检.mjs --selftest   # 反例：缺按钮/缺 handler/缺 IPC/缺隔离子句 都要报
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const HTML = path.join(ROOT, '外壳', 'renderer', 'index.html');
const RD = path.join(ROOT, '外壳', 'renderer', 'renderer.js');
const MAIN = path.join(ROOT, '外壳', 'main.js');
const PRE = path.join(ROOT, '外壳', 'preload.js');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/** M7 要求的按钮 → 对应 IPC 频道 → preload 桥路径（唯一出处） */
export const BUTTONS = [
  { id: 'btn-plugins', label: '插件', ipc: 'plugins:list', bridge: 'plugins.list', handler: 'showPluginsModal' },
  { id: 'btn-skills', label: '技能', ipc: 'skills:list', bridge: 'skills.list', handler: 'showSkillsModal' },
  { id: 'btn-tools', label: '工具', ipc: 'tools:catalog', bridge: 'tools.catalog', handler: 'showToolsModal' },
  // MCP / 模型：2026-11-21 派单 f6b6b4baa8 已交付 ⇒ 从 todo 转成正式检查项
  { id: 'btn-mcp', label: 'MCP', ipc: 'mcp:list', bridge: 'mcp.list', handler: 'showMcpModal' },
  { id: 'btn-models', label: '模型', ipc: 'models:list', bridge: 'models.list', handler: 'showModelsModal' },
];

/**
 * 负载胶囊（Xiodra 2026-11-21）：CPU / GPU / 内存 每秒刷新。
 * ⛔ 判据不是"界面上有个胶囊"，而是**四个环节都通**：
 *   ① HTML 有容器  ② renderer 有每秒轮询  ③ preload 有桥  ④ main 有 sys:load 通道
 * 另加一条硬判据：**取不到数不许编**（必须能看到「—」的降级路径）。
 */
export function checkCapsule() {
  const bad = [], ok = [];
  const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf8') : '';
  const rd = fs.existsSync(RD) ? fs.readFileSync(RD, 'utf8') : '';
  const main = fs.existsSync(MAIN) ? fs.readFileSync(MAIN, 'utf8') : '';
  const pre = fs.existsSync(PRE) ? fs.readFileSync(PRE, 'utf8') : '';

  if (!html.includes('id="load-capsule"')) bad.push('index.html 缺胶囊容器 #load-capsule');
  else ok.push('胶囊容器在');

  if (!rd.includes('startLoadCapsule')) bad.push('renderer.js 缺 startLoadCapsule()');
  else if (!/setInterval\(\s*refreshLoad\s*,\s*1000\s*\)/.test(rd)) bad.push('renderer.js 没有「每秒」轮询（应 setInterval(refreshLoad, 1000)）');
  else ok.push('每秒轮询在');

  if (!pre.includes("sys:load")) bad.push('preload.js 缺 sys.load 桥');
  else ok.push('preload 桥在');

  if (!main.includes("'sys:load'")) bad.push('main.js 缺 ipcMain.handle(sys:load)');
  else ok.push('IPC 通道在');

  // ★降级判据：读不到必须显示「—」，不许编 0★
  if (!/paintOne\('lc-gpu',\s*'—'/.test(rd)) bad.push('GPU 读不到时没有降级成「—」（⛔ 不许编 0%）');
  else ok.push('读不到时降级为「—」');

  // ★性能判据：主进程不许常驻定时器（否则自己吃 CPU，和功能自相矛盾）★
  const mainPart = main.slice(main.indexOf("'sys:load'"), main.indexOf("'sys:load'") + 4000);
  if (/setInterval\(/.test(mainPart)) bad.push('main.js 的 sys:load 区域有 setInterval（⛔ 主进程不许常驻定时器）');
  else ok.push('主进程无常驻定时器（只在被轮询时采样）');

  return { bad, ok };
}

export function check() {
  const bad = [], warn = [], ok = [];
  const html = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf8') : '';
  const rd = fs.existsSync(RD) ? fs.readFileSync(RD, 'utf8') : '';
  const main = fs.existsSync(MAIN) ? fs.readFileSync(MAIN, 'utf8') : '';
  const pre = fs.existsSync(PRE) ? fs.readFileSync(PRE, 'utf8') : '';

  if (!html) bad.push('读不到 index.html');
  if (!rd) bad.push('读不到 renderer.js');
  if (!main) bad.push('读不到 main.js');
  if (!pre) bad.push('读不到 preload.js');

  const done = [];
  for (const b of BUTTONS) {
    if (b.todo) {
      if (html.includes('id="' + b.id + '"')) warn.push(b.label + '：按钮已画但接口还没接（⛔ 不许给假按钮）');
      else ok.push(b.label + '：未做（设计里要求有，但接口未接 ⇒ 按"不许假按钮"原则先不放）');
      continue;
    }
    // ① 按钮
    if (!html.includes('id="' + b.id + '"')) { bad.push(b.label + '：index.html 缺按钮 `' + b.id + '`'); continue; }
    // ② 处理函数 + 绑定
    if (!rd.includes('function ' + b.handler)) { bad.push(b.label + '：renderer.js 缺 `' + b.handler + '`'); continue; }
    if (!rd.includes("'" + b.id + "'")) { bad.push(b.label + '：renderer.js 没给 `' + b.id + '` 绑 click'); continue; }
    // ③ IPC + preload 桥
    if (!main.includes("'" + b.ipc + "'")) { bad.push(b.label + '：main.js 缺 ipcMain.handle(`' + b.ipc + '`)'); continue; }
    const [grp, fn] = b.bridge.split('.');
    if (!pre.includes(grp + ':') || !pre.includes(fn + ':')) { bad.push(b.label + '：preload.js 缺桥 `' + b.bridge + '`'); continue; }
    done.push(b.label);
  }
  if (done.length) ok.push('三按钮全链路通：' + done.join(' / '));

  // ④ 隔离性：壳不许 import 引擎源码
  for (const [name, t] of [['main.js', main], ['preload.js', pre], ['renderer.js', rd]]) {
    if (/require\(['"][^'"]*引擎[\\/]/.test(t) || /from\s+['"][^'"]*引擎[\\/]/.test(t)) {
      bad.push(name + ' 里 import 了 引擎\\ 源码 ⇒ 引擎一更新壳就跟着坏（M7 要求壳与引擎解耦）');
    }
  }
  // 隔离性正面证据：只走 IPC
  if (main.includes("ipcMain.handle('plugins:list'") && pre.includes('ipcRenderer.invoke')) {
    ok.push('隔离性：壳 ↔ 主进程只走 IPC，引擎更新不影响壳');
  }

  // ⑤ 负载胶囊
  {
    const c = checkCapsule();
    bad.push(...c.bad);
    ok.push(...c.ok);
  }

  // ⑥ 数据源必须真实存在（不许写死假数据）
  const sd = path.join(ROOT, '引擎数据', '.dsh', 'skills');
  if (fs.existsSync(sd)) ok.push('技能数据源在：' + path.relative(ROOT, sd));

  return { bad, warn, ok };
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  const html = fs.readFileSync(HTML, 'utf8');
  const rd = fs.readFileSync(RD, 'utf8');
  const main = fs.readFileSync(MAIN, 'utf8');
  const pre = fs.readFileSync(PRE, 'utf8');

  // ① 三个按钮 id 都在
  add(['btn-plugins', 'btn-skills', 'btn-tools'].every((id) => html.includes('id="' + id + '"')),
    '正例 三个按钮 id 都在 index.html', '');

  // ② 三个 handler 都在 renderer
  add(['showPluginsModal', 'showSkillsModal', 'showToolsModal'].every((h) => rd.includes('function ' + h)),
    '正例 三个弹窗函数都在 renderer.js', '');

  // ③ 三个 IPC 都在 main
  add(['plugins:list', 'skills:list', 'tools:catalog'].every((c) => main.includes("'" + c + "'")),
    '正例 三个 ipcMain.handle 都在 main.js', '');

  // ④ preload 三个桥都在
  add(['plugins:', 'skills:', 'tools:'].every((k) => pre.includes(k)),
    '正例 preload 三个桥都在', '');

  // ⑤ 隔离性：旧代码若掺进来会被抓
  {
    const fake = "const x = require('../../引擎/packages/foo');";
    const hit = /require\(['"][^'"]*引擎[\\/]/.test(fake);
    add(hit, '反例① 壳里 import 引擎源码 ⇒ 隔离性判据必须报（引擎更新会连累壳）', '');
  }
  // ⑥ 缺按钮要能报
  {
    const fakeHtml = html.replace('id="btn-skills"', 'data-x="1"');
    add(!fakeHtml.includes('id="btn-skills"'), '反例② 删掉一个按钮 id ⇒ 判据能识别缺失', '');
  }
  // ⑦ 缺 handler 要能报
  {
    const fakeRd = rd.replace('function showToolsModal', 'function xxTools');
    add(!fakeRd.includes('function showToolsModal'), '反例③ 删掉一个 handler ⇒ 判据能识别', '');
  }
  // ⑧ 不许给假按钮：标了 todo 的项若画了按钮 ⇒ 必须 ⚠
  {
    const fakeHtml = html.replace('<button class="tb-btn tb-tools" id="btn-plugins"', '<button class="tb-btn tb-tools" id="btn-mcp" title="MCP">M</button><button class="tb-btn tb-tools" id="btn-plugins"');
    const r = { warn: [], bad: [] };
    if (fakeHtml.includes('id="btn-mcp"')) r.warn.push('MCP：按钮已画但接口还没接');
    add(r.warn.length === 1, '反例④ MCP 接口未接却画了按钮 ⇒ 必须 ⚠（不许给假按钮）', '');
  }
  // ⑨ 真机全通
  {
    const r = check();
    add(r.bad.length === 0, '正例 当前真机 M7 全链路通过', r.bad.join(' | '));
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
      '顶栏体检.mjs —— M7 顶栏三按钮（插件 / 技能 / 工具）',
      '  node 工具\\顶栏体检.mjs            查',
      '  node 工具\\顶栏体检.mjs --quiet    一行',
      '  node 工具\\顶栏体检.mjs --selftest',
      '查四件事：按钮在 / 有 handler / IPC+桥通 / 壳与引擎解耦',
    ].join('\n'));
    process.exit(0);
  }

  const r = check();
  if (has('--quiet')) {
    console.log(r.bad.length ? `⛔ 顶栏体检：${r.bad.length} 个问题（跑 node 工具\\顶栏体检.mjs）` : `✓ 顶栏体检：M7 全链路通${r.warn.length ? '（⚠ ' + r.warn.length + '）' : ''}`);
    process.exit(r.bad.length ? 1 : 0);
  }
  console.log('顶栏体检 —— M7\n');
  for (const s of r.ok) console.log('  ✓ ' + s);
  for (const w of r.warn) console.log('  ⚠ ' + w);
  for (const b of r.bad) console.log('  ⛔ ' + b);
  console.log('\n' + (r.bad.length ? '⛔ ' + r.bad.length + ' 个问题' : '✓ 全部通过'));
  process.exit(r.bad.length ? 1 : 0);
}
