#!/usr/bin/env node
/**
 * 交接.mjs —— 换会话交接 + 新会话接续（M2 / M3）
 *
 * Xiodra 的设计原文：
 *   【M2 换会话交接】上下文将满时立即执行：
 *     ① 核心写回私有技能/定位卡/项目信息（**过滤垃圾与过时文件**）
 *     ② 生成"当前交接"（任务进度 / 未完成事项 / 关键决策 / 下一步 / 文件路径）
 *     ③ 非核心细节归档标记为"**原始层**"并注明可再提炼关键词
 *     ④ 输出**交接摘要 ≤200 字**
 *   【M3 新会话接续】换会话后第一句：
 *     读"当前交接" → 先复述：你是谁（定位卡）/ 职责 / 当前进度 / 下一步 → 确认无误直接继续，
 *     **不重复询问已完成事项**
 *
 * ⛔ 为什么需要机械抓手：交接靠"AI 记得做" ⇒ 忙起来最先丢的就是它。
 *   上下文满了才想起来交接，往往已经写不全。
 *
 * 用法：
 *   node 工具\交接.mjs --场景 DSH·GUI            # 生成交接摘要（写进 §〇 的「0) 交接摘要」）
 *   node 工具\交接.mjs --场景 DSH·GUI --dry      # 只看会写什么
 *   node 工具\交接.mjs --场景 DSH·GUI --接续     # M3：打印"我是谁/职责/进度/下一步"复述稿
 *   node 工具\交接.mjs --check [--quiet]         # 体检：摘要存在？≤200 字？原始层有标记？
 *   node 工具\交接.mjs --selftest                # 反例：超 200 字 / 缺原始层 / 摘要过期
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SCEN = path.join(ROOT, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const MAX_CHARS = 200;

/** 场景清单 */
function scenes() {
  const out = [];
  if (!fs.existsSync(SCEN)) return out;
  for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    /**
     * ⚠ 2026-11-21 修：跳过 `tmp-` / `TMP` / `zz-` 开头的**验收用临时场景**。
     *   实测：GUI改造 建了 `TMPM9` 验 M9 光点，它当然没有私有记忆/交接摘要
     *   ⇒ `交接` 体检报「TMPM9：没有私有记忆」⇒ 机制体检假红。
     *   **临时场景缺记忆是预期行为，不是故障**（和 `场景体检.mjs` 的 tmp- 规则同源）。
     */
    if (/^(tmp-|tmp|zz-)/i.test(f)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (j && j.id) out.push({ id: j.id, name: j.name || j.id, skill: j.skill || '', panels: j.panels || [] });
  }
  return out;
}

function resolveScene(nameOrId) {
  return scenes().find((s) => s.name === nameOrId || s.id === nameOrId) || null;
}

/** 读私有记忆的分段 */
export function parseMem(text) {
  const get = (head) => {
    const i = text.indexOf(head);
    if (i < 0) return '';
    const j = text.indexOf('\n## ', i + head.length);
    return text.slice(i + head.length, j < 0 ? text.length : j).trim();
  };
  return {
    sec0: get('## §〇 当前交接'),
    core: get('## 核心职责'),
    hasSec0: /##\s*§〇/.test(text),
    hasCore: /##\s*核心职责/.test(text),
  };
}

/** 抽「交接摘要」块：`### 0) 交接摘要` 之后到下一个 ### */
export function extractSummary(text) {
  const m = text.match(/###\s*0\)\s*交接摘要[^\n]*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/);
  return m ? m[1].trim() : '';
}

/** 从 §〇 四小节里抽关键信息，拼成 ≤200 字摘要 */
export function buildSummary(sec0, core) {
  const pick = (head) => {
    const re = new RegExp('###\\s*' + head + '[^\\n]*\\n([\\s\\S]*?)(?=\\n###\\s|$)');
    const m = sec0.match(re);
    return m ? m[1].trim() : '';
  };
  /**
   * ⚠ 清洗（2026-11-21 修）：第一版摘要里出现
   *   「职责：（≤10 行，只留每天上班必须知道的事） - 职责：…」和「下一步：下一步：…」
   *   —— 因为把**小节标题里的括号注**当内容，且内容本身又以「下一步：」开头。
   *   规则：
   *     ① 丢掉纯说明性行（含「≤10 行」「只留」「别手改」「待补」这类元信息）
   *     ② 去掉行首的 `- ` / `* ` 与已有的「下一步：」「职责：」前缀，避免重复
   *     ③ 压掉多余空白与重复标点
   */
  const clean = (s) => String(s || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*\s]+/, '').trim())
    .filter((l) => l && !/≤\s*10\s*行|只留每天|别手改|（待补）|待补|^（略）$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^(职责|下一步|进度)[：:]\s*/g, '')
    .replace(/[；;]\s*$/, '')
    .trim();

  /**
   * 按**完整句**取，不按字数硬切 —— 硬切会留下"地盘：`引擎数据\." 这种半句。
   * 判据：摘要要能被人**读懂**，不是"字数刚好 200"。
   */
  const takeSentences = (s, max) => {
    const out = [];
    let len = 0;
    for (const seg of String(s || '').split(/(?<=[。！？；;])/)) {
      const x = seg.trim();
      if (!x) continue;
      if (len + [...x].length > max) break;
      out.push(x);
      len += [...x].length;
    }
    if (!out.length && s) {
      // 一句都放不下 ⇒ 截断但那一段要加省略号，让人知道被截了
      const t = [...String(s)].slice(0, max - 1).join('');
      return t + '…';
    }
    return out.join('');
  };

  const dutyFull = clean(core);
  const progressFull = clean(pick('1\\)\\s*上次交接'));
  const nextFull = clean(pick('4\\)\\s*下一步'));

  // 预算：职责 ≤50 字，进度 ≤85 字，下一步 ≤55 字（合计留余量给三个标签）
  const duty = takeSentences(dutyFull, 50);
  const progress = takeSentences(progressFull, 85);
  const next = takeSentences(nextFull, 55);

  const parts = [];
  if (duty) parts.push('职责：' + duty.replace(/[。；]$/, ''));
  if (progress) parts.push('进度：' + progress.replace(/[。；]$/, ''));
  if (next) parts.push('下一步：' + next.replace(/[。；]$/, ''));

  let s = parts.join('；');
  if ([...s].length > MAX_CHARS) s = [...s].slice(0, MAX_CHARS - 1).join('') + '…';
  return s;
}

/** 体检 */
export function check() {
  const bad = [], warn = [], ok = [];
  for (const sc of scenes()) {
    const f = path.join(MEM, sc.name, '场景私有记忆.md');
    if (!fs.existsSync(f)) { bad.push(sc.name + '：没有私有记忆'); continue; }
    const t = fs.readFileSync(f, 'utf8');
    const p = parseMem(t);

    if (!p.hasCore) bad.push(sc.name + '：缺「## 核心职责」块');

    const sum = extractSummary(t);
    if (!sum) bad.push(sc.name + '：缺「### 0) 交接摘要」（换会话时新 AI 没东西可复述）');
    else {
      const n = [...sum].length;
      if (n > MAX_CHARS) bad.push(sc.name + '：交接摘要 ' + n + ' 字超 ' + MAX_CHARS + ' 字');
      else ok.push(sc.name + '：交接摘要 ' + n + ' 字');
    }

    // 原始层：有归档目录就该有说明
    const rawDir = path.join(MEM, sc.name, '原始层');
    if (fs.existsSync(rawDir)) {
      const files = fs.readdirSync(rawDir);
      const idx = path.join(rawDir, '_索引.md');
      if (files.length && !fs.existsSync(idx)) warn.push(sc.name + '：原始层有 ' + files.length + ' 份但没 `_索引.md`（无从检索）');
      else if (fs.existsSync(idx)) ok.push(sc.name + '：原始层有索引');
    }
  }
  return { bad, warn, ok };
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  const mkSec0 = (progress, next) => [
    '### 1) 上次交接',
    progress,
    '### 2) 当前项目',
    '（略）',
    '### 3) 私有记忆变更',
    '（略）',
    '### 4) 下一步 / 卡点',
    next,
  ].join('\n');

  // ① 正常生成 ≤200 字
  {
    const s = buildSummary(mkSec0('- 正在压私有记忆到 ≤10 行', '- 建技能索引表'), '- 职责：机制建设');
    add([...s].length <= MAX_CHARS && s.includes('职责'), '正例 摘要 ≤200 字且含职责', [...s].length + ' 字');
  }
  // ② 超长必须被截断到 200
  {
    const long = '- ' + '很长的进度'.repeat(60);
    const s = buildSummary(mkSec0(long, long), long);
    add([...s].length <= MAX_CHARS, '反例① 超长输入必须截到 ≤200 字', [...s].length + ' 字');
  }
  // ③ 抽不到摘要 ⇒ 空（体检必须报）
  {
    add(extractSummary('## §〇 当前交接\n\n### 1) 上次交接\n（略）') === '', '反例② 没有「0) 交接摘要」⇒ 抽出空（体检要报）', '');
  }
  // ④ 能抽出摘要
  {
    const t = '### 0) 交接摘要（≤200字）\n职责：X；进度：Y\n### 1) 上次交接\n（略）';
    add(extractSummary(t) === '职责：X；进度：Y', '正例 能抽出交接摘要', JSON.stringify(extractSummary(t)));
  }
  // ⑤ 摘要在 §〇 之外也算（防止误判）
  {
    const t = '## 核心职责\n- x\n### 0) 交接摘要\n在核心职责里的摘要\n';
    add(extractSummary(t).includes('核心职责里的摘要'), '反例③ 摘要写在别处也要能抽到（不依赖位置）', '');
  }
  // ⑥ 缺核心职责要能被 check 抓到（用假场景验证逻辑）
  {
    const p = parseMem('## §〇 当前交接\n### 1) 上次交接\nx\n');
    add(!p.hasCore, '反例④ 缺「## 核心职责」⇒ parseMem 报 hasCore=false', '');
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
      '交接.mjs —— 换会话交接（M2）+ 新会话接续（M3）',
      '  node 工具\\交接.mjs --场景 <名>          生成交接摘要（写进 §〇 的「0) 交接摘要」）',
      '  node 工具\\交接.mjs --场景 <名> --dry    只看会写什么',
      '  node 工具\\交接.mjs --场景 <名> --接续   M3：打印"我是谁/职责/进度/下一步"复述稿',
      '  node 工具\\交接.mjs --check [--quiet]    体检',
      '  node 工具\\交接.mjs --selftest',
      '⛔ 摘要 ≤200 字；核心只留 ≤10 行；其余进「原始层」。',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--check')) {
    const r = check();
    if (has('--quiet')) {
      console.log(r.bad.length ? `⛔ 交接体检：${r.bad.length} 个问题` : `✓ 交接体检：摘要齐备${r.warn.length ? '（⚠ ' + r.warn.length + '）' : ''}`);
      process.exit(r.bad.length ? 1 : 0);
    }
    for (const s of r.ok) console.log('  ✓ ' + s);
    for (const w of r.warn) console.log('  ⚠ ' + w);
    for (const b of r.bad) console.log('  ⛔ ' + b);
    console.log('\n' + (r.bad.length ? '⛔ ' + r.bad.length + ' 个问题' : '✓ 全部通过'));
    process.exit(r.bad.length ? 1 : 0);
  }

  const sceneName = val('--场景');
  if (!sceneName) { console.error('用法：--场景 <场景名> [--dry|--接续]'); process.exit(2); }
  const sc = resolveScene(sceneName);
  if (!sc) { console.error('✗ 找不到场景「' + sceneName + '」'); process.exit(2); }

  const f = path.join(MEM, sc.name, '场景私有记忆.md');
  if (!fs.existsSync(f)) { console.error('✗ 没有记忆文件：' + f); process.exit(2); }
  const text = fs.readFileSync(f, 'utf8');
  const p = parseMem(text);

  // M3 接续稿
  if (has('--接续')) {
    const sum = extractSummary(text);
    console.log('【M3 新会话接续 · ' + sc.name + '】\n');
    console.log('我是：' + sc.name + '（' + sc.id + '）');
    console.log('职责：' + (p.core.split(/\r?\n/).filter((l) => l.trim()).slice(0, 2).map((l) => l.replace(/^[-*\s]+/, '')).join(' ') || '（核心职责未写）'));
    console.log('当前进度与下一步：' + (sum || '（还没生成交接摘要，先跑 --场景 ' + sc.name + '）'));
    console.log('\n⛔ 不重复询问已完成事项；确认无误直接继续。');
    process.exit(0);
  }

  // M2 生成摘要
  const summary = buildSummary(p.sec0, p.core);
  if (!summary) { console.error('✗ §〇 里没有可提取的内容（先补 §〇 四小节）'); process.exit(2); }

  const block = '### 0) 交接摘要（≤200字，换会话时新 AI 读这一段）\n' + summary + '\n\n';
  let out;
  if (/###\s*0\)\s*交接摘要/.test(text)) {
    out = text.replace(/###\s*0\)\s*交接摘要[^\n]*\n[\s\S]*?(?=\n###\s|\n##\s|$)/, block.trimEnd());
  } else {
    // 插在 §〇 标题之后
    out = text.replace(/(##\s*§〇 当前交接[^\n]*\n\n?)/, '$1' + block);
    if (out === text) {
      // 没有 §〇 头就插在文件开头说明之后
      out = text.replace(/^(#[^\n]*\n(?:\n> [^\n]*\n)*\n?)/, '$1' + '## §〇 当前交接\n\n' + block);
    }
  }

  if (has('--dry')) {
    console.log('--dry：会写进 ' + path.relative(ROOT, f));
    console.log('  摘要（' + [...summary].length + ' 字）：\n  ' + summary);
    process.exit(0);
  }

  if (out !== text) {
    fs.writeFileSync(f, out, 'utf8');
    console.log('✓ ' + sc.name + '：交接摘要已写入（' + [...summary].length + ' 字）');
  } else {
    console.log('· ' + sc.name + '：摘要已是最新（' + [...summary].length + ' 字）');
  }
  console.log('  内容：' + summary);
}
