// 自检-执行.mjs —— 通过 CDP 在指定页面里执行一段 JS，并打印返回值
// 用法：node 工具\自检-执行.mjs <表达式文件或直接表达式> [cdpPort] [targetIndex]
// ⚠ 需要启动时带 --remote-debugging-port=9222
import fs from 'fs';

const arg = process.argv[2] || '';
const port = process.argv[3] || '9222';
const idx = Number(process.argv[4] || '0');

const script = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg;
if (!script) { console.error('没有要执行的脚本'); process.exit(1); }

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// ⚠ 2026-11-23 修：原来只认 type==='page'，把 <webview> 全过滤掉了
//   ⇒ 引擎界面（跑在 webview 里）根本探测不到，只能探到外壳自己的 file:// 页面。
//   现在 page 和 webview 都算候选，索引按 /json/list 的原始顺序。
const pages = targets.filter(t => t.type === 'page' || t.type === 'webview');
const target = pages[idx] || pages[0];
if (!target) { console.error('没有 page/webview 目标'); process.exit(1); }
if (process.env.DSH_PROBE_VERBOSE) {
  pages.forEach((t, i) => console.error(`  [${i}] ${t.type} ${(t.title || '').slice(0, 40)}`));
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  return new Promise((res, rej) => { pending.set(mid, { res, rej }); });
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
  }
});

await new Promise((res) => ws.addEventListener('open', res));
await send('Runtime.enable');

const r = await send('Runtime.evaluate', {
  expression: script,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true
});

if (r.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(r.exceptionDetails, null, 2));
  process.exit(2);
}
console.log(JSON.stringify(r.result && r.result.value, null, 2));
ws.close();
