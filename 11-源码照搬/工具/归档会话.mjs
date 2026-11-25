#!/usr/bin/env node
/**
 * 归档会话.mjs —— 从**外面**把一条会话真正归档
 *
 * 为什么必须有它（《02-会话定位与跟随/五-换会话与归档》的硬结论）：
 *   让**会话自己**归档自己永远只成功一半 —— 引擎的 `session/rename` 会成功
 *   （标题变成「已归档 · X · 日期」），但 `workspace/archiveSession` 会被拒
 *   （会话自己还在跑，活动没停）⇒ 结果「只改了个名字」，侧边栏照样显示。
 *   ⇒ 正解就是从**另一条会话/脚本**里归档它。本工具干这个。
 *
 * 用法：
 *   node 工具\归档会话.mjs <会话id或标题>          # 只看计划（默认 dry-run）
 *   node 工具\归档会话.mjs <会话id或标题> --go     # 真归档（带活动时自动 stopActivity 重试）
 *   node 工具\归档会话.mjs --list                  # 列出：已归档 / 名字带「已归档」但没真归档的
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } })();
const PORT = String(process.env.DSH_PORT || CFG.port || 33083);
const BASE = 'http://127.0.0.1:' + PORT;
const engineData = CFG.engineDataDir || '引擎数据\\.dsh';
const localData = path.isAbsolute(engineData) ? engineData : path.join(ROOT, engineData);
const DSH_HOME = fs.existsSync(localData) ? localData : (process.env.DSH_CUSTOMER_HOME || process.env.DSH_HOME || path.join(ROOT, '引擎', '.dsh'));
const WS_FILE = path.join(DSH_HOME, 'storages', 'workspace.json');
const LOG = path.join(ROOT, '外壳', 'server.log');

const argv = process.argv.slice(2);
const GO = argv.includes('--go');
const say = (s) => console.log(s);
const die = (s) => { console.error('✗ ' + s); process.exit(1); };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } };

/* ---------------- 会话清单（两级索引，同 建会话.mjs） ---------------- */
function listSessions() {
  const out = new Map();
  const add = (id, t, cwd, at) => {
    if (!id) return;
    const prev = out.get(id);
    const rec = { id, title: String(t || '').trim(), cwd: cwd || '', at: at || 0 };
    if (!prev || (!prev.title && rec.title) || rec.at > prev.at) out.set(id, { ...prev, ...rec, at: Math.max(prev ? prev.at : 0, rec.at) });
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
const archivedIds = () => new Set(((readJson(WS_FILE) || {}).global || {}).archivedSessionIds || []);
const markArchived = (id) => {
  const j = readJson(WS_FILE) || {};
  j.global = j.global || {};
  const set = new Set(j.global.archivedSessionIds || []);
  set.add(id);
  j.global.archivedSessionIds = [...set];
  fs.writeFileSync(WS_FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
};

/* ---------------- --list ---------------- */
if (argv.includes('--list') || !argv.filter((a) => !a.startsWith('--')).length) {
  const list = listSessions();
  const arch = archivedIds();
  const ghost = list.filter((s) => !arch.has(s.id) && /已归档/.test(s.title));
  say('会话库：' + DSH_HOME);
  say('共 ' + list.length + ' 条，已真归档 ' + arch.size + ' 条。');
  if (ghost.length) {
    say('\n⚠ 名字带「已归档」但**没真归档**（侧边栏里还会显示）：');
    for (const s of ghost) say('  ' + s.title + '  ·  ' + s.id);
    say('  ⇒ 用 `node 工具\\归档会话.mjs <id> --go` 补真归档。');
  } else say('\n✓ 没有「只改名没归档」的幽灵会话。');
  process.exit(0);
}

/* ---------------- 找目标 ---------------- */
const q = argv.filter((a) => !a.startsWith('--'))[0] || '';
const list = listSessions();
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const target = list.find((s) => s.id === q) || list.find((s) => norm(s.title) === norm(q)) || null;
if (!target) die('找不到会话「' + q + '」（用 --list 看真实标题）');

const arch = archivedIds();
say('目标：' + (target.title || '（无标题）'));
say('  id   ：' + target.id);
say('  已归档：' + (arch.has(target.id) ? '是' : '否'));
if (!GO) {
  say('\n--dry：以上只是看计划。加 --go 才真归档（会写 workspace.json 的 global.archivedSessionIds）。');
  process.exit(0);
}

/* ---------------- 真归档 ---------------- */
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
if (!cookie) die('换不到 cookie（引擎没在跑？）');
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

// ① 先停掉它的活动（会话还在跑时 archiveSession 会被拒）
try { await rpc('session/cancel', { request: { sessionId: target.id } }); } catch (e) { /* 没在跑就算了 */ }
await new Promise((r) => setTimeout(r, 800));

// ② 真归档
let r = await rpc('workspace/archiveSession', { request: { sessionId: target.id } });
if (r.status !== 200) {
  // 带活动时再试一次：stopActivity → 等一下 → 重试
  try { await rpc('session/stopActivity', { request: { sessionId: target.id } }); } catch (e) { /* ignore */ }
  await new Promise((r2) => setTimeout(r2, 1200));
  r = await rpc('workspace/archiveSession', { request: { sessionId: target.id } });
}
// ③ 兜底直接写 workspace.json（RPC 不通时仍要落盘，否则"只改名不归档"）
markArchived(target.id);
if (r.status === 200) say('✓ 已真归档（RPC-200）：' + (target.title || target.id));
else say('✓ 已写进 workspace.json 的 archivedSessionIds（RPC 返回 ' + r.status + '，兜底路径）：' + (target.title || target.id));
say('  侧边栏刷新后不再显示；工作台设置页「取消归档」可恢复。');
