// 对指定 CDP target（webview / iframe / page）截图，用于验证 guest 内容真实画面
// 用法：node _shot-wv.mjs <out.png> <urlContains> [cdpPort]
import fs from 'fs';

const out = process.argv[2] || '_wv.png';
const match = process.argv[3] || '';
const port = process.argv[4] || '9222';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const list = targets.filter(t => (t.url || '').includes(match));
if (!list.length) { console.error('没有匹配的 target: ' + match); process.exit(1); }
const target = list[0];

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  return new Promise((res, rej) => { pending.set(mid, { res, rej }); });
}
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Page.enable');
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
const info = await send('Runtime.evaluate', {
  expression: "JSON.stringify({title:document.title,url:location.href,w:innerWidth,h:innerHeight,text:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,200)})",
  returnByValue: true
});
console.log(out, info.result && info.result.value);
ws.close();
