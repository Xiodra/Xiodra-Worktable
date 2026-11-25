// 用 CDP 给 Electron 窗口截图（Node 24 自带全局 WebSocket）
// 用法: node _cdp-shot.mjs <outPath> [cdpPort]
import fs from 'fs';

const outPath = process.argv[2] || '_cdp.png';
const port = process.argv[3] || '9222';

async function main() {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  console.log('target:', page.title, '|', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });

  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });

  await send('Page.enable');
  // 等一帧，确保排版完成
  await new Promise((r) => setTimeout(r, 600));

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log('saved', outPath);

  // 顺手把页面基本信息打出来，方便判断"到底是空白还是有内容"
  const info = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      url: location.href.replace(/token=[^&]+/, 'token=***'),
      bodyLen: document.body ? document.body.innerText.trim().length : 0,
      text: document.body ? document.body.innerText.trim().slice(0, 400) : '',
      hasCanvas: !!document.querySelector('canvas'),
      rootChildren: document.body ? document.body.children.length : 0
    })`,
    returnByValue: true
  });
  console.log('page info:', info.result.value);
  ws.close();
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
