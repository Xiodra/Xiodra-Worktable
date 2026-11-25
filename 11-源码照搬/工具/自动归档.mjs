#!/usr/bin/env node
/**
 * 自动归档.mjs —— 把"已经沉淀、不再天天查"的记忆正文自动搬进 `归档\`（照搬《13-公开情报》的「自动归档」）
 *
 * 参照那边的原话（图1）：「会话 ──当前交接──▶ 归档备份（历史会话 / 旧版记忆，**只进不改**）」
 * 判据：**可回滚；不为了"干净"删证据**。
 *
 * ⛔ 和"手工搬"的区别（这就是"自动"的部分）：
 *   手工要人判断"这节还用不用"，本工具用**四条机械判据**判，并且**只搬不删**：
 *     ① **超体量**：主文件 > `--max-kb`（默认 25 KB，是硬红线）⇒ 必须搬
 *     ② **已有指针**：`###` 标题里已带 `→ \`归档\...\`` 的，说明早搬过 ⇒ 跳过
 *     ③ **受保护**：`§〇` 四小节 / `## 核心职责` / `### 5) 全貌` / `## §一 §二` **永不搬**
 *        （它们是新会话开场必读的导航，搬走就等于失忆）
 *     ④ **挑最大的搬**：按字节从大到小搬，直到降到目标线以下。
 *        ⛔ 不按日期搬 —— "今天写的也多"时按日期会误伤当天的关键决策。
 *
 * 每搬一节，原位置留**带触发句的指针**（照 §2.4 拆分规矩之二）：
 *   `要 查 <这节讲的那件事> 时，读 归档\<文件>.md`
 *   ⛔ 只留一行路径 = 等于没写（人和 AI 都会跳过它）。
 *
 * 用法：
 *   node 工具\自动归档.mjs                       # dry-run：先看会搬什么
 *   node 工具\自动归档.mjs --go                  # 真搬（会先备份主文件）
 *   node 工具\自动归档.mjs --场景 DSH·GUI --go   # 只处理一个场景
 *   node 工具\自动归档.mjs --max-kb 25           # 目标线（默认 25）
 *   node 工具\自动归档.mjs --selftest            # 反例自证（搬错/搬丢/搬了保护区 都要被抓出来）
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

const GO = has('--go');
const ONLY = val('--场景') || val('--scene');
const MAX_KB = Number(val('--max-kb', '25')) || 25;
const TARGET = MAX_KB * 1024;

/** 永不搬的标题（开场必读的导航 / 工具生成的段） */
const PROTECTED = [
  /^###\s*1\)\s*上次交接/,
  /^###\s*2\)\s*当前项目/,
  /^###\s*3\)\s*私有记忆变更/,
  /^###\s*4\)\s*下一步/,
  /^###\s*5\)\s*全貌/,
  /^##\s*§〇/,
  /^##\s*核心职责/,
  /^##\s*§[一二]/,
  /^##\s*[一二]、/,
];

const isProtected = (title) => PROTECTED.some((re) => re.test(title));
const isPointer = (title) => /→\s*`?归档[/\\]/.test(title);

/** 把一节拆出来：返回 {title, body, bytes, start} */
export function sections(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => { if (/^###\s/.test(l)) starts.push(i); });
  return starts.map((s, k) => {
    const e = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const body = lines.slice(s, e);
    // 去掉尾部空行，避免搬走后留一堆空白
    while (body.length && !body[body.length - 1].trim()) body.pop();
    return { start: s, end: e, title: lines[s], body: body.join('\n'), bytes: Buffer.byteLength(body.join('\n')) };
  });
}

/** 从标题里抽一个"要查什么"的短语，用来写触发句 */
export function triggerOf(title) {
  let t = title.replace(/^###\s*/, '');
  t = t.replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, '');   // 去日期
  t = t.replace(/→.*$/, '');                         // 去已有指针尾巴
  t = t.replace(/[（(].*?[）)]/g, '');               // 去括号注
  t = t.trim().replace(/[：:，,。.]$/, '');
  return t || '这一节的内容';
}

/** 规划的搬移（纯函数，便于自测） */
export function plan(text, target = TARGET) {
  const secs = sections(text);
  const movable = secs.filter((s) => !isProtected(s.title) && !isPointer(s.title));
  let total = Buffer.byteLength(text);
  const picked = [];
  // 从大到小搬，直到降到目标线以下
  for (const s of movable.slice().sort((a, b) => b.bytes - a.bytes)) {
    if (total <= target) break;
    picked.push(s);
    total -= s.bytes;                   // 粗估：搬走正文，换来一行指针（低估指针体积，留余量）
    total += 120;
  }
  return { total: Buffer.byteLength(text), target, picked, after: total, movable: movable.length };
}

/** 执行搬移：写归档文件 + 主文件换成指针 */
export function apply(text, picked, archName) {
  const lines = text.split(/\r?\n/);
  const sorted = picked.slice().sort((a, b) => b.start - a.start);   // 从后往前替换
  for (const s of sorted) {
    const trig = triggerOf(s.title);
    const pointer = [
      '### ' + s.title.replace(/^###\s*/, '').replace(/→.*$/, '').trim() + ' → `归档\\' + archName + '`',
      '',
      '要 查「' + trig + '」的经过与取证 时，读 `归档\\' + archName + '`。',
    ];
    lines.splice(s.start, s.end - s.start, ...pointer);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 归档文件正文 */
export function archiveBody(sceneName, picked, date) {
  return [
    '# §五 归档 · ' + sceneName + '（' + date + '）',
    '',
    '> 归属：场景记忆 `' + sceneName + '` 的 §五 决策与坑，由 `工具\\自动归档.mjs` 按体量判据搬出。',
    '> ⛔ **只进不改**：这里是证据，不是新文档；要改请在主文件或技能里改。',
    '> 判据：主文件 > ' + (TARGET / 1024).toFixed(0) + ' KB 就搬；搬走的是**解释/经过/案例**，判据与命令原文留在主文件。',
    '',
    picked.map((p) => p.body).join('\n\n'),
    '',
  ].join('\n');
}

/* ---------------- 自测（反例自证） ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // 反例①：受保护的节绝不能被选中
  {
    const t = [
      '## §〇 当前交接', '### 1) 上次交接', '- 进度', '### 2) 当前项目', '| a | b |',
      '### 5) 全貌', '- 全貌', '## 核心职责', '- 负责：x', '- 负责：y', '- 负责：z',
      '### 2026-01-01 · 一个很大的旧坑', 'x'.repeat(30000),
    ].join('\n');
    const p = plan(t, 1024);
    const bad = p.picked.filter((s) => isProtected(s.title));
    add(bad.length === 0, '反例① 受保护小节（§〇/全貌/核心职责）**绝不**被搬', bad.map((b) => b.title).join(' | ') || '无');
    add(p.picked.length > 0, '正例 超体量时确实会挑到大节来搬', 'picked=' + p.picked.length);
  }

  // 反例②：已经是指针的节不许再搬第二遍（否则归档会重复）
  {
    const t = [
      '### 2026-01-01 · 旧事 → `归档\\§五-x.md`', '要 查 旧事 时，读 `归档\\§五-x.md`。',
      'x'.repeat(30000),
    ].join('\n');
    const p = plan(t, 1024);
    add(!p.picked.some((s) => isPointer(s.title)), '反例② 已是指针的节**不会**被再搬一次', '');
  }

  // 反例③：搬完不许丢字（逐行核对原文都在归档里）
  {
    const body = '### 2026-01-01 · 待搬的节\n\n第一行内容\n第二行内容\n- 列表项'.replace(/\\n/g, '\n');
    const t = body + '\n' + 'x'.repeat(30000);
    const p = plan(t, 1024);
    const picked = p.picked.filter((s) => s.body.includes('待搬的节'));
    if (!picked.length) add(false, '反例③ 找不到要搬的节（样本构造有问题）', '');
    else {
      const ab = archiveBody('测试场景', picked, '2026-01-01');
      const missing = picked[0].body.split(/\r?\n/).filter((l) => l.trim() && !ab.includes(l.trim()));
      add(missing.length === 0, '反例③ 搬完**不丢字**（原文每行都在归档里）', '缺 ' + missing.length + ' 行');
    }
  }

  // 反例④：主文件没超线 ⇒ 一节都不搬（不许"为了干净"乱搬）
  {
    const t = '### 2026-01-01 · 小节\n\n内容\n';
    const p = plan(t, 256 * 1024);
    add(p.picked.length === 0, '反例④ 主文件未超线 ⇒ 一节都不搬（不为了"干净"删证据）', 'picked=' + p.picked.length);
  }

  // 反例⑤：指针必须带触发句（只有一行路径 = 等于没写）
  {
    const t = '### 2026-01-01 · 某事经过\n\n' + 'x'.repeat(3000) + '\n';
    const p = plan(t, 1024);
    const out = apply(t, p.picked, '§五-测试.md');
    const hasTrigger = /要\s*查\s*「.+?」/.test(out);
    const onlyPath = out.split(/\r?\n/).filter((l) => l.includes('归档\\')).length === 1;
    add(hasTrigger && !onlyPath, '反例⑤ 指针带「要 查 X 时，读 …」触发句（不是只留一行路径）', 'trigger=' + hasTrigger);
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
      '自动归档.mjs —— 把沉淀下来的记忆正文自动搬进 归档\\（只进不改）',
      '  node 工具\\自动归档.mjs               dry-run',
      '  node 工具\\自动归档.mjs --go          真搬（先备份主文件）',
      '  node 工具\\自动归档.mjs --场景 DSH·GUI --go',
      '  node 工具\\自动归档.mjs --max-kb 25   目标线',
      '  node 工具\\自动归档.mjs --selftest    反例自证',
    ].join('\n'));
    process.exit(0);
  }

  const scenes = fs.existsSync(MEM)
    ? fs.readdirSync(MEM, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name)
    : [];
  const targets = ONLY ? scenes.filter((s) => s === ONLY) : scenes;
  if (ONLY && !targets.length) { console.error('✗ 没有场景「' + ONLY + '」'); process.exit(2); }

  let acted = 0, movedTotal = 0;
  for (const name of targets) {
    const mainFile = path.join(MEM, name, '场景私有记忆.md');
    if (!fs.existsSync(mainFile)) continue;
    const text = fs.readFileSync(mainFile, 'utf8');
    const p = plan(text, TARGET);

    console.log('\n' + name + '：主文件 ' + (p.total / 1024).toFixed(1) + ' KB（目标 ≤ ' + MAX_KB + ' KB）· 可选小节 ' + p.movable + ' 个');
    if (!p.picked.length) { console.log('  ✓ 不用搬'); continue; }

    console.log('  会搬 ' + p.picked.length + ' 节：');
    for (const s of p.picked) console.log('    ' + String(s.bytes).padStart(6) + ' B  ' + s.title.replace(/^###\s*/, '').slice(0, 56));
    console.log('  预计：' + (p.total / 1024).toFixed(1) + ' KB → 约 ' + (p.after / 1024).toFixed(1) + ' KB');

    if (!GO) { console.log('  （dry-run，加 --go 才真搬）'); continue; }

    // 备份 → 写归档 → 换指针 → 核对不丢字
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const archName = '§五-自动归档-' + date + '.md';
    const archFile = path.join(MEM, name, '归档', archName);
    fs.mkdirSync(path.dirname(archFile), { recursive: true });

    const bak = mainFile + '.bak-' + Date.now();
    fs.copyFileSync(mainFile, bak);

    const ab = archiveBody(name, p.picked, date);
    fs.writeFileSync(archFile, ab, 'utf8');
    const out = apply(text, p.picked, archName);
    fs.writeFileSync(mainFile, out, 'utf8');

    // 只搬不丢：搬走的每行都得在归档里
    const missing = [];
    for (const s of p.picked) for (const l of s.body.split(/\r?\n/)) { const t2 = l.trim(); if (t2 && !ab.includes(t2)) missing.push(t2); }
    const afterKB = Buffer.byteLength(out) / 1024;
    if (missing.length) {
      fs.copyFileSync(bak, mainFile);           // 回滚
      console.log('  ⛔ 核对失败（丢 ' + missing.length + ' 行）⇒ 已自动回滚主文件');
      missing.slice(0, 3).forEach((m) => console.log('     ' + m.slice(0, 90)));
      process.exitCode = 1;
      continue;
    }
    fs.rmSync(bak, { force: true });
    acted += p.picked.length; movedTotal += p.picked.reduce((a, s) => a + s.bytes, 0);
    console.log('  ✓ 搬走 ' + p.picked.length + ' 节 → 归档\\' + archName + '（' + (Buffer.byteLength(ab) / 1024).toFixed(1) + ' KB）');
    console.log('    主文件 → ' + afterKB.toFixed(1) + ' KB · 核对：缺 0 行');
  }

  console.log('\n' + (GO ? '共搬 ' + acted + ' 节 · ' + (movedTotal / 1024).toFixed(1) + ' KB（只进不改，归档可回滚）' : '（dry-run 结束；加 --go 才动文件）'));
}
