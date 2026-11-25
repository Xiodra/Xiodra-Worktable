// main.js —— XIODRA 工作台外壳（纯 JS）
// 当前阶段：**拉起 DSH 引擎进它的 Web UI** + **场景体系**（scenarios\*.json → 标签栏 → 面板网格）+ **控制器场景**。
// 会话绑定、其余面板类型这些后续再长。
//
// 设计跟参照项目一致：壳与引擎只通过 HTTP + token 认识对方，互不 import。
const { app, BrowserWindow, Menu, shell, ipcMain, session, dialog, webContents } = require('electron');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ==================== 零、工作台配置（config.json）====================
// 端口 / 引擎目录 / 数据目录 / 窗口尺寸 / 启动预算 / 日志上限都写在 <工作台根>\config.json。
// `启动.vbs` 与 `外壳\start.vbs` 同样读这份文件（它们把端口与数据目录塞进环境变量），
// 这里再读一遍是为了让「直接 electron . 」这种手工启动也走同一套参数，三处不会各说各话。
//
// ⚠ 读不到 / 写坏了**不报错**，全部退回兜底值：配置文件有问题不该让整个工作台打不开。
//    真需要排查时看 server.log 开头那几行（config = / engineDir = / port = / dshHome =）。
const WORKBENCH_ROOT = path.dirname(__dirname);
const CONFIG_FILE = path.join(WORKBENCH_ROOT, 'config.json');

const CFG = (function () {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    return {};
  }
})();
const CFG_OK = Object.keys(CFG).length > 0;

// 支持 "a.b.c" 这种点号取嵌套值
function cfgGet(dotted) {
  let o = CFG;
  const keys = String(dotted).split('.');
  for (let i = 0; i < keys.length; i++) {
    if (!o || typeof o !== 'object') return undefined;
    o = o[keys[i]];
  }
  return o;
}
// 取数字（配置里写字符串 "33083" 也认）；不合法就用兜底
function cfgNum(dotted, fallback) {
  const v = Number(cfgGet(dotted));
  return (isFinite(v) && v > 0) ? v : fallback;
}
// 取路径：相对路径按「工作台根目录」解析，绝对路径原样用
function cfgPath(dotted, fallback) {
  const v = cfgGet(dotted);
  if (typeof v !== 'string' || !v.trim()) return fallback;
  return path.isAbsolute(v) ? v : path.resolve(WORKBENCH_ROOT, v);
}

// ==================== 一、常量与路径 ====================
// 端口：优先环境变量（`启动.vbs` 从 config.json 读出来塞进来的），其次 config.json，最后 33083
// （避开默认 3080，不撞别人正在跑的引擎）
const DSH_PORT = String(process.env.DSH_PORT || cfgNum('port', 33083));
const BASE = 'http://127.0.0.1:' + DSH_PORT;

// 把外壳目录暴露出去（preload / 渲染层读 data\ 下的文件时用）
process.env.DSH_SHELL_DIR = __dirname;

// Windows 任务栏身份：**必须在 app ready 之前**设置，否则任务栏显示成「Electron」+ 原子图标
app.setAppUserModelId('xiodra.workbench');

// 引擎目录：**优先按「与本工作台同级」推导**（换电脑 / 换盘符都不用改代码）
// 引擎的判定标志是 apps\cli\lib\bin.js —— 只判断目录存在不够，空目录会误判。
const HARNESS_DIR = (function () {
  const sibling = path.join(path.dirname(__dirname), '引擎');
  // 配置里写了 engineDir 就用它（相对路径按工作台根目录解析）
  const fromCfg = cfgPath('engineDir', '');
  if (fromCfg) {
    try { if (fs.existsSync(path.join(fromCfg, 'apps', 'cli'))) return fromCfg; } catch (e) { /* ignore */ }
  }
  try {
    if (fs.existsSync(path.join(sibling, 'apps', 'cli'))) return sibling;
  } catch (e) { /* ignore */ }
  return fromCfg || sibling;
})();

// 已构建的 CLI 入口：直跑它可跳过 cmd.exe → pnpm → tsx 三层转译，启动快很多
const CLI_BUILT = path.join(HARNESS_DIR, 'apps', 'cli', 'lib', 'bin.js');

const NPM_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');

// pnpm 位置各机器不一样（本机在 %LOCALAPPDATA%\pnpm\bin，参照机在 %APPDATA%\npm）。
// 找不到就不排 pnpm 兜底 —— 否则失败日志里只剩一句"pnpm.cmd 不是内部或外部命令"，
// 掩盖了真正的失败原因。
const PNPM_CMD = (function () {
  const cands = [
    path.join(os.homedir(), 'AppData', 'Local', 'pnpm', 'bin', 'pnpm.cmd'),
    path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'bin', 'pnpm.cmd'),
    path.join(NPM_BIN, 'pnpm.cmd'),
    path.join(HARNESS_DIR, 'node_modules', '.bin', 'pnpm.cmd')
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { /* next */ }
  }
  return '';
})();

// 引擎数据目录（DSH_HOME）解析顺序 —— 无论用户双击哪个启动器都不能落到 C 盘：
//   ① <工作台根>\引擎数据\.dsh  ← 本项目自己的数据，**目录存在就优先**（最硬的一条）
//   ② 环境变量 DSH_CUSTOMER_HOME（`启动.vbs` 会设）
//   ③ 环境变量 DSH_HOME
//   ④ <引擎>\.dsh（引擎默认位置，只在前面都不存在时兜底）
// ⚠ 为什么把 ① 放在环境变量前面（2026-11-16 实测）：`外壳\start.vbs` 只跑 electron，
//   不设任何 DSH_* 变量。如果是从别的 DSH 会话里双击启动，父进程的 DSH_HOME
//   （= C:\Users\<user>\.dsh）会原样继承下来，引擎就去读别人的 profiles ——
//   实测撞上 `skipping profile bundle "dsh-worktable": incompatible` 并且会话集体对不上。
//   本地有 引擎数据\.dsh 就说明这是自带数据的工作台，必须用它。
const DSH_HOME = (function () {
  const workbenchRoot = path.dirname(__dirname);
  // ① config.json 里写死的 engineDataDir（最硬：改配置就能换数据目录）
  const fromCfg = cfgPath('engineDataDir', '');
  if (fromCfg) {
    try { if (fs.existsSync(fromCfg)) return fromCfg; } catch (e) { /* ignore */ }
  }
  // ② <工作台根>\引擎数据\.dsh —— 本项目自带的数据，目录存在就优先
  const localHome = path.join(workbenchRoot, '引擎数据', '.dsh');
  try { if (fs.existsSync(localHome)) return localHome; } catch (e) { /* ignore */ }
  // ③ 环境变量（启动.vbs / start.vbs 会把配置里的值设进来）
  const fromEnv = process.env.DSH_CUSTOMER_HOME || process.env.DSH_HOME;
  if (fromEnv) return fromEnv;
  // ④ 引擎默认位置，只在前面都不存在时兜底
  return path.join(HARNESS_DIR, '.dsh');
})();

const LOG_FILE = path.join(__dirname, 'server.log');
const LOG_PREV = path.join(__dirname, 'server.log.prev');
const LOG_MAX_BYTES = Math.round(cfgNum('boot.logMaxBytes', 4 * 1024 * 1024));

// 场景目录：一个场景 = 一个 json 文件，文件名必须等于里面的 id。
// 加场景 = 丢一个 json 进来，不用改代码（顶栏 ⟳ 就出现新标签）。
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
// 标签顺序的唯一权威存在主进程（交互层自己不存顺序，两份顺序迟早打架）
const SCENE_ORDER_FILE = path.join(__dirname, 'data', 'scene-tab-order.json');
// 控制器卡片「已确认熄光」的记账本
const CONSOLE_ACK_FILE = path.join(__dirname, 'data', 'console-ack.json');
// 面板自刷新通道的指令文件：脚本/面板往里写 "all" 或某个场景 id，主进程 500ms 轮询到就删掉它并广播重载
const RELOAD_CMD_FILE = path.join(__dirname, 'data', 'reload-panels.cmd');
/**
 * 面板自刷新的**回执文件**（2026-11-19 加）。
 *
 * 为什么要有它：`工具\刷新面板.mjs` 原来写完指令文件就结束了，**根本不知道有没有生效** ——
 * 这正是铁律里禁止的「投递成功 ≠ 已生效」。有了回执，脚本能确认"主进程真的广播了"。
 * 格式：`{ at, scope, seq, panels }`；主进程每次广播完就覆写它。
 * ⛔ 它是回执不是状态机：只记**最近一次**，不追历史（历史在 server.log 的 [reload] 行里）。
 */
const RELOAD_ACK_FILE = path.join(__dirname, 'data', 'reload-panels.ack.json');

// 引擎冷启动预算（秒）：本机实测 27–43s，重建 profile 时到 65s+。太贴边会出现
// 「慢一步就整轮判失败、转去跑 pnpm 兜底」，所以放到 120s。改 config.json 的 boot.budgetSec 即可调。
const BOOT_BUDGET_SEC = cfgNum('boot.budgetSec', 120);

// ==================== 二、日志 ====================
// 启动时轮转一次：超过 4MB 就把旧日志改名 server.log.prev（只留一份历史）
function rotateLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    try { fs.rmSync(LOG_PREV, { force: true }); } catch (e) { /* ignore */ }
    fs.renameSync(LOG_FILE, LOG_PREV);
  } catch (e) { /* 文件不存在或正被占用：忽略 */ }
}
rotateLog();

function log(line) {
  const s = '[main] ' + line;
  try { fs.appendFileSync(LOG_FILE, s + '\r\n'); } catch (e) { /* ignore */ }
}

// ==================== 三、数据盘隔离 ====================
// Electron 运行时数据（userData / session / localStorage / webview 分区）全部写到工作台目录内，
// **不许落 C 盘**。这两行必须在任何 app API 之前，否则分区已经按默认路径建好了。
const PROFILE_DIR = path.join(__dirname, 'data', 'electron-profile');
try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
try { app.setPath('userData', PROFILE_DIR); } catch (e) { /* ignore */ }
try { app.setPath('sessionData', path.join(PROFILE_DIR, 'sessions')); } catch (e) { /* ignore */ }

const DATA_DIR = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
const BOOT_FAIL_FILE = path.join(DATA_DIR, 'engine-boot-fail.json');

const THEME_FILE = path.join(DATA_DIR, 'theme.json');

// 主题设置的"出厂值"。渲染层拿到的一定是「出厂值 ⊕ 用户改动」的完整对象，
// 少一个键就补一个 —— 免得界面上出现 undefined 直接坏掉。
const THEME_DEFAULTS = {
  wallpaper: {
    path: '',          // 本机绝对路径（图片或视频）；空 = 没有壁纸
    kind: '',          // 'image' | 'video' | ''
    fit: 'cover',      // cover | contain | stretch
    opacity: 100,      // 壁纸整体不透明度 0..100
    blur: 0,           // 壁纸模糊 0..40 px
    dim: 30            // 压暗遮罩 0..90（壁纸太亮时让字读得清）
  },
  look: {
    mode: 'dark',      // 'dark' | 'light' —— 浅色/深色模式（2026-11-19 新增）
    accent: '',        // 主色；空 = 用 styles.css 里的默认蓝
    panelAlpha: 100,   // 面板底色不透明度 40..100
    blur: 0,           // 面板毛玻璃 0..24 px
    border: 100,       // 边框可见度 0..100
    radius: 10,        // 面板圆角 0..20 px
    font: '',          // 正文字体族；空 = 系统默认
    effect: 'beam'     // 面板特效：'beam' 边缘流光 | 'glow' 呼吸光环 | 'none' 无
  }
};

function clampNum(v, lo, hi, def) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function normalizeTheme(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const w = (o.wallpaper && typeof o.wallpaper === 'object') ? o.wallpaper : {};
  const k = (o.look && typeof o.look === 'object') ? o.look : {};
  const d = THEME_DEFAULTS;
  const p2 = typeof w.path === 'string' ? w.path : '';
  const kind = (typeof w.kind === 'string' && w.kind) ? w.kind : (p2 ? (/\.(mp4|webm|mov|m4v|ogv)$/i.test(p2) ? 'video' : 'image') : '');
  return {
    wallpaper: {
      path: p2,
      kind: p2 ? kind : '',
      fit: (w.fit === 'contain' || w.fit === 'stretch') ? w.fit : 'cover',
      opacity: clampNum(w.opacity, 0, 100, d.wallpaper.opacity),
      blur: clampNum(w.blur, 0, 40, d.wallpaper.blur),
      dim: clampNum(w.dim, 0, 90, d.wallpaper.dim)
    },
    look: {
      mode: (k.mode === 'light') ? 'light' : 'dark',
      accent: (typeof k.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(k.accent)) ? k.accent : '',
      panelAlpha: clampNum(k.panelAlpha, 40, 100, d.look.panelAlpha),
      blur: clampNum(k.blur, 0, 24, d.look.blur),
      border: clampNum(k.border, 0, 100, d.look.border),
      radius: clampNum(k.radius, 0, 20, d.look.radius),
      font: (typeof k.font === 'string') ? k.font.slice(0, 120) : '',
      // 面板特效三档（2026-11-23）：不在白名单里的值一律回落到 beam
      effect: (k.effect === 'glow' || k.effect === 'none' || k.effect === 'beam') ? k.effect : d.look.effect
    }
  };
}

function readTheme() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(THEME_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { raw = null; }
  return normalizeTheme(raw);
}

function writeTheme(t) {
  const norm = normalizeTheme(t);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(THEME_FILE, JSON.stringify(norm, null, 2) + '\n', 'utf8');
  } catch (e) {
    log('[theme] 写盘失败: ' + e.message);
    return { ok: false, err: e.message, theme: norm };
  }
  return { ok: true, theme: norm };
}

// 只接受深一层、且两段键都在白名单里的改动 —— 别让渲染层顺手改掉别的字段
function patchTheme(patch) {
  const cur = readTheme();
  const o = (patch && typeof patch === 'object') ? patch : {};
  if (o.wallpaper && typeof o.wallpaper === 'object') {
    for (const key of Object.keys(THEME_DEFAULTS.wallpaper)) {
      if (Object.prototype.hasOwnProperty.call(o.wallpaper, key)) cur.wallpaper[key] = o.wallpaper[key];
    }
  }
  if (o.look && typeof o.look === 'object') {
    for (const key of Object.keys(THEME_DEFAULTS.look)) {
      if (Object.prototype.hasOwnProperty.call(o.look, key)) cur.look[key] = o.look[key];
    }
  }
  return writeTheme(cur);
}


const APP_T0 = Date.now();
let mainWindow = null;
let serverProc = null;
let harnessToken = null;
let engineIsForeign = false;

// ==================== 四、启动进度广播 ====================
// 渲染层的启动页靠这个画进度条。所有窗口都收（将来有多窗口也不用改）。
let lastBoot = { stage: 'init', pct: 0, text: '准备中…', detail: '', ts: Date.now() };

function allWindows() {
  return BrowserWindow.getAllWindows().filter(function (w) {
    try { return w && !w.isDestroyed(); } catch (e) { return false; }
  });
}

function broadcast(channel, payload) {
  for (const w of allWindows()) {
    try { w.webContents.send(channel, payload); } catch (e) { /* ignore */ }
  }
}

function sendBoot(patch) {
  lastBoot = Object.assign({}, lastBoot, patch, { ts: Date.now() });
  try { broadcast('boot:progress', lastBoot); } catch (e) { /* ignore */ }
  return lastBoot;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function bumpBootFail() {
  let n = 0;
  try { n = Number(JSON.parse(fs.readFileSync(BOOT_FAIL_FILE, 'utf8')).count) || 0; } catch (e) { /* first */ }
  n += 1;
  try {
    fs.writeFileSync(BOOT_FAIL_FILE, JSON.stringify({ count: n, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  } catch (e) { /* ignore */ }
  return n;
}
function resetBootFail() {
  try {
    fs.writeFileSync(BOOT_FAIL_FILE, JSON.stringify({ count: 0, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  } catch (e) { /* ignore */ }
}

// ==================== 五、探测与 token ====================
// 只看"端口能不能应答 HTTP"，不看进程在不在 —— 引擎就绪的唯一判据是它能回话。
function probe() {
  return new Promise(function (resolve) {
    const req = http.get(BASE + '/', { timeout: 1500 }, function (res) {
      res.resume();
      resolve(true);
    });
    req.on('error', function () { resolve(false); });
    req.on('timeout', function () { req.destroy(); resolve(false); });
  });
}

// 引擎启动时会打印 `dsh web: http://127.0.0.1:<port>/?token=xxx`，从 stdout/stderr 里捞出来。
// 注意端口要跟着 DSH_PORT 走 —— 写死 3080 会永远捞不到。
function captureToken(text) {
  const re = new RegExp('http:\\/\\/127\\.0\\.0\\.1:' + DSH_PORT + '\\/\\?token=([A-Za-z0-9_\\-]+)');
  const m = String(text).match(re);
  if (m && m[1]) {
    harnessToken = m[1];
    log('[token] captured: ' + m[1]);
  }
}

// ⚠ 关键时序坑（2026-11-16 实测踩到）：端口开始监听 ≠ token 已经打印出来。
//   探测到端口活着就立刻放渲染层跳转，会跳到不带 token 的 `/`，引擎回
//   `dsh web authentication required` —— 界面一片"未授权"。
//   所以这里必须**等 token 真正到手**才认为可以进界面。
async function waitToken(ms) {
  const t0 = Date.now();
  while ((Date.now() - t0) < ms) {
    if (harnessToken) return true;
    // 兜底：进程输出可能落在别的流里，再从日志尾部捞一次
    if (!harnessToken) {
      try {
        const tail = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').slice(-4000) : '';
        captureToken(tail);
      } catch (e) { /* ignore */ }
    }
    if (harnessToken) return true;
    await sleep(150);
  }
  return !!harnessToken;
}

// ==================== 六、拉起引擎 ====================
// DSH_HOME 必须显式指向「引擎数据\.dsh」：
// 不设的话引擎默认用 <用户目录>\.dsh，历史会话在界面里会"集体消失"。
function serverSpawnEnv() {
  const env = Object.assign({}, process.env);
  env.Path = NPM_BIN + ';' + (env.Path || '');
  env.DSH_HOME = DSH_HOME;
  return env;
}

function wireServerProc(proc) {
  proc.stdout.on('data', function (d) { const s = String(d); captureToken(s); log('[out] ' + s.trim()); });
  proc.stderr.on('data', function (d) { const s = String(d); captureToken(s); log('[err] ' + s.trim()); });
  proc.on('exit', function (code) { log('[server exited] code=' + code); });
  return proc;
}

// 找一个能用的 node：优先系统 node；找不到就让 Electron 以纯 Node 模式跑自己
let cachedNodeExe = null;
function resolveNodeExe() {
  if (cachedNodeExe !== null) return cachedNodeExe;
  cachedNodeExe = '';
  if (process.env.DSH_NODE) {
    try { if (fs.statSync(process.env.DSH_NODE).isFile()) { cachedNodeExe = process.env.DSH_NODE; return cachedNodeExe; } } catch (e) { /* ignore */ }
  }
  const dirs = String(process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, 'node.exe');
    try { if (fs.statSync(p).isFile()) { cachedNodeExe = p; return cachedNodeExe; } } catch (e) { /* next */ }
  }
  log('[boot] 未找到系统 node，改用 Electron 的 Node 模式直跑');
  return cachedNodeExe;
}

// 方式一（首选）：直跑构建产物，无 cmd / 无 pnpm / 无 tsx
function spawnServerDirect() {
  const env = serverSpawnEnv();
  const nodeExe = resolveNodeExe();
  let cmd, args;
  if (nodeExe) {
    cmd = nodeExe;
    args = [CLI_BUILT, 'web', '--no-open', '--port', DSH_PORT];
  } else {
    env.ELECTRON_RUN_AS_NODE = '1';
    cmd = process.execPath;
    args = [CLI_BUILT, 'web', '--no-open', '--port', DSH_PORT];
  }
  log('[boot] direct: ' + cmd + ' ' + args.join(' '));
  return wireServerProc(spawn(cmd, args, {
    cwd: HARNESS_DIR,
    env: env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

// 方式二（兜底）：走 pnpm 脚本（tsx 实时转译，慢但兼容性最好）
function spawnServerPnpm() {
  log('[boot] pnpm: ' + PNPM_CMD + ' dsh web --no-open --port ' + DSH_PORT);
  return wireServerProc(spawn('cmd.exe', ['/c', PNPM_CMD + ' dsh web --no-open --port ' + DSH_PORT], {
    cwd: HARNESS_DIR,
    env: serverSpawnEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

function killServer() {
  if (!serverProc) return;
  try { spawnSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { /* ignore */ }
  log('[boot] 已结束引擎进程 pid=' + serverProc.pid);
  serverProc = null;
}

// 主流程：已就绪就复用，否则按两种方式依次试
async function startServer() {
  sendBoot({ stage: 'check', pct: 6, text: '检查引擎状态…', detail: 'http://127.0.0.1:' + DSH_PORT });

  if (await probe()) {
    log('reuse: port ' + DSH_PORT + ' already listening');
    engineIsForeign = true;
    // 端口已在监听时，token 只能尝试从日志历史里找（仅当"我们自己曾拉起过它"时才对）
    if (!harnessToken) {
      const hist = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
      const m = hist.match(/token=([A-Za-z0-9_\-]+)/);
      if (m) harnessToken = m[1];
    }
    sendBoot({ stage: 'wait', pct: 88, text: '正在建立引擎会话…', detail: '复用正在运行的实例' });
    await primeAuthCookie();
    sendBoot({ stage: 'ready', pct: 92, text: '引擎已就绪', detail: '复用正在运行的实例' });
    resetBootFail();
    openReadyGate();
    return true;
  }

  // 引擎目录 / CLI 产物必须先过关，否则后面全是"启动失败"但看不出原因
  if (!fs.existsSync(CLI_BUILT)) {
    log('[boot] 找不到 CLI 产物：' + CLI_BUILT + ' ⇒ 引擎可能没 build');
    sendBoot({
      stage: 'error', pct: 100, text: '找不到引擎构建产物',
      detail: '期望文件：' + CLI_BUILT + '（先在 引擎 目录跑 install + build）'
    });
    return false;
  }

  // 预算按实测放宽：本机冷启动 27–43s（首启会重建 profile，波动很大）。
  // 45s 太贴边，实测出现过"慢一步就整轮判失败、转去跑 pnpm 兜底"。
  const plans = [
    { label: '内置入口', detail: 'apps/cli/lib/bin.js（跳过 pnpm / tsx）', run: spawnServerDirect, budget: BOOT_BUDGET_SEC }
  ];
  // pnpm 兜底只在真的装了 pnpm 时才排进队列（本机可能没有，排进去只会多一条误导日志）
  if (PNPM_CMD) {
    plans.push({ label: 'pnpm 脚本', detail: 'pnpm dsh web（tsx 转译，兜底）', run: spawnServerPnpm, budget: BOOT_BUDGET_SEC });
  }

  for (const plan of plans) {
    sendBoot({ stage: 'spawn', pct: 12, text: '正在启动 Harness 引擎…', detail: plan.detail });
    serverProc = plan.run();
    const proc = serverProc;
    const t0 = Date.now();

    while ((Date.now() - t0) < plan.budget * 1000) {
      await sleep(300);   // 300ms 轮询：就绪后最多 0.3s 就进下一步
      if (await probe()) {
        // 端口通了还要等 token 打印出来，否则界面会跳进"未授权"页
        sendBoot({ stage: 'wait', pct: 90, text: '引擎已响应，正在取访问令牌…', detail: plan.detail });
        await waitToken(8000);
        // 拿到 token 后必须先在主进程里把 auth cookie 种好，界面才进得去
        if (harnessToken) {
          sendBoot({ stage: 'wait', pct: 95, text: '正在建立引擎会话…', detail: plan.detail });
          await primeAuthCookie();
        }
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log('engine ready in ' + secs + 's via ' + plan.label + (harnessToken ? '' : '（⚠ 未取到 token）'));
        sendBoot({
          stage: 'ready', pct: 92,
          text: harnessToken ? '引擎已就绪，正在加载界面…' : '引擎已就绪（未取到令牌）',
          detail: plan.label + ' · ' + secs + 's'
        });
        resetBootFail();
        openReadyGate();
        return true;
      }
      if (proc.exitCode !== null) {
        log(plan.label + ' exited early (code=' + proc.exitCode + ')');
        sendBoot({ stage: 'spawn', pct: 14, text: '该方式未成功，正在尝试兜底…', detail: plan.label + ' 退出（code ' + proc.exitCode + '）' });
        break;
      }
      const el = (Date.now() - t0) / 1000;
      const pct = Math.min(88, 14 + Math.round((el / plan.budget) * 74));
      sendBoot({ stage: 'wait', pct: pct, text: '引擎启动中…', detail: plan.detail + ' · ' + el.toFixed(0) + 's' });
    }
    killServer();
  }

  const n = bumpBootFail();
  log('[engine] start failed, consecutive=' + n);
  sendBoot({
    stage: 'error', pct: 100, text: '引擎启动失败',
    detail: '日志：' + LOG_FILE + '（连续失败 ' + n + ' 次）'
  });
  return false;
}

// ==================== 七、鉴权与引擎地址 ====================
// ⚠ 第二个时序/机制坑（2026-11-16 实测踩到）：
//   引擎的 `?token=` 不是"把 token 拼进地址就能一直用"，它是 303 重定向 + Set-Cookie：
//     GET /?token=xxx  →  303 Location: ./  +  Set-Cookie: dsh-auth--xxxx=...
//   直接让**渲染层**从 file:// 页面跳到这个地址，Electron 里这条 Set-Cookie 会丢，
//   落地页就成了引擎的 `dsh web authentication required` 白字页。
//   正确做法：主进程先用**同一个 session** 把这次请求跑完（cookie 落进 partition），
//   再让 webview 加载不带 token 的 `/`，cookie 自然带上。
//
// ⚠ 注意 session 必须选对：引擎界面现在跑在 <webview partition="persist:harness"> 里，
//   那是**独立的 session**，和 defaultSession 不共享 cookie。种到 defaultSession 里等于白种。
const WEBVIEW_PARTITION = 'persist:harness';

// 哪些分区已经种好 cookie（主引擎界面 + 每个 AI 面板各自的分区）
const primedPartitions = new Set();
let authPrimed = false;

// 给指定分区种鉴权 cookie。partition 省略时是主引擎界面那个分区。
// ⚠ 每个带会话绑定的 AI 面板有**自己的分区**（persist:ai-panel-<面板id>），
//   必须逐分区各种一份，种到别人分区等于白种。
async function primeAuthCookie(partition) {
  const part = partition || WEBVIEW_PARTITION;
  if (!harnessToken) return false;
  if (primedPartitions.has(part)) return true;
  if (part === WEBVIEW_PARTITION && authPrimed) return true;
  let ses;
  try { ses = session.fromPartition(part); } catch (e) { ses = session.defaultSession; }
  try {
    // 1) 让主进程替我们跑完 token → 303 → Set-Cookie 这条链，cookie 落进 webview 那个分区
    const res = await ses.fetch(BASE + '/?token=' + harnessToken, { redirect: 'follow' });
    const cookies = await ses.cookies.get({ url: BASE + '/' });
    const auth = cookies.find(function (c) { return /^dsh-auth/i.test(c.name); });
    if (!auth) {
      log('[auth] prime part=' + part + ' status=' + res.status + ' 但没拿到 dsh-auth cookie');
      return false;
    }

    // 2) ⚠ 引擎发的 cookie 是 SameSite=Strict。webview 首次导航的来源是 about:blank / file://，
    //    属于跨站导航，Strict cookie 不会被带上 —— 结果就是首页照旧 401「authentication required」。
    //    cookie 的值本身没问题，把它按 SameSite=Lax 重登记一份即可（Lax 允许顶级导航携带）。
    await ses.cookies.set({
      url: BASE + '/',
      name: auth.name,
      value: auth.value,
      domain: auth.domain,
      path: auth.path || '/',
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: auth.expirationDate
    });

    const after = await ses.cookies.get({ url: BASE + '/' });
    const fixed = after.find(function (c) { return c.name === auth.name; });
    const ok = res.ok && !!fixed && fixed.sameSite === 'lax';
    if (ok) primedPartitions.add(part);
    if (part === WEBVIEW_PARTITION) authPrimed = ok;
    log('[auth] partition=' + part + ' status=' + res.status + ' cookie=' + auth.name.slice(0, 24) + '… sameSite=' + (fixed ? fixed.sameSite : 'missing'));
    return ok;
  } catch (e) {
    log('[auth] prime part=' + part + ' failed: ' + ((e && e.message) || e));
    return false;
  }
}

// ==================== 七之二、引擎地址 ====================
// 已经种好 cookie 就进干净的 `/`；否则退化成带 token 的地址（尽力而为）
function engineUrl() {
  if (authPrimed) return BASE + '/';
  return harnessToken ? (BASE + '/?token=' + harnessToken) : (BASE + '/');
}

// ⚠ 第三个时序坑：把"拿到 token"当成"可以进界面"是错的。
//   渲染层每 500ms 问一次 harness:ready，只要 token 有值就会立刻跳 ——
//   而那一刻 primeAuthCookie 还没跑完，跳过去必然 401（实测就在 24.5s 跳了，
//   引擎其实 35.1s 才真正就绪）。
//   所以「可进界面」只认这个闸门：cookie 种好之后才置 true。
let engineEnterable = false;
function openReadyGate() {
  engineEnterable = true;
  broadcast('harness:ready', { url: engineUrl() });
}

// ==================== 七之三、场景体系 ====================
// 一个场景 = scenarios\<id>.json。字段（与文档 / 参照项目一致）：
//   id*（必须等于文件名） name*（标签文字） description  icon（标签图标，图片路径或 emoji）
//   panels*（数组，顺序=渲染顺序） cols（默认 4） first（true 的场景固定排最前）
// 只给元信息的精简列表给标签栏用；完整 json 由 scenario:get 按需取（面板多时不占带宽）。
function readSceneOrder() {
  try {
    const j = JSON.parse(fs.readFileSync(SCENE_ORDER_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(j.order) ? j.order.filter(function (x) { return typeof x === 'string'; }) : [];
  } catch (e) { return []; }
}

function writeSceneOrder(order) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SCENE_ORDER_FILE, JSON.stringify({ order: order, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) { log('[scene] 写顺序失败: ' + ((e && e.message) || e)); return false; }
}

// 按 data\scene-tab-order.json 重排；没登记的保持字典序排在后面。
// first=true 的场景永远在最前（那是常驻的引擎场景，位置不许被拖乱）。
function applySceneOrder(list) {
  const order = readSceneOrder();
  const rank = function (id) { const i = order.indexOf(id); return i < 0 ? 9999 : i; };
  const sorted = list.slice().sort(function (a, b) {
    const ra = rank(a.id), rb = rank(b.id);
    if (ra !== rb) return ra - rb;
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted.filter(function (s) { return s.first; }).concat(sorted.filter(function (s) { return !s.first; }));
}

function listScenarios() {
  const out = [];
  try {
    if (!fs.existsSync(SCENARIOS_DIR)) return out;
    for (const f of fs.readdirSync(SCENARIOS_DIR).sort()) {
      if (f.startsWith('_')) continue;          // _模板-*.json 之类不参与
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf8').replace(/^\uFEFF/, ''));
        if (!s || !s.id) continue;
        out.push({
          id: s.id,
          name: s.name || s.id,
          description: s.description || '',
          icon: s.icon || '',
          first: !!s.first,
          panelCount: Array.isArray(s.panels) ? s.panels.length : 0
        });
      } catch (e) { log('[scene] 读不动 ' + f + ': ' + ((e && e.message) || e)); }
    }
  } catch (e) { log('[scene] 扫目录失败: ' + ((e && e.message) || e)); }
  return applySceneOrder(out);
}

function getScenario(id) {
  const safe = String(id || '').replace(/[\\/:*?"<>|]/g, '');
  if (!safe) return null;
  const f = path.join(SCENARIOS_DIR, safe + '.json');
  try {
    if (!fs.existsSync(f)) return null;
    const s = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    if (s && !s.id) s.id = safe;
    return s;
  } catch (e) { log('[scene] 解析 ' + safe + '.json 失败: ' + ((e && e.message) || e)); return null; }
}

// ==================== 七之二、面板类型目录 ====================
// 照搬《01-场景模式\面板类型总览.md》的 24 种类型 / 7 族。
// 这里是**唯一来源**：新建面板的选择器、面板自身的「换类型」入口、配置字段表单都从这份表来。
//   implemented=true  渲染器已经写好了（renderers.js 里注册了同名 type）
//   implemented=false 只登记名字 —— 选了也能写进 json，但面板会明确告诉你"渲染器还没写"，
//                     不会给你留一片白（白屏是最难排查的故障）
// fields 是这种类型要填的配置项（渲染器直接从 meta 里读同名键）。
const PANEL_TYPES = [
  // ---- 通用族（8）----
  { type: 'harness', icon: '💬', family: '通用', label: 'AI 会话', desc: '钉一条会话的 AI 对话窗口', impl: true,
    fields: [{ key: 'sessionTitle', label: '会话标题', kind: 'session' }] },
  { type: 'view', icon: '🪟', family: '通用', label: '预览', desc: '文件 / 图片 / 文档 / 网页都在这看', impl: true,
    fields: [{ key: 'homeFolders', label: '起始文件夹', kind: 'path' }] },
  { type: 'file', icon: '📂', family: '通用', label: '文件管理', desc: '目录树 + 打开文件', impl: true,
    fields: [{ key: 'drives', label: '显示哪些盘（逗号分隔，留空=全部）', kind: 'text' },
             { key: 'viewPanel', label: '点开后交给哪个预览面板', kind: 'panel' }] },
  { type: 'embed', icon: '🌐', family: '通用', label: '内嵌网页', desc: '嵌一个网页（带独立登录态）', impl: true,
    fields: [{ key: 'url', label: '网址', kind: 'text' }] },
  { type: 'web', icon: '🧭', family: '通用', label: '浏览器', desc: '可导航、可刷新的内嵌浏览器', impl: true,
    fields: [{ key: 'url', label: '起始页', kind: 'text' }] },
  { type: 'reserved', icon: '🧱', family: '通用', label: '预留占位', desc: '先画好格子，功能后补', impl: true, fields: [] },
  { type: 'combo', icon: '🧩', family: '通用', label: '组合容器', desc: '一个面板里分几块', impl: true, fields: [] },
  { type: 'dash', icon: '📊', family: '通用', label: '仪表盘', desc: '一排 KPI 卡片', impl: true, fields: [] },

  // ---- 流程图族（1）----
  { type: 'flow', icon: '🗺', family: '流程图', label: '节点画布', desc: '把工序摆成可点可拖的节点图', impl: true, fields: [] },

  // ---- 数据/行情族（3）----
  { type: 'chart', icon: '📈', family: '数据行情', label: '趋势图', desc: '时间序列曲线', impl: false, fields: [] },
  { type: 'board', icon: '🎯', family: '数据行情', label: '板块雷达', desc: '多组横向对比', impl: false, fields: [] },
  { type: 'screen', icon: '🔍', family: '数据行情', label: '筛选结果', desc: '一列候选 + 打标', impl: false, fields: [] },

  // ---- 电脑族（4）----
  { type: 'pc-drives', icon: '💾', family: '电脑', label: '各盘容量', desc: '按危险度变色', impl: true, fields: [] },
  { type: 'pc-toplarge', icon: '📦', family: '电脑', label: '大户排行', desc: '哪个目录最占地方', impl: true, fields: [] },
  { type: 'pc-junk', icon: '🧹', family: '电脑', label: '可清理项', desc: '按类型分组', impl: true, fields: [] },
  { type: 'pc-ledger', icon: '📋', family: '电脑', label: '清理台账', desc: '每次清了什么，只追加', impl: true, fields: [] },

  // ---- 站点族（4）----
  { type: 'site-preview', icon: '📺', family: '站点', label: '站点预览', desc: '带刷新、跳缓存', impl: false, fields: [] },
  { type: 'site-folder', icon: '📁', family: '站点', label: '源码目录树', desc: '只看几个固定夹', impl: false, fields: [] },
  { type: 'site-projects', icon: '🧰', family: '站点', label: '项目清单', desc: '这个站里有哪些工程', impl: false, fields: [] },
  { type: 'site-urls', icon: '🔗', family: '站点', label: '网址清单', desc: '线上地址 / 后台 / 文档', impl: false, fields: [] },

  // ---- 复盘族（2）----
  { type: 'review-doc', icon: '📖', family: '复盘', label: '文档正文', desc: '长文本带目录', impl: false, fields: [] },
  { type: 'review-files', icon: '📑', family: '复盘', label: '文件清单', desc: '按主题分组，点开即读', impl: false, fields: [] },

  // ---- 三维族（2）----
  { type: 'bl-folder', icon: '🧊', family: '三维', label: '工程资源夹', desc: '模型 / 贴图 / 输出', impl: false, fields: [] },
  { type: 'bl-live', icon: '📡', family: '三维', label: '软件实时连接', desc: '连上就显示状态与操作', impl: false, fields: [] },

  // ---- 外壳自有（不属于 24 种，但场景里已经在用）----
  { type: 'console', icon: '🎮', family: '外壳', label: '控制器', desc: '每个场景一张卡，看状态/用时/预览', impl: true, fields: [] },
  { type: 'placeholder', icon: '🪄', family: '外壳', label: '待配置窗口', desc: '还没选类型时显示的选面板界面', impl: true, fields: [] }
];

const PANEL_TYPE_MAP = (function () {
  const m = {};
  for (const t of PANEL_TYPES) m[t.type] = t;
  return m;
})();

// 选面板时能给用户填的配置键（只放行这些 —— 渲染层不许往场景 json 里灌任意内容）
function patchableKeysOf(type) {
  const def = PANEL_TYPE_MAP[String(type || '')];
  // 标题栏三项 + 布局四件套（col/row/w/h，见文档《布局与网格》）
  const keys = ['title', 'sub', 'type', 'expand', 'col', 'row', 'w', 'h'];
  if (def && Array.isArray(def.fields)) for (const f of def.fields) keys.push(f.key);
  // 会话绑定三字段：任何面板都能带（harness 用得上；别的类型带了也不影响）
  keys.push('sessionId', 'sessionTitle', 'pinTarget');
  // 网页类
  keys.push('url');
  // AI 会话：引擎侧边栏的显示档位（2026-11-24 方案 D）
  //   'hide' = 隐藏侧边栏（默认）｜'auto' = 引擎按宽度自适应、外壳不干预
  //   ⚠ 只在 harness 面板上有意义；别的类型带了也不影响（跟 url 一样的处理）
  keys.push('engineSidebar');
  return keys;
}

// 新建场景 = 写一个 scenarios\<id>.json。新场景默认只有一张控制器面板 + 一张占位，
// 保证它建出来就"看得见东西"（空白场景是没法验证的）。
// 新建场景 = 写一个 scenarios\<id>.json。
// 布局预设照搬 dsh-worktable 的 PRESET_DEFS（拓扑骨架），但会话窗口落点照缩略图的蓝色格来：
//   2h 两栏 / 3h 三栏 / l2 左上下+右聊 / grid 井字 / t3 左一上下+右聊
//   l13 左一大下三小+右聊 / g4 左 2×2+右聊 / l23 左 2+3+右聊
// 对应到外壳的场景网格：每个预设给出内容窗 + 会话窗口那一格的坐标与总列数。
const LAYOUT_PRESETS = {
  '2h': { note: '两栏', cols: 2 },
  '3h': { note: '三栏', cols: 3 },
  'l2': { note: '左上下 + 右聊', cols: 2 },
  'grid': { note: '井字', cols: 2 },
  't3': { note: '左一上二下 + 右聊', cols: 3 },
  'l13': { note: '左一 + 下三 + 右聊', cols: 4 },
  'g4': { note: '左 2×2 + 右聊', cols: 3 },
  'l23': { note: '左 2+3 + 右聊', cols: 7 }
};

// 按预设生成面板数组。
// ⚠ 布局缩略图里的「蓝色格」= 本场景绑定的会话窗口（type harness），不是一个额外贴在最右的新列。
//    它的落点照缩略图来：井字就是右下角那一格，其余预设是右侧整列。
// ⚠ 改这里的格数（或加新预设）时，必须同步改 renderers.js 的 contentCellsOf()：
//   那边是弹窗里"自动补几行/多几格"的提示文案，两边格数对不上会说错话（派单 b360862b05 ②C）。
function panelsOfPreset(preset, withChat) {
  const id = String(preset || '2h');
  const pan = function (n, col, row, w, h) {
    return { id: 'p' + n, title: '窗口' + n, sub: '', type: 'placeholder', col: col, row: row, w: w, h: h };
  };
  const out = [];
  // chatCell = 会话窗口那一格的坐标（蓝色格）
  let chatCell = { col: 2, row: 1, w: 1, h: 6 };
  if (id === '2h') {
    // 两栏：左一格 + 右会话整列
    out.push(pan(1, 1, 1, 1, 6));
    chatCell = { col: 2, row: 1, w: 1, h: 6 };
  } else if (id === '3h') {
    // 三栏：两格内容 + 右会话整列
    out.push(pan(1, 1, 1, 1, 6)); out.push(pan(2, 2, 1, 1, 6));
    chatCell = { col: 3, row: 1, w: 1, h: 6 };
  } else if (id === 'l2') {
    // 左二右一：左侧上下两格，右侧会话整列
    out.push(pan(1, 1, 1, 1, 3)); out.push(pan(2, 1, 4, 1, 3));
    chatCell = { col: 2, row: 1, w: 1, h: 6 };
  } else if (id === 'grid') {
    // 井字：2×2 四格 —— 左上/右上/左下是内容窗，右下那一格就是会话窗口（h:3，不再占满整列）
    out.push(pan(1, 1, 1, 1, 3)); out.push(pan(2, 2, 1, 1, 3)); out.push(pan(3, 1, 4, 1, 3));
    chatCell = { col: 2, row: 4, w: 1, h: 3 };
  } else if (id === 't3') {
    // 左品右聊：左侧 2 列 —— 上 1 大（横跨 2 列）+ 下 2 小；右侧会话整列
    out.push(pan(1, 1, 1, 2, 3)); out.push(pan(2, 1, 4, 1, 3)); out.push(pan(3, 2, 4, 1, 3));
    chatCell = { col: 3, row: 1, w: 1, h: 6 };
  } else if (id === 'l13') {
    // 左 1 大 + 下 3 小：左侧 3 列；右侧会话整列
    out.push(pan(1, 1, 1, 3, 3));
    out.push(pan(2, 1, 4, 1, 3)); out.push(pan(3, 2, 4, 1, 3)); out.push(pan(4, 3, 4, 1, 3));
    chatCell = { col: 4, row: 1, w: 1, h: 6 };
  } else if (id === 'g4') {
    // 左 2×2：左侧 2 列；右侧会话整列
    out.push(pan(1, 1, 1, 1, 3)); out.push(pan(2, 2, 1, 1, 3));
    out.push(pan(3, 1, 4, 1, 3)); out.push(pan(4, 2, 4, 1, 3));
    chatCell = { col: 3, row: 1, w: 1, h: 6 };
  } else if (id === 'l23') {
    // 左 2+3：左侧取 6 列（2 与 3 的最小公倍数）—— 上排各 3 列、下排各 2 列；右侧会话整列
    out.push(pan(1, 1, 1, 3, 3)); out.push(pan(2, 4, 1, 3, 3));
    out.push(pan(3, 1, 4, 2, 3)); out.push(pan(4, 3, 4, 2, 3)); out.push(pan(5, 5, 4, 2, 3));
    chatCell = { col: 7, row: 1, w: 1, h: 6 };
  } else {
    out.push(pan(1, 1, 1, 1, 6));
    chatCell = { col: 2, row: 1, w: 1, h: 6 };
  }
  if (withChat) {
    out.push({ id: 'chat', title: 'AI 对话', sub: '', type: 'harness',
                col: chatCell.col, row: chatCell.row, w: chatCell.w, h: chatCell.h });
  }
  return out;
}

// 只给了 sessionId 时，自动补上这条会话的真实标题 ——
// 面板里的钉住脚本靠标题在侧栏认行（会话行 DOM 里没有 id），没有标题就只能干等。
// 找不到就原样返回，不虚构。
function titleOfSession(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return '';
  try {
    const hit = readSessions().find(function (s) { return s.id === sid; });
    return (hit && hit.title) || '';
  } catch (e) { return ''; }
}

function createScenario(input) {
  const id = String((input && input.id) || '').trim();
  const name = String((input && input.name) || '').trim() || id;
  const icon = String((input && input.icon) || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, err: 'id 只能用小写字母、数字、短横，且以字母/数字开头' };
  try { fs.mkdirSync(SCENARIOS_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  const f = path.join(SCENARIOS_DIR, id + '.json');
  if (fs.existsSync(f)) return { ok: false, err: '已经存在场景: ' + id };

  const preset = String((input && input.preset) || '2h');
  const withChat = !(input && input.chat === false);
  let panels = panelsOfPreset(preset, withChat);
  // 面板 id 必须全局唯一（harness 面板的分区名由面板 id 决定，重名会互相抢 cookie）
  for (const p of panels) p.id = id + '-' + p.id;

  // 会话绑定 / 项目文件夹直接写进 json —— 以前这三项要手改文件，现在都在弹窗里填
  const projectDir = String((input && input.projectDir) || '').trim();
  const sessionId = String((input && input.sessionId) || '').trim();
  let sessionTitle = String((input && input.sessionTitle) || '').trim();
  if (sessionId && !sessionTitle) sessionTitle = titleOfSession(sessionId);
  const pinTarget = Array.isArray((input && input.pinTarget)) ? input.pinTarget : (sessionTitle ? [sessionTitle] : []);
  const chatPanel = panels.find(function (p) { return p.type === 'harness'; });
  if (chatPanel) {
    if (sessionId) chatPanel.sessionId = sessionId;
    if (sessionTitle) chatPanel.sessionTitle = sessionTitle;
    if (pinTarget.length) chatPanel.pinTarget = pinTarget;
  }

  const json = {
    id: id,
    name: name,
    description: '',
    layout: 'grid',
    theme: 'dark',
    // cols = 面板实际占到的最大列。不加会话窗口时不能再用预设的 cols ——
    // 预设的 cols 里含着会话窗口那一列，照抄会在右边留一条空列。
    cols: Math.max(
      withChat ? (Math.round(Number((LAYOUT_PRESETS[preset] || {}).cols)) || 2) : 1,
      panels.reduce(function (m, p) { return Math.max(m, p.col + p.w - 1); }, 0)
    ),
    panels: panels,
    first: false
  };
  if (icon) json.icon = icon;
  if (projectDir) json.projectDir = projectDir;
  if (sessionId) json.sessionId = sessionId;
  if (sessionTitle) json.sessionTitle = sessionTitle;
  if (pinTarget.length) json.pinTarget = pinTarget;
  try {
    fs.writeFileSync(f, JSON.stringify(json, null, 2) + '\n', 'utf8');
    log('[scene] 已新建 ' + id + '.json（布局 ' + preset + '，' + panels.length + ' 个面板）');
    // 新建场景顺手在身份索引表登记一行（否则 AI 没法认领自己是谁）
    try { syncIdentityIndex(id, { sessionId: sessionId, sessionTitle: sessionTitle }); } catch (e) { /* 表不在也不该让创建失败 */ }
    return { ok: true, id: id };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// 改单个面板的字段：标题 / 小字 / 类型 / 位置 / 该类型自己的配置项。
// 面板按 id 定位；找不到就报错，不新建（否则一改名就多出一个面板）。
// 白名单按类型动态算（patchableKeysOf）—— 场景 json 是用户的配置，不许被写坏。
function patchPanel(sceneId, panelId, patch) {
  const sc = getScenario(sceneId);
  if (!sc) return { ok: false, err: '场景不存在: ' + sceneId };
  if (!Array.isArray(sc.panels)) return { ok: false, err: '场景里没有 panels' };
  const p = sc.panels.find(function (x) { return x && x.id === panelId; });
  if (!p) return { ok: false, err: '面板不存在: ' + panelId };

  // 换类型时白名单要按「新类型」算，而且旧类型专属的配置项要清掉（否则换个类型还挂着旧字段）
  const nextType = patch && typeof patch.type === 'string' && patch.type ? patch.type : p.type;
  if (patch && 'type' in patch && !PANEL_TYPE_MAP[nextType]) {
    return { ok: false, err: '没登记过的面板类型: ' + nextType };
  }
  const allow = patchableKeysOf(nextType);
  const oldType = p.type;
  const applied = {};
  for (const k of allow) {
    if (!patch || !(k in patch)) continue;
    if (patch[k] === null || patch[k] === '') { delete p[k]; applied[k] = null; continue; }
    if (k === 'expand') p[k] = patch[k] === true;
    else if (k === 'pinTarget') p[k] = Array.isArray(patch[k]) ? patch[k] : [];
    else if (k === 'col' || k === 'row' || k === 'w' || k === 'h') {
      // 布局四件套必须是正整数，写坏了整个网格会歪（文档《布局与网格》：起点从 1 开始）
      const n = Math.round(Number(patch[k]));
      if (!(n >= 1 && n <= 60)) return { ok: false, err: k + ' 要在 1~60 之间' };
      p[k] = n;
    }
    else p[k] = String(patch[k]);
    applied[k] = p[k];
  }
  // 换了类型：把只属于旧类型的配置项删掉（否则换个类型还挂着旧字段，
  // 比如 embed 改成 file 之后 url 还留在 json 里，下次有人读这个字段会一头雾水）。
  // 通用字段（title/sub/布局四件套/会话三字段/url）两边都认，不动。
  if (nextType !== oldType) {
    const BASE = ['title', 'sub', 'type', 'expand', 'col', 'row', 'w', 'h', 'sessionId', 'sessionTitle', 'pinTarget', 'url'];
    const oldKeys = patchableKeysOf(oldType);
    for (const k of oldKeys) {
      if (BASE.indexOf(k) >= 0) continue;
      if (allow.indexOf(k) >= 0) continue;
      if (k in p) { delete p[k]; applied[k] = null; }
    }
    p.type = nextType;
    applied.type = nextType;
    // 换类型时把 title 保持不动（用户可能刚改过名字）
  }
  try {
    const f = path.join(SCENARIOS_DIR, sc.id + '.json');
    fs.writeFileSync(f, JSON.stringify(sc, null, 2) + '\n', 'utf8');
    log('[scene] 面板 ' + panelId + ' 已更新 → ' + JSON.stringify(applied));
    return { ok: true, applied: applied, panel: p };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// 往场景里加一块面板 / 删掉一块面板（面板选择器用）。
// 面板 id 的序号：格式固定是 `<场景id>-p<N>`。
// ⚠ 这个正则有 **p** —— 早先 relayoutScenario 里写成 `/-(\d+)$/` 漏了 p，
//   结果 seq 恒为 0、补出来的 id 与已有 p1 撞车（派单 b360862b05 的真 bug）。
// ⛔ addPanel 与 relayout 必须共用这一份，别再各写。
function nextPanelSeq(sc) {
  let maxN = 0;
  for (const p of ((sc && sc.panels) || [])) {
    const m = /-p(\d+)$/.exec(String((p && p.id) || ''));
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return maxN + 1;
}

function addPanel(sceneId, input) {
  const sc = getScenario(sceneId);
  if (!sc) return { ok: false, err: '场景不存在: ' + sceneId };
  if (!Array.isArray(sc.panels)) sc.panels = [];
  const type = String((input && input.type) || 'placeholder');
  if (!PANEL_TYPE_MAP[type]) return { ok: false, err: '没登记过的面板类型: ' + type };

  // 面板 id 用「场景id-pN」，N 取当前最大序号 +1 —— 面板 id 是持久化身份（存储键、独立分区都挂在它上面），
  // 复用旧 id 会让新面板继承旧面板的分区与记忆。
  const n = nextPanelSeq(sc);
  const def = PANEL_TYPE_MAP[type];
  const panel = {
    id: sc.id + '-p' + n,
    title: String((input && input.title) || def.label || type),
    sub: '',
    type: type,
    col: Math.max(1, Math.round(Number(input && input.col) || 1)),
    row: Math.max(1, Math.round(Number(input && input.row) || 1)),
    w: Math.max(1, Math.round(Number(input && input.w) || 1)),
    h: Math.max(1, Math.round(Number(input && input.h) || 3))
  };
  // 该类型自己的配置项
  // ⚠ 跳过布局四件套与 type：上面已经按整数写过一遍，这里再 String() 一遍会变成 "3" 这种字符串
  //   （grid 用 Number() 兜得住，但 json 里类型不一致，下次读的人会以为是 bug）
  const SKIP = { type: 1, col: 1, row: 1, w: 1, h: 1, title: 1, sub: 1 };
  const allow = patchableKeysOf(type);
  for (const k of allow) {
    if (SKIP[k]) continue;
    if (!input || !(k in input)) continue;
    if (input[k] === null || input[k] === '') continue;
    if (k === 'pinTarget') panel[k] = Array.isArray(input[k]) ? input[k] : [];
    else if (k === 'expand') panel[k] = input[k] === true;
    else panel[k] = String(input[k]);
  }
  sc.panels.push(panel);
  try {
    const f = path.join(SCENARIOS_DIR, sc.id + '.json');
    fs.writeFileSync(f, JSON.stringify(sc, null, 2) + '\n', 'utf8');
    log('[scene] ' + sc.id + ' 新增面板 ' + panel.id + '（' + type + '）');
    return { ok: true, panel: panel };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

function removePanel(sceneId, panelId) {
  const sc = getScenario(sceneId);
  if (!sc) return { ok: false, err: '场景不存在: ' + sceneId };
  if (!Array.isArray(sc.panels)) return { ok: false, err: '场景里没有 panels' };
  const i = sc.panels.findIndex(function (x) { return x && x.id === panelId; });
  if (i < 0) return { ok: false, err: '面板不存在: ' + panelId };
  sc.panels.splice(i, 1);
  try {
    const f = path.join(SCENARIOS_DIR, sc.id + '.json');
    fs.writeFileSync(f, JSON.stringify(sc, null, 2) + '\n', 'utf8');
    log('[scene] ' + sc.id + ' 已删除面板 ' + panelId);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// 改场景的少量元字段（换图标 / 改名字 / 改项目文件夹 / 改会话绑定）。
// 只认白名单字段，不许从渲染层灌任意内容进来 —— 场景 json 是用户手写的配置，别让它被写坏。
const SCENE_PATCHABLE = ['icon', 'name', 'description', 'projectDir', 'sessionId', 'sessionTitle', 'pinTarget', 'cols'];
function patchScenario(id, patch) {
  const sc = getScenario(id);
  if (!sc) return { ok: false, err: '场景不存在: ' + id };
  const applied = {};
  for (const k of SCENE_PATCHABLE) {
    if (!patch || !(k in patch)) continue;
    if (patch[k] === null || patch[k] === '') delete sc[k];
    else if (k === 'cols') {
      const n = Math.round(Number(patch[k]));
      if (!(n >= 1 && n <= 24)) return { ok: false, err: 'cols 要在 1~24 之间' };
      sc[k] = n;
    }
    else sc[k] = patch[k];
    applied[k] = sc[k];
  }
  // 会话绑定三个字段要同步到「AI 对话」面板上：
  // 面板渲染器只认面板自己的 sessionId / sessionTitle / pinTarget，场景级那份只是给控制器卡片看的摘要。
  // 只写场景级的话，右侧对话窗口不会跟着换会话 —— 这是"看着像绑上了、其实没绑"的典型坑。
  const bindKeys = ['sessionId', 'sessionTitle', 'pinTarget'];
  if (bindKeys.some(function (k) { return k in applied; }) && Array.isArray(sc.panels)) {
    for (const p of sc.panels) {
      if (!p || p.type !== 'harness') continue;
      for (const k of bindKeys) {
        if (sc[k] === undefined || sc[k] === null || sc[k] === '') delete p[k];
        else p[k] = sc[k];
      }
    }
  }
  try {
    const f = path.join(SCENARIOS_DIR, sc.id + '.json');
    fs.writeFileSync(f, JSON.stringify(sc, null, 2) + '\n', 'utf8');
    log('[scene] 已更新 ' + sc.id + '.json → ' + JSON.stringify(applied));
    // 会话 id 一变就同步身份索引表（手工维护最容易漏的就是这一列）
    if (bindKeys.some(function (k) { return k in applied; })) {
      try { syncIdentityIndex(sc.id, applied); } catch (e) { /* 索引表坏了不该让绑定失败 */ }
    }
    return { ok: true, applied: applied };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
}

// ==================== 七之三之二、场景身份索引表 ====================
// 参照《02-会话定位与跟随/一-身份是怎么认领的.md》：
//   索引表是 AI「认领自己是谁」的唯一入口（场景 id ↔ 面板 id ↔ 会话 id ↔ 定位卡 ↔ 主技能）。
//   但表与场景 json 打架时 **以场景 json 为准**，然后回来把表改对。
// 这里做的是"让表不要漂"：只要通过外壳改了会话绑定，就把表里那一行的会话 id 一起改掉。
//   —— 手工维护最容易漏的就是这一列（换完会话忘了回写 ⇒ 面板钉到已归档的那条）。
// 表不存在也不报错：重建一行骨架，等第一次绑定再填真值。
const IDENTITY_INDEX_FILE = path.join(SCENARIOS_DIR, '_场景身份索引.md');
const IDX_COLUMNS = '| 场景 id | 面板 id | 面板标题 | 会话名（pinTarget 首项） | 会话 id | 定位卡 | 主技能 |';
const IDX_SEP = '|---|---|---|---|---|---|---|';

function readIdentityIndex() {
  try { return fs.readFileSync(IDENTITY_INDEX_FILE, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return ''; }
}

function idxCell(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? '`' + s.replace(/`/g, '') + '`' : '—';
}

// 把表里 sceneId 那一行的「会话 id」列换成真实值；没有这一行就按场景 json 追加一行。
// patch 里带上刚写入的 sessionId / sessionTitle（可选）。返回 {ok, changed, row, reason}
function syncIdentityIndex(sceneId, patch) {
  const id = String(sceneId || '').trim();
  if (!id) return { ok: false, reason: '没有场景 id' };
  const sc = getScenario(id);
  if (!sc) return { ok: false, reason: '场景不存在: ' + id };

  const sid = String((patch && patch.sessionId) || sc.sessionId || '').trim();
  const title = String((patch && patch.sessionTitle) || sc.sessionTitle || '').trim();
  const session = title || (Array.isArray(sc.pinTarget) && sc.pinTarget[0]) || '';

  const panels = Array.isArray(sc.panels) ? sc.panels : [];
  const hp = panels.find(function (p) { return p && p.type === 'harness' && p.sessionId; })
    || panels.find(function (p) { return p && p.type === 'harness'; });
  const panelId = (hp && hp.id) || '';
  const panelTitle = (hp && hp.title) || '';

  const cells = [idxCell(id), idxCell(panelId), idxCell(panelTitle),
    idxCell(session || '（未绑定）'), idxCell(sid || '__待建__'),
    idxCell('scenarios\\' + id + '-context.md'), idxCell('—')];
  const newRow = '| ' + cells.join(' | ') + ' |';

  let text = readIdentityIndex();
  if (!text) {
    text = '# 场景身份索引\n\n> 外壳改会话绑定时会自动同步本表。表与场景 json 打架时以场景 json 为准。\n\n## §二 表\n\n'
      + IDX_COLUMNS + '\n' + IDX_SEP + '\n';
  }

  const lines = text.split(/\r?\n/);
  // 认这一行：第一列等于 `id` 或 id（容忍反引号与空格）
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.charAt(0) !== '|') continue;
    const first = s.split('|')[1] || '';
    if (first.replace(/[`\s]/g, '') === id) { hit = i; break; }
  }

  if (hit >= 0) {
    if (lines[hit].trim() === newRow) return { ok: true, changed: false, reason: '表已是最新' };
    lines[hit] = newRow;
  } else {
    let last = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].trim().charAt(0) === '|') last = i;
    if (last < 0) lines.push('', IDX_COLUMNS, IDX_SEP, newRow);
    else lines.splice(last + 1, 0, newRow);
  }
  try {
    fs.mkdirSync(SCENARIOS_DIR, { recursive: true });
    fs.writeFileSync(IDENTITY_INDEX_FILE, lines.join('\n'), 'utf8');
    log('[identity] 索引表已同步 ' + id + ' → 会话 ' + (sid || '__待建__'));
    return { ok: true, changed: true, row: newRow };
  } catch (e) { return { ok: false, reason: (e && e.message) || String(e) }; }
}

// ==================== 七之四、控制器数据源 ====================
// ⚠ 引擎没有 /api/worktable/* 这类路由（那是 dsh-worktable 插件自己注册的）。
//   外壳拿会话状态的唯一途径：读引擎的投影缓存
//     引擎数据\.dsh\storages\session_projcache\sessions\<sessionId>.json
//   每条记录 = { version, record: { identity, rows } }，rows 里每个投影都是 { ver, seq, val }。
//   这是**只读镜像**：主进程读文件、算状态、推给渲染层，模型不参与、零 Token（与 dsh-worktable 同思路）。
const PROJCACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const WORKSPACE_FILE = path.join(DSH_HOME, 'storages', 'workspace.json');

function readJsonFile(p) {
  try {
    // 容忍 BOM：PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，
    // 纯 JSON.parse 会直接报 `Unexpected token '\uFEFF'`，界面上只表现为"场景读不出来"。
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { return null; }
}

// 取投影值（行不存在或没有 val 就是 undefined，绝不虚构）
function projVal(rows, key) {
  const r = rows && rows[key];
  return r && Object.prototype.hasOwnProperty.call(r, 'val') ? r.val : undefined;
}

// workspace.json → { workspaces:[{id,path,title,sessionIds}], defaultWorkspaceId }
function readWorkspaces() {
  const j = readJsonFile(WORKSPACE_FILE);
  const out = { workspaces: [], defaultWorkspaceId: '' };
  if (!j || !j.tables || !j.tables.workspaces) return out;
  out.defaultWorkspaceId = (j.global && j.global.defaultWorkspaceId) || '';
  for (const id of Object.keys(j.tables.workspaces)) {
    const w = j.tables.workspaces[id] || {};
    out.workspaces.push({
      id: id,
      path: w.path || '',
      title: w.title || w.path || id,
      sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : []
    });
  }
  return out;
}

// 单条会话投影 → 控制器卡片要的字段
// 状态判据（与 dsh-worktable 的 consoleStatusOf 同语义，只是数据来源换成磁盘投影）：
//   need    = 有未回答的用户提问（userQuestions.questions.active 非空）
//   busy    = 有正在跑的步（sessionStats.openStep 非空）或还有未落地的工具调用
//   done    = 最近一步已结束（turnBoundary.lastStepBoundary.kind === 'end'）且不在跑
//   idle    = 其余（含空会话）
//   ⚠ done 只是"本轮已结束"的中性提醒，不判断任务成功与否。
function statusOfRows(rows, now) {
  const stats = projVal(rows, 'sessionStats') || {};
  const q = projVal(rows, 'userQuestions');
  const tb = projVal(rows, 'turnBoundary') || {};

  const activeQ = q && q.questions && Array.isArray(q.questions.active) ? q.questions.active.length : 0;
  const openStep = stats.openStep || null;
  const pending = stats.pendingCalls && typeof stats.pendingCalls === 'object' ? Object.keys(stats.pendingCalls).length : 0;
  const running = !!openStep || pending > 0;
  const lastStepEnded = !!(tb.lastStepBoundary && tb.lastStepBoundary.kind === 'end');

  let status = 'idle';
  if (activeQ > 0) status = 'need';
  else if (running) status = 'busy';
  else if (lastStepEnded) status = 'done';

  let runtimeMs = null;
  if (running && openStep && Number(openStep.startTime) > 0) {
    runtimeMs = Math.max(0, now - Number(openStep.startTime));
  }
  return { status: status, runtimeMs: runtimeMs };
}

// 卡片预览 = 最近一条助手答复（turnOutline.turns 里最后一个有 response 的），单行、截断
function previewOfRows(rows) {
  const to = projVal(rows, 'turnOutline');
  const turns = to && Array.isArray(to.turns) ? to.turns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i] || {};
    const txt = String(t.response || (i === turns.length - 1 ? to.draft : '') || '').trim();
    if (txt) return txt.replace(/\s+/g, ' ').slice(0, 160);
  }
  return '';
}

// 扫一遍投影缓存，返回所有会话的摘要（渲染层按 id 索引）
function readSessions() {
  const now = Date.now();
  const out = [];
  try {
    if (!fs.existsSync(PROJCACHE_DIR)) return out;
    for (const f of fs.readdirSync(PROJCACHE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      const j = readJsonFile(path.join(PROJCACHE_DIR, f));
      const rows = j && j.record && j.record.rows;
      if (!rows) continue;
      const st = statusOfRows(rows, now);
      const meta = projVal(rows, 'sessionListMetadata') || {};
      const stats = projVal(rows, 'sessionStats') || {};
      out.push({
        id: id,
        title: projVal(rows, 'title') || '',
        cwd: (j.record.identity && j.record.identity.cwd) || projVal(rows, 'workingDirectory') || '',
        status: st.status,
        runtimeMs: st.runtimeMs,
        preview: previewOfRows(rows),
        blank: !!meta.blank,
        lastPromptAt: meta.lastPromptAt || null,
        turns: Number(stats.turns) || 0,
        createdAt: (j.record.identity && j.record.identity.createdAt) || 0
      });
    }
  } catch (e) { log('[console] 扫会话失败: ' + ((e && e.message) || e)); }
  // 最近用过的排前面（没时间戳的按创建时间兜底）
  out.sort(function (a, b) {
    const ta = a.lastPromptAt || a.createdAt || 0;
    const tb2 = b.lastPromptAt || b.createdAt || 0;
    return tb2 - ta;
  });
  return out;
}

// 「已确认熄光」记账：点过发光卡片之后，同一种状态不再重复发光
function readAcks() {
  const j = readJsonFile(CONSOLE_ACK_FILE);
  return j && typeof j === 'object' && j.acks && typeof j.acks === 'object' ? j.acks : {};
}
function writeAcks(acks) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONSOLE_ACK_FILE, JSON.stringify({ acks: acks }, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) { return false; }
}

// 控制器模型的骨架（渲染层负责画）——
// 不再是「一个项目一张卡」，而是**一个场景一张卡**：因为场景标签栏就是原来的应用抽屉，
// 所以控制器 = 所有场景的总览。卡片顺序 = 标签栏顺序（场景 0「DSH 引擎」永远第一张）。
// 每张卡的右上角挂三个入口（会话绑定 / 项目文件夹 / 换图标）。
const HARNESS_SCENE = { id: 'harness', name: 'DSH 引擎', icon: 'assets/deepseek-whale.png', self: false };

function buildConsoleModel() {
  const scenes = listScenarios();
  const sessions = readSessions();
  const bySession = {};
  for (const s of sessions) bySession[s.id] = s;
  const acks = readAcks();

  const cards = [];

  // ---- 场景 0：DSH 引擎（不走 scenarios\*.json，永远排第一）----
  // 它的「会话」就是引擎界面里当前打开的那条，外壳这边没有绑定概念，所以恒定未绑定、空闲。
  cards.push({
    id: HARNESS_SCENE.id,
    name: HARNESS_SCENE.name,
    icon: HARNESS_SCENE.icon,
    status: 'idle',
    runtimeMs: null,
    preview: '引擎本体界面（新会话 / 工作区 / 设置都在这个标签里）',
    bound: false,
    sessionId: '',
    sessionTitle: '',
    pinTarget: [],
    projectDir: '',
    self: false,
    glow: false,
    ackKey: '',
    fixed: true
  });

  // ---- 其余场景：一个 json 一张卡 ----
  for (const sc of scenes) {
    let full = null;
    try { full = getScenario(sc.id); } catch (e) { full = null; }
    // 场景级三字段可能为空：一个场景有多个 AI 面板时（dsh-gui 有两条不同会话）
    // 只能写面板级，写场景级会让两个面板抢同一条会话。所以这里兜底取第一个绑了
    // 会话的 harness 面板 —— 否则控制器卡片永远显示「未绑定」，而右边面板其实钉着。
    let bindSrc = full;
    if (full && !full.sessionId && Array.isArray(full.panels)) {
      const owner = full.panels.find(function (pn) { return pn.type === 'harness' && pn.sessionId; });
      if (owner) bindSrc = owner;
    }
    const sid = (bindSrc && bindSrc.sessionId) || '';
    const bound = !!sid && !!bySession[sid];
    const s = bound ? bySession[sid] : null;
    const status = s ? s.status : 'idle';
    const ackKey = (s ? status + ':' + (s.lastPromptAt || '') : '');
    const glow = !!s && ackKey !== '' && acks[sc.id] !== ackKey && (status === 'done' || status === 'need');
    cards.push({
      id: sc.id,
      name: sc.name,
      icon: sc.icon || '',
      status: status,
      runtimeMs: s ? s.runtimeMs : null,
      preview: s ? s.preview : '',
      bound: bound,
      sessionId: sid,
      sessionTitle: (bindSrc && bindSrc.sessionTitle) || '',
      pinTarget: (bindSrc && bindSrc.pinTarget) || [],
      projectDir: (full && full.projectDir) || '',
      self: !!sc.first,
      glow: glow,
      ackKey: ackKey
    });
  }
  return { cards: cards, sessions: sessions, workspaces: readWorkspaces().workspaces, at: Date.now() };
}

// ==================== 八、窗口 ====================
function createWindow() {
  const win = new BrowserWindow({
    width: Math.round(cfgNum('window.width', 1380)),
    height: Math.round(cfgNum('window.height', 900)),
    minWidth: Math.round(cfgNum('window.minWidth', 1000)),
    minHeight: Math.round(cfgNum('window.minHeight', 660)),
    title: 'XIODRA 工作台',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,   // 不显示 File/Edit/View 那排菜单
    // 自绘标题栏：把系统边框去掉，顶栏由 renderer\index.html 画（拖拽靠 -webkit-app-region）
    frame: false,
    // 程序图标（任务栏 / Alt+Tab / 窗口左上角）。不设的话 Windows 会显示 Electron 的原子图标
    icon: path.join(__dirname, 'renderer', 'assets', 'favicon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });

  win.once('ready-to-show', function () {
    win.show();
    try { win.setMenuBarVisibility(false); } catch (e) { /* ignore */ }
    log('[boot] 窗口可见耗时 ' + (Date.now() - APP_T0) + 'ms');
  });

  // 外链一律丢给系统浏览器，不在壳里开出第二套界面
  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // 只允许导航到：引擎地址 + 外壳自己的 file:// 页面。
  // 这样"把文件拖到窗口上"不会把界面导航走（观感像闪退）。
  win.webContents.on('will-navigate', function (e, url) {
    const u = String(url);
    const ownDir = __dirname.replace(/\\/g, '/').toLowerCase();
    const isOwnFile = u.indexOf('file://') === 0 && decodeURIComponent(u).toLowerCase().indexOf(ownDir) >= 0;
    if (u.indexOf(BASE) !== 0 && !isOwnFile) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // 先加载本地启动页（画进度条 + 顶栏），引擎就绪后由渲染层把 webview 指过去
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow = win;
  return win;
}

// 引擎界面跑在 <webview> 里 —— 那是**独立的 webContents**，上面那两条导航/弹窗规则管不到它。
// 这里给所有 guest 挂同一套策略（照搬参照项目 main.js L821-905 的三分支，缺一条就废一类面板）：
//
//   ★例外：网页版 AI 的窗口（renderer 用 partition="persist:webai-<key>" 建）必须"像浏览器一样"。
//   参照项目 2026-09-20 实测踩到的两头坏：① 智谱加载 2.2 秒后自家 iframe 再跳一次、千问点登录要跳
//   passport.qianwen.com，一拦登录框根本出不来；② 拦的同时还 shell.openExternal()，一开 GUI 预热
//   就会把用户的系统浏览器弹出来。所以这些 guest 的导航一律放行，window.open 在应用内开小窗并沿用
//   原分区（小窗里的登录态要能回到主窗口）。
//   识别方式：会话存储目录里带 Partitions\webai-<key>（getStoragePath() 是公开 API）。
//
//   embed/web 面板（persist:panel-*）里 target=_blank 的链接以前直接 deny ⇒ 点了没反应，
//   改成**就地打开**（不开新窗口、不弹系统浏览器）。
const INTERNAL_PROTOCOLS = /^(file|about|data|blob|devtools|dsh-app|chrome-extension|ws|wss):/i;
const INTERNAL_HOSTS = { '127.0.0.1': true, 'localhost': true, '::1': true };
const EXTERNAL_PROTOCOLS = /^(https?|mailto):/i;

function guestPartition(contents) {
  try {
    const m = /[\\/]Partitions[\\/](.+)$/.exec(contents.session.getStoragePath() || '');
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function isInternalUrl(u) {
  if (!u) return true;
  if (INTERNAL_PROTOCOLS.test(u)) return true;
  try { return INTERNAL_HOSTS[new URL(u).hostname] === true; } catch (e) { return true; }
}

function openInSystemBrowser(u) {
  try {
    if (EXTERNAL_PROTOCOLS.test(u)) { shell.openExternal(u); return true; }
  } catch (e) { /* ignore */ }
  return false;
}

app.on('web-contents-created', function (_e, contents) {
  let type = '';
  try { type = contents.getType(); } catch (e) { return; }
  if (type !== 'webview') return;   // 主窗口已有自己的处理，不重复接管
  const part = guestPartition(contents);
  const webai = /^webai-/.test(part);      // 内置网页版 AI 的窗口
  const isEmbed = /^(panel|embed)-/.test(part);   // 内嵌网页面板
  try {
    contents.setWindowOpenHandler(function (details) {
      if (isInternalUrl(details.url)) return { action: 'allow' };
      if (isEmbed) {
        try { if (/^(https?:\/\/|file:\/\/)/.test(details.url || '')) contents.loadURL(details.url); } catch (e) { /* ignore */ }
        return { action: 'deny' };
      }
      if (webai) {
        // 登录小窗 / 文档链接：在应用内开小窗，沿用原分区 ⇒ 登录态能回主窗口
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560, height: 720, autoHideMenuBar: true,
            webPreferences: { partition: 'persist:' + part }
          }
        };
      }
      openInSystemBrowser(details.url);
      return { action: 'deny' };
    });
  } catch (e) { /* ignore */ }

  // 内置网页版 AI：导航完全照浏览器来，不接管（接管会杀登录框，见上面注释）
  if (webai) return;

  contents.on('will-navigate', function (e, url) {
    if (isInternalUrl(url)) return;
    if (isEmbed) return;   // 内嵌面板：就地导航，别拦页面自己的跳转
    if (openInSystemBrowser(url)) e.preventDefault();
  });
  try {
    contents.on('will-frame-navigate', function (e) {
      const u = (e && e.url) || '';
      if (isInternalUrl(u)) return;
      if (isEmbed) return;
      if (openInSystemBrowser(u)) e.preventDefault();
    });
  } catch (e) { /* 老版本没有这个事件，忽略 */ }
});

// ==================== 九、IPC ====================
ipcMain.handle('boot:state', function () { return lastBoot; });

let bootRunning = false;
ipcMain.handle('boot:retry', async function () {
  if (bootRunning) return { ok: false, err: '正在启动中，请稍候' };
  bootRunning = true;
  try {
    const ok = await startServer();
    if (ok) openReadyGate();
    return { ok: ok, url: ok ? engineUrl() : '' };
  } catch (e) {
    sendBoot({ stage: 'error', pct: 100, text: '重试失败', detail: (e && e.message) || String(e) });
    return { ok: false, err: (e && e.message) || String(e) };
  } finally {
    bootRunning = false;
  }
});

// 渲染层要"进引擎"时问这里拿地址（地址里带 token，不能在渲染层拼）
ipcMain.handle('harness:url', function () { return engineUrl(); });
ipcMain.handle('harness:ready', function () { return engineEnterable; });
// AI 面板用自己的 webview 分区（persist:ai-panel-<面板id>），进界面前要先让主进程给那个分区种 cookie。
// 返回可用的地址；种不成返回 ''（宁可让面板显示失败态，也不要它去撞 401 白屏）。
ipcMain.handle('panel:prime', async function (_e, partition) {
  const part = String(partition || '');
  if (!part) return '';
  if (!engineEnterable) return '';
  const ok = await primeAuthCookie(part);
  if (!ok) { log('[panel] 分区 ' + part + ' 鉴权没种成'); return ''; }
  return BASE + '/';
});

// ==================== 输入法焦点（IME focus）====================
// 为什么需要这条通道（2026-11-23 实测）：
//   Windows 的输入法（TSF）只跟随「拥有系统焦点的那个窗口」。Electron 的 <webview>
//   是独立 webContents，**不会自动接管焦点** —— 焦点一直留在壳的 DOM 上（实测停在
//   `BUTTON.panel-expand` 那个 ▼ 上）。于是用户在面板输入框里打字时，输入法认为
//   焦点还在壳里 ⇒ 退回英文直通，中文打不进去。
//
// 实测证据：点一下 webview 区域后 guest.hasFocus() 立刻变 true，IME 组合事件链
// （compositionstart → 中文 → compositionend）完整、内容成功输入、焦点稳定不丢。
// ⇒ 只要把焦点交给 guest，输入法就正常。
//
// 两个入口（方案 C：点击 + 显示，双保险）：
//   ① `webview:focus`   渲染层在用户点面板/切场景/展开收起后调用
//   ② 面板从隐藏变可见  由渲染层在 visibilitychange 时调用
// 传 panelId 或 partition 都行：先按 panelId 找，再按分区找。
ipcMain.handle('webview:focus', function (_e, key) {
  try {
    const k = String(key || '');
    if (!k) return { ok: false, err: '缺少 panelId / partition' };
    const all = webContents.getAllWebContents();
    // ⚠ Electron 45 的 Session **没有** getPartition()（查过 d.ts，只有 on/off/once）。
    //   现有代码用的是 session.getStoragePath() 里截 Partitions\<名>，这里沿用同一招。
    const partOf = function (wc) {
      try {
        const m = /[\\/]Partitions[\\/](.+)$/.exec(wc.session.getStoragePath() || '');
        return m ? m[1] : '';
      } catch (e) { return ''; }
    };
    // ① 按分区精确匹配（最可靠：一板一分区 ai-panel-<面板id>）
    let hit = all.find(function (wc) {
      try {
        if (wc.getType() !== 'webview') return false;
        const p = partOf(wc);
        return p === k || p === 'persist:' + k || p === 'ai-panel-' + k;
      } catch (e) { return false; }
    });
    // ② 退一步：按 URL 里的面板标识找（分区取不到时的兜底）
    if (!hit) {
      hit = all.find(function (wc) {
        try { return wc.getType() === 'webview' && String(wc.getURL() || '').indexOf(k) >= 0; } catch (e) { return false; }
      });
    }
    if (!hit) return { ok: false, err: '没找到对应的 webview：' + k };
    if (hit.isDestroyed && hit.isDestroyed()) return { ok: false, err: 'webview 已销毁' };
    hit.focus();

    // ★ 关键：再补一次「无副作用按键」★（2026-11-23 Xiodra 实测规律）
    //   用户原话：「需要我点击面板，然后敲下键盘，然后再点输入框才能输入中文」。
    //   ⇒ 焦点链是通的（hit.focus() 后 guest.hasFocus() 确实变 true），但 **输入法
    //     上下文（Windows TSF）没有绑到 guest 进程**；一次真实键盘事件才会触发
    //     Chromium 给该渲染进程建立 IME 上下文。
    //   所以这里补发一次「不产生任何字符」的按键：Shift 单独按下再抬起。
    //   Shift 不带 text 字段 ⇒ 不会往输入框里插入任何内容，纯触发 IME 上下文建立。
    try {
      hit.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: [] });
      hit.sendInputEvent({ type: 'keyUp', keyCode: 'Shift', modifiers: [] });
    } catch (e) { /* 发不出去也不影响返回，交给渲染层的重试 */ }

    return { ok: true, type: hit.getType(), partition: partOf(hit), url: String(hit.getURL() || '').slice(0, 80) };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
});


// 面板实况截图（《02-会话定位与跟随/三-跟着窗口走》§3 的「判据二」）
// 为什么需要它：会话行 DOM 里没有会话 id，「写对了键」不等于「画面切过去了」。
// 宿主定期把 AI 面板的画面截一张、按面板 id 覆盖保存，专门用来回答「眼睛看到的到底是什么」。
// 存 <外壳>\captures\<面板id>.png（已在 .gitignore 里，属运行产物）。
const CAPTURES_DIR = path.join(__dirname, 'captures');
ipcMain.handle('panel:capture', function (_e, panelId, dataUrl) {
  try {
    const id = String(panelId || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) return { ok: false, err: '面板 id 不合法' };
    const s = String(dataUrl || '');
    const i = s.indexOf('base64,');
    if (i < 0) return { ok: false, err: '不是 data URL' };
    const buf = Buffer.from(s.slice(i + 7), 'base64');
    if (!buf.length) return { ok: false, err: '空图' };
    fs.mkdirSync(CAPTURES_DIR, { recursive: true });
    const f = path.join(CAPTURES_DIR, id + '.png');
    fs.writeFileSync(f, buf);
    return { ok: true, path: f, bytes: buf.length };
  } catch (e) { return { ok: false, err: (e && e.message) || String(e) }; }
});

// 失败时「看日志」：用系统默认程序打开 server.log（不存在就先建一个空文件，免得报"找不到"）
ipcMain.handle('boot:open-log', function () {
  try {
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');
    shell.openPath(LOG_FILE);
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('app:version', function () {
  const readVer = function (p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch (e) { return null; }
  };
  return {
    gui: readVer(path.join(__dirname, 'package.json')),
    engine: readVer(path.join(HARNESS_DIR, 'package.json')),
    cli: readVer(path.join(HARNESS_DIR, 'apps', 'cli', 'package.json')),
    engineDir: HARNESS_DIR,
    port: DSH_PORT,
    dshHome: DSH_HOME,
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || ''
  };
});

// ---- 面板自刷新通道 ----
// 零构建的代价是「改完渲染器/样式要重载面板才生效」。为了不让用户去点刷新，
// 留一条文件通道：写 data\reload-panels.cmd（内容 = all 或场景 id）→ 这里轮询到就广播。
// 幂等要点：读到就立刻删文件（否则 500ms 一次会一直重载）。
let reloadWatcher = null;
function startReloadWatcher() {
  if (reloadWatcher) return;
  reloadWatcher = setInterval(function () {
    let raw = '';
    try {
      if (!fs.existsSync(RELOAD_CMD_FILE)) return;
      raw = String(fs.readFileSync(RELOAD_CMD_FILE, 'utf8') || '').replace(/^\uFEFF/, '').trim();
      fs.unlinkSync(RELOAD_CMD_FILE);
    } catch (e) { return; }
    const scope = raw || 'all';
    log('[reload] 面板重载请求 → ' + scope);
    broadcast('panels:reload', { scope: scope, at: Date.now() });
    // 回执：让投递端（工具\刷新面板.mjs）能确认"主进程真的收到了并广播了"。
    // ⛔ 只证明广播已发出，**不代表每个面板都重载成功** —— 那要靠截图验（判据只能是画面）。
    try {
      let seq = 0;
      try { seq = (JSON.parse(fs.readFileSync(RELOAD_ACK_FILE, 'utf8')).seq || 0) + 1; } catch (e) { seq = 1; }
      let panels = 0;
      try {
        const wins = BrowserWindow.getAllWindows();
        panels = wins.length;
      } catch (e) { panels = 0; }
      fs.writeFileSync(RELOAD_ACK_FILE, JSON.stringify({
        at: new Date().toISOString(), scope: scope, seq: seq, windows: panels,
        note: '主进程已广播 panels:reload；只证明"发出去了"，不等于每个面板都画对了'
      }, null, 1), 'utf8');
    } catch (e) { /* 回执写不进去不该影响重载本身 */ }
  }, 500);
}

// ---- 场景体系 ----
// 标签栏只要元信息；点开某个场景才取完整 json（面板多时不占带宽）
ipcMain.handle('scenarios:list', function () { return listScenarios(); });
ipcMain.handle('scenario:get', function (_e, id) { return getScenario(id); });
// 换图标 / 改项目文件夹 / 改会话绑定：只写白名单字段回场景 json
ipcMain.handle('scenario:patch', function (_e, id, patch) { return patchScenario(id, patch); });
// 新建场景（按布局预设生成 panels，见 LAYOUT_PRESETS）
ipcMain.handle('scenario:create', function (_e, input) { return createScenario(input); });

// ==================== 场景换布局：保留面板与配置，只重排网格（派单 49cf727f55）====================
// ⛔ 不复用 scenario:patch（它的白名单不含 panels，也不该含）。
function relayoutScenario(id, preset) {
  const sceneId = String(id || '').replace(/[\\/:*?"<>|]/g, '');
  if (!sceneId) return { ok: false, err: '没有场景 id' };
  const p = path.join(SCENARIOS_DIR, sceneId + '.json');
  if (!fs.existsSync(p)) return { ok: false, err: '场景不存在: ' + sceneId };

  let sc = null;
  try { sc = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return { ok: false, err: '场景 json 读不出来: ' + ((e && e.message) || e) }; }
  if (!sc || !Array.isArray(sc.panels)) return { ok: false, err: '场景里没有 panels' };

  const pid = String(preset || '2h');
  // ① 新布局：内容格 + chatCell
  const all = panelsOfPreset(pid, true);
  const chatTpl = all.filter(function (x) { return x.type === 'harness'; })[0] || null;
  const cells = all.filter(function (x) { return x.type !== 'harness'; })
    .map(function (x) { return { col: x.col, row: x.row, w: x.w, h: x.h }; });
  if (!cells.length) return { ok: false, err: '预设「' + pid + '」没有内容格' };

  // ② 拆现有面板
  const harnesses = [];
  const others = [];
  for (const pn of sc.panels) {
    if (!pn || !pn.id) continue;
    if (pn.type === 'harness') harnesses.push(pn);
    else others.push(pn);
  }
  // 只留第一个 harness，其余按内容面板处理（⛔ 不删面板）
  const keepHarness = harnesses[0] || null;
  for (let i = 1; i < harnesses.length; i++) others.push(harnesses[i]);

  // ③④⑤ 填格 / 补行 / 补占位
  const out = [];
  let maxRow = 0;
  // 内容面板依次落格
  others.forEach(function (pn, i) {
    var cell = cells[i];
    if (!cell) {
      // 面板数 > 格数 ⇒ 自动补行（接到内容区下方，等宽排在最后一格那一列）
      var last = cells[cells.length - 1];
      var extra = i - cells.length + 1;
      cell = { col: last.col, row: last.row + last.h + (extra - 1) * last.h, w: last.w, h: last.h };
      cells.push(cell);
    }
    // ⛔ 只改四件套，其余字段原样保留
    out.push(Object.assign({}, pn, { col: cell.col, row: cell.row, w: cell.w, h: cell.h }));
    maxRow = Math.max(maxRow, cell.row + cell.h);
  });

  // 格数 > 面板数 ⇒ 补 placeholder（id 不复用旧 id）
  var seq = nextPanelSeq(sc) - 1;   // 下一次 ++ 就是"最大序号+1"
  for (var ci = others.length; ci < cells.length; ci++) {
    var c2 = cells[ci];
    seq++;
    out.push({
      id: sceneId + '-p' + seq, title: '窗口' + (ci + 1), sub: '',
      type: 'placeholder', col: c2.col, row: c2.row, w: c2.w, h: c2.h
    });
    maxRow = Math.max(maxRow, c2.row + c2.h);
  }

  // 会话面板落 chatCell（保持它自己的 id/type/绑定三字段）
  if (keepHarness && chatTpl) {
    out.push(Object.assign({}, keepHarness, {
      col: chatTpl.col, row: chatTpl.row, w: chatTpl.w, h: chatTpl.h
    }));
    maxRow = Math.max(maxRow, chatTpl.row + chatTpl.h);
  }

  // ⑥ sc.cols = 实际占到的最大列
  var needCols = out.reduce(function (m, pn) {
    return Math.max(m, (Number(pn.col) || 1) + (Number(pn.w) || 1) - 1);
  }, 1);

  sc.panels = out;
  sc.cols = needCols;
  sc.layoutPreset = pid;                 // 记下来，下次打开能显示"当前是哪种"

  // ★落盘前硬校验：面板 id 必须唯一★
  // 面板 id 是持久化身份（存储键 + persist 分区都挂在它上面），
  // 一重复就会两个面板共用一个分区 ⇒ 串台。宁可失败，也绝不写坏 json。
  const ids = out.map(function (pn) { return pn.id; });
  const dup = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
  if (dup.length) {
    return { ok: false, err: '面板 id 重复（已放弃写盘）：' + Array.from(new Set(dup)).join(', ') };
  }

  try { fs.writeFileSync(p, JSON.stringify(sc, null, 2) + '\n', 'utf8'); }
  catch (e) { return { ok: false, err: '写盘失败: ' + ((e && e.message) || e) }; }

  // ⑦ 让所有面板当场重建
  try { broadcast('panels:reload', { scope: 'all', at: Date.now() }); } catch (e) { /* ignore */ }

  return {
    ok: true,
    id: sceneId,
    preset: pid,
    cols: needCols,
    panelCount: out.length,
    contentCells: cells.length,
    harnessKept: !!keepHarness,
    dropped: 0
  };
}

ipcMain.handle('scenario:relayout', function (_e, id, preset) { return relayoutScenario(id, preset); });
// 改单个面板的字段（标题 / 小字 / 类型 / 该类型的配置项）
ipcMain.handle('panel:patch', function (_e, sceneId, panelId, patch) { return patchPanel(sceneId, panelId, patch); });
// 加一块面板 / 删一块面板（面板选择器用）
ipcMain.handle('panel:add', function (_e, sceneId, input) { return addPanel(sceneId, input); });
ipcMain.handle('panel:remove', function (_e, sceneId, panelId) { return removePanel(sceneId, panelId); });
// 面板自刷新：渲染层投递一次重载请求（等价于往 data\reload-panels.cmd 写一行）
ipcMain.handle('panels:reload-request', function (_e, scope) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RELOAD_CMD_FILE, String(scope || 'all'), 'utf8');
    return true;
  } catch (err) { return false; }
});

// ==================== M7 顶栏三按钮：插件 / 技能 / 工具 ====================
// 照搬参照《淋雨家的工作台》外壳\main.js 的 plugins:list / skills:list / tools:catalog。
// 判据：只读，不改任何东西；读不到就返回 error 字段，⛔ 不抛异常炸渲染层。

const SKILLS_DIR_X = path.join(DSH_HOME, 'skills');
const PLUGINS_DIR_X = path.join(WORKBENCH_ROOT, '插件');
const TOOLS_DIR_X = path.join(WORKBENCH_ROOT, '工具');

/** 读一个技能的元信息（frontmatter name/description + 体积） */
function readSkillMeta(dir) {
  const p = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(p)) return null;
  const t = fs.readFileSync(p, 'utf8');
  const fm = t.match(/^---\s*\n([\s\S]*?)\n---/);
  const body = fm ? fm[1] : '';
  return {
    name: ((body.match(/^name:\s*(.+)$/m) || [])[1] || path.basename(dir)).trim(),
    description: ((body.match(/^description:\s*(.+)$/m) || [])[1] || '').trim(),
    path: p,
    bytes: Buffer.byteLength(t),
  };
}

// ---- 插件清单（扫 工作区\插件\，每个子目录一个插件，读 package.json）----
ipcMain.handle('plugins:list', function () {
  const out = { pluginsDir: PLUGINS_DIR_X, plugins: [], error: '' };
  try {
    if (!fs.existsSync(PLUGINS_DIR_X)) { out.error = '没有 插件 目录：' + PLUGINS_DIR_X; return out; }
    for (const d of fs.readdirSync(PLUGINS_DIR_X)) {
      const dir = path.join(PLUGINS_DIR_X, d);
      let st; try { st = fs.statSync(dir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      let name = d, version = null, description = '';
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          name = pkg.name || d;
          version = pkg.version || null;
          description = pkg.description || '';
        } catch (e) { /* 坏 JSON 不炸 */ }
      }
      const item = { name: name, displayName: d, version: version, description: description, path: dir };
      for (const sub of ['缓存', 'data', 'cache']) {
        const sp = path.join(dir, sub);
        try { if (fs.statSync(sp).isDirectory()) { item.cacheDir = sp; break; } } catch (e) { /* */ }
      }
      for (const sub of ['配置', 'config']) {
        const sp = path.join(dir, sub);
        try { if (fs.statSync(sp).isDirectory()) { item.configDir = sp; break; } } catch (e) { /* */ }
      }
      out.plugins.push(item);
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
});

// ---- 技能清单（扫 引擎数据\.dsh\skills\）----
ipcMain.handle('skills:list', function () {
  const out = { skillsDir: SKILLS_DIR_X, skills: [], error: '' };
  try {
    if (!fs.existsSync(SKILLS_DIR_X)) { out.error = '没有 skills 目录：' + SKILLS_DIR_X; return out; }
    for (const n of fs.readdirSync(SKILLS_DIR_X)) {
      if (n.startsWith('_') || n.startsWith('.')) continue;   // 跳过 _索引.md 之类
      const dir = path.join(SKILLS_DIR_X, n);
      let st; try { st = fs.statSync(dir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      const m = readSkillMeta(dir);
      if (m) out.skills.push(m);
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
});

// ---- 工具清单（扫 工具\*.mjs，读文件头第一行注释当用途）----
// ⚠ 不维护第二份清单文件：**文件名 + 文件头注释就是唯一数据源**。
ipcMain.handle('tools:catalog', function () {
  const out = { toolsDir: TOOLS_DIR_X, tools: [], error: '' };
  try {
    if (!fs.existsSync(TOOLS_DIR_X)) { out.error = '没有 工具 目录：' + TOOLS_DIR_X; return out; }
    for (const n of fs.readdirSync(TOOLS_DIR_X)) {
      if (!n.endsWith('.mjs')) continue;
      const p = path.join(TOOLS_DIR_X, n);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      let desc = '';
      try {
        const head = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(0, 12).join('\n');
        const m = head.match(/^\s*\*\s*(.+)$/m) || head.match(/^\/\/\s*(.+)$/m);
        desc = m ? m[1].trim() : '';
      } catch (e) { /* */ }
      const isShared = n.startsWith('_');   // _投递.mjs 这类是内部共用件
      out.tools.push({ file: n, name: n.replace(/\.mjs$/, ''), description: desc, path: p, bytes: st.size, internal: isShared });
    }
    out.tools.sort(function (a, b) { return (a.internal === b.internal) ? a.name.localeCompare(b.name) : (a.internal ? 1 : -1); });
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
});

// ---- 在系统里打开某个技能 / 插件 / 工具所在目录（只允许这三个根，防变成任意路径打开器）----
// ==================== MCP 列表（派单 f6b6b4baa8 【二】）====================
// 数据来源（实测定过，⛔ 不是猜的）：
//   `引擎数据\.dsh\profiles\<profile>\package.json` → `dsh.profile.bundles`
//   每个 bundle 的 `cordis.patch.yml` 里若引用 `dsh-mcp-client`，它就是一个 MCP 服务；
//   从 patch 里抠 `serverName` / `transport`。
//   本机实测结果：profile=web · bundle=@local/mcp-iconfont-bundle ·
//                serverName=iconfont · transport=stdio ·
//                patch 在 `MCP\bundle-iconfont\cordis.patch.yml`。
ipcMain.handle('mcp:list', function () {
  const items = [];
  const dirsScanned = [];
  try {
    const profilesDir = path.join(DSH_HOME, 'profiles');
    if (!fs.existsSync(profilesDir)) {
      return { profilesDir: profilesDir, items: [], dirsScanned: [], error: '没有 profiles 目录' };
    }
    for (const prof of fs.readdirSync(profilesDir)) {
      const pkgPath = path.join(profilesDir, prof, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      dirsScanned.push(prof);
      let pkg = null;
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { continue; }
      const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
      for (const b of bundles) {
        const dep = (pkg.dependencies && pkg.dependencies[b]) || '';
        let bundleDir = '';
        if (dep.indexOf('link:') === 0) bundleDir = dep.slice(5);
        else bundleDir = path.join(profilesDir, prof, 'node_modules', b);
        const patch = path.join(bundleDir, 'cordis.patch.yml');
        if (!fs.existsSync(patch)) continue;
        let txt = '';
        try { txt = fs.readFileSync(patch, 'utf8'); } catch (e) { continue; }
        if (txt.indexOf('dsh-mcp-client') < 0) continue;
        const sn = /serverName:\s*([^\n\r]+)/.exec(txt);
        const tr = /transport:\s*([^\n\r]+)/.exec(txt);
        items.push({
          profile: prof,
          bundle: b,
          serverName: sn ? sn[1].trim() : '(未命名)',
          transport: tr ? tr[1].trim() : '',
          patchPath: patch
        });
      }
    }
  } catch (e) {
    return { profilesDir: path.join(DSH_HOME, 'profiles'), items: items, dirsScanned: dirsScanned, error: (e && e.message) || String(e) };
  }
  return { profilesDir: path.join(DSH_HOME, 'profiles'), items: items, dirsScanned: dirsScanned, error: '' };
});

// ==================== 模型与提供方（派单 f6b6b4baa8 【三】）====================
// 数据来源（实测）：`引擎数据\.dsh\profiles\<profile>\cordis.patch.yml` 的
//   `llm-pi-ai.config.providers`。
// ★脱敏铁律★：只报「已配 / 未配」+ 环境变量**名**，⛔ 绝不把 key 值打到界面上。
//   本机实测：provider=freellmapi · 模型 auto:agnes-gen / auto:deepseek ·
//             apiKeyEnv=FREELLMAPI_API_KEY（.credentials.yaml 的 refs 里有这一项）。
ipcMain.handle('models:list', function () {
  const providers = [];
  try {
    const profilesDir = path.join(DSH_HOME, 'profiles');
    if (!fs.existsSync(profilesDir)) {
      return { providers: [], error: '没有 profiles 目录（读不到设置）' };
    }
    for (const prof of fs.readdirSync(profilesDir)) {
      const patch = path.join(profilesDir, prof, 'cordis.patch.yml');
      if (!fs.existsSync(patch)) continue;
      let txt = '';
      try { txt = fs.readFileSync(patch, 'utf8'); } catch (e) { continue; }
      if (txt.indexOf('providers:') < 0) continue;
      const lines = txt.split(/\r?\n/);
      let inProv = false, cur = null;
      for (const ln of lines) {
        if (/^\s{4}providers:\s*$/.test(ln)) { inProv = true; continue; }
        if (inProv && /^\s{0,3}[A-Za-z]/.test(ln) && !/^\s{4}providers/.test(ln)) { inProv = false; cur = null; continue; }
        if (!inProv) continue;
        const pm = /^\s{6}([A-Za-z0-9_\-]+):\s*$/.exec(ln);
        if (pm) {
          cur = { profile: prof, name: pm[1], apiKeyEnv: '', baseURL: '', models: [] };
          providers.push(cur);
          continue;
        }
        if (!cur) continue;
        const em = /^\s{8}apiKeyEnv:\s*([^\n\r]+)/.exec(ln);
        if (em) cur.apiKeyEnv = em[1].trim();
        const bm = /^\s{8}baseURL:\s*([^\n\r]+)/.exec(ln);
        if (bm) cur.baseURL = bm[1].trim();
        const mm = /^\s{10}-\s+id:\s*([^\n\r]+)/.exec(ln);
        if (mm) cur.models.push(mm[1].trim());
      }
    }
  } catch (e) {
    return { providers: providers, error: (e && e.message) || String(e) };
  }

  // 凭据：只读 `.credentials.yaml` 的 refs 键名，判断"配没配"
  const configured = {};
  try {
    const credPath = path.join(DSH_HOME, '.credentials.yaml');
    if (fs.existsSync(credPath)) {
      const txt = fs.readFileSync(credPath, 'utf8');
      let inRefs = false;
      for (const ln of txt.split(/\r?\n/)) {
        if (/^refs:\s*$/.test(ln)) { inRefs = true; continue; }
        if (inRefs) {
          const m = /^\s{2}([A-Za-z0-9_\-\.]+):/.exec(ln);
          if (m) configured[m[1]] = true;
        }
      }
    }
  } catch (e) { /* 读不到就当全部未配 */ }

  // ★脱敏★：只给 hasKey（布尔）+ 环境变量名，⛔ 不带任何 key 值
  for (const p of providers) {
    p.hasKey = !!(p.apiKeyEnv && configured[p.apiKeyEnv]);
    p.envName = p.apiKeyEnv || '';
    delete p.apiKeyEnv;
  }
  return { providers: providers, error: '' };
});

// ==================== 工作流（派单 f6b6b4baa8 【一】3(c)）====================
// ⛔ 判据只在 `工具\工作流.mjs`：这里只做"读文件 / 转发调用"，绝不自己判依赖。
const WF_DIR = path.join(__dirname, 'data', 'workflow');
const TOOL_WF = path.join(__dirname, '..', '工具', '工作流.mjs');

function runWorkflowTool(args) {
  // ⚠ 顶部第 7 行只解构了 { spawn, spawnSync }，没有 execFile。
  //   这里就地取一次（require 有缓存，不会重复加载）。
  const cp = require('child_process');
  const execFile = cp.execFile;
  return new Promise(function (resolve) {
    execFile(process.execPath, [TOOL_WF].concat(args), {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024
    }, function (err, stdout, stderr) {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        out: String(stdout || ''),
        err: String(stderr || '')
      });
    });
  });
}

// 列出可用的流程文件
ipcMain.handle('wf:list', function () {
  try {
    if (!fs.existsSync(WF_DIR)) return { dir: WF_DIR, items: [], error: '没有 workflow 目录' };
    const items = fs.readdirSync(WF_DIR)
      .filter(function (f) { return /\.json$/i.test(f); })
      .map(function (f) {
        const full = path.join(WF_DIR, f);
        let name = f.replace(/\.json$/i, ''), desc = '', count = 0;
        try {
          const j = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''));
          name = j.name || name;
          desc = j.desc || '';
          count = (j.nodes || []).length;
        } catch (e) { /* 坏文件也列出来 */ }
        return { file: f, name: name, desc: desc, nodes: count, path: full };
      });
    return { dir: WF_DIR, items: items, error: '' };
  } catch (e) {
    return { dir: WF_DIR, items: [], error: (e && e.message) || String(e) };
  }
});

// 读一个流程 JSON（原样返回，含每节点的 state）
ipcMain.handle('wf:load', function (_e, fileOrName) {
  try {
    const f = String(fileOrName || '');
    if (!f) return { ok: false, err: '没给流程文件' };
    const full = path.isAbsolute(f) ? f : path.join(WF_DIR, /\.json$/i.test(f) ? f : (f + '.json'));
    if (!fs.existsSync(full)) return { ok: false, err: '流程不存在: ' + full };
    const raw = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return { ok: true, path: full, data: j };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
});

// 改一个节点的状态 —— ★全部交给工作流.mjs 判依赖★
ipcMain.handle('wf:mark', async function (_e, fileOrName, nodeId, state) {
  try {
    const f = String(fileOrName || '');
    const nid = String(nodeId || '');
    const st = String(state || '');
    if (!f || !nid || !st) return { ok: false, err: '参数不全（要 文件 / 节点id / 状态）' };
    const full = path.isAbsolute(f) ? f : path.join(WF_DIR, /\.json$/i.test(f) ? f : (f + '.json'));
    if (!fs.existsSync(full)) return { ok: false, err: '流程不存在: ' + full };
    // 依赖校验由工具做：工具非 0 退出 ⇒ 把它的原话带回去给界面显示
    const r = await runWorkflowTool(['--标记', full, nid, st]);
    return { ok: r.ok, code: r.code, out: r.out, err: r.err || (r.ok ? '' : '工作流工具拒绝了这次改动') };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  }
});

ipcMain.handle('skills:open', function (_e, target) {
  const p = target ? path.resolve(String(target)) : SKILLS_DIR_X;
  const ALLOW = [SKILLS_DIR_X, PLUGINS_DIR_X, TOOLS_DIR_X].map(function (x) { return path.resolve(x); });
  const ok = ALLOW.some(function (root) { return p === root || p.indexOf(root + path.sep) === 0; });
  if (!ok) return { ok: false, err: '只允许打开技能 / 插件 / 工具目录里的路径：' + p };
  try {
    if (!fs.existsSync(p)) return { ok: false, err: '路径不存在：' + p };
    shell.openPath(p);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
});

// 面板类型目录（唯一来源：新建面板的选择器、换类型下拉都读它）
ipcMain.handle('panel:types', function () { return PANEL_TYPES; });
ipcMain.handle('scenario:order', function (_e, order) {
  if (!Array.isArray(order)) return false;
  return writeSceneOrder(order.filter(function (x) { return typeof x === 'string'; }));
});

// ---- 控制器 ----
// 一张卡一套状态：主进程读投影缓存算好，渲染层只管画（不在渲染层读盘、不碰 fs）
ipcMain.handle('console:model', function () { return buildConsoleModel(); });
// 点过发光卡片 = 确认熄光（同一种状态不再提醒）
ipcMain.handle('console:ack', function (_e, sceneId, ackKey) {
  const id = String(sceneId || '');
  if (!id) return false;
  const acks = readAcks();
  acks[id] = String(ackKey || '');
  writeAcks(acks);
  return true;
});

// ---- 选目录 / 选图标（无边框窗口里没法用 file input 选目录）----
ipcMain.handle('dialog:pick-folder', async function (e, startAt) {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w || undefined, {
    title: '选择项目文件夹',
    defaultPath: startAt && fs.existsSync(startAt) ? startAt : __dirname,
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return '';
  return r.filePaths[0];
});
// 选一个文件（预览面板空态里那个「打开文件…」按钮用）
ipcMain.handle('dialog:pick-file', async function (e, startAt) {
  const w = BrowserWindow.fromWebContents(e.sender);
  const dir = startAt && fs.existsSync(startAt) ? (safeStat(startAt) && safeStat(startAt).isDirectory() ? startAt : path.dirname(startAt)) : __dirname;
  const r = await dialog.showOpenDialog(w || undefined, {
    title: '选一个文件预览',
    defaultPath: dir,
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return '';
  return r.filePaths[0];
});

ipcMain.handle('dialog:pick-icon', async function (e) {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w || undefined, {
    title: '选择场景图标',
    defaultPath: path.join(__dirname, 'renderer', 'assets'),
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'ico', 'jpg', 'jpeg', 'webp', 'svg'] }]
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return '';
  const picked = r.filePaths[0];
  // 图标必须落在 renderer\assets 下，渲染层才加载得到（file:// + CSP 只放行本站点目录）。
  // 用户选了别处的图，就复制一份进来，返回相对路径。
  try {
    const assetsDir = path.join(__dirname, 'renderer', 'assets');
    const rel = path.relative(assetsDir, picked);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return 'assets/' + rel.replace(/\\/g, '/');
    }
    fs.mkdirSync(assetsDir, { recursive: true });
    const ext = path.extname(picked) || '.png';
    const base = path.basename(picked, ext).replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'scene-icon';
    let name = base + ext;
    let n = 1;
    while (fs.existsSync(path.join(assetsDir, name))) { name = base + '-' + (n++) + ext; }
    fs.copyFileSync(picked, path.join(assetsDir, name));
    log('[dialog] 图标已复制到 assets\\' + name);
    return 'assets/' + name;
  } catch (err) {
    log('[dialog] 复制图标失败: ' + ((err && err.message) || err));
    return '';
  }
});

// 用系统浏览器打开一个网址（面板里的网页不该在工作台里开新窗口）
// ---- 主题（壁纸 + 外观）：设置存宿主端，渲染层只负责画 ----
ipcMain.handle('theme:get', function () {
  return readTheme();
});

// 拖滑块时这个 handler 每秒会被调好几次，只在「壁纸换了」时打日志 ——
// 否则 server.log 几分钟就被同一行淹掉，真出问题时反而看不见。
let lastThemeLog = '';
ipcMain.handle('theme:patch', function (_e, patch) {
  const r = patchTheme(patch);
  if (r.ok) {
    const w = r.theme.wallpaper.path ? path.basename(r.theme.wallpaper.path) : '无';
    if (w !== lastThemeLog) { lastThemeLog = w; log('[theme] 壁纸 = ' + w); }
  }
  return r;
});

// 选一张图 / 一段视频当壁纸。只返回路径，写不写由 theme:patch 决定 ——
// 用户点了「取消」也不会把已有壁纸清掉。
ipcMain.handle('theme:pick-wallpaper', async function (e) {
  const cur = readTheme();
  const startAt = cur.wallpaper.path ? path.dirname(cur.wallpaper.path) : app.getPath('pictures');
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const res = await dialog.showOpenDialog(win, {
    title: '选择壁纸（图片或视频）',
    defaultPath: startAt,
    properties: ['openFile'],
    filters: [
      { name: '图片或视频', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'mp4', 'webm', 'mov', 'm4v'] },
      { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] },
      { name: '视频', extensions: ['mp4', 'webm', 'mov', 'm4v'] }
    ]
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return '';
  return res.filePaths[0];
});

ipcMain.handle('app:open-external', function (_e, url) {
  const u = String(url || '');
  // 只放行 http(s)/mailto —— 渲染层传来的东西一律当不可信输入校验
  if (!/^(https?:|mailto:)/i.test(u)) return false;
  try { shell.openExternal(u); return true; } catch (err) { return false; }
});

// ==================== 文件系统（file / view 面板的数据来源）====================
// 为什么不合并成一个"万能 fs"通道：主进程这边按**动作**分，能一眼看清谁能做什么。
// 渲染层能做的只有三件：看目录、读文本、用系统程序打开/定位。写盘一律不开 ——
// 面板现在是"看"的，等真需要写入再单独加一条带校验的通道，不提前开洞。
// ⚠ 路径一律当不可信输入：只做 readdir/readFile/stat，永远不拼 shell 命令。

function safeStat(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

// 列出盘符（只 Windows 有意义；盘符不存在的盘不列）
function listDrives() {
  const out = [];
  for (let i = 67; i <= 90; i++) {   // C..Z
    const letter = String.fromCharCode(i) + ':';
    const root = letter + '\\';
    try { if (fs.existsSync(root)) out.push({ name: letter, path: root }); } catch (e) { /* skip */ }
  }
  return out;
}

// ==================== 电脑族数据源（派单 c0d1028c64）====================
// 三条都遵守「异步 + 可中断 + 有进度」：⛔ 不许同步扫全盘，UI 会卡死。

// ---- ① 各盘容量：挂载点 / 总量 / 可用 ----
// 用 fs.statfsSync（Node 18.15+ / 24 可用）。拿不到就标 err，绝不给假数字。
/**
 * 顶栏负载胶囊：CPU / GPU / 内存（每秒由渲染层轮询一次）
 *
 * ⛔ 三条硬要求：
 *   ① **读数必须是真测**，取不到就返回 `null` + err，⛔ 绝不编数字（宁可显示「—」）
 *   ② **CPU 必须用两次采样的差值**：os.cpus() 给的是累计时间，直接除会得到"开机以来平均占用"，
 *      那是错的（实测：初次采样直接算会显示 100%）
 *   ③ **GPU 只能靠 nvidia-smi**：Windows 没有通用 GPU 占用 API；
 *      没 NVIDIA 卡 / 没装驱动 ⇒ available=false，界面显示「GPU —」，不许假装 0%
 *
 * 性能：每次调用只做一次 1 秒内的差值 + 一次 nvidia-smi（约 60~120ms），
 *       ⛔ 不用 setInterval 在主进程常驻（那会一直占 CPU，正好和这个功能自相矛盾）。
 */

// CPU 采样：记上一次的累计值，每次调用算差值
let _cpuPrev = null;

function cpuSample() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of cpus) {
    const tm = c.times || {};
    for (const k of Object.keys(tm)) total += tm[k];
    idle += tm.idle || 0;
  }
  return { idle, total, cores: cpus.length };
}

/**
 * 拿 CPU 占用率。
 * 第一次调用没有前值 ⇒ **当场等 200ms 再采一次**（不返回假数字）。
 * 之后每次调用用"上次到这次"的差值 —— 配合渲染层 1 秒轮询，得到的就是实时占用。
 */
async function cpuUsage() {
  const cur = cpuSample();
  if (!_cpuPrev) {
    _cpuPrev = cur;
    await new Promise(function (r) { setTimeout(r, 200); });
    const second = cpuSample();
    _cpuPrev = second;
    const dt = second.total - cur.total;
    const di = second.idle - cur.idle;
    return { pct: dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : null, cores: second.cores };
  }
  const dt = cur.total - _cpuPrev.total;
  const di = cur.idle - _cpuPrev.idle;
  _cpuPrev = cur;
  return { pct: dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : null, cores: cur.cores };
}

/** 内存：os 的总量/空闲量（Windows 上 freemem 是"可用"，不是"空闲未用"，但足够看趋势） */
function memUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  if (!total) return { pct: null, usedGB: null, totalGB: null };
  return {
    pct: ((total - free) / total) * 100,
    usedGB: (total - free) / 1024 / 1024 / 1024,
    totalGB: total / 1024 / 1024 / 1024,
  };
}

/** GPU：只有 nvidia-smi 这条路；取不到就明确说不可用 */
function gpuUsage() {
  return new Promise(function (resolve) {
    const cands = ['nvidia-smi'];
    let done = false;
    const finish = function (payload) { if (!done) { done = true; resolve(payload); } };

    // 超时兜底：nvidia-smi 在部分机器上会卡住
    const timer = setTimeout(function () { finish({ available: false, err: 'nvidia-smi 超时' }); }, 2500);

    let cp = null;
    try {
      cp = require('child_process');
    } catch (e) {
      clearTimeout(timer);
      return finish({ available: false, err: '拿不到 child_process' });
    }

    let child = null;
    try {
      child = cp.spawn(cands[0], ['--query-gpu=utilization.gpu,memory.used,memory.total,name', '--format=csv,noheader,nounits'], { windowsHide: true });
    } catch (e) {
      clearTimeout(timer);
      return finish({ available: false, err: '启动 nvidia-smi 失败：' + ((e && e.message) || e) });
    }

    let out = '', errText = '';
    child.stdout.on('data', function (b) { out += b.toString('utf8'); });
    child.stderr.on('data', function (b) { errText += b.toString('utf8'); });
    child.on('error', function (e) {
      clearTimeout(timer);
      finish({ available: false, err: '没有 nvidia-smi：' + ((e && e.message) || e) });
    });
    child.on('close', function (code) {
      clearTimeout(timer);
      if (code !== 0) return finish({ available: false, err: 'nvidia-smi 退出码 ' + code + ' ' + errText.slice(0, 80) });
      const line = String(out).split(/\r?\n/).find(function (l) { return l.trim(); });
      if (!line) return finish({ available: false, err: 'nvidia-smi 没输出' });
      const parts = line.split(',').map(function (s) { return s.trim(); });
      const util = Number(parts[0]);
      finish({
        available: true,
        pct: Number.isFinite(util) ? util : null,
        usedMB: Number(parts[1]) || null,
        totalMB: Number(parts[2]) || null,
        name: parts[3] || '',
      });
    });
  });
}

ipcMain.handle('sys:load', async function () {
  const out = { at: Date.now(), cpu: null, mem: null, gpu: null };
  try {
    const c = await cpuUsage();
    out.cpu = { pct: c.pct, cores: c.cores };
  } catch (e) { out.cpu = { pct: null, err: (e && e.message) || String(e) }; }
  try { out.mem = memUsage(); } catch (e) { out.mem = { pct: null, err: (e && e.message) || String(e) }; }
  try { out.gpu = await gpuUsage(); } catch (e) { out.gpu = { available: false, err: (e && e.message) || String(e) }; }
  return out;
});

ipcMain.handle('sys:disks', function () {
  const out = [];
  for (const d of listDrives()) {
    const mount = d.path;
    let total = 0, free = 0, err = '';
    try {
      // statfsSync 在部分 Windows 版本上对光驱/网络盘会抛，逐个兜住
      const st = fs.statfsSync ? fs.statfsSync(mount) : null;
      if (st) {
        total = Number(st.blocks) * Number(st.bsize);
        free = Number(st.bavail) * Number(st.bsize);
      } else {
        err = '这个 Node 没有 fs.statfsSync';
      }
    } catch (e) {
      err = (e && e.message) || String(e);
    }
    out.push({
      mount: mount,
      name: d.name,
      letter: String(d.name || '').replace(':', ''),
      total: total,
      free: free,
      used: Math.max(0, total - free),
      err: err
    });
  }
  return { ok: true, disks: out, at: Date.now() };
});

// ---- ② 目录体积扫描：限深 + 可 abort + 进度 ----
// 设计要点（照派单要求）：
//   · **限深**：maxDepth 默认 2（只看"这个目录"和"它下面一层"），再深只算总量不再分项；
//   · **可 abort**：主进程维护一个 token 集合，渲染层调 fs:scan-abort 立刻置位；
//   · **有进度**：每扫完一个子项就 emit 一次 'fs:scan-progress'（渲染层订不订都行）；
//   · **异步分批**：用 await new Promise(setImmediate) 让出事件循环，UI 不卡。
const SCAN_JOBS = new Map();   // token -> { aborted:true }
let SCAN_SEQ = 0;

// 并发度：实测 64 并发比逐个 await 快 75%（1,950 → 3,407 文件/s）。
// 取 48：足够快，又不会把机械盘/杀软拖到卡死。
const STAT_CONCURRENCY = 48;

// dirSize(dir, token, budget, opts)
//   opts.onTick({ bytes, files })   —— 二级进度回调（每 ~400ms 至多一次）
//   opts.maxDepth                   —— 0 = 不限（全量）；>0 = 只下钻这么多层
//   opts.base                       —— 已累计的字节（顶层循环各子项之间累计，进度才连贯）
// 返回 { bytes, files }
async function dirSize(dir, token, budget, opts) {
  const o = opts || {};
  const maxDepth = Math.max(0, Number(o.maxDepth) || 0);
  const onTick = typeof o.onTick === 'function' ? o.onTick : null;
  let total = Number(o.base) || 0;
  let files = 0;
  let lastEmit = 0;

  const inflight = new Set();
  const stack = [{ p: dir, d: 0 }];

  const checkAbort = function () {
    const job = SCAN_JOBS.get(token);
    if (!job || job.aborted) throw new Error('__ABORTED__');
  };
  const tick = function (force) {
    const now = Date.now();
    if (!onTick) return;
    if (!force && now - lastEmit < 400) return;
    lastEmit = now;
    onTick({ bytes: total, files: files });
  };

  while (stack.length) {
    const item = stack.pop();
    checkAbort();
    let ents;
    try { ents = await fs.promises.readdir(item.p, { withFileTypes: true }); }
    catch (e) { continue; }                      // 权限不足/断链：跳过，不中断整体

    for (const d of ents) {
      const full = path.join(item.p, d.name);
      if (d.isDirectory()) {
        // 真实深度：maxDepth=0 表示不限（全量）；>0 才封顶
        if (!maxDepth || item.d + 1 < maxDepth) stack.push({ p: full, d: item.d + 1 });
        continue;
      }
      if (!d.isFile()) continue;

      // ★并发 stat★：填满窗口，满了就等一个完成
      const pr = fs.promises.stat(full).then(function (st) {
        total += Number(st.size) || 0;
        files += 1;
      }).catch(function () { /* 跳过读不到的文件 */ })
        .finally(function () { inflight.delete(pr); });
      inflight.add(pr);

      budget.files -= 1;
      if (budget.files <= 0) throw new Error('__BUDGET__');

      if (inflight.size >= STAT_CONCURRENCY) {
        await Promise.race(inflight);
        checkAbort();
      }
      tick(false);
    }

    await new Promise(function (r) { setImmediate(r); });   // 让出事件循环
    tick(false);
  }

  // 收尾：等所有在飞的 stat 落地，数字才完整
  while (inflight.size) {
    await Promise.race(inflight);
    checkAbort();
  }
  tick(true);
  // ⚠ 只返回**本子树的净增量**（total - base）。
  //   原来直接返回 total（含 base），而调用方又 sumBytes += size ⇒ base 被重复累加，
  //   数值会爆炸（C 盘真值 142.53 GB，面板显示 422.19 GB —— 派单 68dfc63517 bug 2）。
  //   base 只用于 onTick 让进度条连续，不进返回值。
  const baseNum = Number(o.base) || 0;
  return { bytes: total - baseNum, files: files };
}

ipcMain.handle('fs:scan-begin', function () {
  const token = 'scan-' + (++SCAN_SEQ) + '-' + Date.now();
  SCAN_JOBS.set(token, { aborted: false });
  return { ok: true, token: token };
});

ipcMain.handle('fs:scan-abort', function (_e, token) {
  const j = SCAN_JOBS.get(String(token || ''));
  if (!j) return { ok: false, err: '没有这个扫描任务' };
  j.aborted = true;
  return { ok: true };
});

ipcMain.handle('fs:scan-dir', async function (ev, dir, opts) {
  const target = String(dir || '');
  const o = opts || {};
  const token = String(o.token || '');
  // ⚠ 0 是**合法值**（= 不限深度/全量）。原来写 `Number(o.maxDepth) || 2`，
  //   0 是 falsy 会被替换成 2 ⇒ 全量扫退化成限深 2 层（派单 68dfc63517 bug 1）。
  const mdRaw = Number(o.maxDepth);
  const maxDepth = Number.isFinite(mdRaw) ? Math.max(0, Math.min(mdRaw, 4)) : 2;
  // 预算上限提到 200 万（C 盘实测 841,840 文件 / 142.53GB；原来 20 万只跑到 47.5GB —— 数字是假的）
  const maxFiles = Math.max(1000, Math.min(Number(o.maxFiles) || 200000, 2000000));
  if (!target) return { ok: false, err: '没有给目录' };
  const st = safeStat(target);
  if (!st) return { ok: false, err: '路径不存在: ' + target };
  if (!st.isDirectory()) return { ok: false, err: '不是目录: ' + target };
  if (!SCAN_JOBS.has(token)) return { ok: false, err: '扫描 token 无效（要先 fs:scan-begin）' };

  const send = (payload) => { try { ev.sender.send('fs:scan-progress', payload); } catch (e) { /* ignore */ } };
  const budget = { files: maxFiles };
  const rows = [];
  let aborted = false, overBudget = false;
  let sumBytes = 0;                       // 累计字节（跨子项连续，二级进度用它）

  try {
    const top = await fs.promises.readdir(target, { withFileTypes: true });
    let i = 0;
    for (const d of top) {
      const job = SCAN_JOBS.get(token);
      if (!job || job.aborted) { aborted = true; break; }
      const full = path.join(target, d.name);
      let size = 0;
      if (d.isDirectory()) {
        // maxDepth 默认 0 = 全量（用户明确否掉"限深 1 层"：depth1 只得 1.73GB，Users 真实 88.59GB）
        try {
          const r2 = await dirSize(full, token, budget, {
            maxDepth: maxDepth,
            base: sumBytes,
            onTick: function (t2) {
              // ★二级进度★：把"已扫字节"实时推给渲染层，进度条才不会 391 秒不动
              send({
                token: token, done: i, total: top.length,
                name: d.name, size: t2.bytes, bytes: t2.bytes, files: t2.files,
                phase: 'deep', inner: d.name
              });
            }
          });
          size = r2.bytes;
        } catch (e) {
          if (e && e.message === '__ABORTED__') { aborted = true; break; }
          if (e && e.message === '__BUDGET__') { overBudget = true; size = 0; }
        }
      } else if (d.isFile()) {
        try { const st2 = await fs.promises.stat(full); size = st2.size; } catch (e) { /* 跳过 */ }
      }
      rows.push({ name: d.name, isDir: d.isDirectory(), size: size });
      sumBytes += size;
      i++;
      send({
        token: token, done: i, total: top.length, name: d.name,
        size: size, bytes: sumBytes, files: maxFiles - budget.files, phase: 'top'
      });
      await new Promise((r) => setImmediate(r));
      if (budget.files <= 0) { overBudget = true; break; }
    }
  } catch (e) {
    SCAN_JOBS.delete(token);
    return { ok: false, err: (e && e.message) || String(e) };
  }

  SCAN_JOBS.delete(token);
  rows.sort(function (a, b) { return b.size - a.size; });   // 大的在前（这就是"大户排行"要的）
  return {
    ok: true,
    base: target,
    rows: rows,
    aborted: aborted,
    overBudget: overBudget,
    scannedFiles: maxFiles - budget.files,
    at: Date.now()
  };
});

// ---- ③ 清理台账：只追加 ----
// 落到 外壳\data\pc-cleanup-log.json。**只追加不删改**（台账的意义就是不可篡改）。
const PC_LEDGER_FILE = path.join(DATA_DIR, 'pc-cleanup-log.json');
function readPcLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(PC_LEDGER_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}
ipcMain.handle('pc:ledger', function (_e, action, payload) {
  const act = String(action || 'read');
  if (act === 'read') {
    const rows = readPcLedger();
    return { ok: true, rows: rows, file: PC_LEDGER_FILE };
  }
  if (act === 'append') {
    const p = payload || {};
    // 只收白名单字段，渲染层不许往台账里灌任意内容
    const row = {
      at: new Date().toISOString(),
      path: String(p.path || ''),
      bytes: Number(p.bytes) || 0,
      kind: String(p.kind || ''),
      note: String(p.note || '')
    };
    if (!row.path) return { ok: false, err: '台账行必须有 path' };
    const rows = readPcLedger();
    rows.push(row);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PC_LEDGER_FILE, JSON.stringify(rows, null, 2), 'utf8');
    } catch (e) {
      return { ok: false, err: '写台账失败: ' + ((e && e.message) || e) };
    }
    return { ok: true, row: row, count: rows.length };
  }
  return { ok: false, err: '不认识的动作: ' + act };
});

// 找一个"真正的 node"来跑外部 .mjs 工具。
// ⚠ 不能用 process.execPath：在 Electron 里它是 electron.exe，
//   spawnSync/spawn 会把它当应用启动 ⇒ 永远不返回（实测 ETIMEDOUT）。
function findNodeExe() {
  const cands = [];
  // PATH 里优先（用 where 查，失败不抛）
  try {
    const cp = require('child_process');
    const w = cp.spawnSync('where', ['node'], { encoding: 'utf8', timeout: 4000 });
    if (w && w.status === 0 && w.stdout) {
      String(w.stdout).split(/\r?\n/).forEach(function (l) {
        const t = l.trim();
        if (t && /\.exe$/i.test(t)) cands.push(t);
      });
    }
  } catch (e) { /* ignore */ }
  // 常见安装位置兜底
  cands.push('C:\\Program Files\\nodejs\\node.exe');
  cands.push('C:\\Program Files (x86)\\nodejs\\node.exe');
  const home = os.homedir();
  cands.push(path.join(home, 'AppData', 'Roaming', 'nvm', 'current', 'node.exe'));
  cands.push(path.join(home, 'AppData', 'Local', 'Volta', 'bin', 'node.exe'));
  for (const c of cands) {
    try {
      // 排除 electron.exe 自己（防呆：万一 PATH 里指到它）
      if (c && /electron\.exe$/i.test(c)) continue;
      if (fs.existsSync(c)) return c;
    } catch (e) { /* ignore */ }
  }
  return '';
}

// ---- 可清理项：跑 工具\垃圾判据.mjs（判据唯一出处）----
// 实测工具单次 **75 秒**（遍历整棵工作台）⇒ ⛔ 绝不能 spawnSync（会卡死主进程 75s），
// 必须异步 + 缓存 + 并发合流。
const JUNK_TTL_MS = 10 * 60 * 1000;      // 结果缓存 10 分钟
let JUNK_CACHE = null;                   // { at, data }
let JUNK_INFLIGHT = null;                // Promise（并发请求共享）

function runJunkScan() {
  return new Promise(function (resolve) {
    const nodeExe = findNodeExe();
    if (!nodeExe) {
      resolve({ ok: false, err: '本机没找到 node.exe（判据工具需要真 node 跑）' });
      return;
    }
    const cp = require('child_process');
    const tool = path.join(__dirname, '..', '工具', '垃圾判据.mjs');
    if (!fs.existsSync(tool)) { resolve({ ok: false, err: '找不到判据工具：' + tool }); return; }

    let out = '', errText = '', done = false;
    let child = null;
    const finish = function (payload) {
      if (done) return;
      done = true;
      resolve(payload);
    };
    try {
      child = cp.spawn(nodeExe, [tool, '--scan', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: Object.assign({}, process.env, { DSH_WORKBENCH_ROOT: path.join(__dirname, '..') })
      });
    } catch (e) {
      finish({ ok: false, err: '启动判据工具失败: ' + ((e && e.message) || e) });
      return;
    }
    child.stdout.on('data', function (b) { out += b.toString('utf8'); });
    child.stderr.on('data', function (b) { errText += b.toString('utf8'); });
    child.on('error', function (e) { finish({ ok: false, err: '判据工具出错: ' + ((e && e.message) || e) }); });
    child.on('close', function (code) {
      if (code !== 0) { finish({ ok: false, err: '判据工具退出码 ' + code + '：' + errText.slice(0, 400) }); return; }
      let j = null;
      try { j = JSON.parse(out || '{}'); }
      catch (e) { finish({ ok: false, err: '判据工具输出不是合法 JSON' }); return; }
      const data = {
        ok: true,
        root: j.root || '',
        at: j.at || Date.now(),
        safe: Array.isArray(j.safe) ? j.safe : [],
        ask: Array.isArray(j.ask) ? j.ask : [],
        neverCount: Number(j.neverCount) || 0,
        totalBytes: j.totalBytes || { safe: 0, ask: 0 }
      };
      JUNK_CACHE = { at: Date.now(), data: data };
      finish(data);
    });
    // 硬超时 180 秒（工具实测 75s，留足余量）；超时就杀进程
    setTimeout(function () {
      if (done) return;
      try { child.kill(); } catch (e) { /* ignore */ }
      finish({ ok: false, err: '判据工具超过 180 秒没返回（已中止）' });
    }, 180000);
  });
}

ipcMain.handle('pc:junk-scan', async function (_e, opts) {
  const force = !!(opts && opts.force);
  if (!force && JUNK_CACHE && (Date.now() - JUNK_CACHE.at) < JUNK_TTL_MS) {
    return Object.assign({}, JUNK_CACHE.data, { cached: true, ageMs: Date.now() - JUNK_CACHE.at });
  }
  if (!JUNK_INFLIGHT) {
    JUNK_INFLIGHT = runJunkScan().then(function (r) { JUNK_INFLIGHT = null; return r; },
      function (e) { JUNK_INFLIGHT = null; return { ok: false, err: String((e && e.message) || e) }; });
  }
  return await JUNK_INFLIGHT;
});

ipcMain.handle('fs:roots', function () {
  const home = os.homedir();
  const out = listDrives();
  // 家目录放在最前（用户九成时间在这里），盘符跟在后面
  const homeRow = { name: '🏠 ' + path.basename(home), path: home, home: true };
  return { roots: out, home: homeRow, homePath: home };
});

ipcMain.handle('fs:list', function (_e, dir) {
  const target = String(dir || '');
  if (!target) return { ok: false, err: '没有给目录' };
  const st = safeStat(target);
  if (!st) return { ok: false, err: '路径不存在: ' + target };
  if (!st.isDirectory()) return { ok: false, err: '不是目录: ' + target };
  let names;
  try { names = fs.readdirSync(target, { withFileTypes: true }); }
  catch (err) { return { ok: false, err: '读不了这个目录: ' + ((err && err.message) || err) }; }
  const rows = [];
  for (const d of names) {
    const full = path.join(target, d.name);
    let size = 0, mtime = 0;
    try { const s = fs.statSync(full); size = s.size; mtime = Math.floor(s.mtimeMs / 1000); } catch (e) { /* 权限/断链：照列，元信息留 0 */ }
    rows.push({ name: d.name, isDir: d.isDirectory(), size: size, mtime: mtime });
  }
  // 目录在前、各自按名字排（资源管理器习惯，比按时间更稳）
  rows.sort(function (a, b) {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return { ok: true, base: target, rows: rows };
});

const FS_TEXT_MAX = 2 * 1024 * 1024;          // 超过 2MB 不整篇读，界面会提示改用系统程序
ipcMain.handle('fs:read-text', function (_e, p, maxBytes) {
  const target = String(p || '');
  if (!target) return { ok: false, err: '没有给文件' };
  const st = safeStat(target);
  if (!st) return { ok: false, err: '文件不存在: ' + target };
  if (st.isDirectory()) return { ok: false, err: '这是一个目录' };
  const cap = Math.max(4096, Math.min(Number(maxBytes) || FS_TEXT_MAX, FS_TEXT_MAX));
  if (st.size > cap) return { ok: false, err: '文件太大（' + st.size + ' 字节，上限 ' + cap + '）', size: st.size, tooBig: true };
  let buf;
  try { buf = fs.readFileSync(target); }
  catch (err) { return { ok: false, err: '读不了: ' + ((err && err.message) || err) }; }
  // 二进制嗅探：出现 NUL 就当二进制（文本文件里几乎不会有 \0）
  const sniff = buf.subarray(0, 4096);
  for (let i = 0; i < sniff.length; i++) {
    if (sniff[i] === 0) return { ok: false, err: '看起来是二进制文件', binary: true, size: st.size };
  }
  return { ok: true, text: buf.toString('utf8'), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
});

ipcMain.handle('fs:stat', function (_e, p) {
  const target = String(p || '');
  const st = safeStat(target);
  if (!st) return { ok: false, err: '不存在' };
  return { ok: true, isDir: st.isDirectory(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
});

// 用系统程序打开（预览面板看不了的格式走这里）
ipcMain.handle('fs:open-path', function (_e, p) {
  const target = String(p || '');
  if (!target || !safeStat(target)) return false;
  try { shell.openPath(target); return true; } catch (e) { return false; }
});

// ==================== 视频外部播放器（2026-11-25，MPV-EASY-Player 集成）====================
// MPV-EASY-Player 是独立桌面应用（Lua+mpv+Qt），**不能嵌进 Electron 面板**；
// 这里只做两件事：① 探测本机有没有它 / mpv；② 用它打开视频（全格式兜底）。
// ⛔ 面板内嵌播放走渲染层的 <video>，不依赖本文件。

/** 候选路径（存在才算数；⛔ 不编造） */
function videoPlayerCandidates() {
  const out = [];
  // ① 用户显式指定
  const envP = String(process.env.XIODRA_MPV || '').trim();
  if (envP) out.push(envP);

  // ② MPV-EASY-Player 常见安装位置
  const local = process.env.LOCALAPPDATA || '';
  const appdata = process.env.APPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const homes = [local, appdata, pf, pf86, 'D:\\', 'E:\\'].filter(Boolean);

  const names = [
    'MPV-EASY Player\\mpv.exe',
    'MPV-EASY-Player\\mpv.exe',
    'MPV-EASY PLAYER\\mpv.exe',
    'mpv-easy-player\\mpv.exe',
    'mpv\\mpv.exe',
    'mpv\\mpv'
  ];
  homes.forEach(function (h) {
    names.forEach(function (n) { out.push(path.join(h, n)); });
    // 常见"程序"子目录
    names.forEach(function (n) { out.push(path.join(h, 'Programs', n)); });
  });

  // ③ PATH 里的 mpv（交给 where/which 查，这里只管文件名）
  out.push('mpv');
  return out;
}

/** 找一个可用的播放器；返回 { ok, exe, kind } */
function findVideoPlayer() {
  const cands = videoPlayerCandidates();
  for (const c of cands) {
    try {
      if (c === 'mpv') {
        // 交给 where 查（Windows）/ which（其它）
        continue;
      }
      const st = safeStat(c);
      if (st && !st.isDirectory()) {
        const low = c.toLowerCase();
        const kind = /mpv-easy/i.test(c) ? 'MPV-EASY-Player' : 'mpv';
        return { ok: true, exe: c, kind: kind };
      }
    } catch (e) { /* ignore */ }
  }
  return { ok: false, exe: '', kind: '' };
}

// 探测（渲染层只在找到时才显示"用 MPV 打开"按钮）
ipcMain.handle('video:player', function () {
  try {
    const r = findVideoPlayer();
    return { ok: true, found: r.ok, exe: r.exe, kind: r.kind };
  } catch (e) {
    return { ok: false, found: false, exe: '', kind: '', err: (e && e.message) || String(e) };
  }
});

// 用外部播放器打开视频（找不到就回落到系统默认程序，⛔ 不让用户"点了没反应"）
ipcMain.handle('video:open', function (_e, p) {
  const target = String(p || '');
  if (!target || !safeStat(target)) return { ok: false, err: '文件不存在' };

  const r = findVideoPlayer();
  if (r.ok && r.exe) {
    try {
      const child = execFile(r.exe, [target], { windowsHide: false }, function () { /* 播放器自己管生命周期 */ });
      if (child && child.unref) child.unref();
      return { ok: true, via: r.kind, exe: r.exe };
    } catch (e) {
      // 掉下去用系统默认
    }
  }
  try { shell.openPath(target); return { ok: true, via: '系统默认程序', exe: '' }; }
  catch (e) { return { ok: false, err: (e && e.message) || String(e) }; }
});

// 在资源管理器里选中它
ipcMain.handle('fs:reveal', function (_e, p) {
  const target = String(p || '');
  if (!target || !safeStat(target)) return false;
  try { shell.showItemInFolder(target); return true; } catch (e) { return false; }
});

// 窗口控制（无边框窗口靠渲染层的标题栏按钮调这些）
ipcMain.handle('window:minimize', function (e) {
  const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); return true;
});
ipcMain.handle('window:toggle-maximize', function (e) {
  const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
  return w.isMaximized();
});
ipcMain.handle('window:is-maximized', function (e) {
  const w = BrowserWindow.fromWebContents(e.sender);
  return w ? w.isMaximized() : false;
});
ipcMain.handle('window:close', function (e) {
  const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); return true;
});

// ==================== 重启外壳（2026-11-25 Xiodra 要求，顶栏【重启】按钮）====================
// ⛔ 核心约束（2026-11-25 实测，用 IsProcessInJob 查过）：
//   Electron 主进程、引擎、以及 Electron 自己 spawn 出来的子进程，**全都在同一个 Job Object 里**
//   （实测 `inJob=True`）。job 一关，里面所有进程一起被带走。
//   ⇒ `child_process.spawn(..., { detached: true })` **没用**：detached 只建新进程组，出不了 job。
//   实测代价：第一版就是这么写的，助手进程 pid 被记下来了，但它连第一行日志都没写成 ——
//   因为主进程 300ms 后 app.exit(0)，job 立刻把它带走了。
//
// ✅ 解法：用 **WMI `Win32_Process.Create`** 把助手生到 job 外面
//   （实测 WMI 创建的进程 `inJob=False`，父进程是 WmiPrvSE，不在我们的 job 树里）。
//   为了确保 WMI 调用**在退出前完成**，用 `spawnSync` 阻塞等它返回（正常 <1 秒）。
//
// 流程：
//   ① spawnSync powershell → Invoke-CimMethod Win32_Process Create → 在 job 外拉起 restart-helper.ps1
//   ② 校验 ReturnValue === 0（非 0 就报错、不退出，让用户看到提示）
//   ③ killServer() 收掉引擎（⛔ 否则引擎变孤儿占着 33083，新实例会"复用"它）
//   ④ app.exit(0) 退出自己
//   ⑤ 助手（已在 job 外，活下来了）等旧 pid 消失 + 等 1.5 秒让单实例锁释放 → 调 start.vbs 重拉
// ⛔ 铁律：绝不能让「被杀的进程」去执行重启。现在靠"生在 job 外"保证这一点。
// ⚠ 重启会中断当前会话（引擎被收掉，会话进程随之结束）。这是预期行为。
ipcMain.handle('app:restart', function () {
  try {
    const helper = path.join(__dirname, 'restart-helper.ps1');
    const launcher = path.join(__dirname, 'start.vbs');
    if (!fs.existsSync(helper)) return { ok: false, err: '缺少重启助手：' + helper };
    if (!fs.existsSync(launcher)) return { ok: false, err: '缺少启动器：' + launcher };

    log('[restart] 收到重启请求  pid=' + process.pid);

    // 要交给 WMI 的完整命令行（路径含空格 ⇒ 用双引号；整个字符串会塞进 PS 单引号里）
    const cmdLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "'
      + helper + '" -OldPid ' + process.pid + ' -Launcher "' + launcher + '"';
    // ⚠ ShowWindow = 0 ⇒ 助手**不弹控制台窗口**（2026-11-25 实测：不设时 hwnd 非 0，设了 hwnd=0）。
    //   ⛔ 不能用 Invoke-CimMethod + [wmiclass]'Win32_ProcessStartup' 那种写法：
    //      Invoke-CimMethod 会报 "Could not infer CimType from the provided .NET object"。
    //      必须用 New-CimInstance -ClientOnly 造 startup 对象（实测可行）。
    // PowerShell 单引号字符串里，内部的 ' 要写成两个 ''
    const psScript = [
      "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
      "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{",
      "  CommandLine = '" + cmdLine.replace(/'/g, "''") + "'",
      "  ProcessStartupInformation = $si",
      "} | ForEach-Object { $_.ReturnValue }",
    ].join('\n');

    const cpRestart = require('child_process');
    // ⚠ 实测：这个 spawnSync 要跑 6~7 秒（WMI 服务冷启动慢）。期间主进程会卡住，
    //    所以渲染层那边必须先画好「正在重启」提示再发 IPC（renderer.js 里已这么做）。
    //    不用异步：异步的话本进程可能在 WMI 还没返回时就退了，助手拉不起来。
    const r = cpRestart.spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeout: 20000, encoding: 'utf8', windowsHide: true });

    const out = String((r && r.stdout) || '').trim();
    const code = parseInt(out, 10);
    log('[restart] WMI 拉起助手  stdout=' + JSON.stringify(out.slice(0, 80))
      + ' status=' + (r && r.status) + ' error=' + ((r && r.error && r.error.message) || 'none'));

    if (!(code === 0)) {
      const why = 'WMI 创建助手失败（ReturnValue=' + (isNaN(code) ? 'unparsed:' + out : code) + '）';
      log('[restart] 中止：' + why);
      return { ok: false, err: why + '；未做任何重启动作，可手动跑 外壳\\start.vbs' };
    }

    log('[restart] 助手已在 job 外拉起，开始收引擎');
    killServer();

    setTimeout(function () {
      log('[restart] 主进程退出');
      app.exit(0);
    }, 300);
    return { ok: true, pid: process.pid };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('[restart] 失败: ' + msg);
    return { ok: false, err: msg };
  }
});

// ==================== 十、启动链 ====================
// 任何未捕获异常都不许变成"静默打不开"：记日志 + 让启动页显示失败态
process.on('uncaughtException', function (err) {
  log('[fatal] uncaughtException: ' + ((err && err.stack) || err));
  sendBoot({ stage: 'error', pct: 100, text: '主进程异常', detail: String((err && err.message) || err) });
});
process.on('unhandledRejection', function (reason) {
  log('[fatal] unhandledRejection: ' + String((reason && reason.stack) || reason));
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async function () {
    // 彻底去掉默认菜单（File/Edit/View…）：这套界面是自绘的，原生菜单栏只会占一行
    try { Menu.setApplicationMenu(null); } catch (e) { /* ignore */ }
    startReloadWatcher();   // 面板自刷新通道（data\reload-panels.cmd）

    log('==================== 启动 ====================');
    log('config    = ' + (CFG_OK ? CONFIG_FILE : '（没读到，全部用兜底值）'));
    log('engineDir = ' + HARNESS_DIR);
    log('port      = ' + DSH_PORT);
    log('dshHome   = ' + DSH_HOME);

    try { createWindow(); } catch (err) {
      log('[fatal] 创建窗口失败: ' + ((err && err.message) || err));
    }

    let ok = false;
    try { ok = await startServer(); } catch (err) {
      log('[fatal] 启动引擎异常: ' + ((err && err.stack) || err));
      ok = false;
    }

    if (!ok) {
      // 不弹框、不退出：窗口留着，启动页显示失败态 + 重试按钮
      log('startServer failed — 保留窗口，等待用户点重试');
      return;
    }

    log('[boot] 引擎就绪总耗时 ' + ((Date.now() - APP_T0) / 1000).toFixed(1) + 's');
    openReadyGate();

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(function (err) {
    log('[fatal] whenReady 启动链失败: ' + ((err && err.stack) || err));
  });

  app.on('window-all-closed', function () {
    killServer();
    app.quit();
  });

  app.on('before-quit', function () {
    killServer();
  });
}
