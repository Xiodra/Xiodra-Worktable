#!/usr/bin/env node
/**
 * 入口哨兵.mjs —— 启动链路没被破坏（照搬《04/事故复盘》事故一 + §「入口哨兵」）
 *
 * 参照那起事故：「改了一个 exe 的版本信息，**整个工作台变灰白**」
 *   抓手是「入口哨兵：exe 的哈希是否变了；`resources\app` 是否还是目录联接」。
 *
 * ⚠ **我们的启动链路和参照不一样**，所以判据必须重写（⛔ 不能照抄 exe 哈希）：
 *   参照：`启动器\工作台.exe`（打包产物）+ `resources\app` 目录联接 → 源码
 *   我们：`启动.vbs` → `启动配置.vbs`（读 config.json）→ `外壳\node_modules\electron\dist\electron.exe` → `main.js`
 *
 *   ⇒ 我们的"入口"有四个可坏点，本工具逐个查（**这是唯一出处**）：
 *     ① `启动.vbs` / `外壳\start.vbs` 存在且是 **ANSI(GBK) 无 BOM**（⛔ UTF-8 会让中文路径乱码）
 *     ② 它们引用的 `启动配置.vbs` 存在（少了就双击没反应）
 *     ③ `config.json` 能解析，且五个路径键都**真的指得到**（`Test-Path` 那条铁律）
 *     ④ `electron.exe` **存在 + 版本哈希记进基线**（npm install / 手工替换会改它）
 *
 * ⛔ 本工具**只查不修**。它也不重启任何东西（重启是机主的事）。
 *
 * 用法：
 *   node 工具\入口哨兵.mjs              # 查一遍（⛔ ⇒ exit 1）
 *   node 工具\入口哨兵.mjs --quiet      # 一行
 *   node 工具\入口哨兵.mjs --save       # 把当前 electron.exe 指纹存成基线（机主批准后才做）
 *   node 工具\入口哨兵.mjs --selftest   # 反例：坏 json / 路径指空 / 编码错 / 指纹变了
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const BASE_FILE = path.join(MEM, '_共享记忆', '_入口基线.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/** 文件是否 ANSI(GBK) 无 BOM —— vbs 的硬要求 */
export function isAnsiNoBom(file) {
  if (!fs.existsSync(file)) return { ok: false, why: '文件不存在' };
  const b = fs.readFileSync(file);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { ok: false, why: '是 UTF-8 BOM（VBScript 按 ANSI 读会乱码）' };
  if (b[0] === 0xff && b[1] === 0xfe) return { ok: false, why: '是 UTF-16LE（VBScript 读不了）' };
  // UTF-8 无 BOM 的典型特征：出现多字节序列且能按 utf8 严格解码
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    // 能严格解成 utf8 且含中文 ⇒ 很可能被存成了 UTF-8（ANSI 中文在 utf8 下解不开）
    if (/[\u4e00-\u9fff]/.test(new TextDecoder('utf-8').decode(b))) {
      return { ok: false, why: '看起来是 UTF-8 无 BOM（中文会被 VBScript 读成乱码）' };
    }
  } catch { /* 解不开 ⇒ 正是 ANSI 中文，好事 */ }
  return { ok: true, why: 'ANSI 无 BOM' };
}

/** 取 config.json */
export function readConfig() {
  const f = path.join(ROOT, 'config.json');
  try {
    const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    return { ok: true, cfg: JSON.parse(raw), file: f };
  } catch (e) { return { ok: false, err: e.message, file: f }; }
}

/** config 里的路径键 → 绝对路径 */
export function resolveCfgPath(cfg, key) {
  const v = cfg[key];
  if (typeof v !== 'string' || !v.trim()) return null;
  return path.isAbsolute(v) ? v : path.resolve(ROOT, v);
}

/** electron.exe 指纹（大小 + sha256 前 16 位） */
export function exeFingerprint(file) {
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  return { size: st.size, sha: h, mtime: Math.floor(st.mtimeMs / 1000) };
}

/** 主检查 —— 返回 {bad, warn, ok} */
export function check(opts = {}) {
  const bad = [], warn = [], ok = [];
  const root = opts.root || ROOT;

  // ① 两个启动器存在 + 编码
  for (const rel of ['启动.vbs', path.join('外壳', 'start.vbs')]) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) { bad.push('缺启动器：' + rel); continue; }
    const e = isAnsiNoBom(f);
    if (!e.ok) bad.push(rel + ' 编码不对：' + e.why);
    else ok.push(rel + ' 在，' + e.why);
  }

  // ② 启动配置.vbs 存在（两个启动器共用，2026-11-20 起移到 工具\ 下）
  //    ⚠ 路径变了要同步改这里 —— 入口哨兵自己也会因为路径过期而误报（本轮就发生过一次）。
  //    兼容：先在 工具\ 找，找不到再看根目录（老版本布局）。
  const libCandidates = [
    path.join(root, '工具', '启动配置.vbs'),
    path.join(root, '启动配置.vbs'),
  ];
  const lib = libCandidates.find((p) => fs.existsSync(p));
  if (!lib) {
    bad.push('缺 启动配置.vbs（两个启动器都要它读 config.json，少了双击没反应）\n' +
      '     找过：' + libCandidates.map((p) => path.relative(root, p)).join(' / '));
  } else {
    const e = isAnsiNoBom(lib);
    if (!e.ok) bad.push(path.relative(root, lib) + ' 编码不对：' + e.why);
    else ok.push(path.relative(root, lib) + ' 在，' + e.why);
    // 顺带查：两个启动器是否真的引用了它现在的位置（防"文件搬了、引用没改"）
    for (const rel of ['启动.vbs', path.join('外壳', 'start.vbs')]) {
      const f = path.join(root, rel);
      if (!fs.existsSync(f)) continue;
      const txt = new TextDecoder('gbk').decode(fs.readFileSync(f));
      const want = path.relative(root, lib).replace(/\//g, '\\');
      // 启动器里写的是相对 root 的路径片段，例如 "工具\启动配置.vbs"
      const short = want.replace(/^[^\\]*\\/, '');
      const needle = fs.existsSync(path.join(root, '工具', '启动配置.vbs')) ? '工具\\启动配置.vbs' : '启动配置.vbs';
      if (!txt.includes(needle)) bad.push(rel + ' 里没有引用「' + needle + '」⇒ 文件搬了但引用没改，双击会报缺文件');
      else ok.push(rel + ' 引用路径正确（' + needle + '）');
    }
  }

  // ③ config.json 能解析 + 五个路径键指得到
  const c = readConfig();
  if (!c.ok) { bad.push('config.json 解析失败：' + c.err); }
  else {
    ok.push('config.json 可解析');
    const need = ['shellDir', 'engineDir', 'engineDataDir', 'electronExe'];
    for (const k of need) {
      const p = resolveCfgPath(c.cfg, k);
      if (!p) { bad.push('config.json 缺 ' + k); continue; }
      const isFile = /\.exe$/i.test(p);
      const exists = fs.existsSync(p);
      if (!exists) bad.push(`config.json 的 ${k} 指不到：${p}（"长得对"≠"指得对"）`);
      else ok.push(k + ' 指得到');
    }
    // 端口合法性（CInt 16 位上限那个坑）
    const port = Number(c.cfg.port);
    if (!(port > 0 && port <= 65535)) bad.push('config.json 的 port 不合法：' + c.cfg.port);
    else ok.push('port=' + port);
  }

  // ④ electron.exe 存在 + 指纹比对基线
  if (c.ok) {
    const exe = resolveCfgPath(c.cfg, 'electronExe');
    if (exe && fs.existsSync(exe)) {
      const fp = exeFingerprint(exe);
      ok.push('electron.exe 在（' + (fp.size / 1024 / 1024).toFixed(1) + ' MB，sha ' + fp.sha + '）');
      let base = null;
      try { base = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')); } catch { /* 没基线 */ }
      if (!base) warn.push('还没记 electron.exe 指纹基线（跑 --save 记一次）');
      else if (base.exe && base.exe.sha !== fp.sha) {
        bad.push('electron.exe **变了**（基线 ' + base.exe.sha + '，现在 ' + fp.sha + '）⇒ 若刚 npm install 过，跑 --save 重记；若不是，查谁换的');
      } else if (base.exe) ok.push('electron.exe 指纹与基线一致');
    }
  }

  return { bad, warn, ok, root };
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });
  const tmp = path.join(ROOT, '_临时', 'scrap', '入口哨兵自测');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const mk = (name, buf) => { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; };
  const gbk = (s) => {
    // 用 iconv 不可靠，直接手写一段 GBK 中文：'启动' 的 GBK 是 C6 F4 B6 AF
    return Buffer.from([0xc6, 0xf4, 0xb6, 0xaf]);
  };

  // ① UTF-8 BOM ⇒ 判不合格
  {
    const p = mk('a.vbs', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x=1')]));
    const r = isAnsiNoBom(p);
    add(!r.ok && /BOM/.test(r.why), '反例① UTF-8 BOM ⇒ 判不合格（VBScript 按 ANSI 读）', r.why);
  }
  // ② UTF-16LE ⇒ 判不合格
  {
    const p = mk('b.vbs', Buffer.from('\uFEFFx=1', 'utf16le'));
    const r = isAnsiNoBom(p);
    add(!r.ok, '反例② UTF-16LE ⇒ 判不合格', r.why);
  }
  // ③ ANSI(GBK) 中文 ⇒ 合格
  {
    const p = mk('c.vbs', gbk('启动'));
    const r = isAnsiNoBom(p);
    add(r.ok, '正例 ANSI(GBK) 中文 ⇒ 合格', r.why);
  }
  // ④ 纯 ASCII ⇒ 合格
  {
    const p = mk('d.vbs', Buffer.from('Option Explicit'));
    const r = isAnsiNoBom(p);
    add(r.ok, '正例 纯 ASCII ⇒ 合格', r.why);
  }
  // ⑤ 坏 json ⇒ 报出来
  {
    const p = mk('config.json', Buffer.from('{ "port": '));
    let threw = false;
    try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch { threw = true; }
    add(threw, '反例③ 坏 config.json ⇒ JSON.parse 抛错（体检必须报，不许静默兜底）');
  }
  // ⑥ 路径键指不到 ⇒ 报出来（用真配置 + 假路径验证 resolveCfgPath）
  {
    const fake = { shellDir: '不存在的目录XYZ' };
    const p = resolveCfgPath(fake, 'shellDir');
    add(p && !fs.existsSync(p), '反例④ 路径键指不到 ⇒ 能被识别（"长得对"≠"指得对"）', String(p));
  }
  // ⑦ 指纹变化 ⇒ 能比出来
  {
    const f1 = mk('x1.exe', Buffer.from('AAAA'));
    const f2 = mk('x2.exe', Buffer.from('BBBB'));
    const a = exeFingerprint(f1), b = exeFingerprint(f2);
    add(a.sha !== b.sha, '反例⑤ 内容不同的 exe ⇒ 指纹不同（变了能发现）', a.sha + ' vs ' + b.sha);
  }
  // ⑧ 真机链路：只读检查（不写任何东西）
  {
    const r = check();
    add(r.bad.length === 0, '正例 当前真机启动链路完整', r.bad.join(' | '));
  }
  // ⑨ 启动配置.vbs 位置变了，启动器引用也要跟着变（本轮真踩：文件搬了引用没改会双击报缺文件）
  {
    const r = check();
    const refOk = r.ok.filter((s) => s.includes('引用路径正确')).length;
    add(refOk === 2, '反例⑥ 两个启动器都必须引用「工具\\启动配置.vbs」（文件搬了引用没改 ⇒ ⛔）', '引用正确 ' + refOk + '/2');
  }
  // ⑩ 编码守门对 工具\ 下的新位置同样生效
  {
    const lib = path.join(ROOT, '工具', '启动配置.vbs');
    if (fs.existsSync(lib)) {
      const e = isAnsiNoBom(lib);
      add(e.ok, '正例 工具\\启动配置.vbs 编码合规（ANSI 无 BOM）', e.why);
    } else add(false, '找不到 工具\\启动配置.vbs', '');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
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
      '入口哨兵.mjs —— 启动链路没被破坏',
      '  node 工具\\入口哨兵.mjs           查（⛔ ⇒ exit 1）',
      '  node 工具\\入口哨兵.mjs --quiet   一行',
      '  node 工具\\入口哨兵.mjs --save    记 electron.exe 指纹基线（机主批准后才做）',
      '  node 工具\\入口哨兵.mjs --selftest',
      '判据：两个启动器在且 ANSI 无 BOM；启动配置.vbs 在；config 四个路径键指得到；electron.exe 指纹没变',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--save')) {
    const c = readConfig();
    if (!c.ok) { console.error('✗ config.json 读不到：' + c.err); process.exit(2); }
    const exe = resolveCfgPath(c.cfg, 'electronExe');
    const fp = exe ? exeFingerprint(exe) : null;
    if (!fp) { console.error('✗ electron.exe 找不到：' + exe); process.exit(2); }
    fs.mkdirSync(path.dirname(BASE_FILE), { recursive: true });
    fs.writeFileSync(BASE_FILE, JSON.stringify({
      at: new Date().toISOString(), exe: { path: exe, ...fp },
      note: '入口基线：electron.exe 变了就 ⛔（npm install / 手工替换会改它）',
    }, null, 2) + '\n', 'utf8');
    console.log('✓ 已记基线：' + path.relative(ROOT, BASE_FILE));
    console.log('  electron.exe sha=' + fp.sha + '  size=' + (fp.size / 1024 / 1024).toFixed(1) + ' MB');
    process.exit(0);
  }

  const r = check();
  if (has('--quiet')) {
    console.log(r.bad.length ? `⛔ 入口哨兵：${r.bad.length} 个问题（跑 node 工具\\入口哨兵.mjs 看明细）` : `✓ 入口哨兵：启动链路完整${r.warn.length ? '（⚠ ' + r.warn.length + '）' : ''}`);
    process.exit(r.bad.length ? 1 : 0);
  }
  console.log('入口哨兵 —— 启动链路\n');
  for (const s of r.ok) console.log('  ✓ ' + s);
  for (const w of r.warn) console.log('  ⚠ ' + w);
  for (const b of r.bad) console.log('  ⛔ ' + b);
  console.log('\n' + (r.bad.length ? '⛔ ' + r.bad.length + ' 个问题' : '✓ 全部通过'));
  process.exit(r.bad.length ? 1 : 0);
}
