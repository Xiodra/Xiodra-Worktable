#!/usr/bin/env node
/**
 * 日志看门.mjs —— 「面板变白时第一件事」（照搬《04/自检清单》§3 排查顺序 + §4「出事查哪层」）
 *
 * 参照原文的排查顺序（⛔ 别跳步）：
 *   1. `server.log` 找 `launch-failed`  → 有 ⇒ 壳的问题（可能 exe 被换过）
 *   2. 确认 exe 是原来那个（哈希）      → 变了 ⇒ 别改名/别替换，请机主重启
 *   3. 面板重载（all）                  → 好了 ⇒ 只是渲染层没刷新
 *   4. 控制台看单个面板的报错            → 有 ⇒ 该面板渲染器的问题
 *   5. 最后才请机主重启工作台
 *   > ⛔ 顺序颠倒的代价：先重启了，**证据就没了**，下次还会再犯。
 *
 * ⚠ 我们只能自动做第 1 步（读日志）。第 2 步交给 `入口哨兵.mjs`，第 3 步交给 `刷新面板.mjs`。
 *   ⇒ 本工具的输出会**按那五步的顺序**给建议，而不是只丢一堆错误。
 *
 * 判据（唯一出处）：
 *   · `launch-failed` / `did not activate` / `server exited` ⇒ ⛔ 壳层故障
 *   · `ECONNREFUSED` / `ETIMEDOUT` 连引擎 ⇒ ⛔ 引擎没起来
 *   · 未捕获异常堆栈（`TypeError:` / `ReferenceError:` / `Error:`）⇒ ⚠ 可能是面板渲染器
 *   · 日志体积超上限 ⇒ ⚠（参照 config 里 logMaxBytes）
 *
 * 用法：
 *   node 工具\日志看门.mjs            # 扫最近一份日志
 *   node 工具\日志看门.mjs --quiet    # 一行（挂体检）
 *   node 工具\日志看门.mjs --tail 50  # 顺带打印最后 50 行
 *   node 工具\日志看门.mjs --selftest # 反例：launch-failed / ECONNREFUSED / 正常
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const LOG = path.join(ROOT, '外壳', 'server.log');
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } })();
const MAX_BYTES = Number((CFG.boot && CFG.boot.logMaxBytes) || 4 * 1024 * 1024);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

/** 判据表（唯一出处）。ord 决定它落在参照五步里的第几步 */
export const RULES = [
  { id: 'L1', re: /launch-failed|did not activate|server exited/i, level: 'bad', step: 1, why: '壳层故障（渲染进程没起来）⇒ 先查 electron.exe 有没有被换/改名' },
  { id: 'L2', re: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i, level: 'bad', step: 2, why: '连不上引擎 ⇒ 引擎没起来 / 端口不对' },
  { id: 'L3', re: /Uncaught\s+(TypeError|ReferenceError|SyntaxError)/i, level: 'warn', step: 4, why: '未捕获异常 ⇒ 多半是某个面板渲染器抛错（看是哪个面板）' },
  { id: 'L4', re: /^\s*(TypeError|ReferenceError|SyntaxError|RangeError):/m, level: 'warn', step: 4, why: '异常堆栈（非 Uncaught 前缀）⇒ 同上，先定位面板' },
  { id: 'L5', re: /ENOSPC|EACCES|EPERM/i, level: 'warn', step: 0, why: '磁盘满 / 权限不足 ⇒ 写盘失败，数据可能没落盘' },
];

/**
 * 扫一段日志文本。
 *
 * ⚠ 2026-11-19 修（假警报）：第一版对整个日志文件匹配 ⇒ 只要**历史上**失败过一次，
 *   之后每次检查都报 ⛔（实测：第 48 行有旧的 `[server exited] code=1`，但后面
 *   `engine ready in 22.2s` + 两个面板 `status=200`，现在明明是好的）。
 *   ⇒ 判据必须是「**最后一次成功启动之后**还有没有故障」，而不是"文件里出现过没有"。
 *      做法：找到最后一个"启动成功"标记（engine ready / boot 引擎就绪总耗时 / dsh web: http），
 *      只扫它**之后**的日志。
 *   ⛔ 这也是参照 §3 那句话的同一道理：**先重启了证据就没了** —— 反过来说，
 *      旧证据不能当新故障报。
 */
const OK_MARKS = [
  /engine ready in [\d.]+s/i,
  /\[boot\]\s*引擎就绪总耗时\s*[\d.]+s/i,
  /dsh web:\s*http:\/\/127\.0\.0\.1:\d+/i,
];

export function lastGoodIndex(text) {
  let last = -1;
  for (const re of OK_MARKS) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(text))) last = Math.max(last, m.index + m[0].length);
  }
  return last;
}

export function scan(text, opts = {}) {
  // 只看"最后一次启动成功之后"的部分
  const from = opts.fromStart ? 0 : lastGoodIndex(text);
  const tail = from > 0 ? text.slice(from) : text;

  const hits = [];
  for (const r of RULES) {
    const m = tail.match(r.re);
    if (m) hits.push({ id: r.id, level: r.level, step: r.step, why: r.why, sample: m[0].slice(0, 80) });
  }
  // 同一类只报一次（日志刷屏时别报 500 条一样的东西）
  const seen = new Set();
  return hits.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
}

/** 按参照五步给出建议（⛔ 顺序不能颠倒） */
export function advice(hits) {
  const out = [];
  const has1 = hits.some((h) => h.id === 'L1');
  const has2 = hits.some((h) => h.id === 'L2');
  const has4 = hits.some((h) => h.id === 'L3' || h.id === 'L4');
  if (has1) {
    out.push('1. 壳层故障已确认 ⇒ 跑 `node 工具\\入口哨兵.mjs` 看 electron.exe 指纹变没变');
    out.push('   ⛔ 变了也别自己替换/改名（"挪开再挪回"也算）—— 让机主关掉工作台重开');
  }
  if (has2) out.push((has1 ? '2' : '1') + '. 引擎没起来 ⇒ 看 `外壳\\server.log` 开头的 config= / port= / dshHome= 三行，再 Test-Path 那几个路径');
  if (has4) out.push('3~4. 有异常堆栈 ⇒ 先定位是哪个面板（换设备/单面板重载），别急着重启（重启会毁证据）');
  if (!hits.length) out.push('✓ 日志里没有已知故障特征');
  out.push('最后一步才是请机主重启 —— ⛔ 前面几步做完再重启，否则证据没了');
  return out;
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① launch-failed ⇒ bad / 第 1 步
  {
    const h = scan('xx\n  launch-failed: exitCode 57\n');
    add(h.some((x) => x.id === 'L1' && x.level === 'bad'), '反例① launch-failed ⇒ ⛔ 且归第 1 步（壳层）', JSON.stringify(h.map((x) => x.id)));
  }
  // ② ECONNREFUSED ⇒ bad / 第 2 步
  {
    const h = scan('Error: connect ECONNREFUSED 127.0.0.1:33083');
    add(h.some((x) => x.id === 'L2'), '反例② ECONNREFUSED ⇒ ⛔ 引擎没起来', JSON.stringify(h.map((x) => x.id)));
  }
  // ③ TypeError 堆栈 ⇒ warn
  {
    const h = scan('Uncaught TypeError: Cannot read properties of undefined');
    add(h.some((x) => x.id === 'L3' && x.level === 'warn'), '反例③ Uncaught TypeError ⇒ ⚠ 面板渲染器（不阻断）', JSON.stringify(h.map((x) => x.id)));
  }
  // ④ 正常日志 ⇒ 无命中
  {
    const h = scan('config = D:\\x\\config.json\nport = 33083\nengine ready\n');
    add(h.length === 0, '正例 正常日志 ⇒ 0 命中（不报假警报）', JSON.stringify(h.map((x) => x.id)));
  }
  // ⑤ 同类刷屏只报一次
  {
    const h = scan(Array.from({ length: 50 }, () => 'launch-failed').join('\n'));
    add(h.filter((x) => x.id === 'L1').length === 1, '反例④ 同类错误刷屏 50 行 ⇒ 只报 1 次（不刷屏）', String(h.length));
  }
  // ⑥ 建议顺序：壳层故障时第 1 条必须是"查 exe"
  {
    const a = advice(scan('launch-failed: exitCode 57'));
    add(a[0].includes('入口哨兵'), '反例⑤ 有壳层故障 ⇒ 第一条建议必须是"查 electron.exe"（顺序不能颠倒）', a[0]);
  }
  // ⑦ 无故障也给"别急着重启"的提醒
  {
    const a = advice([]);
    add(a.some((x) => x.includes('重启')), '正例 无故障也提醒"最后才重启"', '');
  }
  // ⑧ **旧故障不算新故障**（这条是本轮修的假警报，必须守住）
  {
    const text = [
      '[main] [server exited] code=1',
      '[main] bug 修好后重新启动……',
      '[main] engine ready in 22.2s via 内置入口',
      '[main] [auth] partition=persist:ai-panel-dsh-gui-p3 status=200',
    ].join('\n');
    const h = scan(text);
    add(h.length === 0, '反例⑥ 历史上有过 server exited、但之后启动成功 ⇒ **不许**报故障（旧证据≠新故障）', JSON.stringify(h.map((x) => x.id)));
  }
  // ⑨ 启动成功**之后**又失败 ⇒ 必须报
  {
    const text = [
      '[main] engine ready in 22.2s',
      '[main] [server exited] code=1',
    ].join('\n');
    const h = scan(text);
    add(h.some((x) => x.id === 'L1'), '反例⑦ 启动成功**之后**又 server exited ⇒ 必须报', JSON.stringify(h.map((x) => x.id)));
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
      '日志看门.mjs —— 面板变白时第一件事',
      '  node 工具\\日志看门.mjs            扫 server.log',
      '  node 工具\\日志看门.mjs --quiet    一行',
      '  node 工具\\日志看门.mjs --tail 50  顺带打印最后 50 行',
      '  node 工具\\日志看门.mjs --selftest',
      '⛔ 排查顺序不能颠倒：先看日志 → 查 exe → 重载面板 → 最后才重启（先重启证据就没了）',
    ].join('\n'));
    process.exit(0);
  }

  if (!fs.existsSync(LOG)) {
    console.log('⚠ 没有 server.log（' + LOG + '）—— 工作台还没启动过，或日志被清过');
    process.exit(0);
  }
  const st = fs.statSync(LOG);
  const text = fs.readFileSync(LOG, 'utf8');
  const hits = scan(text);
  const bads = hits.filter((h) => h.level === 'bad');

  if (has('--quiet')) {
    console.log(bads.length ? `⛔ 日志看门：${bads.length} 类故障特征（跑 node 工具\\日志看门.mjs 看明细）`
      : (hits.length ? `⚠ 日志看门：${hits.length} 类告警` : `✓ 日志看门：无故障特征（${(st.size / 1024).toFixed(0)} KB）`));
    process.exit(bads.length ? 1 : 0);
  }

  console.log('日志看门 —— ' + path.relative(ROOT, LOG));
  console.log('  体积 ' + (st.size / 1024).toFixed(0) + ' KB（上限 ' + (MAX_BYTES / 1024 / 1024).toFixed(0) + ' MB）· 最后写入 ' + st.mtime.toISOString().slice(0, 19).replace('T', ' '));
  if (st.size > MAX_BYTES) console.log('  ⚠ 日志超上限（会被主进程轮转，注意别把旧证据冲掉）');

  console.log('\n命中：');
  if (!hits.length) console.log('  ✓ 0 命中');
  for (const h of hits) console.log('  ' + (h.level === 'bad' ? '⛔' : '⚠') + ' [' + h.id + '] ' + h.why + '\n       样本：' + h.sample);

  console.log('\n排查顺序（⛔ 别跳步）：');
  for (const a of advice(hits)) console.log('  ' + a);

  const n = Number(val('--tail', '0'));
  if (n > 0) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    console.log('\n最后 ' + n + ' 行：');
    for (const l of lines.slice(-n)) console.log('  ' + l.slice(0, 160));
  }
  process.exit(bads.length ? 1 : 0);
}
