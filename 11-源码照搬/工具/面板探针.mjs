#!/usr/bin/env node
/**
 * 面板探针.mjs —— 一条命令看清某个面板到底怎么了（固化手写的临时脚本）
 *
 * ⛔ 治的坑（自我复盘 2026-11-21 报）：追 embed 面板故障那三天，
 *   **同一套 CDP 临时脚本手写了 12 次**（开 target → 执行 JS → 读结果 → 对 guest 截图看字节数），
 *   而且每次都要踩「同场景有 2 个同名 guest target」的坑（要按 innerWidth×innerHeight 认）。
 *   ⇒ 固化成一条命令，把最容易搞错的地方都写死。
 *
 * 输出四样（就是自我复盘 建议的）：
 *   ① 标题小字（面板 head 上的 sub，例如「已钉住 · 本地电脑」）
 *   ② webview 元素尺寸
 *   ③ **guest 截图字节数**（判"内容画出来没有"的硬判据）
 *   ④ guest body 文本片段（看有没有真内容）
 *
 * ★核心判据（自我复盘 从三天排障里验出来的，⛔ 别改）★
 *   **看 guest 截图字节数，不看元素 computed background。**
 *   · 约 2 KB（≈2103）= 纯灰空图 ⇒ 内容**没画出来**
 *   · 约 24 KB（≈24409）= 有内容
 *   原因：元素底色改了 ≠ 内容画出来了。这个误判害我们白查一轮。
 *
 * 用法：
 *   node 工具\面板探针.mjs --panel local-chat            # 探某个 AI 面板
 *   node 工具\面板探针.mjs --panel self-review-web       # 探某个 embed 面板
 *   node 工具\面板探针.mjs --panel xxx --guest deepseek  # 同场景多个 guest 时按 url 片段筛
 *   node 工具\面板探针.mjs --list                        # 列出所有 target（含尺寸，便于认）
 *   node 工具\面板探针.mjs --panel xxx --shot 外壳\captures\x.png   # 顺带存 guest 截图
 *   node 工具\面板探针.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const PORT = String(val('--port', process.env.DSH_CDP_PORT || '9222'));


/** CDP 连一个 target，做一次 evaluate */
/**
 * ⛔ 2026-11-21 修（自我复盘 报的稳定崩溃，我已复现）：
 *   带 `--guest` 时 exit=0xC0000409（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`）。
 *   根因：每次调用都 new WebSocket 然后 ws.close() 就走，**没等 close 真正完成**；
 *   `--guest` 分支会连开好几个（尺寸探测 + 截图 + 文本），进程退出时还有句柄在 closing ⇒ libuv 断言。
 *   这和「await 之后 process.exit()」是同一家族：**异步没走完就退**（这是第三次栽了）。
 *
 *   修法三件一起：
 *     ① 每个 ws 都 await 它真的关掉（有 600ms 超时兜底）
 *     ② 所有 ws 记进 OPEN_WS，退出前统一 drain
 *     ③ 用 process.exitCode 代替 process.exit()
 */
const OPEN_WS = new Set();

function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === 2 || ws.readyState === 3) { OPEN_WS.delete(ws); return resolve(); }
    let done = false;
    const fin = () => { if (done) return; done = true; OPEN_WS.delete(ws); resolve(); };
    try { ws.addEventListener('close', fin); } catch (e) { /* */ }
    try { ws.close(); } catch (e) { /* */ }
    setTimeout(fin, 600);
  });
}

async function drainWs() {
  for (const ws of [...OPEN_WS]) await closeWs(ws);
}

/**
 * 关掉 fetch 用的 undici keep-alive 连接池。
 *
 * ⚠ 为什么必须关：Node 18+ 的 fetch 走 undici，它带一个**进程级连接池**。
 *   进程退出时池里若还有连接，libuv 就撞
 *   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（退出码 0xC0000409）。
 *   这是「带 --guest 崩」的**第二半根因**（第一半是 WebSocket 没等 close 完成）。
 *
 * 用法：退出前 await 一次。取不到内部 API 时静默跳过（不同 Node 版本字段名会变）。
 */
async function closeUndici() {
  try {
    const sym = Symbol.for('undici.globalDispatcher.1');
    const disp = globalThis[sym];
    if (disp && typeof disp.close === 'function') await disp.close();
    if (disp && typeof disp.destroy === 'function') await disp.destroy();
  } catch (e) { /* 取不到就跳过，不影响结果 */ }
  await new Promise((r) => setImmediate(r));
}

async function evaluate(target, expr) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  OPEN_WS.add(ws);
  let id = 0;
  const pend = new Map();
  const send = (m, q) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method: m, params: q || {} }));
    return new Promise((res, rej) => pend.set(i, { res, rej }));
  };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  let out = null;
  try {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 异常');
    out = r.result.value;
  } finally {
    await closeWs(ws);   // ★必须 await，不能 ws.close() 就走
  }
  return out;
}

async function captureBytes(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  OPEN_WS.add(ws);
  let id = 0;
  const pend = new Map();
  const send = (m, q) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method: m, params: q || {} }));
    return new Promise((res, rej) => pend.set(i, { res, rej }));
  };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  let data = '';
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    data = (r && r.data) || '';
  } finally {
    await closeWs(ws);
  }
  return data ? Buffer.from(data, 'base64') : Buffer.alloc(0);
}

/**
 * 用 node:http 取 /json。
 *
 * ⚠ 为什么不用 fetch（派单 d578aabec5 的真根因，实测排查出来）：
 *   Node 18+ 的 fetch 走**内置 undici**，它默认开 **keep-alive 连接池**；
 *   进程结尾时这些 socket 可能仍在关闭过程中 ⇒ libuv 撞
 *   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` ⇒ 退出码 -1073740791。
 *   而本机 `import('undici')` 报 Cannot find package ⇒ 拿不到 dispatcher，无法优雅关闭。
 *   ⇒ 改用 node:http：句柄就是普通 socket，取完 `req.destroy()` 并等 'close' 即可彻底释放。
 */
async function httpGetJson(url) {
  const http = await import('node:http');
  return new Promise(function (resolve, reject) {
    const req = http.get(url, { headers: { connection: 'close' } }, function (res) {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        req.destroy();
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    // 兜底：不挂死
    req.setTimeout(8000, function () { try { req.destroy(); } catch (e) {} reject(new Error('http 超时')); });
  });
}

/** 列出所有 targets（带尺寸，便于认出同名 guest） */
async function listTargets() {
  return httpGetJson('http://127.0.0.1:' + PORT + '/json');
}

/**
 * 判"截图字节数"代表什么（唯一判据）
 * ⚠ 阈值来自实测：2103 = 纯灰空图；24409 = 有内容。取中间偏下做分界。
 */
export function judgeShot(bytes) {
  if (!bytes) return { ok: false, why: '截不到图（target 可能没起来）' };
  if (bytes < 6000) return { ok: false, why: '约 ' + (bytes / 1024).toFixed(1) + ' KB ⇒ **基本是空图**（内容没画出来）' };
  return { ok: true, why: '约 ' + (bytes / 1024).toFixed(1) + ' KB ⇒ 有内容' };
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① 实测过的两个基准值必须判对
  add(!judgeShot(2103).ok, '反例① 2103 字节（实测纯灰空图）⇒ 判"空"', judgeShot(2103).why);
  add(judgeShot(24409).ok, '正例 24409 字节（实测有内容）⇒ 判"有内容"', judgeShot(24409).why);
  // ② 截不到图
  add(!judgeShot(0).ok, '反例② 0 字节 ⇒ 判"截不到"', judgeShot(0).why);
  // ③ 判据必须是"字节数"而不是元素属性（防有人改回看 computed background）
  {
    const src = fs.readFileSync(SELF, 'utf8');
    const code = src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const usesCapture = /captureScreenshot/.test(code);
    add(usesCapture, '反例③ 必须用 Page.captureScreenshot 拿真实像素（⛔ 不看 computed background）', '');
  }
  // ④ 必须能按尺寸认同名 guest（自我复盘 踩过的坑）
  {
    const src = fs.readFileSync(SELF, 'utf8');
    add(/innerWidth|width/.test(src) && /--guest/.test(src), '反例④ 必须支持 --guest 按 url 片段筛 + 显示尺寸（同场景多个同名 guest）', '');
  }
  // ⑤ 退出不许用 process.exit（派单 d578aabec5 的真根因，我复现过）
  {
    const src = fs.readFileSync(SELF, 'utf8');
    /**
     * ⚠ 必须先剥掉注释再判：否则**注释里提到 process.exit 也会命中** ⇒ 恒假红。
     *   （同类错误我已经犯过两次：一次在「清理请求」搜 rmSync、一次在别处搜关键词。
     *     判据是「有没有这个**调用**」，不是「有没有这个**词**」。）
     */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
      .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');  // 行注释
    const mainPart = code.slice(0, code.indexOf('function selftest'));
    const badExit = /process\.exit\s*\(/.test(mainPart);
    add(!badExit, '反例⑤ 主流程不许用 process.exit（异步未收尾时退出 ⇒ libuv 断言 0xC0000409）', '');
  }
  // ⑥ 必须 drain ws + 关 undici 池（两个半根因都要治）
  {
    const src = fs.readFileSync(SELF, 'utf8');
    const hasDrain = /drainWs\s*\(\s*\)/.test(src);
    const hasUndici = /closeUndici/.test(src);
    add(hasDrain && hasUndici, '反例⑥ 退出前必须 drainWs() + closeUndici()（缺一个都还会崩）', 'drain=' + hasDrain + ' undici=' + hasUndici);
  }

  // ⑦ 面板不存在必须 exit≠0，且不许继续抓 guest（派单 901be3cea9 的假绿）
  //    实测过的假绿：--panel 不存在的面板 仍报「167.2 KB ⇒ 有内容」+ exit=0，
  //    因为 hostInfo.found=false 时只警告不停止 ⇒ 抓到同场景**别的面板**的 guest。
  {
    const src = fs.readFileSync(SELF, 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    // ⚠ 判据只用**代码里真实存在的结构**，不搜中文短语 ——
    //   中文短语多在注释/字符串里，剥注释后就没了（这正是反例⑤注释里警告过的坑）。
    //   ① 守卫分支存在：if (!hostInfo || !hostInfo.found) {
    const hasGuard = /if\s*\(\s*!hostInfo\s*\|\|\s*!hostInfo\.found\s*\)/.test(code);
    // ② 守卫里设了 exitCode = 1
    const setsExit = /!hostInfo\.found\s*\)[\s\S]{0,600}?process\.exitCode\s*=\s*1/.test(code);
    // ③ 守卫之后紧跟 } else { —— 主流程被 else 包住，才不会继续往下抓 guest
    const hasElse = /process\.exitCode\s*=\s*1[\s\S]{0,200}?\}\s*else\s*\{/.test(code);
    add(hasGuard && setsExit && hasElse,
      '反例⑦ 面板不存在 ⇒ 必须 exit≠0 且不再抓 guest（防"拿别的面板冒充"的假绿）',
      'guard=' + hasGuard + ' exit=' + setsExit + ' else=' + hasElse);
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
      '面板探针.mjs —— 一条命令看清面板怎么了',
      '  node 工具\\面板探针.mjs --panel <面板id>',
      '  node 工具\\面板探针.mjs --panel <id> --guest <url片段>',
      '  node 工具\\面板探针.mjs --panel <id> --shot <输出.png>',
      '  node 工具\\面板探针.mjs --list',
      '  node 工具\\面板探针.mjs --selftest',
      '★判据：看 guest 截图字节数（2KB=空图 / 24KB=有内容），⛔ 不看元素 computed background',
    ].join('\n'));
    process.exit(0);
  }

  let targets = [];
  try { targets = await listTargets(); } catch (e) {
    console.error('✗ 连不上 CDP（' + PORT + '）：' + e.message);
    console.error('  工作台启动时是否带 --remote-debugging-port=' + PORT + '？');
    process.exit(2);
  }

  if (has('--list')) {
    console.log('CDP targets（' + targets.length + '）：\n');
    for (const t of targets) {
      console.log('  [' + String(t.type).padEnd(8) + '] ' + String(t.title || '').slice(0, 32).padEnd(34) + String(t.url || '').slice(0, 60));
    }
    process.exit(0);
  }

  const panelId = val('--panel');
  if (!panelId) { console.error('用法：--panel <面板id>（不确定就先 --list）'); process.exit(2); }
  const guestHint = val('--guest');

  // ① 宿主页：读面板标题小字 + webview 尺寸
  const host = targets.find((t) => t.type === 'page');
  let hostInfo = null;
  if (host) {
    try {
      hostInfo = await evaluate(host, `(function(){
        var all = [].slice.call(document.querySelectorAll('[data-panel-id], .panel, .hpan'));
        var el = null;
        for (var i=0;i<all.length;i++){
          var p = all[i];
          var id = p.getAttribute('data-panel-id') || p.getAttribute('data-id') || (p.id||'').replace(/^panel-/,'');
          if (id === ${JSON.stringify(panelId)}) { el = p; break; }
        }
        if (!el) return { found:false };
        var head = el.querySelector('.panel-head, .hpan-head');
        var sub = head ? (head.querySelector('.panel-sub, .hpan-sub') || {}).textContent : '';
        var wv = el.querySelector('webview');
        var r = wv ? wv.getBoundingClientRect() : null;
        return {
          found: true,
          sub: (sub||'').trim(),
          wvW: r ? Math.round(r.width) : 0,
          wvH: r ? Math.round(r.height) : 0,
          wvSrc: wv ? (wv.getAttribute('src')||'') : ''
        };
      })()`);
    } catch (e) { hostInfo = { err: e.message }; }
  }

  console.log('面板探针：' + panelId + '\n');
  console.log('  ① 标题小字：' + (hostInfo && hostInfo.found ? (hostInfo.sub || '（空）') : '⚠ 宿主页里没找到这个面板'));

  // ★面板不存在就到此为止★（派单 901be3cea9 修掉的假绿）
  //   原来这里只打印一行警告、**没有 return**，继续往下抓 guests
  //   ⇒ 抓到的是同场景**别的面板**的 guest ⇒ 报「有内容」+ exit=0
  //   ⇒ 拿别人的成功冒充这一次的成功。这是最典型的假绿。
  //   ⚠ 这段在 `if (isMain) {}` 普通块里，**不能用 return**（Illegal return statement）
  //     ⇒ 用 else 把主流程整体包起来。
  if (!hostInfo || !hostInfo.found) {
    console.log('  ⛔ 面板「' + panelId + '」不在当前场景');
    console.log('     ⇒ 先 node 工具\\面板探针.mjs --list 看当前场景有哪些面板，或先切到该面板所属场景。');
    console.log('     （⛔ 不再往下抓 guest：那样会拿到别的面板的内容，误判成"有内容"）');
    process.exitCode = 1;
    await drainWs();
    await new Promise(function (r) { setImmediate(r); });
  } else {
  // ILLEGAL_RETURN_MARK —— 主流程从这里开始

  if (hostInfo && hostInfo.found) {
    console.log('  ② webview 尺寸：' + hostInfo.wvW + ' × ' + hostInfo.wvH + '　src=' + String(hostInfo.wvSrc).slice(0, 60));
  }

  // ③ 找 guest：type=webview，按 url 片段筛；同名时按尺寸认
  let guests = targets.filter((t) => t.type === 'webview');
  if (guestHint) guests = guests.filter((t) => String(t.url || '').includes(guestHint));
  // 若知道 webview 尺寸，优先挑尺寸最接近的（这就是"按 innerWidth×innerHeight 认"的做法）
  if (hostInfo && hostInfo.found && hostInfo.wvW && guests.length > 1) {
    const scored = [];
    for (const g of guests) {
      try {
        const d = await evaluate(g, '({w: innerWidth, h: innerHeight})');
        scored.push({ g, d, diff: Math.abs((d?.w || 0) - hostInfo.wvW) + Math.abs((d?.h || 0) - hostInfo.wvH) });
      } catch (e) { scored.push({ g, d: null, diff: 1e9 }); }
    }
    scored.sort((a, b) => a.diff - b.diff);
    console.log('  ③ guest 候选 ' + guests.length + ' 个，按尺寸差排序：');
    for (const s of scored) console.log('       ' + (s.d ? s.d.w + '×' + s.d.h : '?') + '  diff=' + s.diff + '  ' + String(s.g.url).slice(0, 50));
    guests = scored.length ? [scored[0].g] : [];
  } else if (guests.length > 1) {
    console.log('  ⚠ guest 有 ' + guests.length + ' 个，用 --guest <url片段> 可精确指定');
  }

  if (!guests.length) {
    console.log('  ⛔ 没找到匹配的 guest（类型 webview）。先 --list 看有哪些。');
    process.exit(1);
  }

  const g = guests[0];
  // ④ guest 截图字节数（★核心判据★）
  let bytes = 0;
  let shotBuf = Buffer.alloc(0);
  try { shotBuf = await captureBytes(g); bytes = shotBuf.length; } catch (e) { /* */ }
  const v = judgeShot(bytes);
  console.log('  ④ guest 截图：' + v.why);

  // ⑤ guest body 文本
  let bodyText = '';
  try {
    bodyText = await evaluate(g, '(document.body ? document.body.innerText : "").slice(0,200)');
  } catch (e) { bodyText = '（读不到：' + e.message + '）'; }
  console.log('  ⑤ guest 文本：' + String(bodyText || '（空）').replace(/\s+/g, ' ').slice(0, 160));

  const shotTo = val('--shot');
  if (shotTo && shotBuf.length) {
    const p = path.isAbsolute(shotTo) ? shotTo : path.resolve(ROOT, shotTo);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, shotBuf);
    console.log('  💾 已存截图：' + path.relative(ROOT, p) + '（' + (shotBuf.length / 1024).toFixed(1) + ' KB）');
  }

  console.log('\n  判据：④ 的字节数才是"画出来没有"的证据；① 的标题小字只证明"绑定对不对"。');
  // ★不要用 process.exit()★（派单 d578aabec5 的真根因）
  //   process.exit 会在异步收尾完成前强杀进程：
  //     · WebSocket 句柄可能还在 CLOSING
  //     · fetch 用的 undici keep-alive 连接池还没关
  //   ⇒ libuv 在退出阶段撞 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
  //   ⇒ 退出码 -1073740791 (0xC0000409)，上层误判成"探针失败"（其实数据已拿到）。
  //   ⇒ 先 drainWs()（等 ws close 事件）+ closeUndici()（关连接池），最后只设 exitCode。
  await drainWs();
  // 再让事件循环跑两轮，确保 http socket 的 'close' 回调都执行完（不再用 fetch/undici）
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setTimeout(r, 30); });
  process.exitCode = v.ok ? 0 : 1;
  }   // ← 收住上面那个 else
}
