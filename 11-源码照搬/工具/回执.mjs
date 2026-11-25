#!/usr/bin/env node
/**
 * 回执.mjs —— 回执**必须投递**才算闭环（照搬《05-协作与规矩》回执闭环协议）
 *
 * 原文三条（每条都是血）：
 *   ① 干完/卡住/干不了 ⇒ **必须调工具**把回执投回发起方；⛔ 只在自己窗口说"我做完了" = 没闭环
 *      ⇒ 判据：**「活干完了但对方还不知道」= 没干完**
 *   ② 回执用「【不需要回执·知悉】」发出 ⇒ 链路**在第 2 条终止**，发起方不再回
 *   ③ 全链路 **≤3 条**（派单 1 + 回执 1 + 收尾 1）；⛔ 纯确认语（收到/好的/谢谢）不许发
 *
 * 本工具干三件事（一次做完，别手搓）：
 *   1. 把回执**真投递**进发起方面板绑定的会话（走 `_投递.mjs` 唯一配方）
 *   2. 按四件套**校验**正文（结论 / 证据 / 落盘路径 / 还差什么），缺就 ⛔ 不发
 *   3. 自动把台账里对应那条**销账**（`--ack <hash>`），并记一条回执记录
 *
 * 用法：
 *   node 工具\回执.mjs --to 控制器 --ack <hash> --结论 "成" --证据 "机制体检 9/9" --落盘 "工具\索引体检.mjs" [--还差 "无"]
 *   node 工具\回执.mjs --to 控制器 --dry ...            # 只看会发什么
 *   node 工具\回执.mjs --selftest                       # 四件套校验 4 反例 + 1 正例
 *
 * 正文自动加：首行 `【不需要回执·知悉】`，末行 `【结束】`，并截到 ≤200 字 / ≤10 行（超了报错，不静默截断）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deliver, deliveryHint } from './_投递.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const SCEN = path.join(ROOT, '外壳', 'scenarios');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const LEDGER = path.join(MEM, '_共享记忆', '派单台账.json');
const ACK_LOG = path.join(MEM, '_共享记忆', '_回执记录.jsonl');

const argv = process.argv.slice(2);
const val = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d; };
const has = (k) => argv.includes(k);
const die = (s) => { console.error('✗ ' + s); process.exit(1); };

const MAX_LINES = 10;
const MAX_CHARS = 200;

/** 四件套校验：返回缺失的项（空数组 = 齐了） */
export function checkQuartet(p) {
  const miss = [];
  if (!String(p.conclusion || '').trim()) miss.push('结论（成/没成/部分成）');
  if (!String(p.evidence || '').trim()) miss.push('证据（跑了什么命令、几条通过）');
  if (!String(p.paths || '').trim()) miss.push('落盘路径（改了哪个文件 / 记忆写在哪）');
  if (String(p.todo || '').trim() === '') miss.push('还差什么（没有就写「无」，这一项不许空着）');
  // 证据不许是空话
  if (String(p.evidence || '').trim() && !/\d/.test(String(p.evidence))) miss.push('证据里要有数字（"跑了几条通过"），只写"已修复"不算');
  // 结论要有判定词
  if (String(p.conclusion || '').trim() && !/(成|完成|通过|失败|没成|部分|卡住|干不了|已|✓|✓)/.test(String(p.conclusion))) miss.push('结论要说清成/没成/部分成');
  return miss;
}

/** 组正文（首行标记 + 四件套 + 末行【结束】） */
export function buildBody(p, from = '') {
  const body = [
    '【不需要回执·知悉】' + (from ? '来自「' + from + '」的回执' : '回执'),
    '结论：' + String(p.conclusion || '').trim(),
    '证据：' + String(p.evidence || '').trim(),
    '落盘：' + String(p.paths || '').trim(),
    '还差：' + (String(p.todo || '').trim() || '无'),
    '【结束】',
  ].join('\n');
  return body;
}

/** 上限校验：≤200 字 / ≤10 行（超了报错，⛔ 不静默截断） */
export function checkLimits(body) {
  const lines = body.split(/\r?\n/).length;
  const chars = [...body].length;
  const bad = [];
  if (lines > MAX_LINES) bad.push('行数 ' + lines + ' > ' + MAX_LINES);
  if (chars > MAX_CHARS) bad.push('字数 ' + chars + ' > ' + MAX_CHARS + '（回执只留结论与证据，细节进文件）');
  return bad;
}

function readLedger() { try { const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8').replace(/^\uFEFF/, '')); return Array.isArray(j) ? j : []; } catch { return []; } }
function writeLedger(rows) { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(rows, null, 2) + '\n', 'utf8'); }

function scenes() {
  const out = [];
  for (const f of fs.existsSync(SCEN) ? fs.readdirSync(SCEN) : []) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try { const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8').replace(/^\uFEFF/, '')); if (j && j.id) out.push(j); } catch { /* 跳过 */ }
  }
  return out;
}

/* ---------------- 自测：四件套 4 反例 + 上限 1 反例 + 1 正例 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label) => cases.push({ ok, label });
  const good = { conclusion: '已修复', evidence: '机制体检 9/9 全过', paths: '工具\\索引体检.mjs', todo: '无' };
  add(checkQuartet(good).length === 0, '正例 四件套齐全 ⇒ 通过');
  add(checkQuartet({ ...good, conclusion: '' }).some((m) => m.startsWith('结论')), '反例① 缺结论 ⇒ 拦');
  add(checkQuartet({ ...good, evidence: '已修复' }).some((m) => m.includes('数字')), '反例② 证据只有"已修复"没数字 ⇒ 拦');
  add(checkQuartet({ ...good, paths: '  ' }).some((m) => m.startsWith('落盘')), '反例③ 缺落盘路径 ⇒ 拦');
  add(checkQuartet({ ...good, todo: undefined }).some((m) => m.includes('还差')), '反例④ 缺"还差什么"（连"无"都没写）⇒ 拦');
  const long = buildBody({ ...good, evidence: '证据'.repeat(120) }, 'DSH·GUI');
  add(checkLimits(long).some((b) => b.includes('字数')), '反例⑤ 正文超 200 字 ⇒ 拦（不静默截断）');
  const b = buildBody(good, 'DSH·GUI');
  add(b.startsWith('【不需要回执·知悉】') && b.trimEnd().endsWith('【结束】'), '正例 正文首行带标记、末行【结束】');

  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label);
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();

if (isMain) {
  if (has('--selftest')) process.exit(selftest());
  if (has('--help') || has('-h') || (!val('--to') && !has('--selftest'))) {
    console.log([
      '回执.mjs —— 回执必须投递才算闭环',
      '  node 工具\\回执.mjs --to <场景> --结论 成 --证据 "机制体检 9/9" --落盘 工具\\x.mjs --还差 无 [--ack <hash>]',
      '  可加 --dry 只看不发；--from 署名（默认「未注明」）。',
      '⛔ 纯确认语（收到/好的/谢谢）不许发；收到知悉一个字都不许回。',
    ].join('\n'));
    process.exit(has('--help') || has('-h') ? 0 : 1);
  }

  const to = val('--to');
  /**
   * ⚠ 2026-11-19 修（控制器指出「上条漏了 --from」）：
   *   原来 `--from` 缺省就是「（未注明）」且**静默接受** ⇒ 实测 12 条回执里 6 条没署名。
   *   回执不署名 = 对方不知道"谁做完了"，闭环断了一半。
   *   修法：不给 `--from` 就**按自己的会话 id 反查场景名**（`DSH_SESSION_ID` → 场景 json 的面板绑定）。
   *   查不到才用「（未注明）」，并且**明确告警**，不静默。
   */
  const fromRaw = val('--from', '');
  const from = fromRaw || (() => {
    const mySid = process.env.DSH_SESSION_ID || '';
    if (!mySid) return '（未注明）';
    try {
      const scenDir = path.join(ROOT, '外壳', 'scenarios');
      for (const f of fs.readdirSync(scenDir)) {
        if (!f.endsWith('.json') || f.startsWith('_')) continue;
        const j = JSON.parse(fs.readFileSync(path.join(scenDir, f), 'utf8').replace(/^\uFEFF/, ''));
        for (const p2 of j.panels || []) {
          if (p2.sessionId === mySid) return (j.name || j.id) + ' · ' + (p2.sessionTitle || p2.title || p2.id);
        }
      }
    } catch { /* ignore */ }
    return '（未注明）';
  })();
  if (!fromRaw && from === '（未注明）') {
    console.log('⚠ 没给 --from 且按会话 id 查不到场景 ⇒ 回执会署名「未注明」（对方不知道是谁）。建议加 --from。');
  }
  const p = { conclusion: val('--结论'), evidence: val('--证据'), paths: val('--落盘'), todo: val('--还差', has('--还差') ? '' : '无') };

  const miss = checkQuartet(p);
  if (miss.length) die('回执四件套不全，不发：缺 ' + miss.join(' / ') + '\n  （四件套：结论 + 证据（带数字）+ 落盘路径 + 还差什么）');
  const body = buildBody(p, from);
  const over = checkLimits(body);
  if (over.length) die('回执超上限：' + over.join(' / ') + '\n  （≤200 字 / ≤10 行；细节写进文件，回执只留结论与证据）');

  const list = scenes();
  const scene = list.find((s) => s.name === to) || list.find((s) => s.id === to) || null;
  if (!scene) die('找不到场景「' + to + '」（现有：' + list.map((s) => s.name + '/' + s.id).join(', ') + '）');

  /**
   * ⚠ 2026-11-19 修（两道，和 `派单.mjs` 同源事故）：
   *   原来只 `find()` 第一条 harness 面板 ⇒ ① 多会话场景投错人；② 可能投给**自己**。
   *   实测：我给「DSH·GUI」发回执，结果投进了 `dsh-gui-p3`（我自己）。
   *   判据同派单：**投错人比不投更贵**。
   */
  const harnessPanels = (scene.panels || []).filter((x) => x.type === 'harness' && x.sessionId);
  if (!harnessPanels.length) die('场景「' + to + '」没有绑定的 AI 面板 ⇒ 收不到回执');

  const wantPanel = val('--panel');
  let panel = null;
  if (wantPanel) {
    panel = harnessPanels.find((p) => p.id === wantPanel) || null;
    if (!panel) die('场景「' + to + '」里没有面板「' + wantPanel + '」。可投的：' + harnessPanels.map((p) => p.id + '(' + (p.sessionTitle || '') + ')').join(' / '));
  } else {
    if (harnessPanels.length > 1) {
      die('场景「' + to + '」有 ' + harnessPanels.length + ' 条常驻会话，**必须用 --panel 指定**：\n' +
        '    ' + harnessPanels.map((p) => '--panel ' + p.id + '　（' + (p.sessionTitle || '') + '）').join('\n    '));
    }
    panel = harnessPanels[0];
  }
  // ⛔ 不许发给自己
  const myId = process.env.DSH_SESSION_ID || '';
  if (myId && panel.sessionId === myId) {
    die('⛔ 回执的目标就是**你自己**（' + panel.id + ' / ' + (panel.sessionTitle || '') + '）。\n' +
      '  · 回执是"告诉别人我做完了" ⇒ 发给自己等于没闭环\n' +
      '  · 要发给别人：' + (harnessPanels.filter((p) => p.sessionId !== myId).map((p) => '--panel ' + p.id).join(' ') || '（本场景没有别的面板）'));
  }

  if (has('--dry')) {
    console.log('--dry：会发给');
    console.log('  场景：' + scene.name + '（' + scene.id + '）  面板：' + panel.id);
    console.log('  会话：' + (panel.sessionTitle || '') + ' / ' + panel.sessionId);
    console.log('  正文（' + [...body].length + ' 字 / ' + body.split('\n').length + ' 行）：\n' + body);
    process.exit(0);
  }

  const r = await deliver(panel.sessionId, body);
  const hash = crypto.createHash('sha1').update(from + '|' + to + '|回执|' + Date.now()).digest('hex').slice(0, 10);
  const at = new Date().toISOString();   // ⚠ 必须带 Z（_回执记录.jsonl 也按 ISO 存）

  // 记一条回执（只追加，便于追"什么时候回过")
  try {
    fs.mkdirSync(path.dirname(ACK_LOG), { recursive: true });
    fs.appendFileSync(ACK_LOG, JSON.stringify({ hash, from, to, panelId: panel.id, sessionId: panel.sessionId, at, delivered: r.ok ? 'RPC-200' : 'HTTP-' + r.status, body }) + '\n', 'utf8');
  } catch { /* 记录失败不影响投递结论 */ }

  // 销账（给了 hash 才销）
  const ackHash = val('--ack');
  let ackNote = '';
  if (ackHash) {
    const rows = readLedger();
    const row = rows.find((x) => x.hash === ackHash);
    if (!row) ackNote = '⚠ 台账里没有 ' + ackHash + '，没销账';
    else { row.ack = true; row.ackAt = at; writeLedger(rows); ackNote = '✓ 已销账 ' + ackHash; }
  }

  if (!r.ok) die('回执投递失败 —— ' + deliveryHint(r) + '\n  ⇒ 这次回执**没闭环**，别在自己窗口说"已回"');
  console.log('✓ 回执已投递：' + from + ' → ' + to + '（' + deliveryHint(r) + '）');
  console.log('  会话：' + (panel.sessionTitle || '') + ' / ' + panel.sessionId);
  if (ackNote) console.log('  ' + ackNote);
  console.log('  ⛔ 这条是「不需要回执·知悉」⇒ 对方不该再回；你也别再补一条"收到"。');
  // ⚠ 这里**不能** process.exit(0)：await 过 fetch 之后 socket 还挂在 libuv 上，
  //   硬 exit 会触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（Windows 上 exit code 直接变成 0xC0000409）。
  //   设 exitCode 让进程自然退出即可。
  process.exitCode = 0;
}
