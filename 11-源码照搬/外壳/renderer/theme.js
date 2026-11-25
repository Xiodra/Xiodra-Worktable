// theme.js —— 主题（壁纸 + 外观）渲染层
// ─────────────────────────────────────────────────────────────
// 参考 dsh-wallpaper-engine 的「壁纸 / 外观」两块能力，**只做这两块**：
//   壁纸：本机图片或视频铺满工作台（适配方式 / 不透明度 / 模糊 / 压暗可调）
//   外观：主色 / 面板不透明度 / 毛玻璃 / 边框 / 圆角 / 字体
// 明确不做：吉祥物、点击特效、3D 视差、桌宠、Wallpaper Engine 工坊项目解析 ——
//   Wallpaper Engine 的 Scene/Web 壁纸需要它自带的 WebWallGL 实时渲染器，
//   那是另一个量级的工程，用户明确说"其他不需要"。
//
// 设置的唯一权威在主进程（data\theme.json）：
//   这里只负责读一次、画出来、改了就回写 —— 不自己存 localStorage，
//   否则两份状态迟早打架（重启后界面与文件对不上，最难查的那类问题）。
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var CUR = null;          // 当前生效的设置（出厂值 ⊕ 用户改动）
  var TAB = 'wallpaper';   // 抽屉当前页签
  var saveTimer = null;
  var mediaEl = null;      // 当前壁纸元素（img / video）

  var ACCENT_DEFAULT = '#4f8cff';

  // 这些字体在本机基本都存在；写多个做回落，缺一个不至于变方框
  var FONTS = [
    { v: '', label: '系统默认' },
    { v: '"Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif', label: '微软雅黑' },
    { v: '"Segoe UI", system-ui, sans-serif', label: 'Segoe UI' },
    { v: '"Source Han Sans SC", "Noto Sans SC", sans-serif', label: '思源黑体' },
    // 「雅痞-简」：本机字体文件是 "雅痞-简 常规体.otf"，但**内部家族名是 Yuppy SC**，
    // CSS 必须用英文名才命中（用中文名会静默回落成系统默认）。
    { v: '"Yuppy SC", "Microsoft YaHei UI", sans-serif', label: '雅痞-简' },
    { v: '"SimSun", "宋体", serif', label: '宋体' },
    { v: '"Cascadia Code", Consolas, monospace', label: '等宽' }
  ];

  // ---------------- 工具 ----------------
  // 路径 → file:// URL。盘符段不能 encode（D: 编码成 D%3A 就打不开了）
  function fileUrlOf(p) {
    var s = String(p || '').replace(/\\/g, '/');
    var segs = s.split('/');
    var out = segs.map(function (seg, i) {
      if (i === 0 && /^[A-Za-z]:$/.test(seg)) return seg;
      return encodeURIComponent(seg);
    });
    return 'file:///' + out.join('/');
  }

  function baseName(p) {
    var s = String(p || '').replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // 十六进制 → rgba()。alpha 用 0..1。
  function hexToRgba(hex, alpha) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '4f8cff';
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /** 把 #rrggbb 拆成 "r,g,b"（给 rgba(var(--x), a) 用） */
  function hexToRgbParts(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '4f8cff';
    return parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---------------- 壁纸层 ----------------
  function paintWallpaper(w) {
    var layer = $('wallpaper-layer');
    var media = $('wallpaper-media');
    var dim = $('wallpaper-dim');
    if (!layer || !media || !dim) return;

    var has = !!(w && w.path && w.kind);
    document.body.classList.toggle('has-wallpaper', has);
    if (!has) {
      media.textContent = '';
      mediaEl = null;
      layer.style.opacity = '0';
      tintAllGuests();
      return;
    }

    var fit = (w.fit === 'contain' || w.fit === 'stretch') ? w.fit : 'cover';
    var objectFit = (fit === 'stretch') ? 'fill' : fit;

    // 路径没变就不重建元素 —— 拖不透明度滑块时重建 <video> 会闪、还要重新缓冲
    var want = w.kind + '|' + w.path;
    if (media.getAttribute('data-want') !== want) {
      media.textContent = '';
      if (w.kind === 'video') {
        mediaEl = document.createElement('video');
        mediaEl.className = 'wallpaper-video';
        mediaEl.src = fileUrlOf(w.path);
        mediaEl.autoplay = true;
        mediaEl.loop = true;
        mediaEl.muted = true;          // 静音才允许自动播放
        mediaEl.playsInline = true;
        mediaEl.setAttribute('muted', '');
      } else {
        mediaEl = document.createElement('img');
        mediaEl.className = 'wallpaper-img';
        mediaEl.src = fileUrlOf(w.path);
        mediaEl.draggable = false;
        mediaEl.alt = '';
      }
      mediaEl.style.objectFit = objectFit;
      media.appendChild(mediaEl);
      media.setAttribute('data-want', want);
    } else if (mediaEl) {
      mediaEl.style.objectFit = objectFit;
    }

    layer.style.opacity = String(Math.max(0, Math.min(100, w.opacity)) / 100);
    media.style.filter = w.blur > 0 ? 'blur(' + w.blur + 'px)' : 'none';
    // 模糊会让边缘露出底色，放大一点点盖住（否则四边一圈黑边）
    media.style.transform = w.blur > 0 ? 'scale(1.04)' : 'none';
    dim.style.opacity = String(Math.max(0, Math.min(90, w.dim)) / 100);
    // 壁纸有/无变了，引擎页也要跟着变（否则关掉壁纸后引擎还是透明的）
    tintAllGuests();
  }

  // ---------------- 引擎页（webview）跟着壁纸透明化 ----------------
  // 引擎界面在 <webview> 里，guest 页自带不透明底色（实测 body 与 [class*="_frame"] 都是 rgb(21,21,23)），
  // 只靠外壳这边透明是透不过来的。这里给每个 guest 注入「压暗层 + 全部元素透明」，
  // 并用 html.xiodra-wp 当开关 —— 关掉壁纸就摘类，引擎立刻回原样。
  // 壁纸透传只影响**透明度**，不影响**色系**（2026-11-19 重写）
  //
  // 用户原话：「引擎是浅色的外观，但是却显示深色样子…我们【主题】只能影响它的
  //   【透明度】不能影响它本来的色系」
  //
  // 旧实现的错：给所有 div/section/main 设 background-color: transparent !important，
  //   等于把颜色整个抹掉 ⇒ 引擎自己的白底（浅色主题）没了，透出外壳的深色底 ⇒ 看着像深色。
  //
  // 新实现：
  //   ① 不碰任何元素的 background-color —— 引擎是什么色就是什么色；
  //   ② 壁纸透出的程度靠 webview 容器的 opacity（见 tintGuest）；
  //   ③ 这里只保留一条"弹层不要滤镜"的兜底（与色系无关）。
  // 壁纸透传：**只让"页面背景"透，弹层永远不透明**（2026-11-19 定稿）
  //
  // 演进史（三次都踩过，记下别再绕）：
  //   ① 给所有元素设 background:transparent !important ⇒ 把引擎配色整个抹掉（错，已删）
  //   ② 给 webview 设 opacity ⇒ **整棵树**一起变淡，设置弹层也发虚（错，用户报"又透明了"）
  //   ③ 现在：给 html 铺一层可控的**背景罩**（--wp-veil），弹层单独强制不透明。
  //      opacity 只作用在罩子上，不碰任何内容元素。
  // 壁纸透传（2026-11-19 第 3 版定稿）
  //
  // 演进史 —— 三种做法都实测过，前两种都会把设置面板弄透明：
  //   ① 所有 div 设 transparent        ⇒ 弹层被一起抹掉（设置面板透明）
  //   ② webview 整页 opacity           ⇒ 弹层跟着一起淡（设置面板又透明）
  //   ③ **只让最外层背景透明**（本版）  ⇒ 弹层保留自己的底色 ⇒ 不透明 ✔
  //
  // 白名单只有四个：html / body / #root / [class*="_frame"]。
  // 这四层是"页面底板"，把它们透掉，壁纸就能上来；
  // ⛔ 绝不再写 `div`（那会把弹层、按钮、输入框的底色全抹掉）。
  // 在引擎页里跑：把侧栏/输入卡"自己的颜色 + alpha"写回去（R/G/B 不动）
  var TRANSLUCENT_JS = '(' + function (alpha, on) {
    try {
      function parseColor(c) {
        var m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c || '');
        if (!m) return null;
        return { r: +m[1], g: +m[2], b: +m[3], a: (m[4] === undefined ? 1 : +m[4]) };
      }
      var SEL = '[class*="sidebarCol"],[class*="sidebar"],[class*="Sidebar"],'
        + '[class*="_card"],[class*="composer"],[class*="Composer"]';

      function apply() {
        var list = document.querySelectorAll(SEL);
        for (var i = 0; i < list.length; i++) {
          var el = list[i];
          if (on) {
            // 第一次见到它：读"引擎自己的颜色"存起来（之后我们写的是 inline，再读就不准了）
            if (!el.getAttribute('data-xiodra-rgb')) {
              var c = parseColor(getComputedStyle(el).backgroundColor);
              if (!c || c.a < 0.05) continue;          // 本身透明的容器跳过
              el.setAttribute('data-xiodra-rgb', c.r + ',' + c.g + ',' + c.b);
            }
            var p = el.getAttribute('data-xiodra-rgb').split(',');
            el.style.setProperty('background-color',
              'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + alpha + ')', 'important');
          } else {
            el.style.removeProperty('background-color');
            el.removeAttribute('data-xiodra-rgb');
          }
        }
      }
      apply();
      // 引擎是 SPA，容器会重建 ⇒ 观察一次变化就补
      if (on && !window.__xiodraTranslucentObs && window.MutationObserver) {
        var timer = null;
        window.__xiodraTranslucentObs = new MutationObserver(function () {
          if (timer) return;
          timer = setTimeout(function () { timer = null; apply(); }, 150);
        });
        window.__xiodraTranslucentObs.observe(document.body, { childList: true, subtree: true });
      }
      window.__xiodraTranslucent = true;
    } catch (e) { /* ignore */ }
  }.toString() + ')(__ALPHA__, __ON__)';

  var ENGINE_WP_CSS = [
    // ① 只透最外层底板
    'html.xiodra-wp, html.xiodra-wp body, html.xiodra-wp #root,',
    // ★引擎的内容根：刚刚实测到 krsYsW_root 是全屏纯白（rgb(255,255,255)），
    // 它不是 _frame 也不是 #root，所以之前没被透掉 ⇒ 壁纸进不来。
    // 用 [class*="_root"] 精确匹配引擎的命名风格（<hash>_root）；
    // 弹层类名是 *mask / *overlay / *panel，不含 _root，所以不会误伤。
    // ⚠ 这里只透**页面底板**（_frame）。
    // 早先还写了 [class*="_root"] / _main / _content / _layout，
    // 它们太宽，把「侧栏 / 输入框」这类**实体块的父容器**也透了
    // ⇒ 实体块看起来也没了底（用户报：左侧栏和输入框要不透明）。
    // ★只命中页面底板★（2026-11-20 第四次收窄）
    // 底板 = _frame；实体块（sidebar / card / composer / panel / dialog / menu）一律用 :not() 排除。
    // ⛔ 不再用 revert/unset/inherit 去"把颜色改回去"——那会破坏引擎自己的配色。
    'html.xiodra-wp [class*="_frame"]:not([class*="sidebar"]):not([class*="Sidebar"]):not([class*="_card"]):not([class*="composer"]):not([class*="_panel"]),',
    'html.xiodra-wp [class*="_root"]:not([class*="sidebar"]):not([class*="Sidebar"]):not([class*="_card"]):not([class*="composer"]):not([class*="_panel"]):not([class*="overlay"]),',
    'html.xiodra-wp [class*="_main"]:not([class*="sidebar"]):not([class*="Sidebar"]):not([class*="_card"]),',
    'html.xiodra-wp [class*="_layout"]:not([class*="sidebar"]):not([class*="Sidebar"]):not([class*="_card"]) {',
    '  background-color: transparent !important;',
    '  background-image: none !important;',
    '}',
    // ② 压暗罩：壁纸透上来后靠它保文字对比度（可调，来自 --wp-veil）
    'html.xiodra-wp::before {',
    '  content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;',
    '  background: rgba(9, 11, 16, calc(1 - var(--wp-veil, 1)));',
    '}',
    // ③ 内容要在罩子之上
    'html.xiodra-wp body { position: relative; z-index: 1; }',
    // ④ 弹层/菜单：只保证"不透明"，**位置与层级交还引擎**（2026-11-20 修）
    // ⛔ 原来这里还写了 `position: relative; z-index: 2` —— 那是过度入侵：
    //    引擎的「会话右侧三点菜单」是 position:absolute 锚在按钮旁的弹层，
    //    被强改成 relative 就掉回正常文档流 ⇒ 跑到左下角（用户报的那个 bug）。
    // ⇒ 现在只留两行与"不透明"直接相关的；position / z-index 一个字都不写。
    'html.xiodra-wp [role="dialog"], html.xiodra-wp [role="alertdialog"],',
    'html.xiodra-wp [role="menu"], html.xiodra-wp [role="listbox"],',
    'html.xiodra-wp [aria-modal="true"] {',
    '  opacity: 1 !important;',
    '  backdrop-filter: none !important;',
    '}'
  ].join('\n');

  /**
   * 隐藏引擎左侧栏的 CSS（2026-11-24 方案 A）。
   *
   * ⚠ 只注入到 AI 会话面板（persist:ai-panel-*），不影响引擎整页（persist:harness）。
   * ⚠ 用 [class*="sidebarCol"] 而不是写死 .tXqQLW_sidebarCol：
   *    那个前缀是 CSS Modules 的哈希，引擎升级会变；"包含 sidebarCol" 更抗变化。
   * ⚠ display:none 会连带把它的 flex 占位一起收掉，主内容区自动撑满（已实测）。
   */
  var ENGINE_SIDEBAR_HIDE_CSS = [
    '/* 隐藏引擎左侧栏（AI 会话面板专用；开关在外壳面板工具栏） */',
    '/* ⚠ 光 display:none 不够：引擎是 CSS Grid（56px 877px 0px），',
    '   grid 第一列仍占位 ⇒ 左侧留空白。 */',

    // ★① 用 :has() 精确只压"含侧栏列的那个 grid"★
    //   为什么不写成「任何三列 grid」：实测那样会把 _5S7B9a_turnErrorRow（对话里的错误行，
    //   也是三列 grid）一起压坏 —— 这是我第一版踩过的 bug，别再退回去。
    //   为什么用内联 style 特征而不是类名：类名是 CSS Modules 哈希会变；
    //   （此思路借鉴《淋雨家的工作台》HARNESS_CHAT_CSS 的第一行。）
    'div[style*="grid-template-columns"]:has([class*="sidebarCol"]) {',
    '  grid-template-columns: 0px minmax(0, 1fr) 0px !important;',
    '}',
    // ★② 侧栏元素本身也隐掉（双保险）★
    '[class*="sidebarCol"] { display: none !important; }'
  ].join('\n');

  /**
   * 把引擎 grid 的第一列（左侧栏）压成 0，让主内容区撑满。
   *
   * 实测（2026-11-24）：grid-template-columns "56px 877px 0px" → "0px 933px 0px"
   *   ⇒ 对话区 left 56→0、宽度 870→926，左侧无空白。
   * 找法：display:grid 且正好三列的那个元素（引擎的 tXqQLW_frame）；
   *   ⛔ 不按类名找 —— 那前缀是 CSS Modules 哈希，引擎升级就变。
   * 幂等：已经是 "0px … 0px" 就跳过，避免每轮都触发重排。
   */
  var COLLAPSE_GRID_JS = '(' + function () {
    // ⚠ 必须只找「含侧栏列的 grid」：第一版按"三列 grid"找，
    //   把对话里的 turnErrorRow（也是三列）一起压坏过。
    var cols = document.querySelectorAll('[class*="sidebarCol"]');
    if (!cols.length) return 'nosidebar';
    var any = false;
    for (var i = 0; i < cols.length; i++) {
      var g = cols[i].parentElement;
      // 往上找最近的 grid 容器（侧栏列一般是 grid 的直接子项）
      var hop = 0;
      while (g && hop < 4) {
        var cs = getComputedStyle(g);
        if (cs.display === 'grid') break;
        g = g.parentElement; hop++;
      }
      if (!g || !g.style) continue;
      var cur = String(getComputedStyle(g).gridTemplateColumns || '').trim().split(/\s+/);
      if (cur.length !== 3) continue;
      if (parseFloat(cur[0]) === 0) { any = true; continue; }   // 已压好，跳过避免重排
      g.style.setProperty('grid-template-columns', '0px minmax(0,1fr) 0px', 'important');
      any = true;
    }
    return any ? 'collapsed' : 'skip';
  }.toString() + ')()';

  function wallpaperOn() {
    return !!(CUR && CUR.wallpaper && CUR.wallpaper.path && CUR.wallpaper.kind);
  }

  // 给一个 guest 注入（dom-ready 时调一次；reload 会把样式清掉，所以要重注）
  function tintGuest(wv) {
    if (!wv || wv.tagName !== 'WEBVIEW') return;
    // ★白名单：只有引擎页才注入★（2026-11-21 修，派单 07bf1af0d0）
    //
    // 历史（两次都是"黑名单漏了"）：
    //   · 2026-11-18：persist:webai-*（网页版 AI）漏排除 ⇒ 背景被抹成色块 ⇒ 加了黑名单；
    //   · 2026-11-21：persist:panel-*（embed 面板）又漏了 ⇒ DeepSeek 页被注入引擎规则，
    //     html.xiodra-wp body{position:relative;z-index:1} + 透明底板规则 套到第三方站点上，
    //     把它的布局压塌 —— **guest 的 body 高度变成 0**，网页内容一件都画不出来，
    //     用户只看到 webview 元素自己的底色（纯黑一片）。
    //
    // ⇒ 改成**白名单**：只有引擎页（persist:harness / persist:ai-panel-*）才注入，
    //   其余一律按"第三方页面"跳过。以后再加新分区类型也不会再漏。
    try {
      var part = String(wv.getAttribute("partition") || "");
      var isEngine = /^persist:(harness|ai-panel-)/.test(part);
      if (!isEngine) {
        // 保险起见：以前被注入过的，主动把类和变量摘干净
        try {
          wv.executeJavaScript(
            "(function(){var d=document.documentElement;"
            + "d.classList.remove('xiodra-wp');"
            + "d.style.removeProperty('--wp-veil');"
            + "})()"
          );
        } catch (e2) { /* ignore */ }
        return;
      }
    } catch (e) { /* 拿不到分区就按原样处理 */ }
    var on = wallpaperOn();
    try { wv.insertCSS(ENGINE_WP_CSS); } catch (e) { /* guest 还没就绪就算了，下次 dom-ready 再说 */ }

    // ★AI 会话面板：按面板开关隐藏引擎侧边栏（2026-11-24 方案 A+D）★
    //   开关存在 webview 的 data-engine-sidebar 上（renderers.js 从场景 json 写入）。
    //   ⛔ 只对 persist:ai-panel-* 生效：引擎整页（persist:harness）是用户全屏用的，侧栏有用，不动它。
    try {
      var part2 = String(wv.getAttribute('partition') || '');
      var isAiPanel = /^persist:ai-panel-/.test(part2);
      var mode = String(wv.dataset ? (wv.dataset.engineSidebar || '') : '');
      if (isAiPanel && mode === 'hide') {
        try { wv.insertCSS(ENGINE_SIDEBAR_HIDE_CSS); } catch (e3) { /* ignore */ }
        // insertCSS 在 guest 重载后会失效 ⇒ 同时补一条 <style>（两条路并行，更稳）
        try {
          wv.executeJavaScript(
            "(function(){"
            + "var id='xiodra-hide-sidebar';"
            + "if(!document.getElementById(id)){"
            + "var st=document.createElement('style');st.id=id;"
            + "st.textContent='[class*=\"sidebarCol\"]{display:none !important}';"
            + "(document.head||document.documentElement).appendChild(st);}"
            + "return 'ok';"
            + "})()"
          );
        } catch (e4) { /* ignore */ }
        // ★再压 grid 第一列★（只 display:none 会留 56px 空白，实测证实）
        try { wv.executeJavaScript(COLLAPSE_GRID_JS); } catch (e4b) { /* ignore */ }
      } else if (isAiPanel) {
        // 切回 auto：把之前注入的 <style> 摘掉，让引擎恢复自适应
        try {
          wv.executeJavaScript(
            "(function(){var n=document.getElementById('xiodra-hide-sidebar');if(n)n.remove();return 'ok';})()"
          );
        } catch (e5) { /* ignore */ }
      }
    } catch (e6) { /* ignore */ }
    try {
      wv.executeJavaScript(
        'document.documentElement.classList.' + (on ? 'add' : 'remove') + '("xiodra-wp")'
      );
    } catch (e) { /* ignore */ }

    // ★透明度只作用于背景层★（2026-11-19 修正）
    // 早先用 `wv.style.opacity` 整页调透明 —— opacity 作用于**整棵子树**，
    // 设置弹层（role=dialog）也跟着变淡、壁纸从它后面透上来 ⇒ 用户报"设置面板又透明了"。
    // 现在：容器 opacity 恢复 1，改用"给引擎页铺一层可控的背景罩"来透壁纸，
    // 弹层/菜单由 ENGINE_WP_CSS 里的规则**强制不透明**（见那里的弹层豁免）。
    try {
      var w = (CUR && CUR.wallpaper) || {};
      var dim = Math.max(0, Math.min(90, Number(w.dim) || 30));
      // 引擎背景罩的不透明度：dim 越大越压暗（越不透明）；最透约 0.72
      var veil = on ? (0.72 + (dim / 90) * 0.28) : 1;
      wv.style.opacity = '1';                 // ⛔ 整页不设 opacity
      wv.style.background = on ? 'transparent' : '';
      // 把透明度值传给 guest（ENGINE_WP_CSS 里用 --wp-veil 铺背景罩）
      try {
        wv.executeJavaScript(
          'document.documentElement.style.setProperty("--wp-veil", "' + veil.toFixed(2) + '");'
        );
      } catch (e2) { /* ignore */ }

      // ★侧栏 / 输入卡做成半透明★（2026-11-20 用户要求：要能看见背景图，但颜色不改）
      // 做法：在 guest 里读它们**自己的计算色**，原样带上 alpha 写回 —— R/G/B 不动，只降 A。
      // 这样色系一个值都没改，只是变成半透明。
      // alpha 跟「面板不透明度」走（下限 0.55 保可读）。
      try {
        var panelA = Math.max(40, Math.min(100, Number((CUR && CUR.look && CUR.look.panelAlpha) || 100))) / 100;
        var alpha = Math.min(0.92, Math.max(0.55, panelA));
        wv.executeJavaScript(TRANSLUCENT_JS.replace('__ALPHA__', alpha.toFixed(2)).replace('__ON__', on ? 'true' : 'false'));
      } catch (e2) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  function tintAllGuests() {
    var list = document.querySelectorAll('webview');
    for (var i = 0; i < list.length; i++) tintGuest(list[i]);
  }

  // webview 的 dom-ready 会冒泡到 document —— 在 document 上捕获，新加的面板 webview 也能挂上
  document.addEventListener('dom-ready', function (ev) {
    var t = ev.target;
    if (t && t.tagName === 'WEBVIEW') tintGuest(t);
  }, true);
  // ---------------- 外观（CSS 变量）----------------
  // ★模式（浅色 / 深色）★ 2026-11-19 用户要求。
  // 两套调色板分开写：颜色是"全套"的，只改一两个变量会导致浅色下仍有一堆写死的深色块。
  var MODES = {
    dark: {
      bg: '#0b0d12', bgPanel: '#131722', bgPanelHover: '#1a2030',
      text: '#e6e8ee', textDim: '#8b93a7', border: '#232a3a',
      headBg: '#0d1017', panelHeadBg: '#10141d',
      inputBg: 'rgba(255,255,255,.03)', inputBorder: '#232a3a',
      scrollThumb: '#2b3345', scrollThumbHover: '#3a4459',
      // 滑杆：深色下"半透明白"看得见
      sliderTrack: 'rgba(255,255,255,.22)', sliderThumbBorder: '#0d1017',
      // 面板标题栏
      panelHead: '#161b27',
      // 普通按钮/输入框的默认描边（浅色下必须够深，否则"按钮像没有边框"）
      btnBorder: 'rgba(255,255,255,.14)',
      // 下拉弹层（select/option）：深色下就是深底浅字
      selectScheme: 'dark',
      selectOptBg: '#131722',
      selectOptColor: '#e6e8ee',
      selectOptOnBg: '#1f3a63',
      selectOptOnColor: '#ffffff'
    },
    light: {
      bg: '#f4f6fa', bgPanel: '#ffffff', bgPanelHover: '#eef2f8',
      text: '#1b1f27', textDim: '#5f6b7f', border: '#d8dee8',
      headBg: '#eaeef5', panelHeadBg: '#f0f3f9',
      inputBg: 'rgba(0,0,0,.03)', inputBorder: '#d8dee8',
      scrollThumb: '#c2cad6', scrollThumbHover: '#a9b3c2',
      // 浅色下"半透明白轨道"在白底上等于看不见 ⇒ 改深灰
      sliderTrack: 'rgba(27,31,39,.22)', sliderThumbBorder: '#ffffff',
      panelHead: '#f0f3f9',
      // 浅色下按钮边框要比 border 更深一点才看得出来
      btnBorder: 'rgba(27,31,39,.16)',
      // 浅色下弹层必须白底深字（原来写死 #131722 ⇒ 浅色里弹层还是深色，就是这次报的"色系不对"）
      selectScheme: 'light',
      selectOptBg: '#ffffff',
      selectOptColor: '#1b1f27',
      selectOptOnBg: '#dbe7ff',
      selectOptOnColor: '#14428f'
    }
  };
  function modeOf(k) { return (k && k.mode === 'light') ? 'light' : 'dark'; }

  function paintLook(k) {
    var accent = k.accent || ACCENT_DEFAULT;
    var panelA = Math.max(40, Math.min(100, k.panelAlpha)) / 100;
    var borderA = Math.max(0, Math.min(100, k.border)) / 100;
    var radius = Math.max(0, Math.min(20, k.radius));
    var blur = Math.max(0, Math.min(24, k.blur));
    var mode = modeOf(k);
    var M = MODES[mode];
  // ★面板特效档位★（2026-11-23 用户要求做成可切换）
  //   beam = 边缘流光 / glow = 呼吸光环 / none = 不要
  //   用 <html data-effect> 交给 CSS 分流，⛔ 不用 CSS 变量（伪元素里没法用变量做 display 分流）
  var EFFECTS = ['beam', 'glow', 'none'];
  var eff = String((k && k.effect) || 'beam');
  if (EFFECTS.indexOf(eff) < 0) eff = 'beam';
  document.documentElement.setAttribute('data-effect', eff);
    var isLight = mode === 'light';

    var css = [
      ':root {',
      '  --accent: ' + accent + ';',
      // 主色的 RGB 分量（呼吸光环的 box-shadow 要 rgba(r,g,b,alpha) 这种形式，
      // 没法直接用 var(--accent) 再叠透明度）⇒ 让光环色系跟主色统一
      '  --accent-rgb: ' + hexToRgbParts(accent) + ';',
      '  --accent-soft: ' + hexToRgba(accent, 0.14) + ';',
      // 面板/边框保持"可调不透明度"的原有能力，只换基色
      '  --bg: ' + M.bg + ';',
      '  --bg-panel: ' + hexToRgba(M.bgPanel, panelA) + ';',
      '  --bg-panel-hover: ' + hexToRgba(M.bgPanelHover, Math.min(1, panelA + 0.06)) + ';',
      '  --border: ' + hexToRgba(M.border, borderA) + ';',
      '  --text: ' + M.text + ';',
      '  --text-dim: ' + M.textDim + ';',
      '  --panel-radius: ' + radius + 'px;',
      '  --panel-blur: ' + blur + 'px;',
      // ★宿主侧的面板不透明度（0.4~1）★ 2026-11-21
      // 给 embed / 网页类面板的 <webview> 用（styles.css 的 --web-alpha 读它）。
      // 为什么不复用 --wp-veil：那个是 wv.executeJavaScript 注入到 **guest 的 html** 上的，
      // 而 tintGuest 白名单改造后 embed 不再被注入 ⇒ guest 永远拿不到。
      // 这里放在 :root，纯宿主侧，和"面板不透明度"滑杆天然联动。
      '  --panel-alpha: ' + panelA.toFixed(2) + ';',
      // 滑杆 / 面板标题栏 / 按钮描边：按模式给值（styles.css 里读这四个变量）
      '  --slider-track: ' + M.sliderTrack + ';',
      '  --slider-thumb-border: ' + M.sliderThumbBorder + ';',
      // 标题栏与面板同透明度：用 panelA 控制 alpha，标题条才能跟着壁纸一起透
      '  --panel-head-bg: ' + hexToRgba(M.panelHead, panelA) + ';',
      '  --btn-border: ' + M.btnBorder + ';',
      // 下拉弹层配色（styles.css 的 .form-select/.td-select 读这 6 个）
      '  --select-scheme: ' + M.selectScheme + ';',
      '  --select-opt-bg: ' + M.selectOptBg + ';',
      '  --select-opt-color: ' + M.selectOptColor + ';',
      '  --select-opt-on-bg: ' + M.selectOptOnBg + ';',
      '  --select-opt-on-color: ' + M.selectOptOnColor + ';',
      k.font ? '  --sans: ' + k.font + ';' : '',
      // 原生控件（滚动条 / select / checkbox）跟着模式走
      '  color-scheme: ' + (isLight ? 'light' : 'dark') + ';',
      '}',
      // 深色是"写死在 styles.css 里"的原生状态；浅色必须把那些写死的深色也盖掉，
      // 否则页面底色变了、标题栏/输入框/滚动条还是黑的（只改 :root 变量不够）。
      'html[data-mode="light"] body { background: ' + M.bg + ' !important; color: ' + M.text + '; }',
      'html[data-mode="light"] #titlebar { background: ' + M.headBg + ' !important; }',
      'html[data-mode="light"] #scenebar { background: ' + M.headBg + ' !important; }',
      // 标题栏与面板同透明度（原来是 M.panelHeadBg 实色 ⇒ 用户报"标题栏没有透明效果"）
      'html[data-mode="light"] .panel-head { background: ' + hexToRgba(M.panelHead, panelA) + ' !important; }',
      'html[data-mode="light"] .file-bar, html[data-mode="light"] .view-bar, html[data-mode="light"] .web-bar { background: ' + M.panelHeadBg + ' !important; }',
      'html[data-mode="light"] .form-input, html[data-mode="light"] .form-select,',
      'html[data-mode="light"] .num-input, html[data-mode="light"] .td-select {',
      '  background: ' + M.inputBg + ' !important; color: ' + M.text + ' !important; border-color: ' + M.inputBorder + ' !important;',
      '}',
      'html[data-mode="light"] .modal { background: ' + M.bgPanel + ' !important; }',
      'html[data-mode="light"] .theme-drawer { background: ' + M.bgPanel + ' !important; }',
      // ★浅色可读性修正★（2026-11-19 用户报：浅色下主题面板部分控件看不清）
      // 这些控件本来用 --text-dim + opacity 做"次要感"，浅色下会糊成一片灰；
      // 这里在浅色模式下把颜色压实、去掉多余的 opacity。只动颜色，不动布局。
      'html[data-mode="light"] .td-hint,',
      'html[data-mode="light"] .td-note,',
      'html[data-mode="light"] .td-pick-kind,',
      'html[data-mode="light"] .td-empty,',
      'html[data-mode="light"] .td-val {',
      '  color: #3f4a5c !important;',
      '  opacity: 1 !important;',
      '}',
      // 主按钮：深蓝字 + 淡蓝底（原来写死 #cfe1ff 是给深色底配的）
      // ★浅色下按钮边框不可见★（2026-11-20 用户报）
      // 这些按钮在 styles.css 里是 border:1px solid var(--border)，
      // 而浅色模式下 --border 被我设成了「透明度可调」且用户把边框可见度拉到 0% ⇒ 边框消失。
      // 这里给它们一条独立的、始终可见的描边（--btn-border），不受「边框可见度」滑杆影响。
      'html[data-mode="light"] .td-btn,',
      'html[data-mode="light"] .modal-btn,',
      'html[data-mode="light"] .boot-btn,',
      'html[data-mode="light"] .ph-btn,',
      'html[data-mode="light"] .picker-card,',
      'html[data-mode="light"] .folder-btn,',
      'html[data-mode="light"] .td-tab {',
      '  border-color: var(--btn-border, rgba(27,31,39,.16)) !important;',
      '}',
      // 深色模式也同理（深色下面 --border 同样可能被拉到 0%）
      'html[data-mode="dark"] .td-btn,',
      'html[data-mode="dark"] .modal-btn,',
      'html[data-mode="dark"] .boot-btn,',
      'html[data-mode="dark"] .ph-btn,',
      'html[data-mode="dark"] .picker-card,',
      'html[data-mode="dark"] .folder-btn,',
      'html[data-mode="dark"] .td-tab {',
      '  border-color: var(--btn-border, rgba(255,255,255,.14)) !important;',
      '}',
      'html[data-mode="light"] .td-btn.primary {',
      '  color: #14428f !important;',
      '  background: rgba(79, 140, 255, .16) !important;',
      '  border-color: rgba(79, 140, 255, .5) !important;',
      '}',
      // 普通按钮/选项卡的 hover：深色底的半透明白在浅色下没有反馈，换成淡蓝
      'html[data-mode="light"] .td-btn:hover,',
      'html[data-mode="light"] .td-tab:hover {',
      '  background: rgba(79, 140, 255, .12) !important;',
      '  color: ' + M.text + ' !important;',
      '}',
      // 滑杆数值、标签这类小字也压实（它们是 --text-dim 的最大用户）
      'html[data-mode="light"] .td-row .td-label,',
      'html[data-mode="light"] .td-val { color: #2b3444 !important; }',
      // ★弹出提示 / 弹窗跟随浅色★（2026-11-19 用户报：浅色下 toast 还是黑的）
      'html[data-mode="light"] .toast { background: #fff !important; color: ' + M.text + ' !important; border-color: ' + M.border + ' !important; box-shadow: 0 10px 28px rgba(15,23,42,.16) !important; }',
      'html[data-mode="light"] .modal-mask { background: rgba(15,23,42,.32) !important; }',
      'html[data-mode="light"] .modal-body { color: ' + M.text + ' !important; }',
      'html[data-mode="light"] .boot-card { background: #fff !important; color: ' + M.text + ' !important; }',
      'html[data-mode="light"] .theme-drawer .td-head, html[data-mode="light"] .theme-drawer .td-foot { background: ' + M.panelHeadBg + ' !important; }',
      'html[data-mode="light"] .webai-win { background: #fff !important; }',
      'html[data-mode="light"] .webai-head { background: ' + M.panelHeadBg + ' !important; }',
      'html[data-mode="light"] ::-webkit-scrollbar-thumb { background: ' + M.scrollThumb + '; }',
      'html[data-mode="light"] ::-webkit-scrollbar-thumb:hover { background: ' + M.scrollThumbHover + '; }',
      // 有壁纸时外壳底色彻底透明，让壁纸从缝隙里透出来；面板自己带半透明底色
      'body.has-wallpaper { background: transparent; }',
      'body.has-wallpaper #scenario-view, body.has-wallpaper #grid { background: transparent; }',
      'body.has-wallpaper .panel { backdrop-filter: blur(var(--panel-blur)); }',
      'body.has-wallpaper .panel.panel-head, body.has-wallpaper .panel .panel-head { background: transparent; }',
      // ★有壁纸时底板一律透明★（2026-11-20）
      // 上面那几条 data-mode=light 的规则都带 !important（特异性也高），
      // 会把 body/#titlebar/#scenebar 刷成实色 ⇒ 壁纸整层被挡住。
      // 这里用「更高特异性 + !important」把它们压回透明。
      // ⛔ 只在 .has-wallpaper 时生效：没壁纸时浅色主题该实色还是实色。
      // ⚠ 特异性必须压过 html[data-mode="light"] body（那条也是 !important）：
      // 同为 !important 时**特异性高者胜**，所以选择器里必须带上 html[data-mode]。
      'html[data-mode] body.has-wallpaper,',
      'html[data-mode] body.has-wallpaper #titlebar,',
      'html[data-mode] body.has-wallpaper #scenebar,',
      'html[data-mode] body.has-wallpaper #scenario-view,',
      'html[data-mode] body.has-wallpaper #grid,',
      'html[data-mode] body.has-wallpaper .view { background: transparent !important; }',
      // 面板体在浅色下也要能透（否则面板里还是实色，壁纸透不进来）
      'body.has-wallpaper .panel { background-color: var(--bg-panel) !important; }',
      // 无边框感的边框在壁纸下会显得脏，让它跟面板一起半透明
      'body.has-wallpaper .panel-head { border-bottom-color: transparent !important; }'
    ].join('\n');

    var st = $('theme-vars');
    if (!st) {
      st = document.createElement('style');
      st.id = 'theme-vars';
      document.head.appendChild(st);
    }
    st.textContent = css;
  }

  // ★控制器跟全局模式★
  // console.css 的浅色规则选择器是 .dsh-wt_console[data-wt-theme=light] —— 属性必须在**该元素自身**。
  // console.css 是原值移植件（⛔ 不许改），所以在渲染层给每个控制器根节点补属性。
  // 控制器会随场景重建 ⇒ 用 MutationObserver 兜住"新加进来的"。
  function syncConsoleTheme(mode) {
    var m = (mode === 'light') ? 'light' : 'dark';
    try {
      var list = document.querySelectorAll('.dsh-wt_console');
      for (var i = 0; i < list.length; i++) list[i].setAttribute('data-wt-theme', m);
    } catch (e) { /* ignore */ }
  }

  // 只装一次：盯 #grid 的子树变化，新出现的 .dsh-wt_console 立刻补属性
  (function initConsoleThemeWatch() {
    if (window.__xiodraConsoleWatch) return;
    window.__xiodraConsoleWatch = true;
    try {
      if (typeof MutationObserver !== 'function') return;
      var mo = new MutationObserver(function () {
        var mode = (CUR && CUR.look && CUR.look.mode === 'light') ? 'light' : 'dark';
        syncConsoleTheme(mode);
      });
      var hook = function () {
        var g = document.getElementById('grid');
        if (g) { mo.observe(g, { childList: true, subtree: true }); return true; }
        return false;
      };
      if (!hook()) document.addEventListener('DOMContentLoaded', hook, { once: true });
    } catch (e) { /* ignore */ }
  })();

  function apply(t) {
    if (!t || typeof t !== 'object') return;
    CUR = t;
    var mode = modeOf(t.look || {});
    // data-mode 挂在 <html> 上：浅色覆盖规则全部以它为前缀（见 paintLook）
    try { document.documentElement.setAttribute('data-mode', mode); } catch (e) { /* ignore */ }
    // ★控制器跟全局模式★ console.css 自带 [data-wt-theme=light] 浅色变量，
    // 但以前**没人设过这个属性** ⇒ 控制器永远停在深色，浅色下卡片发灰看不清。
    // 挂到 documentElement 上（而不是每个 .dsh-wt_console），这样控制器重建后也自动继承。
    syncConsoleTheme(mode);
    paintWallpaper(t.wallpaper || {});
    paintLook(t.look || {});
    tintAllGuests();
    // 字体/字号变了 ⇒ 场景标签的文字宽度要重测（否则选中标签的文字会溢出）
    if (window.__dshRemeasureTabs) window.__dshRemeasureTabs();
  }

  // ---------------- 回写主进程（合并 200ms 内的连续改动）----------------
  // ⚠ 必须「累积合并」而不是「替换」：连续改两个滑块时，若只保留最后一次 patch，
  //   前一个字段的改动在界面上生效了（本地 paintLook 已画）、却没写进磁盘，
  //   重开窗口就丢回旧值 —— 这类问题最难查（界面明明调过）。
  var pending = null;

  function mergePatch(dst, src) {
    var o = dst || {};
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        o[k] = mergePatch(o[k] || {}, v);
      } else {
        o[k] = v;
      }
    });
    return o;
  }

  function save(patch) {
    pending = mergePatch(pending, patch);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      var body = pending;
      pending = null;
      if (!body) return;
      window.kun.theme.patch(body).then(function (r) {
        if (r && r.ok && r.theme) apply(r.theme);
      }).catch(function () { /* 写盘失败下一次改动会再试 */ });
    }, 200);
  }

  // 改一个字段：先本地立刻生效（滑块要跟手），再回写
  function setW(key, val) {
    if (!CUR) CUR = {};
    if (!CUR.wallpaper) CUR.wallpaper = {};
    CUR.wallpaper[key] = val;
    paintWallpaper(CUR.wallpaper);
    var p = {}; p.wallpaper = {}; p.wallpaper[key] = val;
    save(p);
  }
  function setL(key, val) {
    if (!CUR) CUR = {};
    if (!CUR.look) CUR.look = {};
    CUR.look[key] = val;
    paintLook(CUR.look);
    var p = {}; p.look = {}; p.look[key] = val;
    save(p);
  }

  // ---------------- 抽屉 DOM ----------------
  function row(label, hint) {
    var r = el('div', 'td-row');
    r.appendChild(el('div', 'td-label', label));
    if (hint) r.appendChild(el('div', 'td-hint', hint));
    return r;
  }

  function slider(label, val, min, max, step, onInput, unit) {
    var r = row(label);
    var wrap = el('div', 'td-slider');
    var range = document.createElement('input');
    range.type = 'range';
    range.min = String(min); range.max = String(max); range.step = String(step || 1);
    range.value = String(val);
    var out = el('span', 'td-val', String(val) + (unit || ''));
    range.addEventListener('input', function () {
      out.textContent = range.value + (unit || '');
      onInput(Number(range.value));
    });
    wrap.appendChild(range);
    wrap.appendChild(out);
    r.appendChild(wrap);
    return r;
  }

  function buildWallpaperTab() {
    var body = $('theme-body');
    body.textContent = '';
    var w = (CUR && CUR.wallpaper) || {};

    // 当前壁纸
    var r0 = row('当前壁纸');
    var pick = el('div', 'td-pick');
    var thumb = el('div', 'td-thumb');
    if (w.path) {
      if (w.kind === 'video') {
        thumb.appendChild(el('span', 'td-thumb-ico', '🎬'));
      } else {
        var im = document.createElement('img');
        im.src = fileUrlOf(w.path);
        im.alt = '';
        thumb.appendChild(im);
      }
    } else {
      thumb.appendChild(el('span', 'td-thumb-ico', '🖼'));
    }
    var info = el('div', 'td-pick-info');
    info.appendChild(el('div', 'td-pick-name', w.path ? baseName(w.path) : '（没有壁纸）'));
    info.appendChild(el('div', 'td-pick-kind', w.path ? (w.kind === 'video' ? '视频壁纸' : '图片壁纸') : '选一张图或一段视频，铺满整个工作台'));
    pick.appendChild(thumb);
    pick.appendChild(info);
    r0.appendChild(pick);

    var acts = el('div', 'td-acts');
    var bPick = el('button', 'td-btn primary', w.path ? '换一张…' : '选择图片或视频…');
    bPick.addEventListener('click', function () {
      window.kun.theme.pickWallpaper().then(function (p) {
        if (!p) return;                       // 取消：不动已有壁纸
        var kind = /\.(mp4|webm|mov|m4v|ogv)$/i.test(p) ? 'video' : 'image';
        if (!CUR) CUR = {};
        CUR.wallpaper = CUR.wallpaper || {};
        CUR.wallpaper.path = p;
        CUR.wallpaper.kind = kind;
        var patch = { wallpaper: { path: p, kind: kind } };
        window.kun.theme.patch(patch).then(function (r) {
          if (r && r.ok && r.theme) { apply(r.theme); buildWallpaperTab(); }
        });
      });
    });
    acts.appendChild(bPick);
    if (w.path) {
      var bClear = el('button', 'td-btn', '清除壁纸');
      bClear.addEventListener('click', function () {
        window.kun.theme.patch({ wallpaper: { path: '', kind: '' } }).then(function (r) {
          if (r && r.ok && r.theme) { apply(r.theme); buildWallpaperTab(); }
        });
      });
      acts.appendChild(bClear);
    }
    r0.appendChild(acts);
    body.appendChild(r0);

    if (!w.path) {
      body.appendChild(el('div', 'td-empty', '还没有壁纸。选一张图片或一段短视频，就能铺在工作台底下；面板保持半透明时会透出来。'));
      return;
    }

    // 适配方式
    var rFit = row('适配方式', 'cover 铺满裁切 · contain 完整显示 · stretch 拉伸');
    var sel = document.createElement('select');
    sel.className = 'td-select';
    [['cover', '铺满（裁切）'], ['contain', '完整显示'], ['stretch', '拉伸']].forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0]; op.textContent = o[1];
      if ((w.fit || 'cover') === o[0]) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () { setW('fit', sel.value); });
    rFit.appendChild(sel);
    body.appendChild(rFit);

    body.appendChild(slider('不透明度', w.opacity == null ? 100 : w.opacity, 0, 100, 1, function (v) { setW('opacity', v); }, '%'));
    body.appendChild(slider('模糊', w.blur == null ? 0 : w.blur, 0, 40, 1, function (v) { setW('blur', v); }, 'px'));
    body.appendChild(slider('压暗', w.dim == null ? 30 : w.dim, 0, 90, 1, function (v) { setW('dim', v); }, '%'));
  }

  // 「模式」区块：两张卡片式选项卡（浅色 / 深色）。
  // 样式复用主题抽屉已有的 td-* 体系，卡片用内联样式（只影响这里，不污染全局）。
  function buildModeRow() {
    var r = el('div', 'td-row');
    r.appendChild(el('div', 'td-label', '模式'));
    r.appendChild(el('div', 'td-hint', '选择外壳界面的浅色或深色主题（与引擎界面无关）'));

    var k = (CUR && CUR.look) || {};
    var cur = modeOf(k);

    var wrap = el('div', 'td-mode');
    wrap.style.cssText = 'display:flex;gap:8px;margin-top:7px';

    var defs = [
      { v: 'light', icon: '\u2600', label: '\u6d45\u8272' },
      { v: 'dark', icon: '\u263e', label: '\u6df1\u8272' }
    ];

    defs.forEach(function (d) {
      var on = (cur === d.v);
      var card = el('button', 'td-mode-card');
      card.type = 'button';
      card.dataset.mode = d.v;
      card.title = '\u5207\u5230' + d.label + '\u4e3b\u9898';
      // 选中态：主色描边 + 淡底；未选中：普通边框（与截图里的三栏卡片同观感）
      card.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;'
        + 'justify-content:center;gap:5px;padding:14px 8px;border-radius:10px;cursor:pointer;'
        + 'font:inherit;background:' + (on ? 'var(--accent-soft)' : 'transparent') + ';'
        + 'border:1px solid ' + (on ? 'var(--accent)' : 'var(--border)') + ';'
        + 'color:' + (on ? 'var(--text)' : 'var(--text-dim)') + ';'
        + 'transition:border-color .12s ease,background .12s ease';

      var ic = el('span', '', d.icon);
      ic.style.cssText = 'font-size:17px;line-height:1';
      card.appendChild(ic);
      var lb = el('span', '', d.label);
      lb.style.cssText = 'font-size:12px;font-weight:600;line-height:16px';
      card.appendChild(lb);

      card.addEventListener('click', function () {
        if (modeOf(CUR && CUR.look) === d.v) return;
        setL('mode', d.v);
        // 立刻按新模式重画（不等主进程回写，避免"点了要等一下才变"）
        try {
          var next = Object.assign({}, (CUR && CUR.look) || {}, { mode: d.v });
          document.documentElement.setAttribute('data-mode', d.v);
          paintLook(next);
        } catch (e) { /* ignore */ }
        buildLookTab();   // 重画这一页，让选中态跟着走
      });
      wrap.appendChild(card);
    });

    r.appendChild(wrap);
    return r;
  }

  // ★「面板特效」卡片行★（2026-11-23 用户要求：像「模式」那样卡片化）
  //   · 卡片边框就是该特效本身的样子：beam 卡边框流光、glow 卡边框呼吸、none 普通边框
  //   · 卡片里放一个小示例块，把特效实时演示出来
  //   · 选中的卡片右上角打 √
  function buildEffectRow() {
    var r = el('div', 'td-row');
    r.appendChild(el('div', 'td-label', '面板特效'));
    r.appendChild(el('div', 'td-hint', '面板「工作中」和「展开」时的边框动效'));

    var k = (CUR && CUR.look) || {};
    var cur = String(k.effect || 'beam');
    if (['beam', 'glow', 'none'].indexOf(cur) < 0) cur = 'beam';

    var wrap = el('div', 'td-mode');
    wrap.style.cssText = 'display:flex;gap:8px;margin-top:7px';

    var defs = [
      { v: 'beam', icon: '\u2726', label: '边缘流光' },
      { v: 'glow', icon: '\u25cf', label: '呼吸光环' },
      { v: 'none', icon: '\u25cb', label: '无特效' }
    ];

    defs.forEach(function (d) {
      var on = (cur === d.v);
      var card = el('button', 'td-mode-card td-fx-card');
      card.type = 'button';
      card.dataset.effect = d.v;
      card.title = '\u5207\u5230' + d.label;
      // 选中：主色描边 + 淡底；未选中：普通边框
      card.style.cssText = 'position:relative;flex:1;min-width:0;display:flex;'
        + 'align-items:center;justify-content:center;padding:14px 8px;border-radius:10px;'
        + 'cursor:pointer;font:inherit;background:' + (on ? 'var(--accent-soft)' : 'transparent') + ';'
        + 'border:1px solid ' + (on ? 'var(--accent)' : 'var(--border)') + ';'
        + 'color:' + (on ? 'var(--text)' : 'var(--text-dim)') + ';'
        + 'transition:border-color .12s ease,background .12s ease';

      // 卡片边框本身就演示该特效（class 由 CSS 按档位驱动）
      card.classList.add('td-fx-' + d.v);

      var lb = el('span', '', d.label);
      lb.style.cssText = 'font-size:11.5px;font-weight:600;line-height:15px;white-space:nowrap';
      card.appendChild(lb);

      // 选中角标 √
      if (on) {
        var tick = el('span', 'td-fx-tick', '\u2713');
        tick.style.cssText = 'position:absolute;top:4px;right:6px;font-size:11px;line-height:1;'
          + 'color:var(--accent);font-weight:700';
        card.appendChild(tick);
      }

      card.addEventListener('click', function () {
        if (String((CUR && CUR.look && CUR.look.effect) || 'beam') === d.v) return;
        setL('effect', d.v);
        // 立刻生效，不等主进程回写
        try {
          document.documentElement.setAttribute('data-effect', d.v);
        } catch (e) { /* ignore */ }
        buildLookTab();   // 重画这一页，让选中态/√ 跟着走
      });
      wrap.appendChild(card);
    });

    r.appendChild(wrap);
    return r;
  }

  function buildLookTab() {
    var body = $('theme-body');
    body.textContent = '';
    var k = (CUR && CUR.look) || {};

    // ★模式（浅色 / 深色）★ 放最前面：它是"整体观感"的第一层选择
    body.appendChild(buildModeRow());

    // 主色
    var r1 = row('主色', '按钮、选中态、进度条都用它');
    var colorWrap = el('div', 'td-color');
    var ci = document.createElement('input');
    ci.type = 'color';
    ci.value = k.accent || ACCENT_DEFAULT;
    ci.addEventListener('input', function () { setL('accent', ci.value); });
    colorWrap.appendChild(ci);
    var bDef = el('button', 'td-btn', '用默认色');
    bDef.addEventListener('click', function () {
      ci.value = ACCENT_DEFAULT;
      setL('accent', '');
      buildLookTab();
    });
    colorWrap.appendChild(bDef);
    r1.appendChild(colorWrap);
    body.appendChild(r1);

    body.appendChild(slider('面板不透明度', k.panelAlpha == null ? 100 : k.panelAlpha, 40, 100, 1, function (v) { setL('panelAlpha', v); }, '%'));
    body.appendChild(slider('面板毛玻璃', k.blur == null ? 0 : k.blur, 0, 24, 1, function (v) { setL('blur', v); }, 'px'));
    body.appendChild(slider('边框可见度', k.border == null ? 100 : k.border, 0, 100, 1, function (v) { setL('border', v); }, '%'));
    body.appendChild(slider('圆角', k.radius == null ? 10 : k.radius, 0, 20, 1, function (v) { setL('radius', v); }, 'px'));

    // ★面板特效★（2026-11-23）：卡片式，卡片边框即该特效的样式，选中右上角打 √
    body.appendChild(buildEffectRow());

    // 字体
    var r2 = row('正文字体', '只影响外壳自己的界面，不动引擎界面');
    var fs = document.createElement('select');
    fs.className = 'td-select';
    FONTS.forEach(function (f) {
      var op = document.createElement('option');
      op.value = f.v; op.textContent = f.label;
      if ((k.font || '') === f.v) op.selected = true;
      fs.appendChild(op);
    });
    fs.addEventListener('change', function () { setL('font', fs.value); });
    r2.appendChild(fs);
    body.appendChild(r2);

    body.appendChild(el('div', 'td-empty',
      '面板半透明 + 壁纸 = 玻璃效果。把「面板不透明度」拉到 60% 左右、再给一点毛玻璃，壁纸会从面板后面透出来。'));
  }

  function renderTab() {
    var tw = $('td-tab-wallpaper');
    var tl = $('td-tab-look');
    if (tw) tw.classList.toggle('is-on', TAB === 'wallpaper');
    if (tl) tl.classList.toggle('is-on', TAB === 'look');
    if (TAB === 'look') buildLookTab(); else buildWallpaperTab();
  }

  function open(tab) {
    if (tab) TAB = tab;
    var d = $('theme-drawer');
    if (!d) return;
    renderTab();
    d.classList.add('show');
    document.body.classList.add('theme-open');
  }

  function close() {
    var d = $('theme-drawer');
    if (!d) return;
    d.classList.remove('show');
    document.body.classList.remove('theme-open');
  }

  function toggle() {
    var d = $('theme-drawer');
    if (!d) return;
    if (d.classList.contains('show')) close(); else open();
  }

  // ---------------- 初始化 ----------------
  function init() {
    var b = $('btn-theme');
    if (b) b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); toggle(); });

    var x = $('theme-x');
    if (x) x.addEventListener('click', close);

    var tw = $('td-tab-wallpaper');
    if (tw) tw.addEventListener('click', function () { TAB = 'wallpaper'; renderTab(); });
    var tl = $('td-tab-look');
    if (tl) tl.addEventListener('click', function () { TAB = 'look'; renderTab(); });

    var rs = $('theme-reset');
    if (rs) rs.addEventListener('click', function () {
      window.kun.theme.patch({
        wallpaper: { path: '', kind: '', fit: 'cover', opacity: 100, blur: 0, dim: 30 },
        look: { mode: 'dark', accent: '', panelAlpha: 100, blur: 0, border: 100, radius: 10, font: '' }
      }).then(function (r) {
        if (r && r.ok && r.theme) { apply(r.theme); renderTab(); }
      });
    });

    // ESC 关抽屉（弹窗那边也监听 ESC，各关各的；抽屉没开就什么都不做）
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var d = $('theme-drawer');
      if (d && d.classList.contains('show')) close();
    });

    // 先按出厂值画一帧，再等主进程的设置回来覆盖 —— 避免首屏闪一下默认色
    apply({ wallpaper: { path: '', kind: '', fit: 'cover', opacity: 100, blur: 0, dim: 30 },
            look: { mode: 'dark', accent: '', panelAlpha: 100, blur: 0, border: 100, radius: 10, font: '' } });

    window.kun.theme.get().then(function (t) { apply(t); }).catch(function () { /* 读不到就用出厂值 */ });
  }

  window.__xiodraTheme = { open: open, close: close, toggle: toggle, apply: apply, get: function () { return CUR; }, tint: tintAllGuests };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
