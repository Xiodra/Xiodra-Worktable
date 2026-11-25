#!/usr/bin/env node
/**
 * 快照.mjs —— 打「能回滚」的版本快照（不是给别人装的发布包）
 *
 * ⛔ 和 `封装.mjs` 的区别（别混用）：
 *   · `封装.mjs` = **对外发布包**：清掉 sessionId、剔除引擎数据、给客户装 → 拿来回滚会**丢东西**。
 *   · 本工具 = **自己的回滚点**：原样保留会话绑定、场景配置、记忆、MCP 补丁 → 解压就能盖回来。
 *
 * 装什么（只装"我们改过的 + 恢复必需的"，不装可重建的）：
 *   ✅ 工具\            全套体检/派单/回执/归属/快照脚本
 *   ✅ 外壳\            main.js / preload.js / package.json / *.vbs / renderer\（含 assets）/ data\*.json
 *   ✅ 外壳\scenarios\  场景 json + 定位卡 + 身份索引（**保留 sessionId**，回滚才是原样）
 *   ✅ 引擎数据\.dsh\场景记忆\   全部记忆（§〇 / 归档 / 项目记忆）
 *   ✅ 引擎数据\.dsh\storages\   工作区与投影索引（**会话归属靠它**）
 *   ✅ 引擎数据\.dsh\profiles\web\{cordis*.yml,package.json}  插件配置（不含 node_modules）
 *   ✅ MCP\             vendor 的 MCP 本体（**不含 node_modules**，可 npm install 重建）
 *   ✅ config.json / 启动.vbs / .gitignore / 说明\ / 插件\ / 自我复盘\
 *   ⛔ 不装：引擎\（上游 2.5 GB，改了下次同步会丢）、任何 node_modules、electron-profile、
 *           captures、_临时、attachments、sessions\（会话流可单独留，见 --with-sessions）
 *
 * 用法：
 *   node 工具\快照.mjs --version v0.0.1-rc1 --out "D:\Xiodra Worktable\12-版本"
 *   node 工具\快照.mjs --version v0.0.1-rc1 --out ... --with-sessions   # 连会话流一起（大 4 MB）
 *   node 工具\快照.mjs --version ... --out ... --dry                    # 只看会装什么
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const VERSION = val('--version') || ('v0.0.1-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
const OUT = val('--out') || path.join(path.dirname(ROOT), '12-版本');
const WITH_SESSIONS = has('--with-sessions');
const DRY = has('--dry');
const VERIFY = val('--verify');
const NAME = 'Xiodra-工作台-' + VERSION;
const STAGE = path.join(OUT, NAME);
const ZIP = path.join(OUT, VERSION + '.zip');

/* ---------------- --verify：解到临时区、逐条比对 SHA256SUMS、删临时目录 ---------------- */
if (VERIFY) {
  const zip = path.resolve(VERIFY);
  if (!fs.existsSync(zip)) { console.error('✗ 找不到 ' + zip); process.exit(2); }
  const tmp = path.join(ROOT, '_临时', 'scrap', '包校验-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', zip, '-C', tmp], { stdio: 'inherit' });
    const tops = fs.readdirSync(tmp).filter((n) => fs.statSync(path.join(tmp, n)).isDirectory());
    if (!tops.length) { console.error('✗ 解压后没有目录'); process.exit(2); }
    const base = path.join(tmp, tops[0]);
    const sumsFile = path.join(base, 'SHA256SUMS');
    if (!fs.existsSync(sumsFile)) { console.error('✗ 包里没有 SHA256SUMS'); process.exit(2); }
    const lines = fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/).filter(Boolean);
    let ok = 0, bad = 0, missing = 0;
    const problems = [];
    for (const line of lines) {
      const m = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
      if (!m) { bad++; problems.push('格式不对: ' + line.slice(0, 60)); continue; }
      const abs = path.join(base, m[2]);
      if (!fs.existsSync(abs)) { missing++; problems.push('缺失: ' + m[2]); continue; }
      const got = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      if (got === m[1]) ok++; else { bad++; problems.push('不匹配: ' + m[2]); }
    }
    const manifest = (() => { try { return JSON.parse(fs.readFileSync(path.join(base, '版本.json'), 'utf8')); } catch { return null; } })();
    console.log('包：' + path.basename(zip) + '（' + (fs.statSync(zip).size / 1024 / 1024).toFixed(2) + ' MB）');
    if (manifest) console.log('版本：' + manifest.version + ' · 构建于 ' + manifest.builtAt);
    console.log('校验 ' + lines.length + ' 条：✓ ' + ok + ' · ✗ 不匹配 ' + bad + ' · ✗ 缺失 ' + missing);
    problems.slice(0, 10).forEach((p) => console.log('   ' + p));
    if (bad + missing) { console.log('\n⛔ 这个包不完整，别拿它回滚。'); process.exit(1); }
    console.log('\n✓ 包完整可用');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(0);
}

/* ---------------- 要装的东西（相对 ROOT 的路径，目录递归 / 文件单拷） ---------------- */
const INCLUDE_DIRS = [
  '工具',
  '外壳\\renderer',
  '外壳\\scenarios',
  '引擎数据\\.dsh\\场景记忆',
  '引擎数据\\.dsh\\storages',
  '说明',
  '插件',
  '自我复盘',
  'MCP',
];
const INCLUDE_FILES = [
  'config.json', '启动.vbs', '.gitignore',
  '外壳\\main.js', '外壳\\preload.js', '外壳\\package.json', '外壳\\start.vbs',
  '引擎数据\\.dsh\\profiles\\web\\cordis.yml',
  '引擎数据\\.dsh\\profiles\\web\\cordis.patch.yml',
  '引擎数据\\.dsh\\profiles\\web\\package.json',
];
if (WITH_SESSIONS) INCLUDE_DIRS.push('引擎数据\\.dsh\\sessions');

/* 这些哪怕在 include 目录里也不装（可重建 / 运行时 / 与回滚无关） */
const EXCLUDE_SEG = [
  'node_modules', 'electron-profile', 'captures', '_临时', 'attachments', 'cache',
  '.git', 'build', 'out', '.pnpm', '.plugin-manager', '.dsh-market',
];
/**
 * ⚠ `dist` **不能一刀切排除**：`MCP\mcp-iconfont\dist\` 是**已打补丁的运行产物**，
 *   不装它回滚后 MCP 工具就 403（离线也重建不了补丁）。
 *   ⇒ `dist` 只在 MCP\ 下保留，其它位置仍当构建垃圾排除。
 */
/**
 * ⚠ `.orig` **不能排除**：`MCP\mcp-iconfont\dist\iconfont.js.orig` 是补丁脚本的**原始基线**，
 *   没有它 `mcp-iconfont补丁.mjs` 既不能重新打补丁、也不能 `--restore` 回滚。
 *   它必须跟打补丁后的 `iconfont.js` 一起进快照。
 */
const OTHER_EXCLUDE_FILE = [/\.log$/i, /server\.log$/i, /\.credentials\.yaml$/i, /\.anonymous-user-id$/i];
/**
 * 大体积"不是我们改的"素材 —— 默认不装，但**必须在清单里点名**，让人知道少了什么。
 * ⚠ `boot-video*.mp4` 共 15.6 MB，全工作台代码与 boot-anim 插件**均无引用**（2026-11-18 实测 grep），
 *   是启动动画实验的遗留素材 ⇒ 不进回滚包（回滚它们没有意义，只会让包大 15 倍）。
 *   真要回滚这些素材：`node 工具\快照.mjs ... --with-assets`
 */
const ASSET_HEAVY = [/^boot-video.*\.mp4$/i];
const WITH_ASSETS = has('--with-assets');

function rel(p) { return path.relative(ROOT, p); }
const skippedHeavy = [];
function excluded(relPath) {
  const segs = relPath.split(/[\\/]/).map((s) => s.toLowerCase());
  const underMcp = /^mcp[\\/]/i.test(relPath);
  for (const s of segs) {
    if (EXCLUDE_SEG.some((x) => s === x.toLowerCase())) return true;
    // dist：只有 MCP\ 下的要留（补丁产物）
    if (s === 'dist' && !underMcp) return true;
  }
  const base = segs[segs.length - 1] || '';
  if (!WITH_ASSETS && ASSET_HEAVY.some((re) => re.test(base))) { skippedHeavy.push(relPath); return true; }
  if (OTHER_EXCLUDE_FILE.some((re) => re.test(base))) return true;
  return false;
}

function collect() {
  const out = [];
  const pushFile = (abs) => { const r = rel(abs); if (!excluded(r)) out.push({ abs, rel: r }); };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (excluded(rel(abs))) continue;
      if (e.isDirectory()) walk(abs);
      else pushFile(abs);
    }
  };
  for (const d of INCLUDE_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) { console.log('  ! 跳过不存在的目录：' + d); continue; }
    if (fs.statSync(abs).isFile()) pushFile(abs); else walk(abs);
  }
  for (const f of INCLUDE_FILES) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) { console.log('  ! 跳过不存在的文件：' + f); continue; }
    pushFile(abs);
  }
  // 外壳\data 里的配置文件（theme / 场景标签顺序），不含 electron-profile
  const shellData = path.join(ROOT, '外壳', 'data');
  if (fs.existsSync(shellData)) {
    for (const e of fs.readdirSync(shellData, { withFileTypes: true })) {
      if (e.isDirectory()) continue;
      if (!/\.json$/i.test(e.name)) continue;
      if (/boot-fail/i.test(e.name)) continue;
      pushFile(path.join(shellData, e.name));
    }
  }
  // 去重
  const seen = new Set();
  return out.filter((f) => (seen.has(f.rel) ? false : (seen.add(f.rel), true)));
}

const files = collect();
const totalBytes = files.reduce((a, f) => a + fs.statSync(f.abs).size, 0);
const MB = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

console.log('快照版本：' + VERSION);
console.log('会装 ' + files.length + ' 个文件 · ' + MB(totalBytes));
if (skippedHeavy.length) {
  console.log('  ⚠ 跳过 ' + skippedHeavy.length + ' 个大素材（不是我们改的，且无人引用；要装加 --with-assets）：');
  for (const s of skippedHeavy.slice(0, 6)) console.log('      ' + s);
}
if (DRY) {
  console.log('\n（演练）输出：' + ZIP);
  const byTop = {};
  for (const f of files) {
    const top = f.rel.split(/[\\/]/)[0];
    byTop[top] = (byTop[top] || 0) + fs.statSync(f.abs).size;
  }
  for (const [k, v] of Object.entries(byTop).sort((a, b) => b[1] - a[1])) console.log('  ' + MB(v).padStart(10) + '  ' + k);
  process.exit(0);
}

/* ---------------- 组装 ---------------- */
fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const f of files) {
  const dst = path.join(STAGE, f.rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(f.abs, dst);
}

/* ---------------- 版本清单 + 校验和 ---------------- */
const manifest = {
  product: 'Xiodra 工作台',
  version: VERSION,
  builtAt: new Date().toISOString(),
  purpose: '回滚点（不是对外发布包）',
  includesSessions: WITH_SESSIONS,
  includesHeavyAssets: WITH_ASSETS,
  skippedHeavyAssets: skippedHeavy,
  fileCount: files.length,
  totalBytes,
  note: [
    '解压后直接盖回工作台根即可回滚。',
    '本条不含：引擎\\（上游）、任何 node_modules、electron-profile、captures、_临时。',
    'node_modules 需按 package.json 重装（外壳 与 MCP\\mcp-iconfont 各一份）。',
    'MCP\\mcp-iconfont\\dist\\iconfont.js 已是打补丁版；升级社区包后必须重跑 工具\\mcp-iconfont补丁.mjs。',
    'skippedHeavyAssets 里的启动动画 mp4 未打包（无人引用）；需要时从原目录拷回或用 --with-assets 重打。',
  ],
};
fs.writeFileSync(path.join(STAGE, '版本.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const sums = [];
const walkAll = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { walkAll(abs); continue; }
    const r = path.relative(STAGE, abs);
    if (r === 'SHA256SUMS') continue;
    sums.push(crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') + '  ' + r.replace(/\\/g, '/'));
  }
};
walkAll(STAGE);
sums.sort();
fs.writeFileSync(path.join(STAGE, 'SHA256SUMS'), sums.join('\n') + '\n', 'utf8');
console.log('✓ 校验和：' + sums.length + ' 条');

/* ---------------- 压 zip ---------------- */
if (fs.existsSync(ZIP)) fs.rmSync(ZIP, { force: true });
try {
  execFileSync('tar', ['-a', '-c', '-f', ZIP, '-C', OUT, NAME], { stdio: 'inherit' });
  console.log('✓ 打好：' + ZIP + '（' + MB(fs.statSync(ZIP).size) + '）');
} catch (e) {
  console.error('✗ 打包失败：' + e.message);
  process.exit(2);
}
console.log('  目录版（可核对）：' + STAGE);
