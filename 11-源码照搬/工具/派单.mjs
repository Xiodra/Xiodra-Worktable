#!/usr/bin/env node
/**
 * 派单.mjs —— 把一条派单**真投递**进目标场景的会话，并落台账
 *
 * 为什么不能只"写一条通知"（《00-核心机制/一-协作机制》§4 的真实事故）：
 *   一天 36 条「通知」里只有 8 条真发进会话，执行率 8/36 —— 因为它们只落了盘、
 *   没有唤醒对方。**公告 ≠ 派单**。派单必须真的把消息塞进目标会话，
 *   对方下一轮才会看到。本工具干的就是"真投递"，并记下 delivered 状态。
 *
 * 用法：
 *   node 工具\派单.mjs --to 控制器 --from "DSH·GUI" "现象 …（四件套）"
 *   node 工具\派单.mjs --list                  # 台账：我发出的 / 别人在等我回的
 *   node 工具\派单.mjs --ack <hash>             # 收到回执后销账
 *   node 工具\派单.mjs --to … --dry             # 只看会发给谁，不发
 *   node 工具\派单.mjs --to dsh-gui --panel dsh-gui-chat "…"
 *        # ★多会话场景必用★ 一个场景挂两条常驻会话时，缺省只会投给第一条 AI 面板；
 *        # 用 --panel 指定投给哪个面板。指定的面板不存在 ⇒ 直接报错（不静默退回第一条）。
 *
 * 派单正文四件套（写在内容里，缺一条对方就得回来问）：
 *   ① 现象（可观察，不要形容词）
 *   ② 照哪做（唯一出处：文件路径 / 章节）
 *   ③ 怎么验（跑什么命令、看到什么算通过）
 *   ④ 回一句（写明「我在等你的回执」）
 *
 * 台账：`引擎数据\.dsh\场景记忆\_共享记忆\派单台账.json`
 *   [{ hash, from, to, at, kind, delivered, deliverInfo, ack, ackAt, text }]
 *   两个查询 = 「我发出还没人回的」（ack 为空）/「别人在等我回的」（to 是我、ack 为空）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const LEDGER = path.join(MEM, '_共享记忆', '派单台账.json');
const SCEN = path.join(ROOT, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const val = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const has = (k) => argv.includes(k);
const say = (s) => console.log(s);
const die = (s) => { console.error('✗ ' + s); process.exit(1); };

/* ---------------- 台账 ---------------- */
const readLedger = () => {
  try { const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8').replace(/^\uFEFF/, '')); return Array.isArray(j) ? j : []; }
  catch (e) { return []; }
};
const writeLedger = (rows) => {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(rows, null, 2) + '\n', 'utf8');
};

/* ---------------- --list：台账 + 欠账判据 ----------------
 * 照搬《08-升级与改造清单》例 3「回执双向自动销账」的判据部分：
 *   台账里光有记录不算数，要能**算出"谁欠谁"**。四个判据（都写在这一处，别处不再判）：
 *   ① 空投   delivered ≠ RPC-200  ⇒ 这条根本没进会话
 *   ② 逾期   未 ack 且已过 NAG_MIN 分钟（默认 10）⇒ 对方该回没回
 *   ③ 知悉   text 里带「不需要回执」⇒ 不算欠账（但也不自动销账，人拍板）
 *   ④ 陈旧   未 ack 且超过 STALE_H 小时（默认 48）⇒ 不进"欠账"，单列
 * 排序：空投 → 逾期 → 其它未 ack → 陈旧最后。
 */
if (has('--list') || (!val('--to') && !has('--ack'))) {
  const NAG_MIN = Number(val('--nag-min', '10')) || 10;
  const STALE_H = Number(val('--stale-h', '48')) || 48;
  const rows = readLedger();
  const me = val('--me', '');
  const now = Date.now();
  /**
   * 时间解析（唯一出处，⛔ 别在别处再写一份）：
   *   新行存完整 ISO 带 Z（UTC 标注）⇒ 原样 Date.parse 就对。
   *   老行形如 `2026-11-18 09:49:15`（**无时区**，实际是 UTC 值）⇒ 摘掉空格 + 补 Z 再 parse。
   *   ⚠ 历史坑：以前写入端存 `toISOString().slice(0,19)`（UTC 数值但没标时区），
   *   读取端按本地解析 ⇒ 本机 UTC+8 恒差 8 小时，刚投的派单立刻显示「逾期 480m」。
   *   ⛔ 解法只能是补时区标注，**不许改成写本地时间**（跨时区/夏令时会再翻车）。
   */
  const atMs = (s) => {
    const raw = String(s || '').trim();
    if (!raw) return 0;
    // 已带时区（Z 或 ±hh:mm）⇒ 原样
    if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
      const t = Date.parse(raw);
      return Number.isFinite(t) ? t : 0;
    }
    // 无时区：先按 `YYYY-MM-DD HH:mm:ss` 拆，显式当 UTC
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      return Number.isFinite(t) ? t : 0;
    }
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  };
  const ageMin = (r) => Math.max(0, Math.round((now - atMs(r.at)) / 60000));
  const isInform = (r) => /不需要回执/.test(String(r.text || ''));

  const open = rows.filter((r) => !r.ack);
  const kindOf = (r) => {
    if (r.delivered !== 'RPC-200') return '空投';
    if (isInform(r)) return '知悉';
    if (ageMin(r) > STALE_H * 60) return '陈旧';
    if (ageMin(r) >= NAG_MIN) return '逾期';
    return '在等';
  };
  const flagged = open.map((r) => ({ ...r, _kind: kindOf(r), _age: ageMin(r) }));

  const pending = flagged.filter((r) => r._kind === '逾期' || r._kind === '空投' || r._kind === '在等');
  const stale = flagged.filter((r) => r._kind === '陈旧');
  const inform = flagged.filter((r) => r._kind === '知悉');

  const mine = me ? flagged.filter((r) => r.from === me) : flagged;
  const theirs = me ? flagged.filter((r) => r.to === me) : [];

  const line = (r) => '  [' + r._kind + ' ' + r._age + 'm] ' + r.hash + '  ' + r.from + ' → ' + r.to + '  ' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 50);

  say('派单台账：' + LEDGER);
  say('共 ' + rows.length + ' 条 · 未销账 ' + open.length + ' · 欠账（逾期/空投）' + flagged.filter((r) => r._kind === '逾期' || r._kind === '空投').length + ' · 陈旧 ' + stale.length + ' · 知悉 ' + inform.length);
  say('判据：逾期 ≥' + NAG_MIN + ' 分钟未 ack · 陈旧 >' + STALE_H + ' 小时 · 空投 = delivered 不是 RPC-200\n');

  say('【我发出、还没人回】' + (me ? '（from=' + me + '）' : '（全部）'));
  if (!mine.length) say('  （无）');
  for (const r of mine) say(line(r));

  if (me) {
    say('\n【别人在等我回】');
    if (!theirs.length) say('  （无）');
    for (const r of theirs) say(line(r));
  }

  if (stale.length) {
    say('\n【陈旧（>' + STALE_H + 'h，不进欠账，可 `--ack` 或按需清理）】');
    for (const r of stale) say(line(r));
  }
  if (inform.length) {
    say('\n【知悉类（不需要回执 ⇒ 不算欠账，但也不自动销）】');
    for (const r of inform) say(line(r));
  }

  const dead = rows.filter((r) => r.delivered !== 'RPC-200');
  if (dead.length) {
    say('\n⚠ 从未真投递（等于扔黑洞）：');
    for (const r of dead) say('  ' + r.hash + '  → ' + r.to + '  delivered=' + (r.delivered || '?'));
  }
  // 退出码：有欠账 / 空投 ⇒ 1（这样能挂进机制体检，0 表示干净）
  const bad = flagged.filter((r) => r._kind === '逾期' || r._kind === '空投').length;
  say('\n' + (bad ? '⛔ 欠账 ' + bad + ' 条 ⇒ exit 1' : '✓ 没有欠账'));
  process.exit(bad ? 1 : 0);
}

/* ---------------- --ack：销账（单条 hash 最稳；`--ack <面板> --all` 实测只消一部分，别用） ---------------- */
if (has('--ack')) {
  const h = val('--ack');
  const rows = readLedger();
  const r = rows.find((x) => x.hash === h);
  if (!r) die('台账里没有 ' + h);
  r.ack = true;
  r.ackAt = new Date().toISOString();   // ⚠ 必须带 Z：无时区串会被读取端当本地时间，本机 UTC+8 恒差 8h
  writeLedger(rows);
  say('✓ 已销账 ' + h + '（' + r.from + ' → ' + r.to + '）');
  process.exit(0);
}

/* ---------------- 真投递 ---------------- */
const to = val('--to');
const from = val('--from', '（未注明）');
if (!to) die('用法：node 工具\\派单.mjs --to <场景目录名> [--from <发起场景>] "四件套内容"');
const text = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--to' && argv[i - 1] !== '--from' && argv[i - 1] !== '--me' && argv[i - 1] !== '--panel').join(' ').trim();
if (!text) die('派单内容是空的。四件套：现象 / 照哪做 / 怎么验 / 回一句');

/* 目标场景 json：记忆目录名 == 场景 name（工具约定） */
const readScenes = () => {
  const out = [];
  for (const f of fs.existsSync(SCEN) ? fs.readdirSync(SCEN) : []) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try { const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8').replace(/^\uFEFF/, '')); if (j && j.id) out.push(j); } catch (e) { /* 跳过坏 json */ }
  }
  return out;
};
const scenes = readScenes();
const scene = scenes.find((s) => s.name === to) || scenes.find((s) => s.id === to) || null;
if (!scene) die('找不到场景「' + to + '」（记忆目录名必须等于场景 json 的 name；现有：' + scenes.map((s) => s.name + '/' + s.id).join(', ') + '）');
const wantPanel = val('--panel');
const harnessPanels = (scene.panels || []).filter((p) => p.type === 'harness' && p.sessionId);
let panel = null;
if (wantPanel) {
  // 指定了面板就必须命中；⛔ 不许静默退回第一条（那正是「双会话场景投错人」的成因）
  panel = harnessPanels.find((p) => p.id === wantPanel) || null;
  if (!panel) {
    die('场景「' + to + '」里没有面板「' + wantPanel + '」或它没绑 sessionId。\n    该场景可投的 AI 面板：' +
      (harnessPanels.length ? harnessPanels.map((p) => p.id + '(' + (p.sessionTitle || '') + ')').join(' / ') : '（一个都没有）'));
  }
} else {
  /**
   * ⚠ 2026-11-19 改：**多会话场景不给 --panel 直接报错**（原来只打一行 ⚠ 然后照投第一条）。
   *   事故：我给「DSH·GUI」派单，它有两块面板（GUI改造 / DSH改造），缺省投给了 **DSH改造**
   *   —— 也就是我自己。一条真派单白投，还得先销账再重投。
   *   判据：**投错人比不投更贵**（对方没收到 + 台账多一条假账 + 要手工销）。
   *   ⇒ 这种设计错误不能靠"人看提示"，必须让它失败。
   */
  if (harnessPanels.length > 1) {
    die('场景「' + to + '」有 ' + harnessPanels.length + ' 条常驻会话，**必须用 --panel 指定投给谁**：\n' +
      '    ' + harnessPanels.map((p) => '--panel ' + p.id + '　（' + (p.sessionTitle || '') + '）').join('\n    ') +
      '\n  ⛔ 缺省猜一条 = 可能投给自己或投错人，所以这里直接拒绝。');
  }
  panel = harnessPanels[0] || null;
}
if (!panel) die('场景「' + to + '」里没有已绑定 sessionId 的 AI 面板 ⇒ 先绑会话，否则没法投递');

/**
 * ⛔ 不许把派单投给**自己**（2026-11-19 事故）。
 *   实测：`--to "DSH·GUI"` 在多会话场景缺省命中 `dsh-gui-p3`（DSH改造本尊），
 *   结果一条派单投进自己的会话，绕过一层唤醒后又作为「用户消息」回到自己手上。
 *   判据：`DSH_SESSION_ID` == 目标面板的 sessionId ⇒ 直接拒绝。
 *   ⛔ 不接受"自己给自己留个备忘"这种用法：备忘写场景记忆 §〇，不要占派单台账。
 */
const myId = process.env.DSH_SESSION_ID || '';
if (myId && panel.sessionId === myId) {
  die('⛔ 目标会话就是**你自己**（' + panel.id + ' / ' + (panel.sessionTitle || '') + '）。\n' +
    '  派单是"叫别人干活"，投给自己只会绕一圈回来。\n' +
    '  · 要给自己留备忘 ⇒ 写场景记忆 §〇 或项目记忆，⛔ 别占派单台账\n' +
    '  · 要派给别人 ⇒ 指定别的面板：' + (harnessPanels.filter((p) => p.sessionId !== myId).map((p) => '--panel ' + p.id).join(' ') || '（本场景没有别的面板）'));
}

/* token + cookie（照 建会话.mjs 的实测配方） */
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } })();
const PORT = String(process.env.DSH_PORT || CFG.port || 33083);
const BASE = 'http://127.0.0.1:' + PORT;
const engineData = CFG.engineDataDir || '引擎数据\\.dsh';
const localData = path.isAbsolute(engineData) ? engineData : path.join(ROOT, engineData);
const DSH_HOME = fs.existsSync(localData) ? localData : (process.env.DSH_CUSTOMER_HOME || process.env.DSH_HOME || path.join(ROOT, '引擎', '.dsh'));
const LOG = path.join(ROOT, '外壳', 'server.log');

function tokens() {
  if (!fs.existsSync(LOG)) return [];
  const txt = fs.readFileSync(LOG, 'utf8');
  const re = new RegExp('127\\.0\\.0\\.1:' + PORT + '\\/\\?token=([A-Za-z0-9_\\-]{16,})', 'g');
  return [...txt.matchAll(re)].map((m) => m[1]).reverse();
}
async function getCookie() {
  for (const t of tokens().slice(0, 3)) {
    try {
      const r = await fetch(BASE + '/?token=' + t, { redirect: 'manual' });
      const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      if (sc.length) return sc.map((c) => c.split(';')[0]).join('; ');
    } catch (e) { /* 换下一条 */ }
  }
  return '';
}

const hash = crypto.createHash('sha1').update(from + '|' + to + '|' + text + '|' + Date.now()).digest('hex').slice(0, 10);
const at = new Date().toISOString();   // ⚠ 必须带 Z（老行无时区由读取端 atMs 兼容）

const body4 = [
  '【派单 ' + hash + '】来自「' + from + '」→「' + to + '」  ' + at,
  '',
  text,
  '',
  '（回执四件套：结论 + 证据（跑了什么、几条通过）+ 落盘路径 + 还差什么；同一件事 ≤3 条消息，末行写【结束】）'
].join('\n');

if (has('--dry')) {
  say('--dry：会投递给');
  say('  场景：' + scene.name + '（' + scene.id + '）');
  say('  面板：' + panel.id + '  会话：' + (panel.sessionTitle || '') + ' / ' + panel.sessionId);
  say('  内容：\n' + body4);
  process.exit(0);
}

const cookie = await getCookie();
if (!cookie) die('换不到 cookie（引擎没在跑？先启动工作台）');

const rpc = async (method, a) => {
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args: a } }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
  return { status: r.status, j, t };
};

const pr = await rpc('session/prompt', {
  request: {
    requestId: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    sessionId: panel.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: body4 }],
  },
});

const rows = readLedger();
rows.push({
  hash, from, to, at,
  kind: '派单',
  sceneId: scene.id,
  panelId: panel.id,
  sessionId: panel.sessionId,
  delivered: pr.status === 200 ? 'RPC-200' : 'HTTP-' + pr.status,
  deliverInfo: String(pr.t || '').slice(0, 200),
  ack: false,
  ackAt: '',
  text,
});
writeLedger(rows);

if (pr.status === 200) {
  say('✓ 已投递 ' + hash + '：' + from + ' → ' + to);
  say('  会话：' + (panel.sessionTitle || '') + ' / ' + panel.sessionId);
  say('  台账：' + LEDGER);
  say('  ⚠ 投递成功 ≠ 对方回执。对方回话后用 `--ack ' + hash + '` 销账。');
} else {
  die('投递失败 HTTP ' + pr.status + '：' + String(pr.t || '').slice(0, 200));
}
