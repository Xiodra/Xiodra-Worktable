#!/usr/bin/env node
/**
 * 换会话.mjs —— 一个固定命令，不用思考
 *
 * 照搬《02-会话定位与跟随/五-换会话与归档》的**标准四步**，一步都不许省：
 *   ① 建新会话（**同名**，别改名）
 *   ② 旧会话改名「已归档 · X · 日期」+ **真归档**（只改名不算！）
 *   ③ 新会话开场写「先读 §〇 交接」
 *   ④ 回写 scene json 的 sessionId / sessionTitle + 自检
 *
 * 手工会漏的三处（这就是本工具存在的理由）：
 *   只改名不归档 / 不回写配置 / 不给新会话写开场消息。
 *
 * 用法：
 *   node 工具\换会话.mjs                        # 列出全部面板 + 能不能换
 *   node 工具\换会话.mjs 控制器                  # 空跑：打印计划，不动任何东西
 *   node 工具\换会话.mjs 控制器 --go             # 真换
 *   node 工具\换会话.mjs <面板id> --go           # 也可以直接给面板 id
 *   可加 --force：§〇 交接不新鲜（默认 2 小时）也照换
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SCEN = path.join(ROOT, '外壳', 'scenarios');
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } })();
const PORT = String(process.env.DSH_PORT || CFG.port || 33083);
const BASE = 'http://127.0.0.1:' + PORT;
const engineData = CFG.engineDataDir || '引擎数据\\.dsh';
const localData = path.isAbsolute(engineData) ? engineData : path.join(ROOT, engineData);
const DSH_HOME = fs.existsSync(localData) ? localData : (process.env.DSH_CUSTOMER_HOME || process.env.DSH_HOME || path.join(ROOT, '引擎', '.dsh'));
const LOG = path.join(ROOT, '外壳', 'server.log');
const IDX = path.join(SCEN, '_场景身份索引.md');

const argv = process.argv.slice(2);
const GO = argv.includes('--go');
const FORCE = argv.includes('--force');
const say = (s) => console.log(s);
const die = (s) => { console.error('✗ ' + s); process.exit(1); };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } };

/* ---------------- 场景清单（含每个 harness 面板的绑定） ---------------- */
function scenes() {
  const out = [];
  for (const f of fs.existsSync(SCEN) ? fs.readdirSync(SCEN) : []) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const j = readJson(path.join(SCEN, f));
    if (j && j.id) out.push({ file: f, ...j });
  }
  return out;
}
const SCENES = scenes();
const panels = [];
for (const s of SCENES) for (const p of s.panels || []) if (p.type === 'harness') panels.push({ scene: s, panel: p });

/* §〇 交接新鲜度：看场景私有记忆.md 的 mtime（记忆目录名 == 场景 name） */
function handoffOf(sceneName) {
  const f = path.join(MEM, sceneName, '场景私有记忆.md');
  if (!fs.existsSync(f)) return { file: f, ok: false, why: '没有场景私有记忆.md' };
  const st = fs.statSync(f);
  const mins = (Date.now() - st.mtimeMs) / 60000;
  return { file: f, ok: mins <= 120, mins: Math.round(mins), why: mins <= 120 ? '' : '§〇 交接 ' + Math.round(mins) + ' 分钟没更新' };
}

/* ---------------- 无参：列表 ---------------- */
if (!argv.filter((a) => !a.startsWith('--')).length) {
  say('可换的 AI 面板：');
  for (const { scene, panel } of panels) {
    const h = handoffOf(scene.name);
    say('  ' + (panel.sessionTitle || panel.title) + '  [' + scene.name + ' / ' + panel.id + ']');
    say('      会话：' + (panel.sessionId || '（未绑）'));
    say('      交接：' + (h.ok ? '新鲜（' + h.mins + ' 分钟前）' : '⚠ ' + h.why));
  }
  say('\n用法：node 工具\\换会话.mjs <场景名或面板id> [--go] [--force]');
  process.exit(0);
}

const q = argv.filter((a) => !a.startsWith('--'))[0];
const target = panels.find((x) => x.panel.id === q)
  || panels.find((x) => x.panel.sessionTitle === q)
  || panels.find((x) => x.scene.name === q)
  || null;
if (!target) die('找不到面板「' + q + '」（用无参命令看清单）');
const { scene, panel } = target;
const title = panel.sessionTitle || panel.title;
const h = handoffOf(scene.name);

say('换会话计划：');
say('  场景：' + scene.name + '（' + scene.id + '）');
say('  面板：' + panel.id + '  「' + title + '」');
say('  旧会话：' + (panel.sessionId || '（未绑）'));
say('  交接：' + (h.ok ? '新鲜（' + h.mins + ' 分钟前）' : '⚠ ' + h.why));
if (!h.ok && !FORCE) {
  say('\n⛔ 交接不新鲜，不硬来。两个选择：');
  say('  ① 先把这个场景干到哪了写进 ' + h.file + ' 的 §〇（覆盖，不要追加）');
  say('  ② 确实没进展就加 --force');
  process.exit(1);
}
if (!GO) { say('\n--dry：以上只是计划，没动任何东西。加 --go 才真换。'); process.exit(0); }

/* ---------------- RPC ---------------- */
function tokens() {
  if (!fs.existsSync(LOG)) return [];
  const txt = fs.readFileSync(LOG, 'utf8');
  const re = new RegExp('127\\.0\\.0\\.1:' + PORT + '\\/\\?token=([A-Za-z0-9_\\-]{16,})', 'g');
  return [...txt.matchAll(re)].map((m) => m[1]).reverse();
}
async function getCookie() {
  for (const t of tokens().slice(0, 3)) {
    try {
      const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
      const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      if (sc.length) return sc.map((c) => c.split(';')[0]).join('; ');
    } catch (e) { /* next */ }
  }
  return '';
}
const cookie = await getCookie();
if (!cookie) die('换不到 cookie（引擎没在跑？先启动工作台）');
const rpc = async (method, a) => {
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args: a } }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
  return { status: r.status, j, t };
};
const wsId = (() => {
  const wj = readJson(path.join(DSH_HOME, 'storages', 'workspace.json')) || {};
  const t = wj.tables || {};
  const entries = Object.entries(t.workspaces || {});
  const defId = (wj.global && wj.global.defaultWorkspaceId) || '';
  const pick = entries.find(([id]) => id === defId) || entries[0];
  return pick ? pick[0] : '';
})();

/* ① 建新会话：**同名** */
const c = await rpc('session/create', { request: wsId ? { workspaceId: wsId } : {} });
const newId = c.j && c.j.result && c.j.result.value && c.j.result.value.sessionId;
if (!newId) die('建会话失败：HTTP ' + c.status + ' ' + String(c.t).slice(0, 200));
const rn = await rpc('session/rename', { request: { sessionId: newId, title } });
if (rn.status !== 200) die('新会话改名失败（HTTP ' + rn.status + '）');
say('✓ ① 新会话：' + newId + '  已命名为「' + title + '」');

/* ② 旧会话：改名 + **真归档** */
const oldId = panel.sessionId;
if (oldId && oldId !== newId) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await rpc('session/rename', { request: { sessionId: oldId, title: '已归档 · ' + title + ' · ' + date } });
  try { await rpc('session/cancel', { request: { sessionId: oldId } }); } catch (e) { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800));
  let ar = await rpc('workspace/archiveSession', { request: { sessionId: oldId } });
  if (ar.status !== 200) {
    try { await rpc('session/stopActivity', { request: { sessionId: oldId } }); } catch (e) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1200));
    ar = await rpc('workspace/archiveSession', { request: { sessionId: oldId } });
  }
  // 兜底：RPC 不通也要真落盘（否则就是"只改名不归档"）
  const wj = readJson(path.join(DSH_HOME, 'storages', 'workspace.json')) || {};
  wj.global = wj.global || {};
  const set = new Set(wj.global.archivedSessionIds || []);
  set.add(oldId);
  wj.global.archivedSessionIds = [...set];
  fs.writeFileSync(path.join(DSH_HOME, 'storages', 'workspace.json'), JSON.stringify(wj, null, 2) + '\n', 'utf8');
  say('✓ ② 旧会话 ' + oldId + ' 已改名「已归档 · …」并真归档（RPC ' + ar.status + '，已写 archivedSessionIds）');
}

/* ③ 新会话开场：先读 §〇 交接（空会话不进侧边栏，这句同时把它顶上来） */
const memRel = path.join('引擎数据', '.dsh', '场景记忆', scene.name, '场景私有记忆.md');
const seedTxt = [
  '你是「' + title + '」场景的常驻 AI。开工第一件事：读这一份记忆的 §〇 交接 ——',
  '  ' + memRel,
  '只读 §〇（当前交接）+ §一（职责边界）+ §二（现状/接口），不要通读全文。',
  '读完只回一句「已读 §〇」即可，不要开始任何别的活，等用户下一条指令。'
].join('\n');
await rpc('session/prompt', {
  request: {
    requestId: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    sessionId: newId, mode: 'queue', content: [{ type: 'text', text: seedTxt }],
  },
});
await new Promise((r) => setTimeout(r, 10000));   // 太早取消 = 这轮没真开始 = 会话仍是空
await rpc('session/cancel', { request: { sessionId: newId } });
say('✓ ③ 已给新会话写开场「先读 §〇 交接」');

/* ④ 回写 scene json + 身份索引表，并自检 */
const jf = path.join(SCEN, scene.file);
const sc = readJson(jf);
for (const p of sc.panels || []) {
  if (p.id !== panel.id) continue;
  p.sessionId = newId;
  p.sessionTitle = title;
  p.pinTarget = [title];
}
// 场景级三字段：只有当这个场景**只有这一个** harness 面板时才同步（多个面板各绑不同会话，写场景级会串台）
const harnessCount = (sc.panels || []).filter((p) => p.type === 'harness').length;
if (harnessCount === 1) {
  sc.sessionId = newId;
  sc.sessionTitle = title;
  sc.pinTarget = [title];
}
fs.writeFileSync(jf, JSON.stringify(sc, null, 2) + '\n', 'utf8');
say('✓ ④ 已回写 ' + scene.file + (harnessCount === 1 ? '（含场景级三字段）' : '（只写面板级 —— 本场景有 ' + harnessCount + ' 个 AI 面板，写场景级会串台）'));

if (fs.existsSync(IDX)) {
  let t = fs.readFileSync(IDX, 'utf8');
  const cell = (v) => (v && v !== '—' ? '`' + v + '`' : '—');
  const lines = t.split(/\r?\n/).map((line) => {
    if (!line.trim().startsWith('|')) return line;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
    if (cells.length < 7) return line;
    const sceneId = cells[0].replace(/`/g, '');
    const panelId = cells[1].replace(/`/g, '');
    if (sceneId !== scene.id || panelId !== panel.id) return line;
    cells[4] = cell(newId);
    cells[3] = cell(title);
    return '| ' + cells.join(' | ') + ' |';
  });
  t = lines.join('\n');
  fs.writeFileSync(IDX, t, 'utf8');
  say('✓ ④ 身份索引表已更新「会话 id」列');
}

/* 自检：逐面板打印 id 命中（《00-核心机制/二-记忆机制》换会话协议第 4 步） */
const after = readJson(jf) || {};
say('\n自检（场景 ' + scene.name + ' 的每个 AI 面板）：');
let bad = 0;
for (const p of after.panels || []) {
  if (p.type !== 'harness') continue;
  const hit = p.sessionId === newId && p.sessionTitle === title;
  if (!hit && p.id === panel.id) bad++;
  say('  ' + (hit ? '✓' : '·') + ' ' + p.id + '  ' + (p.sessionTitle || '（未绑）') + '  ' + (p.sessionId || '-'));
}
say(bad ? '\n⚠ 目标面板没写对' : '\n✓ 目标面板 id 命中');
say('\n下一步：切走切回这个场景，让面板重建（分区名不变，但 webview 要重载才读新键）。');
say('判据：面板标题行小字「已钉住 · ' + title + '」+ 外壳\\captures\\' + panel.id + '.png');
