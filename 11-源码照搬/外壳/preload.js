// preload.js —— 渲染层唯一桥（contextIsolation: true）
// 只暴露"启动页"需要的几个能力，不做万能 IPC 通道。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kun', {
  // ---- 启动页 ----
  boot: {
    // 当前进度快照：{ stage, pct, text, detail, ts }
    state: () => ipcRenderer.invoke('boot:state'),
    // 失败后重试：{ ok, err? }
    retry: () => ipcRenderer.invoke('boot:retry'),
    // 用系统默认程序打开 server.log（失败时排障用）
    openLog: () => ipcRenderer.invoke('boot:open-log'),
    // 订阅进度：返回取消订阅函数（幂等，重复订阅各自独立）
    onProgress: (cb) => {
      const h = (_e, payload) => { try { cb(payload); } catch (err) { /* ignore */ } };
      ipcRenderer.on('boot:progress', h);
      return () => ipcRenderer.removeListener('boot:progress', h);
    }
  },
  // ---- 引擎 ----
  harness: {
    // 带 token 的引擎地址（由主进程拼，渲染层不碰 token）
    url: () => ipcRenderer.invoke('harness:url'),
    // 引擎是否已就绪（已经拿到 token 或复用了外部实例）
    ready: () => ipcRenderer.invoke('harness:ready'),
    // 引擎就绪广播：返回取消订阅函数
    onReady: (cb) => {
      const h = (_e, payload) => { try { cb(payload); } catch (err) { /* ignore */ } };
      ipcRenderer.on('harness:ready', h);
      return () => ipcRenderer.removeListener('harness:ready', h);
    }
  },
  // ---- 场景体系 ----
  scenarios: {
    // 标签栏用的精简列表：[{ id, name, description, icon, first, panelCount }]
    list: () => ipcRenderer.invoke('scenarios:list'),
    // 完整场景 json（含 panels），点开某个场景时才取
    get: (id) => ipcRenderer.invoke('scenario:get', id),
    // 改元字段（icon / name / projectDir / sessionId / sessionTitle / pinTarget），只写白名单
    patch: (id, patch) => ipcRenderer.invoke('scenario:patch', id, patch),
    // 新建场景（按布局预设生成 panels；可一并写入会话绑定 / 项目文件夹）
    create: (input) => ipcRenderer.invoke('scenario:create', input),
    // 换布局：保留全部面板与配置，只重排网格（派单 49cf727f55）
    relayout: (id, preset) => ipcRenderer.invoke('scenario:relayout', id, preset),
    // 保存标签顺序（顺序唯一权威在主进程 data\scene-tab-order.json）
    setOrder: (order) => ipcRenderer.invoke('scenario:order', order),
    // 改单个面板的字段（标题 / 小字 / 类型 / 该类型的配置项）
    patchPanel: (sceneId, panelId, patch) => ipcRenderer.invoke('panel:patch', sceneId, panelId, patch),
    // 加一块面板 / 删一块面板
    addPanel: (sceneId, input) => ipcRenderer.invoke('panel:add', sceneId, input),
    removePanel: (sceneId, panelId) => ipcRenderer.invoke('panel:remove', sceneId, panelId),
    // 面板类型目录（24 种 + 外壳自有的 console/placeholder）
    panelTypes: () => ipcRenderer.invoke('panel:types')
  },
  // ---- AI 面板的 webview 分区（一板一分区，见文档《会话绑定三字段》）----
  panel: {
    // 给这个分区种鉴权 cookie，返回可用地址；种不成返回 ''（别让它去撞 401 白屏）
    prime: (partition) => ipcRenderer.invoke('panel:prime', partition), capture: (panelId, dataUrl) => ipcRenderer.invoke('panel:capture', panelId, dataUrl),
    // 把系统焦点交给面板的 webview —— 输入法（TSF）只跟系统焦点走，
    // 焦点留在壳里时中文打不进面板输入框（详见 main.js 的「输入法焦点」注释）。
    // 传 panelId 或 partition 都行。返回 { ok, type?, url? } | { ok:false, err }
    focus: (key) => ipcRenderer.invoke('webview:focus', key) },
  // ---- 面板自刷新通道（文档《面板通用能力》§2）----
  panels: {
    // 订阅重载广播：内容 = { scope:'all'|场景id, at }，返回取消订阅函数
    onReload: (cb) => {
      const h = (_e, payload) => { try { cb(payload); } catch (err) { /* ignore */ } };
      ipcRenderer.on('panels:reload', h);
      return () => ipcRenderer.removeListener('panels:reload', h);
    },
    // 自己投递一次重载请求（改完面板配置顺手刷新，不用让用户点 ⟳）
    requestReload: (scope) => ipcRenderer.invoke('panels:reload-request', scope)
  },
  // ---- 控制器 ----
  console: {
    // { cards:[…], sessions:[…], workspaces:[…], at } —— 主进程读引擎投影缓存算好
    model: () => ipcRenderer.invoke('console:model'),
    // 点过发光卡片 = 确认熄光
    ack: (sceneId, ackKey) => ipcRenderer.invoke('console:ack', sceneId, ackKey)
  },
  // ---- 选目录 / 选图标（无边框窗口里没法用原生 file input 选目录）----
  dialog: {
    pickFolder: (startAt) => ipcRenderer.invoke('dialog:pick-folder', startAt),
    pickIcon: () => ipcRenderer.invoke('dialog:pick-icon'),
    // 选一个文件（预览面板空态用）；取消返回 ''
    pickFile: (startAt) => ipcRenderer.invoke('dialog:pick-file', startAt)
  },
  // ---- 文件系统（file / view 面板的数据来源）----
  // 只读：看目录 / 读文本 / 用系统程序打开 / 在资源管理器里定位。
  // 一条写盘通道都没开 —— 面板现在是"看"的，需要写入时再单开带校验的。
  fs: {
    // { roots:[{name,path}], home:{name,path}, homePath }
    roots: () => ipcRenderer.invoke('fs:roots'),
    // { ok, base, rows:[{name,isDir,size,mtime}] } | { ok:false, err }
    list: (dir) => ipcRenderer.invoke('fs:list', dir),
    // { ok, text, size, mtime } | { ok:false, err, binary?, tooBig? }
    readText: (p, maxBytes) => ipcRenderer.invoke('fs:read-text', p, maxBytes),
    stat: (p) => ipcRenderer.invoke('fs:stat', p),
    openPath: (p) => ipcRenderer.invoke('fs:open-path', p),
    reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
    // ---- 目录体积扫描（电脑族用）：begin 拿 token → scanDir 开扫 → 切走时 abort ----
    // ⛔ 必须异步 + 可中断：扫全盘会吃满 CPU，用户切走面板要能立刻停。
    scanBegin: () => ipcRenderer.invoke('fs:scan-begin'),
    scanDir: (dir, opts) => ipcRenderer.invoke('fs:scan-dir', dir, opts),
    scanAbort: (token) => ipcRenderer.invoke('fs:scan-abort', token),
    // 进度广播：返回取消订阅函数
    onScanProgress: (cb) => {
      const h = (_e, payload) => { try { cb(payload); } catch (err) { /* ignore */ } };
      ipcRenderer.on('fs:scan-progress', h);
      return () => ipcRenderer.removeListener('fs:scan-progress', h);
    }
  },
  // ---- M7 顶栏三按钮：插件 / 技能 / 工具（照搬参照 淋雨家 的 preload 桥）----
  plugins: {
    // { pluginsDir, plugins:[{name,displayName,version,description,path,cacheDir?,configDir?}], error }
    list: () => ipcRenderer.invoke('plugins:list')
  },
  skills: {
    // { skillsDir, skills:[{name,description,path,bytes}], error }
    list: () => ipcRenderer.invoke('skills:list'),
    // 在系统里打开技能/插件/工具目录（主进程限三个根，不是任意路径打开器）
    open: (target) => ipcRenderer.invoke('skills:open', target)
  },
  tools: {
    // { toolsDir, tools:[{file,name,description,path,bytes,internal}], error }
    catalog: () => ipcRenderer.invoke('tools:catalog')
  
  },

  // ---- MCP（派单 f6b6b4baa8 【二】）----
  // { profilesDir, items:[{profile,bundle,serverName,transport,patchPath}], dirsScanned, error }
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list')
  },

  // ---- 模型与提供方（派单 f6b6b4baa8 【三】）----
  // { providers:[{profile,name,baseURL,models:[],hasKey,envName}], error }
  // hasKey 是布尔值，⛔ 不含任何 key 内容
  models: {
    list: () => ipcRenderer.invoke('models:list')
  },

  // ---- 工作流（派单 f6b6b4baa8 【一】）----
  // 依赖校验只在 工具\工作流.mjs，这里只转发
  wf: {
    list: () => ipcRenderer.invoke('wf:list'),
    load: (file) => ipcRenderer.invoke('wf:load', file),
    mark: (file, nodeId, state) => ipcRenderer.invoke('wf:mark', file, nodeId, state)
  },
  // ---- 视频外部播放器（2026-11-25，MPV-EASY-Player 集成）----
  // { ok, found, exe, kind }  found=false 表示本机没装 mpv / MPV-EASY-Player
  video: {
    player: () => ipcRenderer.invoke('video:player'),
    // 用外部播放器打开（找不到就回落系统默认程序）；返回 { ok, via, exe }
    open: (p) => ipcRenderer.invoke('video:open', p)
  },

  // ---- 系统信息（电脑族：各盘容量）----
  sys: {
    // { ok, disks:[{ mount, name, total, free, used, err }], at }
    disks: () => ipcRenderer.invoke('sys:disks'),
    // 顶栏负载胶囊：{ at, cpu:{pct,cores}, mem:{pct,usedGB,totalGB}, gpu:{available,pct,usedMB,totalMB,name} }
    // ⛔ 取不到的项返回 null + err，渲染层显示「—」，不许编数字
    load: () => ipcRenderer.invoke('sys:load')
  },
  // ---- 清理台账（只追加，落 外壳\data\pc-cleanup-log.json）----
  pc: {
    // read => { ok, rows, file } | append => { ok, row, count }
    ledger: (action, payload) => ipcRenderer.invoke('pc:ledger', action, payload),
    // 可清理项：主进程跑 工具\垃圾判据.mjs，返回 { ok, safe, ask, neverCount, totalBytes }
    junkScan: () => ipcRenderer.invoke('pc:junk-scan')
  },
  // ---- 主题（壁纸 + 外观）----
  // 设置存宿主端 data\theme.json，渲染层只负责把它画出来。
  // 参考 dsh-wallpaper-engine 的「壁纸 / 外观」两块，其余（吉祥物、特效、桌宠…）一律不做。
  theme: {
    // 完整设置对象（出厂值 ⊕ 用户改动，缺键自动补齐）
    get: () => ipcRenderer.invoke('theme:get'),
    // 浅合并两层（wallpaper / look），只认白名单键；返回 { ok, theme }
    patch: (patch) => ipcRenderer.invoke('theme:patch', patch),
    // 选图 / 选视频，返回绝对路径；取消返回 ''
    pickWallpaper: () => ipcRenderer.invoke('theme:pick-wallpaper')
  },
  // 用系统浏览器打开一个网址（面板里的网页不该在工作台里开新窗口）
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  // ---- 版本信息（左上角悬停用）----
  version: () => ipcRenderer.invoke('app:version'),
  // ---- 窗口控制（自绘标题栏用，窗口是 frame:false）----
  win: {
    min: () => ipcRenderer.invoke('window:minimize'),
    toggleMax: () => ipcRenderer.invoke('window:toggle-maximize'),
    isMax: () => ipcRenderer.invoke('window:is-maximized'),
    close: () => ipcRenderer.invoke('window:close')
  },
  // ---- 重启外壳（顶栏【重启】按钮）：收引擎 + 重拉新实例 ----
  // ⚠ 会中断当前会话（引擎被收掉）。返回 { ok, pid, helperPid } | { ok:false, err }
  //   实际重启由主进程抛出的 restart-helper.ps1 完成，本进程随即退出。
  app: {
    restart: () => ipcRenderer.invoke('app:restart')
  }
});
