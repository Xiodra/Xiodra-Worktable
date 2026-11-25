#!/usr/bin/env node
/**
 * 临时哨兵.mjs —— 扫「不该出现临时文件的地方」，有就 ⛔ 并 exit 1
 *
 * 照搬：淋雨家工作台《08-升级与改造清单》例 1 的第 3、4 步。
 * 判据出处只有一个：`临时路径.mjs` 的允许区（`_临时\big|keep|scrap`）。
 * ⛔ 本脚本只**列**、只**报**，一个文件都不删（删东西必须由 Xiodra 拍板）。
 *
 * 扫哪些地方（WATCH = 工作台根的直接子目录 + 各场景记忆；`_w`/`_x` 等工作区内部目录不扫）：
 *   工作台根下每个文档/资产目录（含 `说明\`、`08-*`、`工作区`）+ `引擎数据\.dsh\场景记忆`
 * 不扫（SKIP）：`_临时`（允许区本身）、node_modules、.git、引擎、引擎数据（除场景记忆）、
 *   captures、备份、归档、attachments…
 *
 * 什么算临时件：
 *   ① 名字特征 `~$* / *.tmp / *.bak / *.swp / *.part / *.crdownload`
 *   ② **允许区之外**出现叫 `_临时` 的目录（裸放 —— 说明有人绕过了临时路径.mjs）
 *
 * 用法：
 *   node 工具\临时哨兵.mjs            # 全量扫，有违规 exit 1
 *   node 工具\临时哨兵.mjs --quiet    # 只有一行结论（挂计划任务用）
 *   node 工具\临时哨兵.mjs --json     # 给别的脚本读
 *   node 工具\临时哨兵.mjs --selftest # 自造 3 个反例 + 1 个正例，验证它真的会报
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, TMP_ROOTS, tierOf } from './临时路径.mjs';

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);

const TMP_NAME = /(^~\$)|(\.tmp$)|(\.bak$)|(\.swp$)|(\.part$)|(\.crdownload)$/i;

/** 不扫的目录名（小写比较） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '_临时', 'captures', '备份', '归档', '模型',
  '引擎', 'dist', 'build', 'out', 'coverage', 'attachments',
  'electron-profile', '_归档-无场景模板',
].map((s) => s.toLowerCase()));

/** 扫哪些地方。`引擎数据` 只下钻到「场景记忆」。`_临时` 本身是允许区，交给临时路径.mjs 判，不在这扫。 */
const WATCH_TOP_SKIP = new Set(['引擎数据']);
const WATCH_TOP_PREFIX_SKIP = ['_selftest', '_w', '_x'];
function watchRoots() {
  const out = [ROOT, path.join(ROOT, '_临时')];
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (WATCH_TOP_SKIP.has(d.name)) continue;
    if (WATCH_TOP_PREFIX_SKIP.some((p) => d.name.startsWith(p))) continue;
    // ⚠ 2026-11-23 修（真 bug）：原来这里没查 SKIP_DIRS，
    //   于是根目录下的 `备份\` 虽然写在 SKIP_DIRS 里，却被**直接加进扫描列表**，
    //   绕过了豁免 ⇒ 备份的 .bak 被误报违规（MCP\备份\ 不报是因为它在下钻时才被 SKIP 拦下）。
    //   ⇒ 根目录这一层也要走同一套豁免。
    if (SKIP_DIRS.has(d.name.toLowerCase())) continue;
    out.push(path.join(ROOT, d.name));
  }
  const mem = path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
  if (fs.existsSync(mem)) out.push(mem);
  return out;
}

function walk(dir, depth, hits, seen) {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (seen.has(full)) continue;
    seen.add(full);
    // 裸放的 `_临时`：允许区之外出现 `_临时` 这个名字 ⇒ 违规（只看目录本身，不继续下钻）
    if (e.isDirectory() && e.name === '_临时') {
      if (tierOf(full) === null) hits.push({ p: full, why: '裸放的 _临时（不在三档允许区）' });
      continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      walk(full, depth + 1, hits, seen);
      continue;
    }
    const hit = hits.some((h) => h.p === full);
    if (TMP_NAME.test(e.name) && !hit) hits.push({ p: full, why: '临时件名字特征：' + e.name });
  }
}

/** 普通扫描（不含自造样本） */
export function scan() {
  const hits = [];
  const seen = new Set();
  for (const r of watchRoots()) if (fs.existsSync(r)) walk(r, 0, hits, seen);
  return hits;
}

function report(hits, quiet, asJson) {
  const rel = hits.map((h) => ({ path: path.relative(ROOT, h.p), why: h.why }));
  if (asJson) { console.log(JSON.stringify({ root: ROOT, bad: rel.length, hits: rel }, null, 2)); return rel.length ? 1 : 0; }
  if (quiet) {
    console.log(rel.length ? `⛔ 临时哨兵：${rel.length} 处违规（跑 node 工具\\临时哨兵.mjs 看明细）` : '✓ 临时哨兵：0 处违规');
    return rel.length ? 1 : 0;
  }
  if (!rel.length) { console.log('✓ 临时哨兵：没发现临时件（' + ROOT + '）'); return 0; }
  console.log('⛔ 临时哨兵：发现 ' + rel.length + ' 处违规（只列不删）');
  for (const h of rel.slice(0, 50)) console.log('  · ' + h.path + '  ← ' + h.why);
  if (rel.length > 50) console.log('  … 其余 ' + (rel.length - 50) + ' 处略');
  console.log('\n怎么处置：大体积/草稿挪进 `node 工具\\临时路径.mjs --big|--keep --name <名>` 给的目录；');
  console.log('确认没用就自己删；要批量清交给「本地电脑」场景（⛔ 本脚本不改任何文件）。');
  return 1;
}

/* ---------------- 自测：自造样本必须在本次扫描里被报出来 ---------------- */
function selftest() {
  const bigRoot = TMP_ROOTS.big;
  fs.mkdirSync(bigRoot, { recursive: true });
  const samples = [
    // 正例：允许区内的嵌套 `_临时` 不算裸放
    { dir: path.join(ROOT, '_临时', 'keep', '_selftest', '_临时'), file: 'inner.tmp', expect: false, label: '正例允许区内的嵌套 _临时 ⇒ 必须忽略' },
    { dir: path.join(ROOT, '_selftest-sentinel'), file: 'junk.tmp', expect: true, label: '反例①工作台根出现 .tmp ⇒ 必须报' },
    { dir: path.join(ROOT, '_selftest-sentinel', 'sub'), file: '~$锁.docx', expect: true, label: '反例②深层目录出现 ~$ 锁文件 ⇒ 必须报' },
    { dir: path.join(ROOT, '08-升级与改造清单', '_临时'), file: 'x.bak', expect: true, label: '反例③允许区之外出现 _临时 目录（裸放）⇒ 必须报' },
    // ⚠ 2026-11-23 补：根目录 `备份\` 必须豁免（原来 watchRoots 没查 SKIP_DIRS ⇒ 误报）
    { dir: path.join(ROOT, '备份', '_selftest-bak'), file: 'y.bak', expect: false, label: '正例根目录 备份\\ 下的 .bak ⇒ 必须忽略（SKIP_DIRS 对根层也要生效）' },
  ];
  for (const s of samples) {
    fs.mkdirSync(s.dir, { recursive: true });
    fs.writeFileSync(path.join(s.dir, s.file), 'selftest\n', 'utf8');
  }
  const hits = scan();
  const hitPaths = hits.map((h) => path.resolve(h.p).toLowerCase());
  let pass = 0;
  const rows = [];
  for (const s of samples) {
    const target = path.join(s.dir, s.file);
    // 反例②按文件命中；反例③按目录命中；反例①按文件命中
    const got = hitPaths.some((h) => h === path.resolve(target).toLowerCase() || h === path.resolve(s.dir).toLowerCase());
    const ok = got === s.expect;    if (ok) pass++;
    rows.push('  ' + (ok ? '✓' : '✗') + ' ' + s.label + (ok ? '' : `（实际 got=${got}）`));
  }
  // 清理自造样本
  for (const s of samples) { try { fs.rmSync(path.join(s.dir, s.file), { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(path.join(ROOT, '_selftest-sentinel'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(ROOT, '_临时', '裸放自测'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(ROOT, '08-升级与改造清单', '_临时'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(ROOT, '备份', '_selftest-bak'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(ROOT, '_临时', 'big', '_selftest'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(bigRoot, '_selftest'), { recursive: true, force: true }); } catch { /* ignore */ }

  for (const r of rows) console.log(r);
  const total = samples.length;
  console.log('  selftest: ' + (pass === total ? `PASS ${pass}/${total}` : `FAIL ${pass}/${total}`));
  return pass === total ? 0 : 1;
}

/* ---------------- CLI ---------------- */
const isMain = (() => {
  // ⚠ 必须用 fileURLToPath（`new URL().pathname` 在 Windows 下盘符前多一个斜杠，等于恒 false ⇒ 整个 CLI 静默不输出）
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  if (has('--selftest')) process.exit(selftest());
  const hits = scan();
  process.exit(report(hits, has('--quiet'), has('--json')));
}
