#!/usr/bin/env node
/**
 * 临时路径.mjs —— 「临时文件该放哪」的**唯一判据**（别自己猜路径、别写 %TEMP%）
 *
 * 照搬：淋雨家工作台《08-升级与改造清单》例 1「临时文件只能放三处」。
 * 落地点：`<工作台根>\_临时\`（不随包发布，已在 .gitignore 里）。
 *
 * 三档（`--check` 也按这三档判）：
 *   ① `--big`   大体积（视频/音频/模型/镜像/依赖包，几十 MB 以上） → `_临时\big\<名>-<时间>\`
 *   ② `--keep`  有点价值（要复核/复用/可能是产物草稿）             → `_临时\keep\<名>-<时间>\`
 *   ③ （默认）   纯一次性脚本/中间日志/试跑输出                     → `_临时\scrap\<名>-<时间>\`
 *
 * ⛔ 允许区之外一律判违规（`%TEMP%`、系统盘临时目录、盘根临时目录都算）。
 *
 * 用法：
 *   node 工具\临时路径.mjs --big  --name 视频下载      # 打印并建好目录
 *   node 工具\临时路径.mjs --keep --name 报告草稿
 *   node 工具\临时路径.mjs        --name 一次性脚本
 *   node 工具\临时路径.mjs --check <路径>              # 合规 exit 0 / 违规 exit 1
 *   node 工具\临时路径.mjs --selftest                  # 4 条正例 + 4 条反例
 *
 * 谁用：任何要落临时文件的脚本 / 工具 / 技能 ⇒ 先调它拿路径，⛔ 不要硬编码临时目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 工作台根：本文件在 `<根>\工具\` 下 */
export const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 允许区（唯一出处）· tier → 根目录 */
export const TMP_ROOTS = {
  big: path.join(ROOT, '_临时', 'big'),
  keep: path.join(ROOT, '_临时', 'keep'),
  scrap: path.join(ROOT, '_临时', 'scrap'),
};

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);
const val = (f, d = '') => { const i = ARGV.indexOf(f); return i >= 0 && i + 1 < ARGV.length ? ARGV[i + 1] : d; };
const hasTrue = () => process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'batch';

/** 档位 → 根目录。没认出的档按默认（scrap）算。 */
export function rootOf(tier) {
  const t = String(tier || '').trim();
  return TMP_ROOTS[t] || TMP_ROOTS.scrap;
}

/** 判一个路径合不合规（合规返回命中的档位，否则 null）。 */
export function tierOf(p) {
  const a = path.resolve(p).toLowerCase();
  for (const [tier, root] of Object.entries(TMP_ROOTS)) {
    const r = path.resolve(root).toLowerCase();
    if (a === r || a.startsWith(r + path.sep)) return tier;
  }
  // 允许区根目录的**上一级**（`_临时\` 本身）也放行 —— 它是允许区的家，不是裸放
  const parent = path.dirname(path.resolve(TMP_ROOTS.scrap)).toLowerCase();
  if (a === parent) return 'root';
  return null;
}

/** 主要给代码用：返回 {dir, tier}，不建目录。 */
export function pickTmpDir(name, tier) {
  const t = TMP_ROOTS[String(tier || '').trim()] ? String(tier).trim() : 'scrap';
  return { dir: path.join(rootOf(t), safe(name) + '-' + stamp()), tier: t };
}

/* ---------------- 自测：4 正 + 4 反（反例必须是「故意建出来的真违规样本」） ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label) => cases.push({ ok, label });

  // 正例 1~3：三档落点都在允许区，且就是自己那一档
  for (const tier of ['big', 'keep', 'scrap']) {
    const { dir } = pickTmpDir('自测样本', tier);
    add(tierOf(dir) === tier, `--${tier} 落点合规且档位正确（${path.relative(ROOT, dir)}）`);
  }
  // 正例 4：允许区根目录本身算合规
  add(tierOf(TMP_ROOTS.scrap) === 'scrap', '_临时 子根本身算合规');

  // 反例 1：%TEMP%
  const sysTmp = path.join(os.tmpdir(), 'xiodra-selftest');
  fs.mkdirSync(sysTmp, { recursive: true }); // 故意真建出来
  const r1 = tierOf(sysTmp) === null;
  try { fs.rmdirSync(sysTmp); } catch { /* 清不干净不算失败 */ }
  add(r1, `反例①%TEMP% 判违规（${sysTmp}）`);

  // 反例 2：盘根临时目录（拼出来，源码里不出现盘符字面量）
  const driveTmp = path.parse(ROOT).root + 'xiodra-tmp-selftest';
  add(tierOf(driveTmp) === null, '反例②盘根临时目录判违规（' + driveTmp + '）');

  // 反例 3：工作区根直接放（不在 _临时 下）
  add(tierOf(path.join(ROOT, '临时.txt')) === null, '反例③工作台根直接放临时件判违规');

  // 反例 4：_临时 根下直接放（没进三档子目录）
  add(tierOf(path.join(ROOT, '_临时', '裸放')) === null, '反例④_临时 根下裸放（不在三档内）判违规');

  const pass = cases.filter((c) => c.ok).length;
  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label);
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- CLI ---------------- */
if (hasTrue()) {
  if (has('--help') || has('-h')) {
    console.log([
      '临时路径.mjs —— 临时文件落点唯一判据',
      '  --big  --name <名>   → ' + TMP_ROOTS.big,
      '  --keep --name <名>   → ' + TMP_ROOTS.keep,
      '  （默认）--name <名>  → ' + TMP_ROOTS.scrap,
      '  --check <路径>       → 合规 exit 0 / 违规 exit 1',
      '  --selftest           → 4 正 + 4 反',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--selftest')) process.exit(selftest());

  if (has('--check')) {
    const p = val('--check');
    if (!p) { console.error('用法：--check <路径>'); process.exit(2); }
    const tier = tierOf(p);
    if (tier) { console.log('✓ 合规（' + tier + '）：' + p); process.exit(0); }
    console.log('⛔ 违规：' + p);
    console.log('  临时文件只许放三处：');
    console.log('    big   → ' + TMP_ROOTS.big);
    console.log('    keep  → ' + TMP_ROOTS.keep);
    console.log('    scrap → ' + TMP_ROOTS.scrap);
    process.exit(1);
  }

  const tier = has('--big') ? 'big' : has('--keep') ? 'keep' : 'scrap';
  const { dir } = pickTmpDir(val('--name', 'batch'), tier);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.error('建目录失败：' + e.message); process.exit(2); }
  console.log(dir);
}
