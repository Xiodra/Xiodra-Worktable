#!/usr/bin/env node
/**
 * 协作体检.mjs —— 给「规矩本身」配体检（照搬《05-协作与规矩/README》第 5 步）
 *
 * 原文那句话：「给"规矩"本身配体检：过期/死条目/身份漂移/体积超线，让机器替你盯」
 * 以及《三-跨场景协作》§六：**§一 的行数必须 = 身份索引 §二 的面板数**，缺谁多谁点名。
 *
 * 判据（唯一出处 = 本文件；⛔ 别在别处再判一次）：
 *  ① 地盘表 ↔ 场景：`_共享记忆\索引.md` 的地盘表每一行都要有对应场景 json；
 *    每个"有 harness 面板"的场景在地盘表里**必须**有一行，且 `areas\<场景id>.md` 真实存在（死条目）。
 *  ② 地盘表 ↔ areas：`_共享记忆\索引.json` 里登记的每个 area，文件必须存在、memory 目录必须存在。
 *  ③ 身份索引 ↔ json：`外壳\scenarios\_场景身份索引.md` 每个面板 id 必须在某个场景 json 里出现（漂移）。
 *  ④ 体积红线：`99-工作区\AGENTS.md` **≤4 KB**（每轮注入，超了每轮都更贵）；
 *    `_共享记忆\协作规矩.md` **≤16 KB**（宪法，细则必须下沉）。
 *  ⑤ 宪法必须留「待 Xiodra 确认」出口（⛔ 没有出口 ⇒ AI 的推断会直接写进正文）。
 *
 * 用法：
 *   node 工具\协作体检.mjs            # 全量
 *   node 工具\协作体检.mjs --quiet     # 一行（挂机制体检）
 *   node 工具\协作体检.mjs --json
 *   node 工具\协作体检.mjs --selftest  # 5 个反例（漂移 / 死条目 / 超体积 / 缺出口 / 少登记索引.json）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const GUI = process.env.DSH_GUI_DIR || path.join(ROOT, '外壳');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
const BOARD = path.join(SHARED, '索引.md');
const BOARD_JSON = path.join(SHARED, '索引.json');
const RULES = path.join(SHARED, '协作规矩.md');
const IDX = path.join(GUI, 'scenarios', '_场景身份索引.md');
/**
 * 注入层 AGENTS.md 的落点（这是唯一权威列表，改位置就改这里）。
 * 为什么不是写死一条：工作台根与工作区根**不同**（工作区 = `<工作台>\..\99-工作区` 这种布局），
 * 写死一条会在换机/换盘后静默"找不到" ⇒ 体检报假 ⛔。
 */
const AGENTS_CANDIDATES = [
  process.env.DSH_AGENTS_FILE,
  path.join(ROOT, '99-工作区', 'AGENTS.md'),
  path.join(ROOT, '..', '99-工作区', 'AGENTS.md'),
  path.join(ROOT, 'AGENTS.md'),
].filter(Boolean);
const AGENTS = AGENTS_CANDIDATES.find((p) => fs.existsSync(p)) || AGENTS_CANDIDATES[1];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

const SIZE = { agents: 4096, rules: 16 * 1024 };
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

function readScenes() {
  const dir = path.join(GUI, 'scenarios');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '')); if (j && j.id) out.push(j); } catch { /* 坏 json 交给场景体检 */ }
  }
  return out;
}

/** 读地盘表（`索引.md` 的三列主表） */
function readBoard() {
  const rows = [];
  if (!fs.existsSync(BOARD)) return rows;
  for (const line of fs.readFileSync(BOARD, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const c = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim().replace(/`/g, ''));
    if (c.length < 3) continue;
    if (c[0] === '场景' || /^-+$/.test(c[0])) continue;
    rows.push({ scene: c[0], area: c[1], owner: c[2] });
  }
  return rows;
}

export function check() {
  const bad = [], warn = [], ok = [];
  const scenes = readScenes();
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const byName = new Map(scenes.map((s) => [s.name, s]));
  const board = readBoard();

  /* ① 地盘表 ↔ 场景：双向 */
  for (const r of board) {
    const hit = byId.get(r.scene) || byName.get(r.scene);
    if (!hit) bad.push(`地盘表多出一行「${r.scene}」（没有对应场景 json ⇒ 表过期，删这行或补场景）`);
  }
  const boardNames = new Set(board.map((r) => r.scene));
  for (const s of scenes) {
    const harness = (s.panels || []).filter((p) => p.type === 'harness' && p.sessionId);
    if (!harness.length) continue;                        // 没有常驻会话的场景不必上地盘表
    if (!boardNames.has(s.id) && !boardNames.has(s.name)) bad.push(`场景「${s.name}」有 AI 面板但地盘表里没这一行（别的场景不知道这块地归谁）`);
  }
  if (board.length) ok.push('地盘表 ' + board.length + ' 行 ↔ 场景 ' + scenes.length + ' 个（双向已核）');

  /* ② 索引.json ↔ areas 文件 */
  try {
    if (fs.existsSync(BOARD_JSON)) {
      const j = JSON.parse(fs.readFileSync(BOARD_JSON, 'utf8').replace(/^\uFEFF/, ''));
      for (const a of j.areas || []) {
        const f = path.join(SHARED, a.file || '');
        if (!a.file || !fs.existsSync(f)) bad.push(`索引.json 里 ${a.id} 的 area 文件不存在：${a.file || '（空）'}`);
        const memDir = path.join(MEM, (a.memory || '').replace(/^场景记忆[\\/]/, ''));
        if (!a.memory || !fs.existsSync(memDir)) bad.push(`索引.json 里 ${a.id} 的 memory 目录不存在：${a.memory || '（空）'}`);
        if (a.panel && !(idxPanels().has(a.panel))) bad.push(`索引.json 里 ${a.id} 的 panel「${a.panel}」不在身份索引表里`);
      }
      ok.push('索引.json areas ' + (j.areas || []).length + ' 个（文件与记忆目录已核）');
    } else warn.push('缺 索引.json（共享层地盘表没有机器可读版）');
  } catch (e) { bad.push('索引.json 解析失败：' + e.message); }

  /* ②b 反向核对：地盘表每一行都必须在 索引.json 里登记（派单 dd6a6568af） */
  // ⚠ 第②项是"正向"（索引.json → 文件在不在），**少登记会假绿**。
  //   这里补"反向"（地盘表 → 索引.json 有没有这一行），少登记就会报出来。
  try {
    if (fs.existsSync(BOARD_JSON)) {
      const j2 = JSON.parse(fs.readFileSync(BOARD_JSON, 'utf8').replace(/^\uFEFF/, ''));
      const registered = new Set(
        (j2.areas || []).map(function (a) { return String(a.file || '').replace(/\\/g, '/'); })
      );
      // 地盘表的 area 列形如：`areas/controller.md` ｜ `场景记忆\控制器\场景私有记忆.md`
      // ⇒ 必须**按 ｜ 切开只取前半**（areas/*.md），否则永远对不上 索引.json 的 areas[].file。
      const areaFileOf = function (cell) {
        let v = String(cell || '');
        // 三种分隔符都兜住（全角竖线 / 半角竖线 / 新式顿号）
        v = v.split(/[｜|]/)[0];
        v = v.replace(/[\u3000]/g, ' ').trim();
        return v.replace(/\\/g, '/').replace(/^\.\//, '');
      };
      let checkedRows = 0;
      for (const r of board) {
        const area = areaFileOf(r.area);
        if (!area) continue;                    // 空 area 行不在本条判据范围
        checkedRows += 1;
        if (!registered.has(area)) {
          bad.push('地盘表「' + r.scene + '」的 area ' + area + ' 没在 索引.json 的 areas 里登记（少登记 = 别的场景查不到这块地）');
        }
      }
      if (checkedRows) {
        ok.push('地盘表 ' + checkedRows + ' 行 area ↔ 索引.json areas ' + registered.size + ' 个（反向已核）');
      }
    }
  } catch (e) { bad.push('索引.json 反向核对失败：' + e.message); }

  /* ③ 身份索引 ↔ 场景 json（漂移） */
  const idxP = idxPanels();
  const jsonPanels = new Set();
  for (const s of scenes) for (const p of s.panels || []) jsonPanels.add(p.id);
  for (const pid of idxP) if (!jsonPanels.has(pid)) bad.push(`身份索引多出一行 ${pid}（场景 json 里没这个面板 ⇒ 身份漂移）`);
  ok.push('身份索引 ' + idxP.size + ' 个面板 ↔ json ' + jsonPanels.size + ' 个（漂移已核）');

  /* ④ 体积红线 */
  if (!fs.existsSync(AGENTS)) bad.push('缺 ' + path.relative(ROOT, AGENTS) + '（注入层没了 ⇒ 每次开场都不认身份）');
  else {
    const b = fs.statSync(AGENTS).size;
    if (b > SIZE.agents) bad.push(`AGENTS.md ${kb(b)} 超红线 ${kb(SIZE.agents)}（每轮注入，必须减；细则下沉到协作规矩）`);
    else ok.push('AGENTS.md ' + kb(b) + '（红线 ' + kb(SIZE.agents) + '）');
  }
  if (!fs.existsSync(RULES)) bad.push('缺 协作规矩.md');
  else {
    const b = fs.statSync(RULES).size;
    if (b > SIZE.rules) bad.push(`协作规矩.md ${kb(b)} 超红线 ${kb(SIZE.rules)}（搬旧内容进 归档\\，留指针）`);
    else ok.push('协作规矩.md ' + kb(b) + '（红线 ' + kb(SIZE.rules) + '）');
  }

  /* ⑤ 宪法必须留「待 Xiodra 确认」出口（判据 = 有一个**独立小节**，正文提一句不算） */
  if (fs.existsSync(RULES)) {
    const t = fs.readFileSync(RULES, 'utf8');
    if (!/^##+\s*待 Xiodra 确认/m.test(t)) bad.push('协作规矩.md 里没有「## 待 Xiodra 确认」小节（AI 的推断会直接写进正文；正文提一句不算出口）');
    else ok.push('「待 Xiodra 确认」小节在');
  }
  return { bad, warn, ok, board: board.length, scenes: scenes.length, panels: idxP.size };
}

function idxPanels() {
  const set = new Set();
  if (!fs.existsSync(IDX)) return set;
  for (const line of fs.readFileSync(IDX, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const c = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim().replace(/`/g, ''));
    if (c.length < 3) continue;
    if (c[1] === '面板 id' || /^-+$/.test(c[1])) continue;
    if (c[1]) set.add(c[1]);
  }
  return set;
}

/* ---------------- 反例门禁 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });
  const boardBackup = fs.existsSync(BOARD) ? fs.readFileSync(BOARD) : null;
  const rulesBackup = fs.existsSync(RULES) ? fs.readFileSync(RULES) : null;

  const restore = (f, b) => { if (b !== null) fs.writeFileSync(f, b); };
  try {
    // 反例①：地盘表造一个不存在的场景
    if (boardBackup) {
      fs.writeFileSync(BOARD, boardBackup.toString('utf8') + '\n| 不存在的场景 | `areas/x.md` | x-ai |\n', 'utf8');
      const r = check();
      add(r.bad.some((b) => b.includes('地盘表多出一行')), '反例① 地盘表多一行不存在的场景 ⇒ ⛔', r.bad.slice(0, 2).join(' | '));
      restore(BOARD, boardBackup);
    }
    // 反例②：身份索引漂移（加一个 json 里没有的面板）
    if (fs.existsSync(IDX)) {
      const b = fs.readFileSync(IDX);
      fs.writeFileSync(IDX, b.toString('utf8') + '\n| `ghost` | `ghost-panel` | 幽灵 | `幽灵` | `session-XX-ghost` | `scenarios/ghost-context.md` | — |\n', 'utf8');
      const r = check();
      add(r.bad.some((x) => x.includes('身份索引多出一行')), '反例② 身份索引多一行 json 里没有的面板 ⇒ ⛔ 漂移', r.bad.slice(0, 2).join(' | '));
      fs.writeFileSync(IDX, b);
    }
    // 反例③：AGENTS.md 超 4 KB
    if (fs.existsSync(AGENTS)) {
      const b = fs.readFileSync(AGENTS);
      fs.writeFileSync(AGENTS, b.toString('utf8') + '\n' + '填充'.repeat(1500) + '\n', 'utf8');
      const r = check();
      add(r.bad.some((x) => x.includes('AGENTS.md') && x.includes('超红线')), '反例③ AGENTS.md 灌到 4 KB 以上 ⇒ ⛔', r.bad.slice(0, 2).join(' | '));
      fs.writeFileSync(AGENTS, b);
    }
    // 反例④：拿掉「待 Xiodra 确认」出口
    if (rulesBackup) {
      const t = rulesBackup.toString('utf8').replace(/##\s*待 Xiodra 确认[\s\S]*$/, '');
      fs.writeFileSync(RULES, t, 'utf8');
      const r = check();
      add(r.bad.some((x) => x.includes('待 Xiodra 确认')), '反例④ 宪法没有「待 Xiodra 确认」出口 ⇒ ⛔', r.bad.slice(0, 2).join(' | '));
      restore(RULES, rulesBackup);
    }
    // 反例⑤：地盘表某行**少登记**进 索引.json ⇒ ②b 反向核对必须报 ⛔
    // ⚠ 这层"前置补全"不能省：现状 索引.json 可能本来就少登记（check() 本来就报错），
    //   那样"删一条 → 断言报错"会恒真 ⇒ 假绿。所以先把基线补成**干净**的再删。
    if (fs.existsSync(BOARD_JSON)) {
      const idxBackup = fs.readFileSync(BOARD_JSON);          // ★Buffer，字节级备份★
      try {
        const base = JSON.parse(idxBackup.toString('utf8').replace(/^\uFEFF/, ''));
        base.areas = Array.isArray(base.areas) ? base.areas : [];

        // 按地盘表把缺的 area 都补上（只用于造干净基线）
        const haveFiles = new Set(base.areas.map((a) => String(a.file || '').replace(/\\/g, '/')));
        for (const r of readBoard()) {
          const f = String(r.area || '').split(/[｜|]/)[0].trim().replace(/\\/g, '/');
          if (!f || haveFiles.has(f)) continue;
          base.areas.push({
            id: f.replace(/^areas\//, '').replace(/\.md$/, ''),
            name: r.scene, owner: r.owner || '',
            memory: '场景记忆/' + r.scene, file: f, panel: ''
          });
          haveFiles.add(f);
        }

        fs.writeFileSync(BOARD_JSON, JSON.stringify(base, null, 2) + '\n', 'utf8');
        const rClean = check();
        const cleanOk = !rClean.bad.some((x) => x.includes('没在 索引.json 的 areas 里登记'));

        if (!cleanOk) {
          add(false, '反例⑤ 少登记 索引.json ⇒ ⛔（跳过：补全后基线仍不干净）',
            rClean.bad.slice(0, 2).join(' | '));
        } else {
          // 从干净基线里删掉一条 ⇒ 必须报
          const drop = base.areas[base.areas.length - 1];
          const broken = JSON.parse(JSON.stringify(base));
          broken.areas = broken.areas.filter((a) => a.file !== drop.file);
          fs.writeFileSync(BOARD_JSON, JSON.stringify(broken, null, 2) + '\n', 'utf8');
          const r2 = check();
          const hit = r2.bad.some((x) => x.includes('没在 索引.json 的 areas 里登记'));
          add(hit, '反例⑤ 地盘表某行少登记进 索引.json ⇒ ⛔（删 ' + drop.file + '）',
            hit ? '' : ('没报出来；bad=' + r2.bad.slice(0, 2).join(' | ')));
        }
      } finally {
        fs.writeFileSync(BOARD_JSON, idxBackup);              // ★写回原 Buffer，字节级还原★
      }
    }
  } finally {
    restore(BOARD, boardBackup);
    restore(RULES, rulesBackup);
  }
  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- CLI ---------------- */
if (isMain) {
  if (has('--selftest')) process.exit(selftest());
  const r = check();
  if (has('--json')) { console.log(JSON.stringify({ bad: r.bad.length, warn: r.warn.length, ...r }, null, 2)); process.exit(r.bad.length ? 1 : 0); }
  if (has('--quiet')) {
    console.log(r.bad.length ? `⛔ 协作体检：${r.bad.length} 个硬问题（跑 node 工具\\协作体检.mjs 看明细）` : `✓ 协作体检：地盘表/索引/体积 全过${r.warn.length ? '（⚠ ' + r.warn.length + '）' : ''}`);
    process.exit(r.bad.length ? 1 : 0);
  }
  console.log('协作体检 —— 给「规矩本身」查一遍\n');
  for (const s of r.ok) console.log('  ✓ ' + s);
  for (const w of r.warn) console.log('  ⚠ ' + w);
  for (const b of r.bad) console.log('  ⛔ ' + b);
  console.log('\n' + (r.bad.length ? `⛔ ${r.bad.length} 个硬问题` : '✓ 全部通过'));
  process.exit(r.bad.length ? 1 : 0);
}
