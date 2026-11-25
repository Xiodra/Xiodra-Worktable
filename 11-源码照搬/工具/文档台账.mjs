#!/usr/bin/env node
/**
 * 文档台账.mjs —— 「东西在哪、什么状态、什么时候该复核」（照搬《05/二-标准化规范》§2.7 / §2.10）
 *
 * 参照的判据（原文）：
 *   · **四状态**：`活`（每次干活都读写）/ `常备`（半年复核）/ `留档`（只作证据）/ `待清`（一周内必须处理掉）
 *   · **到期四选一**：更新 / 合并 / 归档 / 清（**合并优先**）
 *   · **文档密集目录必须有 `_索引.md`**：直接子文档 ≥30，或 ≥8 且 ≥500 KB，或同主题 ≥10
 *   · ⛔ **状态格只许四个词**（写成「留档（2026-10-18 归档）」体检认不出 ⇒ 被当成未登记）
 *
 * ⚠ 我们**不做**参照那种 85 KB 的全机文档台账。理由：
 *   实测本工作台**没有一个目录达到"密集"判据**（最多 8 份 / 208 KB）⇒ 强制索引是过度设计。
 *   ⇒ 只做两件真有用的：
 *     ① `--scan`  列出所有"值得登记"的文档目录与份数（人一眼看出哪在变胖）
 *     ② `--check` 查：已达密集却没 `_索引.md` ⇒ ⛔；`_索引.md` 里的状态词/到期 ⇒ ⛔
 *
 * 用法：
 *   node 工具\文档台账.mjs --scan              # 扫一遍：哪些目录有文档、各多少份
 *   node 工具\文档台账.mjs --check [--quiet]   # 体检：密集无索引 / 状态词非法 / 到期
 *   node 工具\文档台账.mjs --dense             # 只看"已达密集判据"的目录
 *   node 工具\文档台账.mjs --selftest          # 反例：密集无索引 / 状态带注 / 待清超7天
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const WT = path.resolve(ROOT, '..');     // 工作台根（11-源码照搬 的上一级）

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const STATES = ['活', '常备', '留档', '待清'];
const HOLD_DAYS = { 常备: 180, 待清: 7 };
const DOC = /\.(md|txt)$/i;
const SKIP = new Set(['node_modules', '.git', '引擎', '引擎数据', 'captures', '_临时', '12-版本', '99-工作区', '_w', '_x']);

/** 直接子文档数（参照判据就是"直接子文档"） */
export function directDocs(dir) {
  let files = 0, bytes = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) continue;
      if (!DOC.test(e.name)) continue;
      files++; bytes += fs.statSync(path.join(dir, e.name)).size;
    }
  } catch { /* 读不到算 0 */ }
  return { files, bytes };
}

/** 是否达到"文档密集"判据（唯一出处） */
export function isDense(s) {
  return s.files >= 30 || (s.files >= 8 && s.bytes >= 512000);
}

/** 找索引文件 */
export function indexOf(dir) {
  for (const n of ['_索引.md', '_文件索引.md', 'README.md']) {
    if (fs.existsSync(path.join(dir, n))) return n;
  }
  return null;
}

const daysAgo = (s) => {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Math.floor((Date.now() - Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00')) / 86400000);
};

/** 检查一份 `_索引.md` 的表格行 */
export function checkIndex(text) {
  const bad = [], warn = [], ok = [];
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const c = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim().replace(/`/g, ''));
    if (c.length < 4) continue;
    if (/^(文件|文件 \/ 目录)$/.test(c[0])) continue;
    if (/^-+$/.test(c[1] || '')) continue;
    rows.push({ file: c[0], state: c[2] || '', date: c[3] || '' });
  }
  if (!rows.length) { warn.push('索引里没有表格行'); return { bad, warn, ok, rows }; }

  for (const r of rows) {
    if (!STATES.includes(r.state)) {
      bad.push(`状态格非法「${r.state}」（只许 ${STATES.join('/')}；注解放最后一列）：${r.file}`);
      continue;
    }
    const d = daysAgo(r.date);
    if (d === null) { bad.push('复核日期解析不出：' + r.file); continue; }
    const limit = HOLD_DAYS[r.state];
    if (limit && d > limit) bad.push(`${r.state} 已过复核期 ${d} 天（红线 ${limit}）：${r.file}`);
  }
  if (!bad.length) ok.push(rows.length + ' 行状态与日期都合规');
  return { bad, warn, ok, rows };
}

/** 扫工作台根下的文档目录（深度 ≤2） */
export function scanDirs() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory()) continue;
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      const s = directDocs(p);
      if (s.files) out.push({ dir: p, rel: path.relative(WT, p), ...s, dense: isDense(s), idx: indexOf(p) });
      walk(p, depth + 1);
    }
  };
  // 根目录本身
  const rs = directDocs(WT);
  if (rs.files) out.push({ dir: WT, rel: '（根）', ...rs, dense: isDense(rs), idx: indexOf(WT) });
  walk(WT, 0);
  return out;
}

/** 体检 */
export function checkAll() {
  const bad = [], warn = [], ok = [];
  const dirs = scanDirs();
  for (const d of dirs) {
    if (!d.dense) continue;
    if (!d.idx) { bad.push('文档密集但无索引：' + d.rel + '（' + d.files + ' 份 / ' + (d.bytes / 1024).toFixed(0) + ' KB）'); continue; }
    ok.push(d.rel + ' 密集有索引（' + d.idx + '）');
    const r = checkIndex(fs.readFileSync(path.join(d.dir, d.idx), 'utf8'));
    bad.push(...r.bad.map((b) => d.rel + '：' + b));
  }
  if (!dirs.some((d) => d.dense)) warn.push('当前没有目录达到"文档密集"判据（正常，不必建索引）');
  return { bad, warn, ok, dirs };
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① 密集判据：30 份
  add(isDense({ files: 30, bytes: 1000 }), '正例 ≥30 份 ⇒ 密集');
  // ② 密集判据：8 份但只有 100KB ⇒ 不密集（这条是关键，防误判）
  add(!isDense({ files: 8, bytes: 100 * 1024 }), '反例① 8 份但仅 100KB ⇒ **不算**密集（防单文件大目录误判）');
  // ③ 8 份且 600KB ⇒ 密集
  add(isDense({ files: 8, bytes: 600 * 1024 }), '正例 8 份且 ≥500KB ⇒ 密集');

  // ④ 状态带注 ⇒ ⛔
  {
    const r = checkIndex('| 文件 | 是什么 | 状态 | 复核 |\n|---|---|---|---|\n| `a.md` | x | 留档（2026-10-18 归档） | 2026-11-19 |\n');
    add(r.bad.some((b) => b.includes('状态格非法')), '反例② 状态写成「留档（…）」⇒ ⛔（体检认不出=未登记）', r.bad.join(' | '));
  }
  // ⑤ 待清超 7 天 ⇒ ⛔
  {
    const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const r = checkIndex('| 文件 | 是什么 | 状态 | 复核 |\n|---|---|---|---|\n| `a.md` | x | 待清 | ' + old + ' |\n');
    add(r.bad.some((b) => b.includes('已过复核期')), '反例③ 待清超 7 天 ⇒ ⛔ 到期', r.bad.join(' | '));
  }
  // ⑥ 常备未超 180 天 ⇒ 通过
  {
    const d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const r = checkIndex('| 文件 | 是什么 | 状态 | 复核 |\n|---|---|---|---|\n| `a.md` | x | 常备 | ' + d + ' |\n');
    add(r.bad.length === 0, '正例 常备 30 天（未超 180）⇒ 通过', r.bad.join(' | '));
  }
  // ⑦ 四个状态词都认
  {
    const d = new Date().toISOString().slice(0, 10);
    const rows = STATES.map((s) => '| `' + s + '.md` | x | ' + s + ' | ' + d + ' |').join('\n');
    const r = checkIndex('| 文件 | 是什么 | 状态 | 复核 |\n|---|---|---|---|\n' + rows + '\n');
    add(r.bad.length === 0, '正例 活/常备/留档/待清 四词都认', r.bad.join(' | '));
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
      '文档台账.mjs —— 东西在哪 / 什么状态 / 何时复核',
      '  node 工具\\文档台账.mjs --scan     扫目录（份数 + 是否密集 + 有无索引）',
      '  node 工具\\文档台账.mjs --dense    只看已达密集判据的',
      '  node 工具\\文档台账.mjs --check [--quiet]',
      '  node 工具\\文档台账.mjs --selftest',
      '判据：密集 = 直接子文档 ≥30，或 ≥8 且 ≥500KB',
      '四状态：活 / 常备(180d) / 留档 / 待清(7d)',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--scan') || has('--dense')) {
    const only = has('--dense');
    const dirs = scanDirs().filter((d) => !only || d.dense).sort((a, b) => b.files - a.files);
    console.log('文档目录扫描（根：' + WT + '）\n');
    for (const d of dirs) {
      console.log('  ' + (d.dense ? '⚠' : '·') + ' ' + d.rel.padEnd(34) + String(d.files).padStart(3) + ' 份  '
        + (d.bytes / 1024).toFixed(0).padStart(6) + ' KB  ' + (d.dense ? '密集 ' : '     ') + '索引=' + (d.idx || '无'));
    }
    const denseN = dirs.filter((d) => d.dense).length;
    console.log('\n共 ' + dirs.length + ' 个有文档的目录；达密集判据 ' + denseN + ' 个' + (denseN ? '' : '（不需要建强制索引）'));
    process.exit(0);
  }

  const r = checkAll();
  if (has('--quiet')) {
    console.log(r.bad.length ? `⛔ 文档台账：${r.bad.length} 个问题（跑 node 工具\\文档台账.mjs --check）` : `✓ 文档台账：密集目录都有索引${r.warn.length ? '（⚠ ' + r.warn.length + '）' : ''}`);
    process.exit(r.bad.length ? 1 : 0);
  }
  console.log('文档台账体检\n');
  for (const s of r.ok) console.log('  ✓ ' + s);
  for (const w of r.warn) console.log('  ⚠ ' + w);
  for (const b of r.bad) console.log('  ⛔ ' + b);
  console.log('\n' + (r.bad.length ? '⛔ ' + r.bad.length + ' 个问题' : '✓ 全部通过'));
  process.exit(r.bad.length ? 1 : 0);
}
