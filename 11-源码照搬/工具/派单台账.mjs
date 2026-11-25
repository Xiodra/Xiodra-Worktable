#!/usr/bin/env node
/**
 * 派单台账.mjs —— 给 `派单.mjs --list` 造测试样本（**不动真台账**）
 *
 * 为什么要有它：`派单.mjs --list` 的四条欠账判据（空投 / 逾期 / 知悉 / 陈旧）
 * 如果只是"看起来实现了"，等于没有（《把规矩变成机制》第 4 步：反例不报 = 检查是假的）。
 * 这个脚本按指定 shape 生成一份**临时台账**，用 `DSH_SCENE_MEMORY` 指过去跑 `--list`，
 * 断言期望的 exit code 与关键字，跑完删掉临时目录。
 *
 * 用法：
 *   node 工具\派单台账.mjs --selftest     # 5 个 shape（4 反例 + 1 干净），逐条断言
 *   node 工具\派单台账.mjs                # 只打印当前真台账的判据结论（同 --list）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT } from './临时路径.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAI = path.join(HERE, '派单.mjs');
const TMP_BASE = path.join(ROOT, '_临时', 'scrap');

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();   // 带 Z
/** 老格式：UTC 数值但**不标时区**（历史行就长这样）。读取端必须能兼容它。 */
const legacyIso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString().slice(0, 19).replace('T', ' ');

function row(o) {
  return {
    hash: o.hash || Math.random().toString(16).slice(2, 12),
    from: o.from || 'DSH·GUI',
    to: o.to || '控制器',
    at: o.at || iso(1),
    kind: '派单',
    sceneId: 'controller',
    panelId: 'controller-chat',
    sessionId: 'session-XX-派单台账占位',
    delivered: o.delivered || 'RPC-200',
    deliverInfo: '',
    ack: !!o.ack,
    ackAt: o.ack ? iso(0) : '',
    text: o.text || '现象：样本；照哪做：样本；怎么验：样本；回一句：我在等你的回执。',
  };
}

/** 每个 shape = { name, rows, wantExit, wantText[] } */
const SHAPES = [
  { name: '① 干净台账（1 条已 ack）', rows: [row({ ack: true })], wantExit: 0, wantText: ['✓ 没有欠账'] },
  { name: '② 空投（delivered=HTTP-500）', rows: [row({ delivered: 'HTTP-500' })], wantExit: 1, wantText: ['[空投'] },
  { name: '③ 逾期（20 分钟未 ack）', rows: [row({ at: iso(20) })], wantExit: 1, wantText: ['[逾期'] },
  { name: '④ 知悉（带「不需要回执」）⇒ 不算欠账', rows: [row({ at: iso(20), text: '【不需要回执·知悉】收到了' })], wantExit: 0, wantText: ['知悉类', '✓ 没有欠账'] },
  { name: '⑤ 陈旧（50 小时未 ack）⇒ 单列、不算欠账', rows: [row({ at: iso(50 * 60) })], wantExit: 0, wantText: ['陈旧', '✓ 没有欠账'] },
  // ⚠ ⑥⑦ 是「时区」这一组的反例（2026-11-18 控制器派单 0dabe0e6c5）：
  //   老行存的是 UTC 数值但没标时区，若按本地解析 ⇒ 本机 UTC+8 恒差 8 小时 ⇒ 刚投的派单立刻「逾期 480m」。
  { name: '⑥ 老格式（无 Z 无时区，实际是 UTC）刚写 2 分钟 ⇒ 必须「在等」，不许逾期',
    rows: [row({ at: legacyIso(2) })], wantExit: 0, wantText: ['[在等', '✓ 没有欠账'] },
  { name: '⑦ 新格式（带 Z）刚写 2 分钟 ⇒ 必须「在等」，不许逾期',
    rows: [row({ at: iso(2) })], wantExit: 0, wantText: ['[在等', '✓ 没有欠账'] },
];

function runList(memDir, extra = []) {
  const env = { ...process.env, DSH_SCENE_MEMORY: memDir };
  const r = spawnSync(process.execPath, [PAI, '--list', ...extra], { encoding: 'utf8', env });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function selftest() {
  let pass = 0;
  const rowsOut = [];
  for (const s of SHAPES) {
    const dir = path.join(TMP_BASE, '派单台账自测-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6));
    fs.mkdirSync(path.join(dir, '_共享记忆'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_共享记忆', '派单台账.json'), JSON.stringify(s.rows, null, 2), 'utf8');
    const { code, out } = runList(dir);
    const okExit = code === s.wantExit;
    const miss = s.wantText.filter((t) => !out.includes(t));
    const ok = okExit && !miss.length;
    if (ok) pass++;
    rowsOut.push('  ' + (ok ? '✓' : '✗') + ' ' + s.name + '：exit=' + code + '（期望 ' + s.wantExit + '）' + (miss.length ? ' 缺：' + miss.join(' / ') : ''));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  rowsOut.forEach((r) => console.log(r));
  console.log('  selftest: ' + (pass === SHAPES.length ? `PASS ${pass}/${SHAPES.length}` : `FAIL ${pass}/${SHAPES.length}`));
  return pass === SHAPES.length ? 0 : 1;
}

if (process.argv.includes('--selftest')) process.exit(selftest());

const { code, out } = runList(process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆'));
console.log(out.trim());
process.exit(code || 0);
