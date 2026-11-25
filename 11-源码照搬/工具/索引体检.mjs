#!/usr/bin/env node
/**
 * 索引体检.mjs —— 「文档索引」的判据（照搬《05-协作与规矩/二-标准化规范》§2.7 + §2.10）
 *
 * 治的坑：索引写了但和文件脱节 —— 新文件没登记（⚠）、登记的文件早没了（⛔）、
 *   状态词写成「留档（2026-10-18 归档）」这种带注的（体检认不出 ⇒ 等于未登记）。
 *
 * 判据（唯一出处，写死在这里；⛔ 别在别处再判一次）：
 *   ① 场景记忆目录里**每个文件/一级目录**都必须在 `_文件索引.md` 有一行
 *   ② `_文件索引.md` 里每一行指向的东西必须真实存在（`项目记忆\` / `归档\` 这类目录算存在）
 *   ③ 状态格**只许四个词**：活 / 常备 / 留档 / 待清（带注 = ⛔）
 *   ④ `复核日期` 必须能解析；`常备` 超 180 天、`待清` 超 7 天 ⇒ ⛔ 到期
 *   ⑤ 未登记 = ⚠（不阻断）；死条目 / 状态词非法 / 到期 = ⛔（exit 1）
 *
 * 用法：
 *   node 工具\索引体检.mjs              # 全场景
 *   node 工具\索引体检.mjs --场景 DSH·GUI
 *   node 工具\索引体检.mjs --quiet      # 一行结论（挂机制体检）
 *   node 工具\索引体检.mjs --json
 *   node 工具\索引体检.mjs --selftest   # 造 3 反例（未登记 / 死条目 / 状态带注）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

export const STATES = ['活', '常备', '留档', '待清'];
const HOLD_DAYS = { 常备: 180, 待清: 7 };

const daysAgo = (s) => {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

/** 读一份索引的表格行 */
function parseIndex(file) {
  const rows = [];
  if (!fs.existsSync(file)) return rows;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const c = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim().replace(/`/g, ''));
    if (c.length < 4) continue;
    if (c[0] === '文件 / 目录' || c[0] === '文件') continue;
    if (/^-+$/.test(c[0])) continue;
    rows.push({ raw: line, file: c[0], what: c[1], state: c[2], date: c[3] });
  }
  return rows;
}

/** 目录里"该登记"的东西（跳过 _文件索引.md 自身） */
function actualEntries(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '_文件索引.md') continue;
    if (e.name.startsWith('.')) continue;
    out.push(e.isDirectory() ? e.name + '\\' : e.name);
  }
  return out;
}

/** 查一个场景目录 */
export function checkScene(name) {
  const dir = path.join(MEM, name);
  const idxFile = path.join(dir, '_文件索引.md');
  const bad = [], warn = [], ok = [];
  if (!fs.existsSync(dir)) return { name, bad: ['没有这个场景目录'], warn, ok, rows: 0 };
  if (!fs.existsSync(idxFile)) { bad.push('缺 _文件索引.md（跑 场景记忆.mjs init）'); return { name, bad, warn, ok, rows: 0 }; }

  const rows = parseIndex(idxFile);
  const listed = new Set(rows.map((r) => r.file.replace(/\\$/, '')));
  const actual = actualEntries(dir);

  for (const a of actual) {
    const key = a.replace(/\\$/, '');
    if (!listed.has(key)) warn.push('未登记（文件在，索引没这一行）：' + a);
  }
  for (const r of rows) {
    const key = r.file.replace(/\\$/, '');
    const exists = fs.existsSync(path.join(dir, key));
    if (!exists) bad.push('死条目（索引里有，文件已没）：' + r.file);
    if (!STATES.includes(r.state)) bad.push(`状态格非法「${r.state}」（只许 ${STATES.join(' / ')}；注解放最后一列）：${r.file}`);
    else {
      const d = daysAgo(r.date);
      if (d === null) bad.push('复核日期解析不出：' + r.file + '（「' + r.date + '」）');
      else if (HOLD_DAYS[r.state] && d > HOLD_DAYS[r.state]) bad.push(`${r.state} 已过复核期 ${d} 天（红线 ${HOLD_DAYS[r.state]}）：` + r.file);
      else ok.push(r.file);
    }
  }
  if (!bad.length) ok.push('索引与目录一致（' + rows.length + ' 行）');
  return { name, bad, warn, ok, rows: rows.length };
}

/** 全部场景（跳过 `_` 开头的共享/归档目录） */
export function sceneDirs() {
  if (!fs.existsSync(MEM)) return [];
  return fs.readdirSync(MEM, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name).sort();
}

/* ---------------- 反例门禁 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });
  const target = sceneDirs()[0];
  if (!target) { console.log('  ✗ 没有场景目录，无法自测'); return 1; }
  const dir = path.join(MEM, target);
  const idxFile = path.join(dir, '_文件索引.md');
  const backup = fs.readFileSync(idxFile);

  const tryCase = (label, mutate, wantBad) => {
    fs.writeFileSync(idxFile, backup);
    const before = checkScene(target);
    const res = mutate(before);
    const afterBad = res ? res.bad : checkScene(target).bad;
    const hit = afterBad.some((b) => wantBad.test(b));
    add(hit, label, '实际 ⛔：' + (afterBad.join(' | ') || '无'));
    fs.writeFileSync(idxFile, backup);
  };

  // 反例①：造一个没登记的文件
  {
    const p = path.join(dir, '_自测未登记.md');
    fs.writeFileSync(p, 'x', 'utf8');
    const r = checkScene(target);
    fs.rmSync(p, { force: true });
    add(r.warn.some((w) => w.includes('_自测未登记.md')), '反例① 目录里多一个文件、索引没登记 ⇒ ⚠ 未登记', '实际 ⚠：' + (r.warn.join(' | ') || '无'));
  }
  // 反例②：索引里写一个不存在的文件 ⇒ 死条目
  tryCase('反例② 索引里写不存在的文件 ⇒ ⛔ 死条目', (before) => {
    fs.writeFileSync(idxFile, backup.toString('utf8') + '\n| `_根本不存在的文件.md` | 自测 | 活 | 2026-11-18 |\n', 'utf8');
    return null;
  }, /死条目/);
  // 反例③：状态格带注 ⇒ ⛔ 非法
  tryCase('反例③ 状态写成「留档（2026-10-18 归档）」⇒ ⛔ 状态格非法', () => {
    const t = backup.toString('utf8').replace('| 活 |', '| 留档（2026-10-18 归档） |');
    fs.writeFileSync(idxFile, t === backup.toString('utf8') ? backup.toString('utf8') + '\n| `场景私有记忆.md` | 自测 | 留档（x归档） | 2026-11-18 |\n' : t, 'utf8');
    return null;
  }, /状态格非法/);
  // 反例④：待清超 7 天 ⇒ ⛔ 到期
  tryCase('反例④ 待清、复核日期 30 天前 ⇒ ⛔ 到期', () => {
    fs.writeFileSync(idxFile, backup.toString('utf8') + '\n| `场景私有记忆.md` | 自测 | 待清 | 2020-01-01 |\n', 'utf8');
    return null;
  }, /已过复核期/);

  fs.writeFileSync(idxFile, backup);
  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- CLI ---------------- */
if (isMain) {
  if (has('--selftest')) process.exit(selftest());
  const only = val('--场景') || val('--scene');
  const names = only ? [only] : sceneDirs();
  const rows = names.map(checkScene);
  const badN = rows.filter((r) => r.bad.length).length;
  const warnN = rows.filter((r) => r.warn.length).length;

  if (has('--json')) { console.log(JSON.stringify({ total: rows.length, bad: badN, warn: warnN, scenes: rows }, null, 2)); process.exit(badN ? 1 : 0); }
  if (has('--quiet')) {
    console.log(badN ? `⛔ 索引体检：${badN}/${rows.length} 个场景有硬问题（跑 node 工具\\索引体检.mjs 看明细）`
      : `✓ 索引体检：${rows.length} 个场景索引一致${warnN ? '（⚠ ' + warnN + ' 个有未登记）' : ''}`);
    process.exit(badN ? 1 : 0);
  }
  for (const r of rows) {
    console.log(`\n${r.name}：${r.bad.length ? '⛔ ' + r.bad.length : '✓'}（索引 ${r.rows} 行${r.warn.length ? ' · ⚠ ' + r.warn.length : ''}）`);
    for (const b of r.bad) console.log('   ⛔ ' + b);
    for (const w of r.warn) console.log('   ⚠ ' + w);
  }
  console.log('\n判据（唯一出处 = 本文件）：未登记 ⚠ · 死条目 / 状态词非法 / 到期 ⛔');
  console.log(badN ? `⛔ ${badN}/${rows.length} 个场景有硬问题` : `✓ ${rows.length} 个场景全部通过`);
  process.exit(badN ? 1 : 0);
}
