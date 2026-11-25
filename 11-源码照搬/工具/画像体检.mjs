#!/usr/bin/env node
/**
 * 画像体检.mjs —— 机主画像的纪律（照搬《05/一-全局铁律》§「记忆分两级」）
 *
 * 参照原文：「共享 = `_共享记忆\宿主画像.md`（**权威，只有 dg-dsh 与 sr-ai 可改**；参考件 `宿主画像参考.md` 全员可写）」
 *
 * 为什么要两个文件：
 *   · **权威版** `机主画像.md` —— 机主确认过的偏好/风格/红线。改它要机主点头，否则画像会被 AI 越写越歪。
 *   · **参考版** `机主画像参考.md` —— 各场景观察到的东西先写这里，等机主确认才并进权威版。
 *   ⛔ 一个文件做不到这件事：谁都能改 = 没人负责；谁都改不了 = 观察无处沉淀。
 *
 * 判据（唯一出处 = 本文件）：
 *   ① 权威版存在，且**头部有 `> 依据：` 行**（说明每条都是机主说的，不是 AI 猜的）
 *   ② 权威版每条**必须带日期或出处**（`（2026-11-19 · 原话/确认）`），⛔ 无出处 = 编的
 *   ③ 权威版 ≤ 8 KB（画像要能一屏读完，不是自传）
 *   ④ **禁区不许出现**：健康 / 家庭 / 财务 / 证件 / 宗教（《六-场景即人的一面》四条硬边界）
 *   ⑤ **不许从语气推原因**：出现「因为他/她觉得…」这类推断 ⇒ ⚠
 *
 * 用法：
 *   node 工具\画像体检.mjs            # 检查
 *   node 工具\画像体检.mjs --quiet    # 一行
 *   node 工具\画像体检.mjs --init     # 建两个空骨架（只在没有时建）
 *   node 工具\画像体检.mjs --selftest # 反例：缺出处 / 超线 / 碰禁区 / 推断原因 必须能报
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
const AUTH = path.join(SHARED, '机主画像.md');          // 权威（只机主点头才改）
const REF = path.join(SHARED, '机主画像参考.md');        // 参考（各场景可写）

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MAX_KB = 8;

/** 禁区（《六-场景即人的一面》四条硬边界 + 证件） */
const FORBIDDEN = [
  // ⚠ 只列「健康」不够：实测「有高血压」不含"健康"二字 ⇒ 必须把常见病症形态也覆盖
  { re: /健康|病史|病历|体检结果|疾病|病症|用药|吃药|过敏|血压|血糖|手术|住院|失眠|抑郁|焦虑|体重|减肥|怀孕/i, what: '健康' },
  { re: /家庭|老婆|丈夫|妻子|孩子|儿子|女儿|父母|父亲|母亲|亲戚|婚姻|离婚|未婚/i, what: '家庭' },
  { re: /收入|工资|存款|财务|资产|贷款|负债|股票盈亏|账户余额|月薪|年薪|房价/i, what: '财务' },
  { re: /身份证|护照号|银行卡|社保号|证件号|卡号/i, what: '证件' },
  { re: /宗教信仰|信佛|信教|教会|寺庙|祷告/i, what: '宗教' },
];

/** 从语气推原因（禁止） */
const INFERRING = /因为他(?:觉得|认为|怕)|因为机主(?:觉得|认为|怕)|他之所以.*是因为|推测他|应该是他不想/;

/** 纯函数：判一段画像正文 */
export function check(text) {
  const bad = [], warn = [], ok = [];
  const bytes = Buffer.byteLength(text);

  /**
   * ⚠ 先剥掉「引用禁区清单」的那几行：说明性文字（"健康/家庭/财务…一律不记"）本身会命中禁区正则。
   *   不剥 ⇒ 骨架文件自己抽自己（实测：--init 生成的骨架立刻 3 个 ⛔）。
   *   判据：**禁区要用在"记某人的事"上才算违规**，写在"规则说明"里不算。
   */
  const bodyOnly = text
    .split(/\r?\n/)
    .filter((l) => !/禁区|不记|硬边界|一律不|不许记/.test(l))
    .join('\n');

  if (!/>\s*依据[：:]/.test(text)) bad.push('头部缺「> 依据：」行（必须写明每条都来自机主，不是 AI 猜的）');
  else ok.push('有依据声明');

  // 每条 bullet 必须带日期或出处
  const bullets = text.split(/\r?\n/).filter((l) => /^\s*[-*]\s+\S/.test(l));
  const noDate = bullets.filter((l) => !/\d{4}-\d{2}-\d{2}|\d{2}-\d{2}|原话|确认|他说|他说过/.test(l));
  if (bullets.length === 0) warn.push('画像里还没有条目（正常：等机主给）');
  else if (noDate.length) bad.push(`有 ${noDate.length} 条没日期/出处（⛔ 无出处 = 编的）：` + noDate[0].trim().slice(0, 60));
  else ok.push(bullets.length + ' 条都带出处');

  if (bytes > MAX_KB * 1024) bad.push(`${(bytes / 1024).toFixed(1)} KB 超 ${MAX_KB} KB（画像要一屏读完，不是自传）`);
  else ok.push((bytes / 1024).toFixed(1) + ' KB');

  for (const f of FORBIDDEN) if (f.re.test(bodyOnly)) bad.push('碰到禁区「' + f.what + '」（四条硬边界：健康/家庭/财务/证件/宗教 不记）');
  if (!FORBIDDEN.some((f) => f.re.test(bodyOnly))) ok.push('未触禁区');

  if (INFERRING.test(bodyOnly)) warn.push('出现「从语气推原因」的写法（只能记"他这样说"，不能记"他为什么这样说"）');

  return { bad, warn, ok, bullets: bullets.length };
}

function init() {
  fs.mkdirSync(SHARED, { recursive: true });
  const made = [];
  if (!fs.existsSync(AUTH)) {
    fs.writeFileSync(AUTH, [
      '# 机主画像（权威）',
      '',
      '> 依据：**只有 Xiodra 亲口说的 / 明确同意过的**才能进这里。⛔ AI 不许自己加。',
      '> 谁能改：⛔ 只有 Xiodra 本人拍板后改（AI 只能提请求）。观察到的东西先写 `机主画像参考.md`。',
      '> 禁区：健康 / 家庭 / 财务 / 证件 / 宗教 —— 一律不记（四条硬边界）。',
      '> 体积：≤ 8 KB（要能一屏读完）。',
      '',
      '## 一、称呼与语言',
      '',
      '（等 Xiodra 给）',
      '',
      '## 二、偏好与风格',
      '',
      '（等 Xiodra 给）',
      '',
      '## 三、红线（⛔ 绝对不要做的事）',
      '',
      '（等 Xiodra 给）',
      '',
      '## 四、交付口味（要多长、先给结论还是过程）',
      '',
      '（等 Xiodra 给）',
      '',
    ].join('\n'), 'utf8');
    made.push(AUTH);
  }
  if (!fs.existsSync(REF)) {
    fs.writeFileSync(REF, [
      '# 机主画像 · 参考（各场景可写）',
      '',
      '> 用途：各场景观察到的偏好先写这里，**等 Xiodra 确认后才并进 `机主画像.md`**（权威）。',
      '> 规则：⛔ 只记「他这样说过/这样要求过」+ 日期 + 场景；⛔ 不从语气推原因；⛔ 碰禁区的一律不记。',
      '',
      '| 日期 | 场景 | 观察到的（原话/要求） | 是否已并进权威版 |',
      '|---|---|---|---|',
      '| ', '',
    ].join('\n'), 'utf8');
    made.push(REF);
  }
  console.log(made.length ? '✓ 已建：\n  ' + made.map((f) => path.relative(ROOT, f)).join('\n  ') : '· 两个文件都已存在，没动');
}

function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });
  const good = (body) => ['# 机主画像（权威）', '', '> 依据：只有 Xiodra 亲口说的才算。', '', body, ''].join('\n');

  // ① 缺依据声明
  {
    const r = check('# 画像\n\n- 喜欢简短（2026-11-19 原话）\n');
    add(r.bad.some((b) => b.includes('依据')), '反例① 缺「> 依据：」声明 ⇒ ⛔', r.bad.join(' | '));
  }
  // ② 条目没出处
  {
    const r = check(good('- 喜欢简短\n'));
    add(r.bad.some((b) => b.includes('没日期')), '反例② 条目没日期/出处 ⇒ ⛔（无出处=编的）', r.bad.join(' | '));
  }
  // ③ 超 8 KB
  {
    const r = check(good('- 喜欢简短（2026-11-19 原话）\n' + 'x'.repeat(9000)));
    add(r.bad.some((b) => b.includes('超 8 KB')), '反例③ 超 8 KB ⇒ ⛔', r.bad.join(' | '));
  }
  // ④ 碰禁区
  {
    const r = check(good('- 有高血压（2026-11-19 原话）\n'));
    add(r.bad.some((b) => b.includes('禁区')), '反例④ 写健康 ⇒ ⛔ 触禁区', r.bad.join(' | '));
  }
  {
    const r = check(good('- 月收入两万（2026-11-19 原话）\n'));
    add(r.bad.some((b) => b.includes('禁区')), '反例④b 写财务 ⇒ ⛔ 触禁区', r.bad.join(' | '));
  }
  // ⑤ 从语气推原因 ⇒ ⚠ 不阻断
  {
    const r = check(good('- 他要结论是因为他觉得过程没用（2026-11-19）\n'));
    add(r.warn.some((w) => w.includes('推原因')), '反例⑤ 从语气推原因 ⇒ ⚠ 告警', r.warn.join(' | '));
  }
  // ⑥ 正例
  {
    const r = check(good('- 要结论先给，过程在后（2026-11-19 原话）\n- 不用「老板」称呼（2026-11-19 确认）\n'));
    add(r.bad.length === 0, '正例 有依据 + 带出处 + 未触禁区 ⇒ 通过', r.bad.join(' | '));
  }

  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();

if (isMain) {
  if (has('--selftest')) process.exit(selftest());
  if (has('--help') || has('-h')) {
    console.log([
      '画像体检.mjs —— 机主画像的纪律',
      '  node 工具\\画像体检.mjs           检查',
      '  node 工具\\画像体检.mjs --quiet   一行',
      '  node 工具\\画像体检.mjs --init    建空骨架',
      '  node 工具\\画像体检.mjs --selftest 反例自证',
      '权威：' + path.relative(ROOT, AUTH) + '（只 Xiodra 点头才改）',
      '参考：' + path.relative(ROOT, REF) + '（各场景可写）',
    ].join('\n'));
    process.exit(0);
  }
  if (has('--init')) { init(); process.exit(0); }

  const bad = [], warn = [], ok = [];
  if (!fs.existsSync(AUTH)) bad.push('缺权威版「机主画像.md」（跑 --init）');
  else {
    const r = check(fs.readFileSync(AUTH, 'utf8'));
    bad.push(...r.bad); warn.push(...r.warn); ok.push(...r.ok);
  }
  if (!fs.existsSync(REF)) warn.push('缺参考版「机主画像参考.md」（各场景的观察无处沉淀）');
  else ok.push('参考版在');

  if (has('--quiet')) {
    console.log(bad.length ? `⛔ 画像体检：${bad.length} 个问题（跑 node 工具\\画像体检.mjs 看明细）` : `✓ 画像体检：纪律正常${warn.length ? '（⚠ ' + warn.length + '）' : ''}`);
    process.exit(bad.length ? 1 : 0);
  }
  console.log('画像体检 —— 机主画像的纪律\n');
  for (const s of ok) console.log('  ✓ ' + s);
  for (const w of warn) console.log('  ⚠ ' + w);
  for (const b of bad) console.log('  ⛔ ' + b);
  console.log('\n' + (bad.length ? '⛔ ' + bad.length + ' 个问题' : '✓ 全部通过'));
  process.exit(bad.length ? 1 : 0);
}
