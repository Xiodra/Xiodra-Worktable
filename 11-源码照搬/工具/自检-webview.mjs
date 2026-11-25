// 自检-webview.mjs —— 逐个 webview 目标执行一段 JS 并打印结果
// 用法：node 工具\自检-webview.mjs <表达式文件> [cdpPort]
import fs from 'fs';

const file = process.argv[2];
const port = process.argv[3] || '9222';
const expr = fs.readFileSync(file, 'utf8');

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const views = targets.filter((t) => t.type === 'webview' || t.type === 'page');

for (const t of views) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, q) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method: m, params: q || {} }));
    return new Promise((r, j) => pend.set(i, { r, j }));
  };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const { r, j } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  try {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log(t.type, '| EXCEPTION:', JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    else console.log(t.type, '|', typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value));
  } catch (e) {
    console.log(t.type, '| ERR', e.message);
  }
  ws.close();
}
