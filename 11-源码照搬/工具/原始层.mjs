#!/usr/bin/env node
/**
 * 原始层.mjs —— 垃圾沉淀区（M2 ③）：非核心细节归档到这里，并注「可再提炼关键词」
 *
 * Xiodra 的设计原文：
 *   【M2 ③】非核心细节归档标记为「**原始层**」并注明**可再提炼关键词**。
 *   【铁律①】私有记忆 ≤10 行，只留"每天上班必须知道的事"。
 *
 * ⛔ 为什么必须有这个工具：
 *   私有记忆要压到 ≤10 行，就必然有大量内容要外置。
 *   如果只是"删掉"或"搬进一个目录不管"⇒ **等于埋掉**，下次想查只能整篇翻。
 *   ⇒ 原始层 = 存档 + **索引**（每份写清"这是什么"+"可再提炼关键词"），
 *     查询方式是 **grep 关键词**，⛔ 不是通读。
 *
 * 用法：
 *   node 工具\原始层.mjs                     # 重建所有场景的原始层索引
 *   node 工具\原始层.mjs --场景 DSH·GUI       # 只重建一个
 *   node 工具\原始层.mjs --查 "关键词"        # 在原始层里 grep（给"我要找那件事"用）
 *   node 工具\原始层.mjs --check [--quiet]   # 体检：有文件无索引 / 索引有死条目
 *   node 工具\原始层.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const IDX = '_索引.md';

export function sceneDirs() {
  if (!fs.existsSync(MEM)) return [];
  return fs.readdirSync(MEM).filter((n) => !n.startsWith('_') && fs.statSync(path.join(MEM, n)).isDirectory());
}

/** 从一份原始层文件里抽「这是什么」与「可再提炼关键词」 */
export function describe(file) {
  const t = fs.readFileSync(file, 'utf8');
  const title = (t.match(/^#\s+(.+)$/m) || [])[1] || path.basename(file, '.md');

  /**
   * ⚠ 2026-11-21 修（自我复盘 报「索引缺 embed/假绿/C1」）：
   *   原来 `slice(0, 8)` 硬截前 8 个，**而且是按插入顺序**（反引号出现的先后）
   *   ⇒ 前面反复出现的通用词把真正重要的词挤掉了，人看索引会误以为"这块地没记那件事"。
   *   （`--查` 是全文 grep，不受影响 —— 但"索引看起来没有"本身就是误导。）
   *
   *   改成：**按出现频次排序**取前 12 个。频次高的通常才是这份文档的主题。
   */
  const freq = new Map();
  const bump = (w) => { if (w && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) || 0) + 1); };
  for (const m of t.matchAll(/`([^`\n]{2,40})`/g)) {
    bump(m[1].replace(/[\\/]/g, '/').split('/').filter(Boolean).pop());
  }
  // 标题里的实词也算（标题通常最能代表主题）
  for (const m of title.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,20}|[\u4e00-\u9fff]{2,8}/g)) bump(m[0]);

  const kw = [...freq.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))   // 频次降序，同频按字典序稳妥
    .slice(0, 12)                                                // 12 个（原为 8）
    .map((x) => x[0])
    .join(' / ');

  return { title: title.slice(0, 46), kw: kw || '（无显式关键词）' };
}

/** 重建一个场景的原始层索引 */
export function rebuild(name) {
  const rawDir = path.join(MEM, name, '原始层');
  if (!fs.existsSync(rawDir)) return { name, count: 0, skipped: true };

  const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.md') && f !== IDX).sort();
  const rows = files.map((f) => {
    const p = path.join(rawDir, f);
    const d = describe(p);
    return { f, kb: (fs.statSync(p).size / 1024).toFixed(1), ...d };
  });

  const idx = [
    '# 原始层索引（垃圾沉淀区 —— 可再提炼）',
    '',
    '> 这里放**不是"每天上班必须知道"**的东西：完整经过、旧版全文、一次性排查记录。',
    '> ⛔ **不当记忆读**：要查某件事时用「可再提炼关键词」去 grep，**别整篇读**。',
    '> 判据：私有记忆 ≤10 行装不下的，全进这里 —— **不是删掉**。',
    '',
    '| 文件 | 体积 | 这是什么 | 可再提炼关键词 |',
    '|---|---|---|---|',
    ...rows.map((r) => '| `' + r.f + '` | ' + r.kb + ' KB | ' + r.title + ' | ' + r.kw + ' |'),
    '',
    '> 重生成本索引：`node 工具\\原始层.mjs`　查东西：`node 工具\\原始层.mjs --查 "关键词"`',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(rawDir, IDX), idx, 'utf8');
  return { name, count: rows.length, bytes: Buffer.byteLength(idx) };
}

/** 体检 */
export function check() {
  const bad = [], warn = [], ok = [];
  for (const name of sceneDirs()) {
    const rawDir = path.join(MEM, name, '原始层');
    if (!fs.existsSync(rawDir)) continue;
    const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.md') && f !== IDX);

    const idxPath = path.join(rawDir, IDX);
    /**
     * ⚠ 顺序很重要（2026-11-21 修）：原来先 `if (!files.length) continue` 再查死条目，
     *   导致「文件全删了、索引还留着」这种最典型的死条目**永远查不到**。
     *   判据：**先查死条目，再判断要不要继续**。
     */
    if (fs.existsSync(idxPath)) {
      const idx0 = fs.readFileSync(idxPath, 'utf8');
      const listed0 = [...idx0.matchAll(/^\|\s*`([^`]+\.md)`\s*\|/gm)].map((m) => m[1]);
      for (const f of listed0) if (!files.includes(f)) bad.push(name + '：索引里有死条目 `' + f + '`（文件已删）');
    }

    if (!files.length) continue;
    if (!fs.existsSync(idxPath)) { bad.push(name + '：原始层有 ' + files.length + ' 份但没 `_索引.md`（归档等于埋掉）'); continue; }

    const idx = fs.readFileSync(idxPath, 'utf8');
    for (const f of files) if (!idx.includes('`' + f + '`')) bad.push(name + '：原始层文件 `' + f + '` 没进索引');

    if (!bad.some((b) => b.startsWith(name))) ok.push(name + '：原始层索引一致（' + files.length + ' 份）');
  }
  return { bad, warn, ok };
}

/** grep 原始层 */
export function search(kw) {
  const hits = [];
  for (const name of sceneDirs()) {
    const rawDir = path.join(MEM, name, '原始层');
    if (!fs.existsSync(rawDir)) continue;
    for (const f of fs.readdirSync(rawDir)) {
      if (!f.endsWith('.md')) continue;
      const t = fs.readFileSync(path.join(rawDir, f), 'utf8');
      if (!t.includes(kw)) continue;
      const line = t.split(/\r?\n/).find((l) => l.includes(kw)) || '';
      hits.push({ scene: name, file: f, line: line.trim().slice(0, 110) });
    }
  }
  return hits;
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① describe 能抽出标题与关键词
  {
    const probe = path.join(ROOT, '_临时', 'selftest-原始层', 'x.md');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, '# 某次排查记录\n\n涉及 `外壳\\main.js` 与 `工具\\派单.mjs`。\n', 'utf8');
    const d = describe(probe);
    add(/某次排查/.test(d.title) && (d.kw.includes('main.js') || d.kw.includes('派单.mjs')), '正例 抽出标题与可再提炼关键词', JSON.stringify(d).slice(0, 90));
    fs.rmSync(path.join(ROOT, '_临时', 'selftest-原始层'), { recursive: true, force: true });
  }
  // ② 没关键词时不许空着（要写明）
  {
    const probe = path.join(ROOT, '_临时', 'selftest-原始层', 'y.md');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, '没有标题也没有反引号', 'utf8');
    const d = describe(probe);
    add(d.kw && d.kw.length > 0, '反例① 抽不到关键词也必须给占位说明（不许空着）', JSON.stringify(d.kw));
    fs.rmSync(path.join(ROOT, '_临时', 'selftest-原始层'), { recursive: true, force: true });
  }
  // ③ 有文件无索引 ⇒ 体检必须报
  {
    const name = 'zz原始层测试场景';
    const rawDir = path.join(MEM, name, '原始层');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'a.md'), '# a', 'utf8');
    const r = check();
    const hit = r.bad.some((b) => b.includes(name) && b.includes('没 `_索引.md`'));
    add(hit, '反例② 原始层有文件但没索引 ⇒ 体检报 ⛔（归档等于埋掉）', r.bad.filter((b) => b.includes(name)).join(' | '));
    // ④ 建索引后回绿
    rebuild(name);
    const r2 = check();
    const green = !r2.bad.some((b) => b.includes(name));
    add(green, '反例③ 建索引后该场景回绿', '');
    fs.rmSync(path.join(MEM, name), { recursive: true, force: true });
  }
  // ⑤ 索引里的死条目要报
  {
    const name = 'zz原始层死条目';
    const rawDir = path.join(MEM, name, '原始层');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'a.md'), '# a', 'utf8');
    rebuild(name);
    fs.rmSync(path.join(rawDir, 'a.md'));
    const r = check();
    const hit = r.bad.some((b) => b.includes(name) && b.includes('死条目'));
    add(hit, '反例④ 索引里的死条目（文件已删）⇒ 体检报 ⛔', r.bad.filter((b) => b.includes(name)).join(' | '));
    fs.rmSync(path.join(MEM, name), { recursive: true, force: true });
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
      '原始层.mjs —— 垃圾沉淀区（M2 ③）',
      '  node 工具\\原始层.mjs               重建所有场景的原始层索引',
      '  node 工具\\原始层.mjs --场景 <名>   只重建一个',
      '  node 工具\\原始层.mjs --查 "关键词"  grep 原始层找那件事',
      '  node 工具\\原始层.mjs --check        体检',
      '  node 工具\\原始层.mjs --selftest',
      '⛔ 原始层用于"能找回"，不是"读起来舒服"：查的时候 grep 关键词，别整篇读。',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--查')) {
    const kw = val('--查');
    if (!kw) { console.error('用法：--查 "关键词"'); process.exit(2); }
    const hits = search(kw);
    if (!hits.length) { console.log('（原始层里没有匹配「' + kw + '」的内容）'); process.exit(0); }
    console.log('原始层匹配「' + kw + '」共 ' + hits.length + ' 处：\n');
    for (const h of hits) console.log('  [' + h.scene + '\\原始层\\' + h.file + ']\n    ' + h.line);
    process.exit(0);
  }

  if (has('--check')) {
    const r = check();
    if (has('--quiet')) {
      console.log(r.bad.length ? `⛔ 原始层：${r.bad.length} 个问题` : `✓ 原始层：索引一致${r.warn.length ? '（⚠ ' + r.warn.length + '）' : ''}`);
      process.exit(r.bad.length ? 1 : 0);
    }
    for (const s of r.ok) console.log('  ✓ ' + s);
    for (const w of r.warn) console.log('  ⚠ ' + w);
    for (const b of r.bad) console.log('  ⛔ ' + b);
    console.log('\n' + (r.bad.length ? '⛔ ' + r.bad.length + ' 个问题' : '✓ 全部通过'));
    process.exit(r.bad.length ? 1 : 0);
  }

  const one = val('--场景');
  const targets = one ? [one] : sceneDirs();
  let total = 0;
  for (const name of targets) {
    const r = rebuild(name);
    if (r.skipped) continue;
    total += r.count;
    console.log('  ✓ ' + name.padEnd(10) + '原始层索引：' + r.count + ' 份 · ' + (r.bytes / 1024).toFixed(1) + ' KB');
  }
  console.log('\n共 ' + total + ' 份原始层文件已建索引');
}
