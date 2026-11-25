#!/usr/bin/env node
/**
 * 刷新面板.mjs —— 面板自刷新通道的投递端（**并确认它真的生效**）
 *
 * 为什么存在：改完 `renderer\*.js` 需要面板重载才生效；以前只能人手点 ⟳，
 * AI 会话改完没法自己让它生效。现在会话跑这个脚本就能自助刷新。
 *
 * ⚠ 2026-11-19 改：**原来写完指令文件就结束，根本不知道有没有生效**。
 *   那正是铁律禁止的「投递成功 ≠ 已生效」。现在加了两道：
 *     ① 主进程广播后写回执 `data\reload-panels.ack.json`；
 *     ② 本脚本**等回执出现**（默认 3 秒）再报结果 —— 没等到就明确说"没生效"。
 *   ⛔ 即便如此，回执也只证明"主进程广播了"，**不证明每个面板都画对了** ——
 *      判据只能是画面（截图 / 面板小字）。
 *
 * 用法：
 *   node 工具\刷新面板.mjs              # 刷新全部面板（等价 all）
 *   node 工具\刷新面板.mjs all
 *   node 工具\刷新面板.mjs controller   # 只刷新该场景的面板
 *   node 工具\刷新面板.mjs all --no-wait  # 不来回执（老行为，投完就结束）
 *   node 工具\刷新面板.mjs all --wait 5000
 *
 * 原理：写 `外壳\data\reload-panels.cmd`；主进程每 500ms 轮询该文件，
 *       读到就重载匹配的 webview、删掉指令文件、并写一份回执。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const guiDir = path.join(path.resolve(here, '..'), '外壳');
const cmdFile = path.join(guiDir, 'data', 'reload-panels.cmd');
const ackFile = path.join(guiDir, 'data', 'reload-panels.ack.json');

const argv = process.argv.slice(2);
const target = (argv[0] ?? 'all').trim() || 'all';
const noWait = argv.includes('--no-wait');
const wi = argv.indexOf('--wait');
const waitMs = wi >= 0 && argv[wi + 1] ? Number(argv[wi + 1]) : 3000;

const readAck = () => { try { return JSON.parse(fs.readFileSync(ackFile, 'utf8')); } catch { return null; } };

/**
 * 自测：判"回执是不是这次产生的"。这段逻辑最容易写错成"文件存在就算成功"。
 * ⛔ 用旧回执冒充新回执，会让脚本永远报成功 —— 那是假绿。
 */
if (argv.includes('--selftest')) {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  const isFresh = (a, beforeSeq, beforeAt) => {
    if (!a) return false;
    return Number(a.seq || 0) > beforeSeq || String(a.at || '') !== beforeAt;
  };

  // ① 没有回执 ⇒ 不算成功
  add(!isFresh(null, 0, ''), '反例① 没有回执文件 ⇒ 判"没生效"（⛔ 不许当成功）');
  // ② 旧回执（seq/at 都没变）⇒ 不算成功
  add(!isFresh({ seq: 3, at: '2026-11-19T08:00:00Z' }, 3, '2026-11-19T08:00:00Z'), '反例② 旧回执（seq 与 at 都没变）⇒ 判"没生效"（这就是"文件存在就算成功"的坑）');
  // ③ seq 变大 ⇒ 算
  add(isFresh({ seq: 4, at: '2026-11-19T08:00:00Z' }, 3, '2026-11-19T08:00:00Z'), '正例 seq 变大 ⇒ 判"本次回执"');
  // ④ 只有 at 变 ⇒ 也算（seq 可能被重置）
  add(isFresh({ seq: 1, at: '2026-11-19T09:00:00Z' }, 3, '2026-11-19T08:00:00Z'), '正例 只有 at 变（seq 被重置）⇒ 也算本次回执');
  // ⑤ 投递端必须真的写了指令文件
  {
    const exists = fs.existsSync(cmdFile);
    add(true, '说明：指令文件投递路径 ' + (exists ? '（当前存在，主进程还没取走）' : '（当前已被主进程取走）'));
  }

  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  process.exit(pass === cases.length ? 0 : 1);
}

fs.mkdirSync(path.dirname(cmdFile), { recursive: true });

// 记下发之前的回执序号，用来判断"是不是这次的回执"（⛔ 不能只看文件在不在）
const before = readAck();
const beforeSeq = before ? Number(before.seq || 0) : 0;
const beforeAt = before ? String(before.at || '') : '';

try { fs.rmSync(cmdFile, { force: true }); } catch { /* 删不掉不影响投递 */ }
fs.writeFileSync(cmdFile, target, 'utf8');
console.log(`已投递刷新命令「${target}」→ ${cmdFile}`);

if (noWait) {
  console.log('（--no-wait：不确认回执，投完即返回）');
  process.exit(0);
}

// 等回执：seq 变大 或 at 变化，才算"这次"的回执
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + waitMs;
let ack = null;
while (Date.now() < deadline) {
  await sleep(250);
  const a = readAck();
  if (!a) continue;
  const seqUp = Number(a.seq || 0) > beforeSeq;
  const atChanged = String(a.at || '') !== beforeAt;
  if (seqUp || atChanged) { ack = a; break; }
}

if (ack) {
  console.log(`✓ 主进程已确认收到（seq ${ack.seq}｜scope=${ack.scope}｜${ack.at}）`);
  console.log('  ⚠ 这只证明"广播已发出"，**不证明每个面板都画对了**。');
  console.log('     判据只能是画面：截一张 `外壳\\captures\\` 图，或看面板标题行小字。');
  process.exit(0);
}

console.log('⛔ 没等到回执（' + waitMs + 'ms）—— 面板**可能没重载**。');
console.log('  怎么办：');
console.log('   1. 工作台没在跑？⇒ 界面上根本没有面板可刷');
console.log('   2. 主进程还是老版本（没写过回执）⇒ 重启一次 Electron 就长期有效');
console.log('   3. 用 `--no-wait` 确认它至少投递了，再去界面上点一次 ⟳ 兜底');
process.exit(1);
