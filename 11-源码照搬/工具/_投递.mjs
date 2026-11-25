#!/usr/bin/env node
/**
 * _投递.mjs —— 「把一段话真发进某个会话」的唯一底层（只给工具用，不是给 AI 调的）
 *
 * 存在的理由：`派单.mjs` / `回执.mjs` / 以后的通知类工具都要走同一条 RPC 配方
 * （从 `外壳\server.log` 里捞 token → 换 cookie → `POST /api/session/prompt`）。
 * ⛔ 这份配方**只写这一处**：以前每个脚本各写一遍，改端口/改配方时要改四处，漏一处就静默不投递。
 *
 * 用法（代码）：
 *   import { deliver, deliveryHint } from './_投递.mjs'
 *   const r = await deliver(sessionId, '正文')
 *   r.ok / r.status / r.body
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const CFG = readJson(path.join(ROOT, 'config.json')) || {};
export const PORT = String(process.env.DSH_PORT || CFG.port || 33083);
export const BASE = 'http://127.0.0.1:' + PORT;
const LOG = path.join(ROOT, '外壳', 'server.log');

/** 从 server.log 里捞最近的几个访问 token（引擎每次启动会打印带 token 的本机地址） */
export function tokens() {
  if (!fs.existsSync(LOG)) return [];
  const txt = fs.readFileSync(LOG, 'utf8');
  const re = new RegExp('127\\.0\\.0\\.1:' + PORT + '\\/\\?token=([A-Za-z0-9_\\-]{16,})', 'g');
  return [...txt.matchAll(re)].map((m) => m[1]).reverse();
}

/** 用 token 换 cookie（最多试最近 3 个） */
export async function getCookie() {
  for (const t of tokens().slice(0, 3)) {
    try {
      const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
      const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      if (sc.length) return sc.map((c) => c.split(';')[0]).join('; ');
    } catch { /* 换下一条 */ }
  }
  return '';
}

/** 调引擎 RPC */
export async function rpc(method, args, cookie) {
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie: cookie || '' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
  });
  const body = await r.text();
  let j = null; try { j = JSON.parse(body); } catch { /* 非 JSON */ }
  return { status: r.status, j, body };
}

/**
 * 把一段文本真投进一个会话。
 * @returns {Promise<{ok:boolean, status:number, body:string}>}
 *   ok = HTTP 200（对方下一轮就会看到）。⚠ 200 只代表"送到了"，不代表"对方回了"。
 */
export async function deliver(sessionId, text) {
  if (!sessionId) return { ok: false, status: 0, body: '没有 sessionId' };
  const cookie = await getCookie();
  if (!cookie) return { ok: false, status: 0, body: '换不到 cookie（引擎没在跑？先启动工作台）' };
  const r = await rpc('session/prompt', {
    request: {
      requestId: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  }, cookie);
  return { ok: r.status === 200, status: r.status, body: String(r.body || '').slice(0, 300) };
}

/** 一句人话的投递结论（工具输出统一口径） */
export const deliveryHint = (r) =>
  r.ok ? 'RPC-200（真进会话）' : 'HTTP-' + r.status + '：' + r.body;
