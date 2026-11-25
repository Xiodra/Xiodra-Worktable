#!/usr/bin/env node
/**
 * 宪法体检.mjs —— 规矩本身有没有版本纪律（照搬《04/自检清单》+ 拓扑 C1「改一次版本+1、旧版留档」）
 *
 * 治什么：规矩被改了很多次，**一次版本号都没打、旧版也没留档** ⇒ 规矩回滚不了、也说不清哪版改了什么。
 * 这是根上的洞：别的体检都查"文件对不对"，这一项查"**改动有没有被记账**"。
 *
 * 判据（唯一出处 = 本文件）：
 *   ① **版本号在**：`协作规矩.md` 头部必须有 `版本：vX.Y`（⛔ 没有 ⇒ 关闸）
 *   ② **变更记录在**：必须有「## 变更记录」小节，且**最后一行版本 == 头部版本**（⛔ 不一致 ⇒ 改过没记账）
 *   ③ **改过必须升版**：把当前内容指纹和「上次记账时的指纹」比 ——
 *      **内容变了但版本号没变 ⇒ ⛔ 悄悄改**（这一条是关键，其余都是它的配套）
 *   ④ **旧版留档在**：`_共享记忆\归档\协作规矩-v<版本>-*.md` 必须存在（v1.0 起）
 *   ⑤ **只追加**：变更记录的版本号必须**单调递增**，且历史行不许少（和上次记的比）
 *
 * 用法：
 *   node 工具\宪法体检.mjs            # 检查（⛔ ⇒ exit 1）
 *   node 工具\宪法体检.mjs --quiet    # 一行结论（挂机制体检）
 *   node 工具\宪法体检.mjs --bump "改了什么"   # 升一版：+1、写变更行、旧版留档、重记指纹
 *   node 工具\宪法体检.mjs --record   # 只重记指纹（首次接入用，不升版）
 *   node 工具\宪法体检.mjs --selftest # 反例：改内容不升版必须被抓出来
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
const DOC = path.join(SHARED, '协作规矩.md');
const ARCH_DIR = path.join(SHARED, '归档');
const STATE = path.join(SHARED, '_宪法状态.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/** 从正文里抽版本号与变更记录 */
export function parse(text) {
  const ver = (text.match(/版本[：:]\s*\*{0,2}(v\d+\.\d+)/) || [])[1] || '';
  const rows = [];
  const i = text.indexOf('## 变更记录');
  if (i >= 0) {
    const rest = text.slice(i);
    const end = rest.indexOf('\n## ', 5);
    const sec = end > 0 ? rest.slice(0, end) : rest;
    for (const line of sec.split(/\r?\n/)) {
      const m = line.match(/^\|\s*(v\d+\.\d+)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/);
      if (m) rows.push({ ver: m[1], date: m[2], what: m[3] });
    }
  }
  return { ver, rows };
}

const cmpVer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  return pa[0] - pb[0] || (pa[1] || 0) - (pb[1] || 0);
};
const bumpVer = (v) => {
  const m = String(v).replace(/^v/, '').split('.').map(Number);
  return 'v' + m[0] + '.' + ((m[1] || 0) + 1);
};

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n', 'utf8');

/** 核心检查（纯函数式，便于自测） */
export function check(docText, state) {
  const bad = [], warn = [], ok = [];
  const { ver, rows } = parse(docText);

  if (!ver) bad.push('头部没有「版本：vX.Y」⇒ 规矩没有版本纪律');
  else ok.push('版本 ' + ver);

  if (!rows.length) bad.push('没有「## 变更记录」或它是空的（改了什么没记账）');
  else {
    const last = rows[rows.length - 1];
    if (ver && last.ver !== ver) bad.push(`变更记录最后一行是 ${last.ver}，但头部写 ${ver}（改过没记账 / 号写错了）`);
    else ok.push('变更记录 ' + rows.length + ' 行（最新 ' + last.ver + ' 与头部一致）');

    // 单调递增
    for (let i = 1; i < rows.length; i++) {
      if (cmpVer(rows[i].ver, rows[i - 1].ver) < 0) bad.push(`变更记录不是递增：${rows[i - 1].ver} 之后出现 ${rows[i].ver}`);
    }
  }

  // ③ 改过没升版（关键判据）
  const h = sha(docText);
  if (!state) warn.push('还没有指纹基线（跑 --record 接入）');
  else {
    if (state.hash === h) ok.push('内容未变（指纹 ' + h + '）');
    else if (state.version === ver) bad.push(`内容改了但版本号仍是 ${ver}（⛔ 悄悄改：改完必须 --bump）`);
    else ok.push('内容已变且版本已升（' + state.version + ' → ' + ver + '）');
    // ⑤ 历史行不许少
    if (typeof state.rowCount === 'number' && rows.length < state.rowCount) {
      bad.push(`变更记录少了行（上次 ${state.rowCount} 行，现在 ${rows.length} 行）—— 只追加，不许删历史`);
    }
  }

  // ④ 旧版留档：**除当前版本外**，变更记录里提到的每个版本都该有归档文件
  //    （升版时归档的是"被换下来的那一版"，所以当前版没有归档是正常的）
  if (ver && rows.length) {
    const older = rows.map((r) => r.ver).filter((v) => cmpVer(v, ver) < 0);
    const inArch = fs.existsSync(ARCH_DIR) ? fs.readdirSync(ARCH_DIR) : [];
    const missing = older.filter((v) => !inArch.some((f) => f.startsWith('协作规矩-v' + v.replace(/^v/, '') + '-')));
    if (missing.length) warn.push('这些旧版没留档：' + missing.join(' / ') + '（升版时应用 --bump 自动留档）');
    else ok.push('旧版留档齐全（' + older.length + ' 个旧版本）');
  }
  return { bad, warn, ok, ver, rows, hash: h };
}

/* ---------------- 升版 / 记指纹 ---------------- */
function bump(note) {
  const text = fs.readFileSync(DOC, 'utf8');
  const { ver, rows } = parse(text);
  const state = readState();
  if (!note) { console.error('✗ --bump 必须带一句「改了什么」'); process.exit(2); }
  if (!ver) { console.error('✗ 文档里没有版本号，先手工加「版本：v1.0」'); process.exit(2); }

  const next = state && state.hash !== sha(text) ? bumpVer(ver) : ver === (state && state.version) ? bumpVer(ver) : ver;
  const oldVer = ver;

  // ① 旧版留档（当前内容 = 旧版）
  fs.mkdirSync(ARCH_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const arch = path.join(ARCH_DIR, '协作规矩-v' + oldVer.replace(/^v/, '') + '-' + stamp + '.md');
  if (!fs.existsSync(arch)) {
    fs.writeFileSync(arch, [
      '> 归属：`_共享记忆\\协作规矩.md` 的旧版留档（只进不改）。',
      '> 留档原因：升版到 ' + next + '（' + note + '）',
      '',
      text,
    ].join('\n'), 'utf8');
  }

  // ② 头版本 +1
  let out = text.replace(/(版本[：:]\s*\*{0,2})v\d+\.\d+/, '$1' + next);
  // ③ 追加变更行
  const today = new Date().toISOString().slice(0, 10);
  const newRow = '| ' + next + ' | ' + today + ' | ' + note + ' |';
  const idx = out.lastIndexOf('\n| v');
  if (idx < 0) { console.error('✗ 找不到变更记录表格'); process.exit(2); }
  const lineEnd = out.indexOf('\n', idx + 1);
  out = out.slice(0, lineEnd) + '\n' + newRow + out.slice(lineEnd);

  fs.writeFileSync(DOC, out, 'utf8');
  const { rows: rows2 } = parse(out);
  writeState({ version: next, hash: sha(out), rowCount: rows2.length, at: new Date().toISOString(), archived: path.basename(arch) });

  console.log('✓ 升版 ' + oldVer + ' → ' + next);
  console.log('  改了什么：' + note);
  console.log('  旧版留档：归档\\' + path.basename(arch));
  console.log('  变更记录：' + rows2.length + ' 行');
}

function record() {
  const text = fs.readFileSync(DOC, 'utf8');
  const { ver, rows } = parse(text);
  if (!ver) { console.error('✗ 文档里没有版本号'); process.exit(2); }
  writeState({ version: ver, hash: sha(text), rowCount: rows.length, at: new Date().toISOString() });
  console.log('✓ 已记指纹：' + ver + ' · ' + sha(text) + ' · ' + rows.length + ' 行');
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  const good = (ver, extra = '') => [
    '# 协作规矩', '', '> **版本：' + ver + '**（2026-11-19 立）', '',
    '## 变更记录', '', '| 版本 | 日期 | 改了什么 |', '|---|---|---|',
    '| v1.0 | 2026-11-19 | 建档 |' + extra, '',
    '## §1 规则只认 Xiodra', '- 依据只有一种' + (extra ? '（改过）' : ''), '',
  ].join('\n');

  // ① 缺版本号
  {
    const t = good('v1.0').replace(/版本：v1\.0/, '无版本');
    const r = check(t, null);
    add(r.bad.some((b) => b.includes('版本')), '反例① 没有版本号 ⇒ ⛔', r.bad.join(' | '));
  }
  // ② 头部与变更记录不一致
  {
    const t = good('v1.2');
    const r = check(t, null);
    add(r.bad.some((b) => b.includes('改过没记账')), '反例② 头部 v1.2 但记录只到 v1.0 ⇒ ⛔ 改过没记账', r.bad.join(' | '));
  }
  // ③ 改内容不升版（最关键）
  {
    const before = good('v1.0');
    const state = { version: 'v1.0', hash: sha(before), rowCount: 1 };
    const after = good('v1.0', ' ');   // 内容变了（表格多一个空格），版本没变
    const r = check(after, state);
    add(r.bad.some((b) => b.includes('悄悄改')), '反例③ **内容变了但版本号没变** ⇒ ⛔ 悄悄改', r.bad.join(' | '));
  }
  // ④ 变更记录少了行（删历史）
  {
    const before = good('v1.0');
    const state = { version: 'v1.0', hash: sha(before), rowCount: 5 };
    const r = check(before, state);
    add(r.bad.some((b) => b.includes('少了行')), '反例④ 变更记录比上次少 ⇒ ⛔ 删了历史', r.bad.join(' | '));
  }
  // ⑤ 全绿
  {
    const t = good('v1.0');
    const r = check(t, { version: 'v1.0', hash: sha(t), rowCount: 1 });
    add(r.bad.length === 0, '正例 版本/记录/指纹一致 ⇒ 通过', r.bad.join(' | '));
  }
  // ⑥ 正常升版
  {
    const before = good('v1.0');
    const after = good('v1.1', '').replace('| v1.0 | 2026-11-19 | 建档 |', '| v1.0 | 2026-11-19 | 建档 |\n| v1.1 | 2026-11-19 | 加一条 |');
    const state = { version: 'v1.0', hash: sha(before), rowCount: 1 };
    const r = check(after, state);
    const okBump = r.bad.filter((b) => !b.includes('留档')).length === 0;
    add(okBump, '正例 改了内容且升到 v1.1 ⇒ 通过（只剩留档提示）', r.bad.join(' | '));
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
      '宪法体检.mjs —— 规矩的版本纪律',
      '  node 工具\\宪法体检.mjs              检查',
      '  node 工具\\宪法体检.mjs --record     首次接入：只记指纹',
      '  node 工具\\宪法体检.mjs --bump "改了什么"  升一版 + 旧版留档',
      '  node 工具\\宪法体检.mjs --selftest   反例自证',
      '  node 工具\\宪法体检.mjs --quiet      一行（挂机制体检）',
    ].join('\n'));
    process.exit(0);
  }
  if (!fs.existsSync(DOC)) { console.error('✗ 找不到 ' + DOC); process.exit(2); }
  if (has('--record')) { record(); process.exit(0); }
  if (has('--bump')) { bump(val('--bump') || argv[argv.indexOf('--bump') + 1] || ''); process.exit(0); }

  const r = check(fs.readFileSync(DOC, 'utf8'), readState());
  if (has('--quiet')) {
    console.log(r.bad.length ? `⛔ 宪法体检：${r.bad.length} 个问题（跑 node 工具\\宪法体检.mjs 看明细）` : `✓ 宪法体检：${r.ver} · 版本纪律正常${r.warn.length ? '（⚠ ' + r.warn.length + '）' : ''}`);
    process.exit(r.bad.length ? 1 : 0);
  }
  console.log('宪法体检 —— 规矩有没有版本纪律\n');
  for (const s of r.ok) console.log('  ✓ ' + s);
  for (const w of r.warn) console.log('  ⚠ ' + w);
  for (const b of r.bad) console.log('  ⛔ ' + b);
  console.log('\n' + (r.bad.length ? '⛔ ' + r.bad.length + ' 个问题' : '✓ 全部通过'));
  if (r.bad.length) console.log('  怎么修：改完跑 node 工具\\宪法体检.mjs --bump "改了什么"');
  process.exit(r.bad.length ? 1 : 0);
}
