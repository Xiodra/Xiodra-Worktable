#!/usr/bin/env node
/**
 * 催办.mjs —— 欠账没回就催一次（照搬《08/机制清单》§6「对方一直不回」）
 *
 * 参照原文：「**超 20 分钟自动催**（`回执哨兵.mjs` 调 `通知场景.mjs --wake --no-tag` 催对方；
 *           **≤2 次、间隔 30 分钟**；`--no-nag` 关；失败下轮重试（过负载闸）」
 *
 * 为什么需要它：`派单.mjs --list` **能查出欠账，但不会催**。
 *   而我们不挂高频计划任务（只有每天 12:30 的审计）⇒ 欠账很可能一直没人看。
 *   「能查出问题」和「问题的对方知道」是两件事。
 *
 * 三条硬约束（⛔ 防刷屏，都是参照踩过的）：
 *   ① **≤2 次**：同一笔欠账最多催两次，之后只记不催（再催就是骚扰）
 *   ② **间隔 ≥30 分钟**：刚催过的不重复催
 *   ③ **催办也走真投递**：⛔ 不许只写台账假装催了（那正是「公告≠派单」的老毛病）
 *
 * 状态记在哪：`派单台账.json` 每条加 `nagCount` / `nagAt[]`（只追加，不覆盖历史）。
 *
 * 用法：
 *   node 工具\催办.mjs              # 真催（按判据挑该催的）
 *   node 工具\催办.mjs --dry        # 只看会催谁，不发
 *   node 工具\催办.mjs --stats      # 看每笔欠账催了几次
 *   node 工具\催办.mjs --selftest   # 反例：刚催过/已催2次/未到期 都不许催
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deliver, deliveryHint } from './_投递.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const LEDGER = path.join(MEM, '_共享记忆', '派单台账.json');
const SCEN = path.join(ROOT, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

/** 三条硬约束（唯一出处） */
export const NAG_RULES = {
  firstAfterMin: Number(val('--after-min', '20')) || 20,  // 逾期多少分钟才开始催
  minGapMin: Number(val('--gap-min', '30')) || 30,        // 两次催办的最小间隔
  maxTimes: Number(val('--max', '2')) || 2,               // 最多催几次
};

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const readLedger = () => { const j = readJson(LEDGER); return Array.isArray(j) ? j : []; };
const writeLedger = (rows) => fs.writeFileSync(LEDGER, JSON.stringify(rows, null, 2) + '\n', 'utf8');

const atMs = (s) => {
  const raw = String(s || '').trim();
  if (!raw) return 0;
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw)) { const t = Date.parse(raw); return Number.isFinite(t) ? t : 0; }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
};

/**
 * 判一笔欠账该不该催（纯函数，便于自测）。返回 { nag:boolean, why:string }
 * @param row 台账条目
 * @param now 当前毫秒
 */
export function shouldNag(row, now = Date.now(), rules = NAG_RULES) {
  if (row.ack) return { nag: false, why: '已销账' };
  if (row.delivered !== 'RPC-200') return { nag: false, why: '从未真投递 ⇒ 该重发而不是催' };
  if (/不需要回执/.test(String(row.text || ''))) return { nag: false, why: '知悉类不欠回执' };

  const ageMin = (now - atMs(row.at)) / 60000;
  if (ageMin < rules.firstAfterMin) return { nag: false, why: '还没到 ' + rules.firstAfterMin + ' 分钟（现在 ' + Math.round(ageMin) + '）' };

  const times = Number(row.nagCount || 0);
  if (times >= rules.maxTimes) return { nag: false, why: '已催 ' + times + ' 次（上限 ' + rules.maxTimes + '）' };

  const lastNag = Array.isArray(row.nagAt) && row.nagAt.length ? atMs(row.nagAt[row.nagAt.length - 1]) : 0;
  if (lastNag) {
    const gap = (now - lastNag) / 60000;
    if (gap < rules.minGapMin) return { nag: false, why: '距上次催办才 ' + Math.round(gap) + ' 分钟（间隔需 ≥' + rules.minGapMin + '）' };
  }
  return { nag: true, why: '逾期 ' + Math.round(ageMin) + ' 分钟，第 ' + (times + 1) + ' 次催办' };
}

/** 找目标面板（多会话场景必须指明，⛔ 不许猜） */
function resolveTarget(row) {
  const scenes = [];
  for (const f of fs.existsSync(SCEN) ? fs.readdirSync(SCEN) : []) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const j = readJson(path.join(SCEN, f));
    if (j && j.id) scenes.push(j);
  }
  for (const s of scenes) {
    for (const p of s.panels || []) {
      if (p.sessionId && p.sessionId === row.sessionId) return { scene: s, panel: p };
    }
  }
  return null;
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });
  const now = Date.now();
  const mk = (o) => ({ ack: false, delivered: 'RPC-200', at: new Date(now - 60 * 60000).toISOString(), text: 'x', ...o });
  const R = { firstAfterMin: 20, minGapMin: 30, maxTimes: 2 };

  add(shouldNag(mk({}), now, R).nag === true, '正例 逾期 60 分钟、没催过 ⇒ 该催');
  add(shouldNag(mk({ at: new Date(now - 5 * 60000).toISOString() }), now, R).nag === false, '反例① 才过 5 分钟 ⇒ 不催（未到 20 分钟）');
  add(shouldNag(mk({ ack: true }), now, R).nag === false, '反例② 已销账 ⇒ 不催');
  add(shouldNag(mk({ delivered: 'HTTP-500' }), now, R).nag === false, '反例③ 空投（从没真投递）⇒ 不催，该重发');
  add(shouldNag(mk({ text: '【不需要回执·知悉】ok' }), now, R).nag === false, '反例④ 知悉类 ⇒ 不催');
  add(shouldNag(mk({ nagCount: 2 }), now, R).nag === false, '反例⑤ 已催 2 次 ⇒ 不再催（上限）');
  {
    const last = new Date(now - 5 * 60000).toISOString();
    add(shouldNag(mk({ nagCount: 1, nagAt: [last] }), now, R).nag === false, '反例⑥ 刚催过 5 分钟 ⇒ 不催（间隔 <30 分钟）');
  }
  {
    const last = new Date(now - 40 * 60000).toISOString();
    add(shouldNag(mk({ nagCount: 1, nagAt: [last] }), now, R).nag === true, '正例 催过 1 次且已过 40 分钟 ⇒ 可以催第 2 次');
  }
  // 时区：老行无 Z 也要算对
  {
    const legacy = new Date(now - 60 * 60000).toISOString().slice(0, 19).replace('T', ' ');
    const r = shouldNag(mk({ at: legacy }), now, R);
    add(r.nag === true, '正例 老格式（无 Z）逾期 60 分钟 ⇒ 也算该催（时区兼容）', r.why);
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
      '催办.mjs —— 欠账没回就催一次（≤2 次 / 间隔 ≥30 分钟 / 只催逾期 ≥20 分钟的）',
      '  node 工具\\催办.mjs           真催',
      '  node 工具\\催办.mjs --dry     只看会催谁',
      '  node 工具\\催办.mjs --stats   看每笔催了几次',
      '  node 工具\\催办.mjs --selftest',
      '约束：' + JSON.stringify(NAG_RULES),
    ].join('\n'));
    process.exit(0);
  }

  const rows = readLedger();
  const now = Date.now();

  if (has('--stats')) {
    const open = rows.filter((r) => !r.ack);
    console.log('未销账 ' + open.length + ' 条：\n');
    for (const r of open) {
      const j = shouldNag(r, now);
      console.log('  ' + r.hash + '  ' + r.from + ' → ' + r.to + '  催过 ' + (r.nagCount || 0) + ' 次  ' + (j.nag ? '⏰ 可催' : '· ' + j.why));
    }
    process.exit(0);
  }

  const todo = rows.filter((r) => shouldNag(r, now).nag);
  if (!todo.length) {
    console.log('✓ 没有需要催的欠账（' + rows.filter((r) => !r.ack).length + ' 条未销账，都不到催办条件）');
    process.exit(0);
  }

  console.log((has('--dry') ? '（dry-run）会催 ' : '催办 ') + todo.length + ' 条：\n');
  let sent = 0, failed = 0;
  for (const r of todo) {
    const verdict = shouldNag(r, now);
    const t = resolveTarget(r);
    const who = t ? (t.scene.name + ' · ' + (t.panel.sessionTitle || t.panel.id)) : '（找不到面板）';
    console.log('  ' + r.hash + '  → ' + r.to + '（' + who + '）　' + verdict.why);

    if (has('--dry')) continue;
    if (!t) { console.log('    ⛔ 找不到对应面板，跳过'); failed++; continue; }

    const body = [
      '【催办·需要回执】' + r.hash,
      '',
      '你有一单还没回执（' + verdict.why + '）：',
      String(r.text || '').split('\n').slice(0, 3).join('\n'),
      '',
      '不管做完没做完，回一句就行：',
      '`node 工具\\回执.mjs --to "' + r.from + '" --结论 … --证据 … --落盘 … --还差 …`',
      '（这是第 ' + ((Number(r.nagCount) || 0) + 1) + ' 次、也是最后一次提醒；次数上限 ' + NAG_RULES.maxTimes + '）',
    ].join('\n');

    const res = await deliver(t.panel.sessionId, body);
    if (res.ok) {
      sent++;
      r.nagCount = (Number(r.nagCount) || 0) + 1;
      r.nagAt = Array.isArray(r.nagAt) ? r.nagAt : [];
      r.nagAt.push(new Date().toISOString());
      console.log('    ✓ 已催（' + deliveryHint(res) + '）第 ' + r.nagCount + ' 次');
    } else {
      failed++;
      console.log('    ✗ 催办投递失败：' + deliveryHint(res));
    }
  }
  if (!has('--dry') && sent) {
    writeLedger(rows);
    console.log('\n✓ 共催 ' + sent + ' 条' + (failed ? '，失败 ' + failed : '') + '（台账已记 nagCount/nagAt）');
  }
  // ⚠ 这里已经 await 过 fetch：⛔ 不能 process.exit()，否则 Windows 上会触发
  //   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码变成 0xC0000409，
  //   明明催成功了却被上层判成失败（本文件第一版就踩了，和 回执.mjs 同一个坑）。
  process.exitCode = failed ? 1 : 0;
}
