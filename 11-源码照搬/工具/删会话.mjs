#!/usr/bin/env node
/**
 * 删会话.mjs —— 真删一条会话（引擎没有 deleteSession 接口，只能自己落盘）
 *
 * ⚠ 不可逆。所以本工具强制三道闸：
 *   ① 默认 dry-run，必须 --go 才动；
 *   ② 必须 `--id <完整会话id>` 精确匹配（⛔ 不支持按标题模糊删）；
 *   ③ 删之前把三处都备份到 `_临时\scrap\删会话前备份-<时间>\`，并打印备份路径。
 *
 * 要动三处（少一处就会留下"幽灵"）：
 *   1. `storages\workspace.json` → 该工作区 `sessionIds` 数组里的一项
 *   2. `storages\session_projcache\sessions\<id>.json` → 投影缓存单条
 *   3. `sessions\<ws>\<id>\` → 会话流目录（`session.v4.jsonl.zstd` 在这里）
 *
 * ⛔ 不碰：别的会话、`archivedSessionIds`、`pinnedSessionIds`、记忆文件。
 *
 * 用法：
 *   node 工具\删会话.mjs --id <会话id>            # 只看会删什么（dry-run）
 *   node 工具\删会话.mjs --id <会话id> --go       # 真删
 *   node 工具\删会话.mjs --list                   # 列出所有会话 + 大小 + 是否面板绑定（找可疑残留）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
const engineData = CFG.engineDataDir || '引擎数据\\.dsh';
const localData = path.isAbsolute(engineData) ? engineData : path.join(ROOT, engineData);
const DSH_HOME = fs.existsSync(localData) ? localData : (process.env.DSH_HOME || path.join(ROOT, '引擎', '.dsh'));
const WS_FILE = path.join(DSH_HOME, 'storages', 'workspace.json');
const PROJ = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const SESS = path.join(DSH_HOME, 'sessions');
const SCEN = path.join(ROOT, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const die = (s) => { console.error('✗ ' + s); process.exit(1); };

/** 面板绑定的会话 id（这些绝不能被当残留删掉） */
function boundSessionIds() {
  const set = new Set();
  if (!fs.existsSync(SCEN)) return set;
  for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const j = readJson(path.join(SCEN, f)) || {};
    for (const p of j.panels || []) if (p.sessionId) set.add(p.sessionId);
    if (j.sessionId) set.add(j.sessionId);
  }
  return set;
}

/** 所有会话目录 → 大小 */
function sessionDirs() {
  const out = [];
  if (!fs.existsSync(SESS)) return out;
  for (const ws of fs.readdirSync(SESS)) {
    const d = path.join(SESS, ws);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const sid of fs.readdirSync(d)) {
      if (!sid.startsWith('session-')) continue;
      const f = path.join(d, sid, 'session.v4.jsonl.zstd');
      out.push({ id: sid, ws, dir: path.join(d, sid), size: fs.existsSync(f) ? fs.statSync(f).size : 0 });
    }
  }
  return out;
}

/* ---------------- --check：给机制体检用（有可疑残留 ⇒ exit 1） ---------------- */
if (has('--check')) {
  const bound = boundSessionIds();
  /**
   * 空壳判据（2026-11-21 重写，第二版）：
   *   判据 = **无面板绑定 且 体积 < 4 KB**。
   *
   * ⛔ 走过的弯路（留着别重犯）：
   *   第一版：只看「无绑定 + <4KB」⇒ 把引擎默认会话也报成空壳（假警报）。
   *   第二版：豁免「工作区 sessionIds 的第一位」⇒ **会话顺序一变就失效**。
   *           实测：新建场景后第一位变成 self-review 的会话，豁免就打错对象，
   *           导致反例⑧ 造的空壳数不上报 ⇒ 门禁假红。
   *   现在：**不猜"哪个是默认会话"**。默认会话一旦被任何场景复用就有绑定了，
   *        所以"无绑定 + 极小"就是空壳，不需要豁免任何东西。
   *        （实测本机 5 条会话全部有绑定，库里没有"该被豁免"的默认会话。）
   */
  const ghosts = sessionDirs().filter((s) => !bound.has(s.id) && s.size < 4096);

  if (!ghosts.length) {
    console.log('✓ 会话库干净：' + sessionDirs().length + ' 条，无空壳残留');
    process.exit(0);
  }
  console.log('⛔ 发现 ' + ghosts.length + ' 条空壳会话（无面板绑定 + <4 KB）：');
  for (const g of ghosts) console.log('  ' + g.id + ' 　' + (g.size / 1024).toFixed(1) + ' KB');
  console.log('  怎么修：node 工具\\删会话.mjs --id <完整id> --go（会先备份）');
  console.log('  ⚠ 若它是"准备给新场景用的空会话"⇒ 先绑面板，绑上就不算空壳。');
  process.exit(1);
}

/* ---------------- --list：找可疑残留 ---------------- */
if (has('--list') || (!val('--id') && !has('--go'))) {
  const bound = boundSessionIds();
  const dirs = sessionDirs().sort((a, b) => a.size - b.size);
  console.log('会话库：' + DSH_HOME + '\n');
  for (const s of dirs) {
    const tag = bound.has(s.id) ? '面板绑定' : '⚠ 无绑定';
    const sizeTxt = (s.size / 1024).toFixed(1).padStart(9) + ' KB';
    console.log(`  ${s.id}  ${sizeTxt}  ${tag}`);
  }
  console.log('\n判据：**无面板绑定 + 体积极小** ⇒ 大概率是建会话失败留下的空壳。');
  console.log('删除：node 工具\\删会话.mjs --id <完整id> --go（会先备份）');
  process.exit(0);
}

/* ---------------- 目标校验 ---------------- */
const id = val('--id');
if (!/^session-[0-9a-f-]{30,}$/.test(id)) die('--id 必须是完整会话 id（session-xxxxxxxx-…），不接受模糊匹配');
const bound = boundSessionIds();
if (bound.has(id)) die('⛔ 这个会话正被面板绑定着，删了会让面板指向空会话。先换会话/改绑定再删。');

// ⛔ 工作区的**最后一条**会话不许删（删了工作区会空掉，引擎会重建一个）
// ⚠ 2026-11-24 修（真 bug）：原来写的是 `sessionIds[0]`，注释说那是"引擎自带默认会话"。
//   但实测 `workspace.json` 的 sessionIds 是**最新在前**排的（updatedAt 每次 prepend）：
//     [0] session-<最新>   ← 最新建的那条
//     [1] session-<次新>
//     ...
//     [n] session-<最早>
//   ⇒ [0] 根本不是"引擎默认会话"，而是**最新建的那条**。结果任何新会话都会被
//     误判成"默认会话"而拒绝删除（我这次就被挡住了）。
//   真正要防的是"删到工作区一条不剩"，判据应该是**长度**，不是位置。
{
  const j = readJson(WS_FILE) || {};
  for (const [wid, w] of Object.entries(j.tables?.workspaces || {})) {
    const ids = w.sessionIds || [];
    if (ids.length === 1 && ids[0] === id) {
      die('⛔ 这是工作区 ' + wid.slice(0, 8) + ' **唯一**的一条会话，删了工作区会空掉（引擎下次启动会重建）。不删。');
    }
  }
}

const wsJson = readJson(WS_FILE);
if (!wsJson) die('读不到 workspace.json');
const dirs = sessionDirs();
const target = dirs.find((d) => d.id === id);
const projFile = path.join(PROJ, id + '.json');
const hasProj = fs.existsSync(projFile);

// 该 id 出现在哪些工作区的 sessionIds 里
const hits = [];
for (const [wsId, w] of Object.entries((wsJson.tables || {}).workspaces || {})) {
  const arr = w.sessionIds || [];
  const i = arr.indexOf(id);
  if (i >= 0) hits.push({ wsId, index: i, name: w.name || '(无名)' });
}

console.log('删除计划（不可逆）：');
console.log('  会话 id ：' + id);
console.log('  会话目录：' + (target ? target.dir + '  (' + (target.size / 1024).toFixed(1) + ' KB)' : '（不存在）'));
console.log('  投影缓存：' + (hasProj ? projFile : '（不存在）'));
console.log('  工作区登记：' + (hits.length ? hits.map((h) => h.name + ' sessionIds[' + h.index + ']').join(' / ') : '（没有）'));

if (!target && !hasProj && !hits.length) die('三处都找不到，没什么可删（可能已经删过了）');

if (!has('--go')) {
  console.log('\n--dry：以上只是计划。加 --go 才真删（会先备份三处）。');
  process.exit(0);
}

/* ---------------- 备份 → 删除 ---------------- */
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '');
const backup = path.join(ROOT, '_临时', 'scrap', '删会话前备份-' + stamp);
fs.mkdirSync(backup, { recursive: true });
fs.copyFileSync(WS_FILE, path.join(backup, 'workspace.json'));
if (hasProj) fs.copyFileSync(projFile, path.join(backup, 'projcache-entry.json'));
if (target) fs.cpSync(target.dir, path.join(backup, 'session-dir'), { recursive: true });
console.log('\n✓ 已备份到：' + backup);

const done = [];

// ① workspace.json 里摘掉（只动 sessionIds，其它字段一字不动）
if (hits.length) {
  for (const h of hits) {
    const w = wsJson.tables.workspaces[h.wsId];
    w.sessionIds = w.sessionIds.filter((x) => x !== id);
  }
  fs.writeFileSync(WS_FILE, JSON.stringify(wsJson, null, 2) + '\n', 'utf8');
  done.push('workspace.json 摘掉 ' + hits.length + ' 处登记');
}

// ② 投影缓存单条
if (hasProj) { fs.rmSync(projFile, { force: true }); done.push('投影缓存单条'); }

// ③ 会话目录
if (target) { fs.rmSync(target.dir, { recursive: true, force: true }); done.push('会话目录（' + (target.size / 1024).toFixed(1) + ' KB）'); }

console.log('\n✓ 已删除：');
for (const d of done) console.log('  · ' + d);
console.log('\n⚠ 引擎若在运行，界面可能要刷新/重启工作台才看不到残留条目。');
console.log('  回滚：把 ' + backup + ' 里的三份拷回原位。');
