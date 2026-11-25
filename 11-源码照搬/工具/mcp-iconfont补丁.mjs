#!/usr/bin/env node
/**
 * mcp-iconfont补丁.mjs —— 给社区包 `@dawipong/mcp-iconfont` 打上「接口已变」的补丁
 *
 * 治的坑（2026-11-18 实测）：
 *   iconfont.cn 的搜索接口现在要求请求带 `Cookie: ctoken=null`（表单字段里的 ctoken 不够）。
 *   社区包 0.3.1 **不发 Cookie** ⇒ 一调就 `403 Redirecting to /.`，工具列得出来但搜不到东西。
 *   两个接口都中招：`/api/icon/search.json` 与 `/api/illustration/search.json`。
 *
 * 判据（唯一出处 = 本文件）：
 *   `dist/iconfont.js` 里**两个**搜索请求的 headers 都必须含 `Cookie: "ctoken=null"`。
 *   ⛔ 只补一处算失败 —— 只补 icon 会让人以为好了，插画却还 403。
 *
 * 做法（可复现，不是手改 node_modules）：
 *   `dist/iconfont.js.orig` 是 npm tarball 的原始基线（永不修改）。
 *   每次运行都**从 .orig 重新生成** iconfont.js，所以幂等、可回滚、可反复跑。
 *
 * 用法：
 *   node 工具\mcp-iconfont补丁.mjs            # 检查 + 需要时打补丁
 *   node 工具\mcp-iconfont补丁.mjs --check    # 只检查（合规 exit 0 / 不合规 exit 1）
 *   node 工具\mcp-iconfont补丁.mjs --restore  # 还原成原始基线
 *   node 工具\mcp-iconfont补丁.mjs --selftest # 反例门禁：拿基线验证"不补会判不合格"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const PKG = process.env.DSH_MCP_ICONFONT_DIR || path.join(ROOT, 'MCP', 'mcp-iconfont');
const TARGET = path.join(PKG, 'dist', 'iconfont.js');
const ORIG = TARGET + '.orig';

const NEEDLE = `                "User-Agent": ICONFONT_USER_AGENT,
                Accept: "application/json",
            },`;
const REPL = `                "User-Agent": ICONFONT_USER_AGENT,
                Accept: "application/json",
                // ⚠ 2026-11-18 补：iconfont 搜索接口要求该 Cookie（缺了整站 403 Redirecting to /）
                Cookie: "ctoken=null",
                Referer: "https://www.iconfont.cn/",
                Origin: "https://www.iconfont.cn",
            },`;

const EXPECT_HITS = 2;   // icon + illustration

/** 判一段源码合不合规：两个搜索请求都要带 Cookie */
export function audit(src) {
  const bad = [];
  const cookieN = (src.match(/Cookie:\s*"ctoken=null"/g) || []).length;
  if (cookieN < EXPECT_HITS) bad.push(`带 Cookie 的请求只有 ${cookieN} 处（应为 ${EXPECT_HITS}：icon + illustration）`);
  // 逐请求核对：两个 search 端点各自的 headers 块里都得有 Cookie
  for (const fn of ['searchIcons', 'searchIllustrations']) {
    const i = src.indexOf(fn + '(');
    if (i < 0) { bad.push('找不到方法 ' + fn + '（包结构变了，补丁脚本要跟着改）'); continue; }
    const seg = src.slice(i, i + 900);
    if (!/Cookie:\s*"ctoken=null"/.test(seg)) bad.push(fn + ' 的请求没带 Cookie（这个接口会 403）');
  }
  return bad;
}

function patchFromOrig() {
  if (!fs.existsSync(ORIG)) {
    console.error('✗ 缺原始基线 ' + ORIG + '\n  ⇒ 从 npm 重新取一份 0.3.1 的 dist/iconfont.js 存成 .orig 再来。');
    process.exit(2);
  }
  const orig = fs.readFileSync(ORIG, 'utf8');
  const hits = orig.split(NEEDLE).length - 1;
  if (hits !== EXPECT_HITS) {
    console.error(`✗ 基线里命中 ${hits} 处（应为 ${EXPECT_HITS}）⇒ 包版本变了，补丁锚点要改，⛔ 本次不写文件。`);
    process.exit(2);
  }
  const patched = orig.split(NEEDLE).join(REPL);
  const left = audit(patched);
  if (left.length) { console.error('✗ 补丁后仍不合规：\n  ' + left.join('\n  ')); process.exit(2); }
  fs.writeFileSync(TARGET, patched, 'utf8');
  return hits;
}

function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  if (!fs.existsSync(ORIG)) { console.log('  ✗ 缺原始基线，无法自测'); return 1; }
  const orig = fs.readFileSync(ORIG, 'utf8');

  // 反例①：原始基线（没 Cookie）必须被判不合格
  const a1 = audit(orig);
  add(a1.length > 0, '反例① npm 原始基线（无 Cookie）⇒ 必须判不合格', '实际：' + (a1.join(' | ') || '合格（假检查！）'));

  // 反例②：只补一处（只补 icon）必须被判不合格
  const onePatch = orig.replace(NEEDLE, REPL);
  const a2 = audit(onePatch);
  add(a2.length > 0, '反例② 只补 icon、漏插画 ⇒ 必须判不合格', '实际：' + (a2.join(' | ') || '合格（假检查！）'));

  // 正例：两处都补 ⇒ 合格
  const good = orig.split(NEEDLE).join(REPL);
  const a3 = audit(good);
  add(a3.length === 0, '正例 两处都补 ⇒ 合格', '实际：' + (a3.join(' | ') || '合格'));

  // 反例③：包里方法名改了（模拟上游重构）⇒ 必须报出来，不许静默合格
  const renamed = good.split('searchIllustrations(').join('searchPics(');
  const a4 = audit(renamed);
  add(a4.length > 0, '反例③ 方法名被上游改掉 ⇒ 必须报（不许静默合格）', '实际：' + (a4.join(' | ') || '合格（假检查！）'));

  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();

if (isMain) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);

  if (has('--selftest')) process.exit(selftest());

  if (has('--restore')) {
    if (!fs.existsSync(ORIG)) { console.error('✗ 缺 ' + ORIG); process.exit(2); }
    fs.copyFileSync(ORIG, TARGET);
    console.log('✓ 已还原成原始基线（未打补丁 ⇒ 会出现 403，除非 iconfont 改回接口）');
    process.exit(0);
  }

  if (!fs.existsSync(PKG)) {
    console.error('✗ 找不到 ' + PKG + '\n  ⇒ 先把包 vendor 到 MCP\\mcp-iconfont\\（含 dist 与 node_modules）。');
    process.exit(2);
  }
  if (!fs.existsSync(TARGET)) { console.error('✗ 缺 ' + TARGET); process.exit(2); }

  const cur = fs.readFileSync(TARGET, 'utf8');
  const bad = audit(cur);

  if (has('--check')) {
    if (bad.length) { console.log('⛔ 未打补丁（会 403）：\n  ' + bad.join('\n  ')); console.log('  怎么修：node 工具\\mcp-iconfont补丁.mjs'); process.exit(1); }
    console.log('✓ 补丁在位（两个搜索请求都带 Cookie: ctoken=null）');
    process.exit(0);
  }

  if (!bad.length) { console.log('✓ 补丁已在位，无需重打（幂等）'); process.exit(0); }

  console.log('补丁缺失，从原始基线重新生成…\n  原因：' + bad.join('\n        '));
  const n = patchFromOrig();
  console.log('✓ 已打补丁（命中 ' + n + ' 处）→ ' + path.relative(ROOT, TARGET));
  console.log('  基线：' + path.relative(ROOT, ORIG) + '（可 --restore 回滚）');
  console.log('  ⚠ dist/iconfont.js 是**生成产物**：包升级后必须重跑本脚本。');
  process.exit(0);
}
