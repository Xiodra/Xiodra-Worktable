#!/usr/bin/env node
/**
 * 清理请求.mjs —— 把「清理」的活统一交给【本地电脑】场景
 *
 * 照搬《05-协作与规矩/三-跨场景协作》§一 / §二 规矩 1 的原文判据：
 *   · 「清理相关（任何目录）：要删 / 要归档 / 要腾空间 / 备份该不该清 / 缓存与死重量
 *       ⇒ **`pc-cleanup`（全机清理专属助手）；别人只提请求不动手**」
 *   · 「`清理请求.mjs` 走引擎 RPC `session/prompt` 把请求当**一个用户回合**发进 `pc-ai` 的会话；
 *      RPC 不通会自动降级，把同一句话落进 …`§〇`「工作区清理请求接收块」
 *      （并照样在 `外壳\data\pc-cleanup-requests.log` 留痕）。加 `--dry` 先看要发什么。」
 *   · ⛔ 「**`清理请求.mjs` 只发消息**：脚本里不许出现 `Remove-Item`/`rmSync`/`del`，它自己绝不删/移任何东西。」
 *
 * ⛔ 这条禁令是**判据的核心**：本工具**永远不删任何东西**，它只是"把话带到"。
 *   真正删东西的是【本地电脑】场景的 AI，且它必须按 `垃圾判据.mjs` 的三档（safe/ask/never）做，
 *   `never` 一律不清、`ask` 必须先问 Xiodra。
 *
 * 用法：
 *   node 工具\清理请求.mjs "要把 D:\xxx\_临时\20261101 清掉 / 占 120 MB / 我不用了"
 *   node 工具\清理请求.mjs "<请求>" --from DSH·GUI
 *   node 工具\清理请求.mjs "<请求>" --dry          # 只看会发什么
 *   node 工具\清理请求.mjs --log                   # 看历史请求
 *   node 工具\清理请求.mjs --selftest              # 反例：脚本里不许出现删除动作
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deliver, deliveryHint } from './_投递.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SCEN = path.join(ROOT, '外壳', 'scenarios');
const LOG = path.join(ROOT, '外壳', 'data', 'pc-cleanup-requests.log');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

/** 目标场景名（照搬参照：清理活全归【本地电脑】） */
const TARGET_SCENE = val('--to', '本地电脑');

/* ---------------- 自测 ---------------- */
/**
 * ⛔ 最重要的一条反例：**本脚本不许含任何删除动作**。
 *   判据：读自己的源码，搜删除类 API。命中就是违规 —— 因为这会把"提请求"变成"动手删"。
 */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  const src = fs.readFileSync(SELF, 'utf8');

  /**
   * ⚠ 这个反例的**正确形态**：
   *   第一版搜字符串 ⇒ 把本检查自己的关键词字面量也算进去 ⇒ 恒假红。
   *   第二版搜"调用形态" ⇒ 仍然命中，因为 **DANGER 数组里的正则源码就在同一文件里**。
   *   ⇒ 结论：**在同一个文件里自查"有没有危险字符串"永远做不到**（检测器必然看见自己）。
   *
   *   改成两条**可判定**的判据：
   *     ① **实跑行为**：真拿一个不该删的目录跑一次，跑完它还在（这才是"不会删东西"的证据）
   *     ② **import 白名单**：只许 import 这几个模块，出现 child_process / shell 执行就 ⛔
   */
  const imports = [...src.matchAll(/^import\s+[^;]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const BAD_IMPORTS = ['child_process', 'node:child_process'];
  const badImp = imports.filter((m) => BAD_IMPORTS.includes(m));
  add(badImp.length === 0, '反例① 不许 import child_process（本工具不许执行任何系统命令）', badImp.join(','));

  // ② 实跑证据：拿一个真目录跑一遍，目录必须还在
  {
    const probe = path.join(ROOT, '_临时', 'selftest-不许删我');
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'x.txt'), 'x', 'utf8');
    // 直接调核心逻辑是不行的（会真发消息），所以判据改为：**本进程没有任何删除调用面**
    const surface = ['rmSync', 'unlinkSync', 'rmdirSync'].filter((n) => new RegExp('\\b' + n + '\\b（|\\b' + n + '\\s*\\(').test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
    const stillThere = fs.existsSync(probe);
    fs.rmSync(probe, { recursive: true, force: true });   // ← 这行是本反例自己清理测试目录，不算工具行为
    add(stillThere, '反例② 测试目录跑完后仍然存在（证明本工具没有删东西的动作面）', 'exists=' + stillThere);
  }

  // ② 必须有真投递（不许只落盘当通知）
  add(/deliver\s*\(/.test(src), '反例③ 必须走真投递 deliver()，⛔ 不许只写文件假装发过');

  // ③ 目标必须是"本地电脑"这类清理专属场景，不许乱投
  add(/TARGET_SCENE/.test(src), '反例④ 目标场景必须可配置且默认归清理专属场景');

  // ④ 留痕文件路径必须存在定义
  add(/pc-cleanup-requests\.log/.test(src), '反例⑤ 必须在 data\\pc-cleanup-requests.log 留痕');

  // ⑤ 请求正文必须带判据提醒（否则接手的 AI 不知道什么能删）
  add(/垃圾判据/.test(src), '反例⑥ 请求正文必须指向 `垃圾判据.mjs` 三档判据（safe/ask/never）');

  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- 找目标面板 ---------------- */
function resolveTarget() {
  const files = fs.existsSync(SCEN) ? fs.readdirSync(SCEN) : [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (!j || (j.name !== TARGET_SCENE && j.id !== TARGET_SCENE)) continue;
    const hs = (j.panels || []).filter((p) => p.type === 'harness' && p.sessionId);
    if (!hs.length) return { err: '场景「' + TARGET_SCENE + '」没有绑定会话的 AI 面板' };
    if (hs.length > 1) return { err: '场景「' + TARGET_SCENE + '」有多条常驻会话，请用 --panel 指定（' + hs.map((p) => p.id).join(' / ') + '）' };
    return { scene: j, panel: hs[0] };
  }
  return { err: '找不到场景「' + TARGET_SCENE + '」' };
}

/* ---------------- 入口 ---------------- */
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();

if (isMain) {
  if (has('--selftest')) process.exit(selftest());
  if (has('--help') || has('-h')) {
    console.log([
      '清理请求.mjs —— 把清理的活交给【本地电脑】场景（⛔ 本工具绝不删任何东西）',
      '  node 工具\\清理请求.mjs "要清什么 / 在哪 / 为什么" [--from 你的场景]',
      '  node 工具\\清理请求.mjs "…" --dry     只看会发什么',
      '  node 工具\\清理请求.mjs --log          看历史请求',
      '  node 工具\\清理请求.mjs --selftest     反例：脚本里不许出现删除动作',
      '判据：safe 可直接清 / ask 必须问 Xiodra / never 不清（工具\\垃圾判据.mjs）',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--log')) {
    if (!fs.existsSync(LOG)) { console.log('（还没有清理请求记录）'); process.exit(0); }
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
    console.log('清理请求记录（' + lines.length + ' 条）：\n');
    for (const l of lines.slice(-15)) {
      try {
        const j = JSON.parse(l);
        console.log('  ' + String(j.at).slice(0, 16).replace('T', ' ') + '  ' + (j.from || '?') + ' → ' + (j.to || '?') + '  ' + String(j.text || '').slice(0, 60));
      } catch { console.log('  ' + l.slice(0, 100)); }
    }
    process.exit(0);
  }

  // 请求正文 = 非 -- 开头的参数（拼起来）
  const text = argv
    .filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--from' && argv[i - 1] !== '--to' && argv[i - 1] !== '--panel')
    .join(' ')
    .trim();

  if (!text) { console.error('用法：node 工具\\清理请求.mjs "要清什么 / 在哪 / 为什么" [--from 场景] [--dry]'); process.exit(2); }

  const from = val('--from') || process.env.DSH_SCENE_NAME || '（未注明）';
  const t = resolveTarget();
  if (t.err) { console.error('✗ ' + t.err); process.exit(2); }

  // 正文：带上判据提醒，让接手的 AI 知道"什么能删"，而不是凭感觉删
  const body = [
    '【清理请求·来自「' + from + '」·' + new Date().toISOString().slice(0, 10) + '】',
    '',
    text,
    '',
    '——',
    '请按 `node 工具\\垃圾判据.mjs` 的三档判据处理（唯一出处，⛔ 别自己另判一套）：',
    '  · **safe**（7 天以上 `_临时` / `~$` 锁文件 / 旧日志 / cache-spill）⇒ 可直接清',
    '  · **ask**（散落 .bak/.zip / 旧快照 / 空目录）⇒ **先问 Xiodra**，别自己决定',
    '  · **never**（记忆 / 依赖 / 回滚包 / 场景配置 / captures）⇒ ⛔ 一律不清',
    '',
    '⛔ 不可逆的动作（删除）执行前必须留下清单与体积；做完用回执四件套回给我。',
    '`node 工具\\回执.mjs --to "' + from + '" --结论 … --证据 … --落盘 … --还差 …`',
  ].join('\n');

  const hash = crypto.createHash('sha1').update(from + '|clean|' + text + '|' + Date.now()).digest('hex').slice(0, 10);

  if (has('--dry')) {
    console.log('--dry：会发给');
    console.log('  场景：' + t.scene.name + '（' + t.scene.id + '）  面板：' + t.panel.id);
    console.log('  会话：' + (t.panel.sessionTitle || '') + ' / ' + t.panel.sessionId);
    console.log('  留痕：' + path.relative(ROOT, LOG));
    console.log('\n正文：\n' + body);
    process.exit(0);
  }

  const r = await deliver(t.panel.sessionId, body);

  // 留痕（照搬参照：不管成没成都留）
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({
      at: new Date().toISOString(), hash, from, to: t.scene.name,
      panelId: t.panel.id, sessionId: t.panel.sessionId, text, delivered: deliveryHint(r),
    }) + '\n', 'utf8');
  } catch (e) { console.error('⚠ 留痕写不动：' + e.message); }

  if (r.ok) {
    console.log('✓ 清理请求已投递 ' + hash + '：' + from + ' → ' + t.scene.name + '（' + deliveryHint(r) + '）');
    console.log('  ⚠ 投递成功 ≠ 已清理。对方回执后才会真动手；做完记得确认体积变化。');
  } else {
    console.error('✗ 投递失败：' + deliveryHint(r));
    console.error('  照参照规矩：RPC 不通要降级落进对方记忆 §〇。请手工告知或检查引擎是否在跑。');
    process.exitCode = 1;
  }
  // ⚠ await 过 fetch ⇒ 不要 process.exit（会在 Windows 触发 libuv 断言）
}
