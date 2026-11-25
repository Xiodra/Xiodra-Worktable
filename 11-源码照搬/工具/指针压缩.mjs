#!/usr/bin/env node
/**
 * 指针压缩.mjs —— 把 §五 里堆积的「→ 归档」指针收成一张紧凑索引
 *
 * ⛔ 治的坑（2026-11-21 实测）：`自动归档.mjs` 的 `isPointer()` 把指针排除在搬移之外
 *   —— 这是对的（指针不能再搬走，否则线索就断了）。但它有个副作用：
 *   **指针本身会无限累积**。DSH·GUI 主文件里堆了 **58 个指针**，每个 0.3 KB（标题+触发句+空行），
 *   合计 **18 KB**，把主文件顶到 26.3 KB（红线 25 KB），
 *   而 `自动归档` 报"可选小节 0 个"——因为剩下的全都是指针，它一个都不肯搬。
 *
 * 判据：**指针只需"能找回"，不需"读起来舒服"**。
 *   58 个「### 标题 / 空行 / 要查「X」时读 归档\Y」三行块 ⇒ 收成一张表：
 *   | 主题 | 去哪找 |
 *   一行一指针，体积降到约 1/3，且**信息一点不丢**（主题词 + 归档文件名都保留）。
 *
 * 用法：
 *   node 工具\指针压缩.mjs --场景 DSH·GUI            # dry-run：看能省多少
 *   node 工具\指针压缩.mjs --场景 DSH·GUI --go       # 真压缩（先备份）
 *   node 工具\指针压缩.mjs --selftest                # 反例：正文小节不许被收进表
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

const isPointerTitle = (l) => /^###\s/.test(l) && /→\s*`?归档[/\\]/.test(l);

/** 从指针标题里抽出「主题」与「归档文件」 */
export function parsePointer(title) {
  const t = title.replace(/^###\s*/, '').trim();
  // 归档文件名：→ `归档\xxx.md` / → `归档/x.md` / （→ `归档\x.md`）
  const m = t.match(/归档[/\\]([^`）)]+\.md)/);
  const file = m ? m[1] : '';
  let topic = t
    .replace(/→\s*`?归档[/\\][^`）)]*`?）?/g, '')
    .replace(/[（(]\s*$/g, '')
    .trim()
    .replace(/[→\s·]+$/, '')
    .trim();
  return { topic: topic || t, file };
}

/** 分析：把指针小节 vs 正文小节分开 */
export function analyze(text) {
  const lines = text.split(/\r?\n/);
  const ptrs = [], others = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isPointerTitle(lines[i])) continue;
    // 这一节的正文 = 标题后到下一个 ### 或 ## 之前
    let j = i + 1;
    while (j < lines.length && !/^###\s/.test(lines[j]) && !/^##\s/.test(lines[j])) j++;
    const body = lines.slice(i, j);
    ptrs.push({ title: lines[i], start: i, end: j, bytes: Buffer.byteLength(body.join('\n')), ...parsePointer(lines[i]) });
    i = j - 1;
  }
  return { ptrs, totalBytes: ptrs.reduce((a, p) => a + p.bytes, 0) };
}

/** 压缩：把指针小节替换成一张表（放在 §五 末尾，带一个明确标题） */
export function compress(text) {
  const { ptrs, totalBytes } = analyze(text);
  if (!ptrs.length) return { text, saved: 0, count: 0, worth: false };

  const lines = text.split(/\r?\n/);
  // 从后往前删，避免下标错位
  for (const p of ptrs.slice().sort((a, b) => b.start - a.start)) {
    lines.splice(p.start, p.end - p.start);
  }

  const table = [
    '### 归档索引（历史小节指针，按主题查）',
    '',
    '> 以下小节正文已搬进 `归档\\` 目录；要查某一项的经过与取证，按主题找对应文件。',
    '> ⛔ 这张表只增行、不删行（删了线索就断了）。',
    '',
    '| 主题 | 去哪找 |',
    '|---|---|',
    ...ptrs.map((p) => '| ' + p.topic.replace(/\|/g, '/') + ' | `归档\\' + p.file + '` |'),
    '',
  ].join('\n');

  let out = lines.join('\n').replace(/\s*$/, '\n');
  out += '\n' + table;
  const saved = totalBytes - Buffer.byteLength(table);

  /**
   * ⚠ 判据：**只有真省才压缩，且不能越压越大**。
   *   实测：3 个指针时表格头（标题+说明+表头）比省下的正文还长 ⇒ saved = **-119**（越压越大）。
   *   ⇒ 设阈值：省不下来就不动。否则"优化"会变成"越改越胖"。
   *   阈值取 256 B（不是 512）：目的只是"别做亏本买卖"，不必要求省很多。
   *   —— 真文件 58 条指针省 2725 B，远高于阈值；短指针 40 条省 489 B 也够。
   */
  const worth = saved > 256;
  if (!worth) return { text, saved, count: ptrs.length, worth };

  return { text: out, saved, count: ptrs.length, worth };
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① parsePointer 能抽出主题与文件
  {
    const p = parsePointer('### 2026-11-19 · 某次修改 → `归档\\§五-自动归档-20261119.md`');
    add(p.file === '§五-自动归档-20261119.md' && /某次修改/.test(p.topic), '正例 解析出主题与归档文件', JSON.stringify(p));
  }
  // ② 正文小节不许被当成指针
  {
    const t = ['### 2026-11-19 · 真的正文', '', '这里有很长的内容，没有归档指针。', ''].join('\n');
    const r = analyze(t);
    add(r.ptrs.length === 0, '反例① 正文小节（没有 → 归档）**不许**被收进表', 'ptrs=' + r.ptrs.length);
  }
  // ③ 指针小节必须被识别
  {
    const t = ['### 2026-11-19 · 某事 → `归档\\x.md`', '', '要查「某事」时读 `归档\\x.md`。', ''].join('\n');
    const r = analyze(t);
    add(r.ptrs.length === 1, '正例 指针小节被识别', 'ptrs=' + r.ptrs.length);
  }
  // ④ 压缩后体积必须变小，且归档文件名一个都不能丢（用 20 条，量够才值得压）
  {
    const N = 20;
    const many = [];
    for (let i = 0; i < N; i++) {
      many.push('### 2026-11-19 · 第' + i + '件事 → `归档\\f' + i + '.md`', '', '要查「第' + i + '件事」时读 `归档\\f' + i + '.md`。', '');
    }
    const body = ['## 五、决策与坑', ''].join('\n') + many.join('\n');
    const r = compress(body);
    /**
     * ⚠ 这里原来写成 `many.every((_, i) => ...)` —— many 每轮 push 4 个元素，
     *   20 轮后是 **80 个**，`i` 取值范围 0..79 ⇒ 去查 f20.md…f79.md，当然不存在 ⇒ 恒假红。
     *   **又是"索引含义变了"，和 TASKS[1] / ITEMS[5] 同一类坑。**
     *   ⇒ 明确只查 0..N-1。
     */
    let filesKept = true;
    for (let i = 0; i < N; i++) if (!r.text.includes('f' + i + '.md')) filesKept = false;
    add(r.worth && r.saved > 0 && filesKept, '反例② 20 条指针压缩后体积必须变小，且**归档文件名一个不许丢**', 'saved=' + r.saved + ' kept=' + filesKept + ' worth=' + r.worth);
  }
  // ④b 指针太少时**不许动**（否则越压越大 —— 实测 3 条时 saved = -119）
  {
    const few = [];
    for (let i = 0; i < 2; i++) few.push('### 2026-11-19 · 第' + i + '件 → `归档\\g' + i + '.md`', '', '要查时读。', '');
    const body = ['## 五、决策与坑', ''].join('\n') + few.join('\n');
    const r = compress(body);
    add(!r.worth && r.text === body, '反例②b 指针太少（2 条）⇒ **不许动文件**（阈值 256 B，否则"优化"会越改越胖）', 'saved=' + r.saved + ' worth=' + r.worth);
  }
  // ⑤ 必须留"只增不删"的说明（用够多条，确保真的走到了压缩分支）
  {
    /**
     * ⚠ 条数要够：阈值是"至少省 512 B"，而这里每条指针说明只有"要查时读。"（很短）。
     *   20 条省不到 512 ⇒ worth=false ⇒ 返回原文 ⇒ 断言假红。
     *   ⇒ 用 40 条，留足余量。（真文件 58 条省 2725 B，远超阈值。）
     */
    const many = [];
    for (let i = 0; i < 40; i++) many.push('### 2026-11-19 · 某事' + i + ' → `归档\\x' + i + '.md`', '', '要查时读。', '');
    const r = compress(['## 五、决策与坑', ''].join('\n') + many.join('\n'));
    add(r.worth && /只增行、不删行/.test(r.text), '反例③ 压缩后必须写明「只增不删」（防后人删行断线索）', 'worth=' + r.worth + ' saved=' + r.saved);
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
      '指针压缩.mjs —— 把堆积的「→ 归档」指针收成一张表',
      '  node 工具\\指针压缩.mjs --场景 DSH·GUI         看能省多少（dry-run）',
      '  node 工具\\指针压缩.mjs --场景 DSH·GUI --go    真压缩（先备份）',
      '  node 工具\\指针压缩.mjs --selftest',
      '⛔ 只收"正文已归档"的指针小节；正文小节一律不动；归档文件名一个不丢。',
    ].join('\n'));
    process.exit(0);
  }

  const scene = val('--场景');
  if (!scene) { console.error('用法：--场景 <场景名> [--go]'); process.exit(2); }
  const file = path.join(MEM, scene, '场景私有记忆.md');
  if (!fs.existsSync(file)) { console.error('✗ 找不到 ' + file); process.exit(2); }

  const text = fs.readFileSync(file, 'utf8');
  const before = Buffer.byteLength(text);
  const { ptrs, totalBytes } = analyze(text);

  if (!ptrs.length) { console.log('✓ 没有可压缩的指针小节（' + (before / 1024).toFixed(1) + ' KB）'); process.exit(0); }

  const r = compress(text);
  const after = Buffer.byteLength(r.text);
  console.log(scene + '：' + ptrs.length + ' 个指针小节，占 ' + (totalBytes / 1024).toFixed(1) + ' KB');
  console.log('  预计：' + (before / 1024).toFixed(1) + ' KB → ' + (after / 1024).toFixed(1) + ' KB（省 ' + ((before - after) / 1024).toFixed(1) + ' KB）');

  if (!has('--go')) { console.log('（dry-run，加 --go 才真改）'); process.exit(0); }

  // 备份到 归档\
  const archDir = path.join(MEM, scene, '归档');
  fs.mkdirSync(archDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const bak = path.join(archDir, '指针压缩前-' + stamp + '.md');
  fs.writeFileSync(bak, text, 'utf8');
  fs.writeFileSync(file, r.text, 'utf8');

  // 核对：归档文件名一个都没丢
  const lost = ptrs.filter((p) => p.file && !r.text.includes(p.file)).map((p) => p.file);
  console.log('  ' + (lost.length ? '⛔ 丢了 ' + lost.length + ' 个归档文件名' : '✓ 归档文件名一个没丢'));
  console.log('  备份：' + path.relative(ROOT, bak));
  console.log('  现在：' + (Buffer.byteLength(r.text) / 1024).toFixed(1) + ' KB');
  process.exitCode = lost.length ? 1 : 0;
}
