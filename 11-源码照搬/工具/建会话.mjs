#!/usr/bin/env node
// 建会话.mjs —— 不开 GUI、不用点侧边栏，直接调引擎 RPC 建一条会话（给场景的 AI 面板用）
//
// 为什么需要它（照搬《02-会话定位与跟随/五-换会话与归档.md》）：
//   新场景的 AI 面板要写 `sessionId`（验明正身 + 决定独立分区）/ `sessionTitle`（逐字一致的标题），
//   而"在 GUI 里手建再抄 id"既慢又容易抄错。引擎有 `session/create` + `session/rename` 两个 RPC，
//   这里照淋雨家 `scripts\建会话.mjs` 的实测配方调：
//     token 从 server.log 取 → 换签名 cookie（**必须 redirect:'manual'**，跟随后反而 401）→ POST /api/<method>
//
// ⚠ 两条实测铁律（抄自参照项目，别改）：
//   ① **必须传 workspaceId**：侧边栏按 workspace 分组，只传 cwd 建出来的会话会掉进「未分组」；
//   ② **空会话不进侧边栏**：默认建完塞一条开场消息再打断（`--no-seed` 可关）。
//      ⚠ 打断不能太早 —— 太早取消 = 这轮没真开始 = 会话仍是空 = 侧边栏看不到。默认等 10 秒。
//
// 用法：
//   node 工具\建会话.mjs --title "控制器"
//   node 工具\建会话.mjs --title "GUI改造" --cwd "<某个目录>"
//   node 工具\建会话.mjs --title "控制器" --dry          # 空跑，只查工作区
//   node 工具\建会话.mjs --list                          # 列出本项目已有会话（标题 · id · 最后活动）
//
// 输出最后一行 `sessionId = session-…`，可直接抄进 scenarios\*.json。
// 建完记得：①回写场景 json 的三字段 ②回写 scenarios\_场景身份索引.md（外壳改绑定时会自动同步，
//   手工改 json 则要自己改表）③切走切回让面板重建，看面板标题行小字是否「已钉住 · <标题>」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));   // …\工具
const ROOT = path.resolve(TOOL_DIR, '..');                        // …\11-源码照搬
const SHELL = path.join(ROOT, '外壳');

/* ---------- 读配置（与启动器同一份 config.json）---------- */
function readCfg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { return {}; }
}
const CFG = readCfg();
const PORT = String(process.env.DSH_PORT || CFG.port || 33083);
const BASE = process.env.DSH_GUI_BASE || 'http://127.0.0.1:' + PORT;
// ⚠ 数据目录必须「本地优先」，跟 main.js 同一套顺序：
//   ① config.json 的 engineDataDir（最硬）② <工作台根>\引擎数据\.dsh ③ 环境变量 ④ 兜底
// 为什么不能直接用 process.env.DSH_HOME：在 DSH 会话里跑脚本时这个变量是**继承来的**，
//   指向 C:\Users\Administrator\.dsh（别人的数据目录），照着它会列出/建出完全不相关的会话。
const engineDataDir = CFG.engineDataDir || '引擎数据\\.dsh';
const localData = path.isAbsolute(engineDataDir) ? engineDataDir : path.join(ROOT, engineDataDir);
const DSH_HOME = fs.existsSync(localData)
  ? localData
  : (process.env.DSH_CUSTOMER_HOME || process.env.DSH_HOME || path.join(ROOT, '引擎', '.dsh'));
const LOG = path.join(SHELL, 'server.log');

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const title = val('--title', '');
const dry = argv.includes('--dry');
const seedIt = !argv.includes('--no-seed');
const listOnly = argv.includes('--list');

const say = (s) => console.log(s);
const die = (s) => { console.error('✗ ' + s); process.exit(1); };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } };

/* ---------- --list：列出本项目已有会话 ---------- */
function listSessions() {
  const out = new Map();
  const add = (id, t, cwd, at) => {
    if (!id) return;
    const prev = out.get(id);
    const rec = { id, title: String(t || '').trim(), cwd: cwd || '', at: at || 0 };
    if (!prev || (!prev.title && rec.title) || rec.at > prev.at) {
      out.set(id, { ...prev, ...rec, at: Math.max(prev ? prev.at : 0, rec.at) });
    }
  };
  const total = readJson(path.join(DSH_HOME, 'storages', 'session_projcache.json'));
  if (total && total.tables && total.tables.sessions) {
    for (const [id, v] of Object.entries(total.tables.sessions)) {
      const rows = v.rows || {};
      add(id, rows.title && rows.title.val, (v.identity || {}).cwd, (v.identity || {}).createdAt);
    }
  }
  const dir = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const r = (readJson(path.join(dir, f)) || {}).record;
      if (!r) continue;
      const rows = r.rows || {};
      add(f.replace(/\.json$/, ''), rows.title && rows.title.val, (r.identity || {}).cwd, (r.identity || {}).createdAt);
    }
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

if (listOnly) {
  const list = listSessions();
  if (!list.length) say('（本项目数据目录里还没有会话：' + DSH_HOME + '）');
  else {
    say('本项目已有会话（' + list.length + ' 条）：');
    for (const s of list) {
      say('  ' + (s.title || '（无标题）') + '  ·  ' + s.id);
    }
  }
  process.exit(0);
}

if (!title) {
  console.error('用法：node 工具\\建会话.mjs --title "会话名" [--cwd <目录>] [--no-seed] [--dry] | --list');
  process.exit(2);
}

/* ---------- 找 workspace（侧边栏分组靠它）---------- */
const cwdArg = val('--cwd', '');
let wsId = '';
let wsTitle = '';
let cwd = cwdArg;
const wf = path.join(DSH_HOME, 'storages', 'workspace.json');
const wj = readJson(wf) || {};
const tbl = wj.tables || {};
const norm = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
const wsEntries = Object.entries(tbl.workspaces || {});
if (cwd) {
  for (const [id, v] of wsEntries) {
    if (norm(v.path) === norm(cwd)) { wsId = id; wsTitle = v.title || ''; break; }
  }
} else if (wsEntries.length) {
  // 没给 --cwd：挂到默认工作区（默认工作区 → 第一个）
  const defId = (wj.global && wj.global.defaultWorkspaceId) || '';
  const pick = wsEntries.find(([id]) => id === defId) || wsEntries[0];
  wsId = pick[0];
  wsTitle = pick[1].title || '';
  cwd = pick[1].path || '';
}
say('工作区：' + (wsId ? '「' + wsTitle + '」 ' + wsId : '⚠ 没找到工作区（会落进「未分组」，侧边栏看不到）'));
if (!wsId) say('      提示：先在引擎界面里建一个工作区，或给 --cwd 指一个已有工作区目录。');

if (dry) { say('\n--dry：以上只是查了工作区，没有建会话。去掉 --dry 即真做。'); process.exit(0); }

/* ---------- token → 签名 cookie ---------- */
function cookieFromLog() {
  if (!fs.existsSync(LOG)) return '';
  const txt = fs.readFileSync(LOG, 'utf8');
  const re = new RegExp('127\\.0\\.0\\.1:' + PORT + '\\/\\?token=([A-Za-z0-9_\\-]{16,})', 'g');
  const toks = [...txt.matchAll(re)].map((m) => m[1]).reverse();
  return toks;
}
const toks = cookieFromLog();
if (!toks.length) die('server.log 里没有 token（引擎没在跑？看 ' + LOG + '）');

async function getCookie() {
  for (const t of toks.slice(0, 3)) {
    try {
      const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
      const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      if (sc.length) {
        // ⚠ 引擎给的是 SameSite=Strict，Node 的 fetch 不走浏览器那套同站规则，
        //   所以这里原样带回即可（脚本自己发请求，不存在跨站导航）。
        return sc.map((c) => c.split(';')[0]).join('; ');
      }
    } catch (e) { /* 换下一条 */ }
  }
  return '';
}

const cookie = await getCookie();
if (!cookie) die('换不到 cookie（引擎没在跑或 token 失效）—— 等工作台起来后重试');

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

/* ---------- 建会话 ---------- */
const c = await rpc('session/create', { request: wsId ? { workspaceId: wsId } : { cwd } });
const newId = c.j && c.j.result && c.j.result.value && c.j.result.value.sessionId;
if (!newId) die('建会话失败：HTTP ' + c.status + ' ' + String(c.t).slice(0, 200));
say('✓ 新会话：' + newId);

const rn = await rpc('session/rename', { request: { sessionId: newId, title } });
if (rn.status !== 200) die('改名失败（HTTP ' + rn.status + '）⇒ 别把 id 写进 json');
say('✓ 已命名为「' + title + '」');

/* ---------- 开场消息（空会话不进侧边栏）+ 立刻打断 ---------- */
if (seedIt) {
  const seedTxt = '你是「' + title + '」场景的 AI 助手。现在只回一句话「已读」即可 —— '
    + '不要读任何文件、不要调用任何工具、不要开始干活，等用户下一条指令。';
  const pr = await rpc('session/prompt', {
    request: {
      requestId: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      sessionId: newId, mode: 'queue', content: [{ type: 'text', text: seedTxt }],
    },
  });
  await new Promise((r) => setTimeout(r, 10000));   // 太早取消 = 这轮没真开始 = 会话仍是空
  const cx = await rpc('session/cancel', { request: { sessionId: newId } });
  say((pr.status === 200 ? '✓' : '✗ HTTP ' + pr.status) + ' 开场消息   '
    + (cx.status === 200 ? '✓' : '✗ HTTP ' + cx.status) + ' 已打断（这轮不会动任何东西）');
} else {
  say('（--no-seed：没写开场消息，侧边栏可能要等它被打开过才显示）');
}

say('');
say('sessionId = ' + newId);
say('下一步：把下面三行写进 scenarios\\<场景id>.json 的 AI 面板：');
say('  "sessionTitle": "' + title + '",');
say('  "sessionId": "' + newId + '",');
say('  "pinTarget": ["' + title + '"]');
say('然后回写 scenarios\\_场景身份索引.md 的「会话 id」列，切走切回让面板重建。');
