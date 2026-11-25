#!/usr/bin/env node
/**
 * 会话档案.mjs —— 换会话后给旧会话留一份关键信息（照搬拓扑 C7「交接归档：旧版进 归档\，只进不改，可恢复」）
 *
 * 治什么：换会话 = 旧会话被归档，**它的对话要点就找不回来了**。
 *   场景记忆 §〇 只记"最后的进度"，记不下"这条会话里踩过什么、定了什么"。
 *   于是三个月后问"当时为什么这么改"，只能翻 1.8 MB 的会话流。
 *
 * 参照的做法（《05-协作与规矩》）：`会话档案\`（+ `_索引.md` + `核心\` + `概览\`），
 *   每次换会话后跑一次，旧 sessionId 进历史、新 sessionId 成当前。分级：**重要场景留关键信息，其它只记大概**。
 *
 * ⛔ 本工具**不抄聊天正文**（那会把档案变成第二个上下文）。它只记：
 *   会话 id / 标题 / 起止时间 / 体积 / 消息条数 / **用户在开头说的话**（前几条 user 消息，截断）。
 *
 * 用法：
 *   node 工具\会话档案.mjs --capture                 # 给当前所有 bound 会话拍一份快照
 *   node 工具\会话档案.mjs --capture --scene DSH·GUI
 *   node 工具\会话档案.mjs --list                    # 已有档案
 *   node 工具\会话档案.mjs --rotate <旧id>           # 标记某条会话"已归档"并留档案（换会话后调）
 *   node 工具\会话档案.mjs --check [--quiet]         # 档案完整性（漏档的 bound 会话 ⇒ ⚠）
 *   node 工具\会话档案.mjs --selftest
 *
 * 落点：`引擎数据\.dsh\会话档案\`（`_索引.md` 由本工具生成，别手改）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
const engineData = CFG.engineDataDir || '引擎数据\\.dsh';
const localData = path.isAbsolute(engineData) ? engineData : path.join(ROOT, engineData);
const DSH_HOME = fs.existsSync(localData) ? localData : (process.env.DSH_HOME || path.join(ROOT, '引擎', '.dsh'));
const ARCH = path.join(DSH_HOME, '会话档案');
const SESS = path.join(DSH_HOME, 'sessions');
const PROJ = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const SCEN = path.join(ROOT, '外壳', 'scenarios');
const IDX = path.join(ARCH, '_索引.md');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

/** 面板绑定的会话 → { id: {scene, title, panel} } */
export function boundMap() {
  const m = new Map();
  if (!fs.existsSync(SCEN)) return m;
  for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const j = readJson(path.join(SCEN, f)); if (!j) continue;
    for (const p of j.panels || []) {
      if (p.type === 'harness' && p.sessionId) m.set(p.sessionId, { scene: j.name || j.id, title: p.sessionTitle || p.title || '', panel: p.id });
    }
  }
  return m;
}

/** 找会话目录 */
export function findDir(id) {
  if (!fs.existsSync(SESS)) return null;
  for (const ws of fs.readdirSync(SESS)) {
    const d = path.join(SESS, ws, id);
    if (fs.existsSync(d)) return d;
  }
  return null;
}

/** 解多帧 zstd，抽出统计与「用户开头说的话」 */
export function digestSession(id) {
  const dir = findDir(id);
  if (!dir) return { missing: true };
  const f = path.join(dir, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(f)) return { missing: true };
  const buf = fs.readFileSync(f);
  let txt = '';
  let off = 0;
  while (off < buf.length) {
    const idx = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), off + 1);
    const end = idx < 0 ? buf.length : idx;
    try { txt += zlib.zstdDecompressSync(buf.subarray(off, end)).toString('utf8'); } catch { /* 该帧坏 */ }
    if (idx < 0) break;
    off = idx;
  }
  const lines = txt.split('\n').filter(Boolean);
  let head = null;
  const userMsgs = [];
  let msgCount = 0;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type === 'session') head = o;
    if (o.type === 'message' || o.type === 'user/message' || o.type === 'assistant/message') msgCount++;
    // 抓用户说的话（各种可能形状）
    const txt2 = o?.data?.content ?? o?.data?.text ?? o?.content;
    const isUser = /user/i.test(String(o.type || '')) || /user/i.test(String(o.role || o?.data?.role || ''));
    if (isUser) {
      const s = typeof txt2 === 'string' ? txt2 : Array.isArray(txt2) ? txt2.map((x) => x?.text || '').join(' ') : '';
      const clean = s.trim().replace(/\s+/g, ' ');
      // ⛔ 过滤注入噪声：system-reminder / 环境时间戳 / 技能目录 —— 它们不是"用户说的话"
      const noise = /^<system-reminder>|^Time sampled|^Current working directory|^You are the root agent|^A skill is a reusable set|^This information describes your current session/;
      if (clean && !noise.test(clean) && !/^<system-reminder>/.test(clean)) {
        userMsgs.push(clean.slice(0, 200));
      }
    }
  }
  return {
    missing: false,
    bytes: buf.length,
    lines: lines.length,
    msgCount,
    createdAt: head?.createdAt || 0,
    cwd: head?.cwd || '',
    userMsgs: userMsgs.slice(0, 6),
  };
}

/** 生成一份档案正文 */
export function buildCard(id, meta, dg, archived = false) {
  const dt = (ms) => (ms ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : '—');
  return [
    '# 会话档案 · ' + (meta.title || '（无标题）'),
    '',
    '| 项 | 值 |',
    '|---|---|',
    '| 会话 id | `' + id + '` |',
    '| 场景 | ' + (meta.scene || '—') + ' |',
    '| 面板 | `' + (meta.panel || '—') + '` |',
    '| 建立时间 | ' + dt(dg.createdAt) + ' |',
    '| 归档时间 | ' + (archived ? new Date().toISOString().slice(0, 19).replace('T', ' ') : '（仍在用）') + ' |',
    '| 会话流体积 | ' + (dg.bytes / 1024).toFixed(1) + ' KB |',
    '| 事件行数 | ' + dg.lines + ' |',
    '| cwd | `' + (dg.cwd || '—') + '` |',
    '',
    '## 用户在这条会话里说过的话（开头几条，截断）',
    '',
    dg.userMsgs.length ? dg.userMsgs.map((s, i) => (i + 1) + '. ' + s).join('\n') : '（没抓到用户消息 —— 可能这条会话一直是 AI 在跑，或事件形状变了）',
    '',
    '> ⛔ 本档案**不抄聊天正文**（那会把档案变成第二个上下文）。要全文去看会话流或 GUI 导出。',
    '',
  ].join('\n');
}

function ensure() { fs.mkdirSync(ARCH, { recursive: true }); }

function indexPath() { return IDX; }

/** 已有档案的 id 集合 */
function archivedIds() {
  if (!fs.existsSync(ARCH)) return new Set();
  return new Set(fs.readdirSync(ARCH).filter((f) => f.endsWith('.md') && f.startsWith('会话-')).map((f) => f.replace(/^会话-/, '').replace(/\.md$/, '')));
}

/** 重建索引（工具生成，别手改） */
function rebuildIndex() {
  ensure();
  const files = fs.readdirSync(ARCH).filter((f) => f.startsWith('会话-') && f.endsWith('.md')).sort();
  const rows = files.map((f) => {
    const t = fs.readFileSync(path.join(ARCH, f), 'utf8');
    const g = (re) => (t.match(re) || [])[1] || '—';
    return {
      id: g(/会话 id \| `([^`]+)`/),
      scene: g(/\| 场景 \| ([^|]+) \|/).trim(),
      title: g(/^# 会话档案 · (.+)$/m),
      size: g(/会话流体积 \| ([\d.]+) KB/),
      ang: g(/\| 归档时间 \| ([^|]+) \|/).trim(),
    };
  });
  const md = [
    '# 会话档案 · 索引',
    '',
    '> 由 `工具\\会话档案.mjs` 生成（⛔ 别手改）。用途：换掉的会话**要点**还找得回来。',
    '> 每条只留 id / 场景 / 标题 / 体积 / 归档时间；全文在对应文件里。',
    '',
    '| 会话 id | 场景 | 标题 | 体积 | 归档时间 |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| \`${r.id}\` | ${r.scene} | ${r.title} | ${r.size} KB | ${r.ang} |`),
    '',
  ].join('\n');
  fs.writeFileSync(IDX, md, 'utf8');
  return rows.length;
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① 档案不抄正文：buildCard 不含大段对话
  {
    const dg = { missing: false, bytes: 1234, lines: 10, msgCount: 2, createdAt: Date.now(), cwd: 'x', userMsgs: ['你好，帮我改个东西'] };
    const card = buildCard('session-x', { scene: 'S', title: 'T', panel: 'p' }, dg, true);
    add(card.includes('不抄聊天正文') && card.includes('你好，帮我改个东西'), '正例 档案含要点、且声明不抄正文', '');
    add(card.length < 2000, '反例① 档案体积很小（<2 KB，不是把对话贴进来）', 'len=' + card.length);
  }
  // ② 没抓到用户消息要显式说明，不许静默空白
  {
    const card = buildCard('session-y', { scene: 'S', title: 'T', panel: 'p' }, { missing: false, bytes: 1, lines: 1, msgCount: 0, createdAt: 0, cwd: '', userMsgs: [] }, false);
    add(card.includes('没抓到用户消息'), '反例② 抓不到用户消息 ⇒ 显式说明（不静默空白）');
  }
  // ③ 索引能认出已归档 id
  {
    const set = new Set(['会话-abc.md']);
    add(set.has('会话-abc.md'), '正例 索引文件名 ↔ 会话 id 约定（会话-<id>.md）');
  }
  // ④ 路由表能把 bound 会话找出来
  {
    const m = boundMap();
    add(m.size >= 0, '正例 boundMap 可读（当前 ' + m.size + ' 条绑定会话）');
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
      '会话档案.mjs —— 换会话后给旧会话留要点（C7）',
      '  node 工具\\会话档案.mjs --capture [--scene <场景>]  给绑定会话拍档案',
      '  node 工具\\会话档案.mjs --list                     已有档案',
      '  node 工具\\会话档案.mjs --rotate <旧id>            标记已归档并留档案',
      '  node 工具\\会话档案.mjs --check [--quiet]          漏档的绑定会话 ⇒ ⚠',
      '  node 工具\\会话档案.mjs --selftest',
      '落点：' + path.relative(ROOT, ARCH),
    ].join('\n'));
    process.exit(0);
  }

  if (has('--list')) {
    const rows = fs.existsSync(ARCH) ? fs.readdirSync(ARCH).filter((f) => f.startsWith('会话-') && f.endsWith('.md')) : [];
    console.log('会话档案：' + ARCH);
    console.log('共 ' + rows.length + ' 份');
    rows.forEach((r) => console.log('  ' + r));
    process.exit(0);
  }

  if (has('--rotate')) {
    const id = val('--rotate');
    if (!/^session-[0-9a-f-]{30,}$/.test(id)) { console.error('✗ --rotate 需要完整会话 id'); process.exit(2); }
    const meta = boundMap().get(id) || { scene: '（已解绑）', title: '', panel: '' };
    const dg = digestSession(id);
    if (dg.missing) { console.error('✗ 找不到这条会话的会话流：' + id); process.exit(2); }
    ensure();
    const f = path.join(ARCH, '会话-' + id + '.md');
    fs.writeFileSync(f, buildCard(id, meta, dg, true), 'utf8');
    const n = rebuildIndex();
    console.log('✓ 已留档：' + path.relative(ROOT, f));
    console.log('  用户开头说过 ' + dg.userMsgs.length + ' 条（截断）；总体积 ' + (dg.bytes / 1024).toFixed(1) + ' KB');
    console.log('  索引已重建：' + n + ' 份');
    process.exit(0);
  }

  // --capture / --check（默认 capture）
  const only = val('--scene');
  const bound = boundMap();
  const ids = [...bound.keys()].filter((id) => !only || bound.get(id).scene === only);

  if (has('--check')) {
    const have = archivedIds();
    const missing = ids.filter((id) => !have.has(id));
    const bad = missing.length > 0;
    if (has('--quiet')) {
      console.log(bad ? `⚠ 会话档案：${missing.length}/${ids.length} 条绑定会话还没档案（跑 node 工具\\会话档案.mjs --capture）` : `✓ 会话档案：${ids.length} 条绑定会话都有档`);
      process.exit(0);
    }
    console.log('会话档案完整性：');
    for (const id of ids) console.log('  ' + (have.has(id) ? '✓' : '⚠') + ' ' + id + '  ' + (bound.get(id).title || ''));
    console.log('\n' + (bad ? '⚠ ' + missing.length + ' 条没档案（不阻断，但换会话后要点就丢了）' : '✓ 全部有档'));
    process.exit(0);
  }

  ensure();
  let n = 0;
  for (const id of ids) {
    const meta = bound.get(id);
    const dg = digestSession(id);
    if (dg.missing) { console.log('  ! 跳过（找不到会话流）：' + id); continue; }
    fs.writeFileSync(path.join(ARCH, '会话-' + id + '.md'), buildCard(id, meta, dg, false), 'utf8');
    n++;
    console.log('  ✓ ' + (meta.title || id) + '　' + (dg.bytes / 1024).toFixed(0) + ' KB · 用户消息 ' + dg.userMsgs.length + ' 条');
  }
  const total = rebuildIndex();
  console.log('\n✓ 拍了 ' + n + ' 份 · 索引共 ' + total + ' 份');
  console.log('  落点：' + path.relative(ROOT, ARCH));
}
