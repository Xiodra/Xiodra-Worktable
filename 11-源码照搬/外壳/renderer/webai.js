/* ============================================================================
 * 网页版 AI 图标条（照搬《淋雨家的工作台》renderers.js L11551-12010 的 WEB_AI 一整套）
 *
 * 位置：紧跟顶栏品牌名之后（#titlebar .brand 的 nextSibling）。
 * 行为：点图标开一个浮动窗口（<webview>），再点收起（warm，不销毁 ⇒ 秒开）。
 *
 * ⚠ 三条必须照搬的坑（参照项目实测）：
 *   ① 父层 #titlebar 是 -webkit-app-region: drag，拖拽区不把鼠标事件投给页面
 *      ⇒ 图标条必须显式 no-drag，否则点了没反应。
 *   ② 窗口标题栏的拖动必须自己用 mousedown/mousemove 实现，
 *      绝不能用 -webkit-app-region: drag（那是拖整个应用窗口）。
 *   ③ 这些 webview 的分区是 persist:webai-<key>，主进程对它们**不接管导航**
 *      （见 main.js 的 web-contents-created：webai 一律放行，window.open 开应用内小窗）。
 *      少了这一条，DeepSeek / 豆包的登录框都出不来。
 * ========================================================================== */
(function () {
  'use strict';

  // ---- 站点表：先把 DeepSeek 与豆包做出来（用户要求），其余保持注释态便于以后补 ----
  var WEB_AI = [
    {
      key: 'deepseek', name: 'DeepSeek', icon: 'assets/webai/deepseek.png', fallback: 'D',
      url: 'https://chat.deepseek.com/', userAgent: 'chrome'
    },
    {
      key: 'doubao', name: '豆包', icon: 'assets/webai/doubao.png', fallback: '豆',
      url: 'https://www.doubao.com/chat/', userAgent: 'chrome'
    }
    // 下面三个是参照项目里的另外三个站点，本阶段先不做（用户要求"先把 deepseek 和豆包实现"）：
    // { key:'tongyi', name:'通义千问', icon:'assets/webai/tongyi.png', fallback:'通', url:'https://tongyi.aliyun.com/qianwen/' },
    // { key:'chatglm', name:'智谱清言', icon:'assets/webai/chatglm.png', fallback:'智', url:'https://chatglm.cn/main/alltoolsdetail' },
    // { key:'kimi',  name:'Kimi',     icon:'assets/webai/kimi.png',    fallback:'K', url:'https://www.kimi.com/' }
  ];

  // 状态挂在 window 上：本文件的 IIFE 可能被重新求值（⟳ / reload），
  // 放进局部 var 会导致重复建窗口（参照项目注释里写明的原因）。
  var ST = window.__xiodraWebAi || (window.__xiodraWebAi = {
    wins: {}, layer: null, z: 2400, strip: null, bound: false
  });

  function siteOf(key) {
    for (var i = 0; i < WEB_AI.length; i++) if (WEB_AI[i].key === key) return WEB_AI[i];
    return null;
  }
  function siteIndex(key) {
    for (var i = 0; i < WEB_AI.length; i++) if (WEB_AI[i].key === key) return i;
    return 0;
  }
  function partitionOf(site) {
    return site.partition || ('persist:webai-' + site.key);
  }
  function hostOf(u) {
    try { return new URL(u).host; } catch (e) { return ''; }
  }

  // ---- 窗口几何：记住上次的位置与大小（key 里带 key，两个站点互不影响）----
  var GEOM_KEY = function (key) { return 'xiodra.webai.geom.' + key; };

  function readGeom(key, idx) {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(GEOM_KEY(key)) || 'null'); } catch (e) { d = null; }
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 800;
    var dw = Math.min(980, Math.max(420, Math.round(vw * 0.56)));
    var dh = Math.min(760, Math.max(360, Math.round(vh * 0.78)));
    var def = {
      w: dw, h: dh,
      x: Math.round((vw - dw) / 2) + idx * 26,
      y: Math.max(46, Math.round((vh - dh) / 2) + idx * 22)
    };
    if (!d || typeof d !== 'object') return def;
    return {
      w: Number(d.w) > 200 ? Number(d.w) : def.w,
      h: Number(d.h) > 150 ? Number(d.h) : def.h,
      x: Number.isFinite(Number(d.x)) ? Number(d.x) : def.x,
      y: Number.isFinite(Number(d.y)) ? Number(d.y) : def.y
    };
  }

  function writeGeom(key, g) {
    try { localStorage.setItem(GEOM_KEY(key), JSON.stringify(g)); } catch (e) { /* ignore */ }
  }

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  // ---- 状态点：none / loading / ready / fail ----
  function setStatus(key, st) {
    var btn = ST.strip && ST.strip.querySelector('.webai-btn[data-key="' + key + '"]');
    if (btn) btn.dataset.st = st || 'none';
  }

  // ---- 抬到最前 ----
  function raise(o) {
    if (!o || !o.el) return;
    o.el.style.zIndex = String(++ST.z);
    markOn();
  }

  function markOn() {
    if (!ST.strip) return;
    var btns = ST.strip.querySelectorAll('.webai-btn');
    Array.prototype.forEach.call(btns, function (b) {
      var w = ST.wins[b.dataset.key];
      if (w && !w.el.classList.contains('warm')) b.classList.add('on');
      else b.classList.remove('on');
    });
  }

  // ---- 建窗口（mode==='warm' 只加载不显示）----
  function ensure(key, mode) {
    var site = siteOf(key);
    if (!site) return null;
    if (ST.wins[key]) return ST.wins[key];

    var layer = ST.layer;
    if (!layer || !layer.parentNode) {
      layer = el('div', 'webai-layer');
      document.body.appendChild(layer);
      ST.layer = layer;
    }

    var idx = siteIndex(key);
    var g = readGeom(key, idx);
    // 夹一次视口：localStorage 里的旧几何可能是别的屏幕尺寸下存的（拔了外接屏后
    // 窗口会大到把整个工作台盖住）。宁可缩回来，也不要"窗口开着但看不见全貌"。
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 800;
    g.w = Math.min(g.w, Math.max(360, vw - 80));
    g.h = Math.min(g.h, Math.max(240, vh - 80));
    g.x = Math.min(Math.max(0, g.x), Math.max(0, vw - g.w));
    g.y = Math.min(Math.max(0, g.y), Math.max(0, vh - 120));
    var win = el('div', 'webai-win');
    win.dataset.key = key;
    win.style.left = g.x + 'px';
    win.style.top = g.y + 'px';
    win.style.width = g.w + 'px';
    win.style.height = g.h + 'px';
    win.style.zIndex = String(++ST.z);
    if (mode === 'warm') win.classList.add('warm');

    // ---- 标题栏 ----
    var head = el('div', 'webai-head');
    var ico = document.createElement('img');
    ico.src = site.icon;
    ico.draggable = false;
    ico.alt = site.name;
    ico.onerror = function () { ico.style.display = 'none'; };
    head.appendChild(ico);
    var titleEl = el('span', 'webai-title', site.name);
    head.appendChild(titleEl);
    var hostEl = el('span', 'webai-host', hostOf(site.url));
    head.appendChild(hostEl);
    head.appendChild(el('span', 'webai-spacer'));

    function tb(act, text, title, cls) {
      var b = el('button', 'webai-tb' + (cls ? ' ' + cls : ''), text);
      b.type = 'button';
      b.dataset.act = act;
      b.title = title;
      head.appendChild(b);
      return b;
    }
    var backBtn = tb('back', '‹', '后退');
    var fwdBtn = tb('fwd', '›', '前进');
    tb('reload', '⟳', '重新加载');
    tb('free', '⏏', '释放这个窗口的内存（下次点开会重新加载）');
    tb('open', '↗', '用系统浏览器打开');
    tb('close', '✕', '关掉这个窗口', 'close');
    backBtn.disabled = true;
    fwdBtn.disabled = true;
    win.appendChild(head);

    // ---- 内容区：webview + 加载遮罩 ----
    var bodyEl = el('div', 'webai-body');
    // 外框底色跟着**这个站点自己的主题**走（站点 body 透明 ⇒ 这层就是页面实际背景）
    // 底色不在建窗口时定 —— 由 dom-ready 里探测站点主题后设置（见下方 apply）。
    // 这里只给个中性兜底，避免加载瞬间闪白。
    bodyEl.style.background = '#17181c';
    var mask = el('div', 'webai-mask');
    var spin = el('div', 'webai-spin');
    mask.appendChild(spin);
    var maskT = el('div', 'webai-mask-t', '正在加载 ' + site.name + ' …');
    mask.appendChild(maskT);

    var wv = document.createElement('webview');
    wv.className = 'webai-webview';
    // ⚠ partition / useragent 必须在插入 DOM 之前设（插进去之后设不生效）
    wv.setAttribute('partition', partitionOf(site));
    if (site.userAgent === 'chrome') {
      wv.setAttribute('useragent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/126.0.0.0 Safari/537.36');
    }
    wv.setAttribute('allowpopups', '');
    // ★网页版 AI 的配色：**外框跟着站点自己的主题走，不跟工作台**★
    //
    // 用户要求（两次）：
    //   ① 「DeepSeek 窗口是设置【深色】主题，应该不受我工作台的【主题】影响」
    //   ② 「豆包已经设置深色主题，外观受主题影响，应该不受主题影响的」
    //
    // 【为什么外框底色是决定性的】洋红实验证实：站点 body 是 rgba(0,0,0,0) 全透明，
    //   ⇒ **外框底色 = 页面实际背景**。站点深色出浅字，外框给白 ⇒ 浅字看不见；反之亦然。
    //
    // 【为什么不再手工标深浅色】上一版给每站写死 bg（把豆包标成白），用户一切深色就全错。
    //   站点主题用户随时可切，写死的值必然过时 ⇒ 改成**运行时读页面真实配色**。
    //
    // ⛔ 绝不改站点文字颜色 —— 一改就是替站点做主张，前两次返工都是这么来的。
    wv.addEventListener('dom-ready', function () {
      // 在**页面自己**的上下文里判断它是深色还是浅色（能读到 data-theme 与计算色）
      var probe = [
        '(function(){',
        '  var de = document.documentElement;',
        '  var body = document.body;',
        // 0) ★优先读站点自己的背景变量★（最准：站点的变量与它的遮罩/渐变同色）
        '  function normHex(v){',
        '    if (!v) return null;',
        '    var t = String(v).trim();',
        '    if (!t) return null;',
        '    if (/^#[0-9a-f]{3}$/i.test(t)) {',
        '      return "#" + t[1]+t[1] + t[2]+t[2] + t[3]+t[3];',
        '    }',
        '    if (/^#[0-9a-f]{6}$/i.test(t)) return t;',
        '    var m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/.exec(t);',
        '    if (m) {',
        '      var h = function(n){ var x = Math.max(0,Math.min(255,Math.round(+n))).toString(16); return x.length<2?"0"+x:x; };',
        '      return "#" + h(m[1]) + h(m[2]) + h(m[3]);',
        '    }',
        '    return null;',
        '  }',
        '  function lumOfHex(hx){',
        '    if (!hx) return null;',
        '    var r = parseInt(hx.slice(1,3),16), g = parseInt(hx.slice(3,5),16), b = parseInt(hx.slice(5,7),16);',
        '    return (0.299*r + 0.587*g + 0.114*b) / 255;',
        '  }',
        '  var VAR_NAMES = ["--chat-bg-color","--dbx-bg-color","--dbx-bg","--bg-color","--background-color","--s-color-bg","--color-bg"];',
        '  var hostForVars = document.querySelector("main") || body || de;',
        '  var csVars = getComputedStyle(hostForVars);',
        '  for (var vi = 0; vi < VAR_NAMES.length; vi++) {',
        '    var raw = csVars.getPropertyValue(VAR_NAMES[vi]);',
        '    var hx = normHex(raw);',
        '    if (hx) {',
        '      var lu = lumOfHex(hx);',
        '      return { bg: hx, scheme: (lu !== null && lu < 0.5) ? "dark" : "light", why: "var(" + VAR_NAMES[vi] + ")=" + hx };',
        '    }',
        '  }',

        // 1) html[data-theme]
        '  var t1 = String((de && de.getAttribute("data-theme")) || "");',
        '  if (/dark/i.test(t1))  return { bg: "#17181c", scheme: "dark", why: "html[data-theme]=dark" };',
        '  if (/light/i.test(t1)) return { bg: "#ffffff", scheme: "light", why: "html[data-theme]=light" };',
        // 2) class 里带 dark / light（DeepSeek 是 body.class = "zh_CN dark"）
        '  var cls = String((de && de.className) || "") + " " + String((body && body.className) || "");',
        '  if (/\\bdark\\b/i.test(cls))  return { bg: "#17181c", scheme: "dark", why: "class~=dark" };',
        '  if (/\\blight\\b/i.test(cls)) return { bg: "#ffffff", scheme: "light", why: "class~=light" };',
        // 3) 可见文字的真实颜色（取中位数，避开个别占位色）
        '  function lumOf(c){',
        '    var m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/.exec(c || "");',
        '    if (!m) return null;',
        '    var a = (m[4] === undefined) ? 1 : parseFloat(m[4]);',
        '    if (a < 0.1) return null;',
        '    return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;',
        '  }',
        '  var ls = [];',
        '  var els = document.querySelectorAll("h1,h2,h3,p,span,a,button,label,li");',
        '  for (var i2 = 0; i2 < els.length && ls.length < 40; i2++) {',
        '    var e = els[i2];',
        '    var txt = (e.textContent || "").trim();',
        '    if (!txt || txt.length > 60) continue;',
        '    var r = e.getBoundingClientRect();',
        '    if (r.width < 8 || r.height < 8) continue;',
        '    var l = lumOf(getComputedStyle(e).color);',
        '    if (l !== null && l > 0.02 && l < 0.98) ls.push(l);',
        '  }',
        '  if (ls.length >= 3) {',
        '    ls.sort(function(a,b){return a-b;});',
        '    var med = ls[Math.floor(ls.length / 2)];',
        '    // 中位亮度 > 0.5 ⇒ 多数文字是浅色 ⇒ 深色主题',
        '    return med > 0.5',
        '      ? { bg: "#17181c", scheme: "dark", why: "medianTextLum=" + med.toFixed(2) }',
        '      : { bg: "#ffffff", scheme: "light", why: "medianTextLum=" + med.toFixed(2) };',
        '  }',
        // 4) 兜底
        '  var pd = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;',
        '  return pd ? { bg: "#17181c", scheme: "dark", why: "prefers-dark" }',
        '            : { bg: "#ffffff", scheme: "light", why: "prefers-light" };',
        '})()'
      ].join('\n');

      function applyOnce() {
        try {
          var pr = wv.executeJavaScript(probe);
          if (!pr || typeof pr.then !== 'function') return;
          pr.then(function (r) {
            if (!r || !r.bg) return;
            if (typeof o !== 'undefined' && o && o.alive === false) return;
            // ★只给外框兜底色，不再给站点的 html/body 刷背景★
            // 站点自己已经有正确底色（theme.js 不再把 webai 页面抹透）。
            // 再用 !important 刷一层会盖掉它，反而把输入框那一圈衬得像色块（2026-11-18 用户报的就是这个）。
            bodyEl.style.background = r.bg;
          }).catch(function () { /* ignore */ });
        } catch (e) { /* ignore */ }
      }
      // 页面是异步挂载的：多试几次，以最后一次读到的为准（豆包 main 元素可能晚于 dom-ready）
      [0, 600, 1500, 3000, 6000].forEach(function (delay) {
        setTimeout(function () {
          if (typeof o !== 'undefined' && o && o.alive === false) return;
          applyOnce();
        }, delay);
      });

      // 用户切站点主题时跟上：盯页面 class / data-theme 是否变化（60 次 × 1.5s 内）
      try {
        wv.executeJavaScript(
          '(function(){try{' +
          '  if (window.__xiodraThemeWatch) return;' +
          '  var last = "";' +
          '  function sig(){ var d = document.documentElement;' +
          '    return String((d.getAttribute("data-theme")||"") + "|" + (d.className||"")); }' +
          '  last = sig(); var n = 0;' +
          '  window.__xiodraThemeWatch = setInterval(function(){' +
          '    var c = sig();' +
          '    if (c !== last) { last = c; window.postMessage({xiodraTheme:"changed"},"*"); }' +
          '    if (++n > 60) { clearInterval(window.__xiodraThemeWatch); window.__xiodraThemeWatch = null; }' +
          '  }, 1500);' +
          '}catch(e){}})()'
        ).catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    });
    wv.setAttribute('src', site.url);
    bodyEl.appendChild(wv);
    bodyEl.appendChild(mask);
    win.appendChild(bodyEl);
    layer.appendChild(win);

    var o = {
      key: key, site: site, el: win, head: head, body: bodyEl, mask: mask,
      maskT: maskT, wv: wv, titleEl: titleEl, hostEl: hostEl,
      backBtn: backBtn, fwdBtn: fwdBtn, alive: true
    };
    ST.wins[key] = o;

    bindWebview(o);
    bindWindow(o);
    setStatus(key, 'loading');
    return o;
  }

  // ---- webview 事件 ----
  function bindWebview(o) {
    var wv = o.wv;

    wv.addEventListener('did-start-loading', function () {
      if (!o.alive) return;
      setStatus(o.key, 'loading');
      o.mask.classList.remove('gone');
    });

    wv.addEventListener('did-stop-loading', function () {
      if (!o.alive) return;
      setStatus(o.key, 'ready');
      o.mask.classList.add('gone');
      syncNav(o);
    });

    wv.addEventListener('did-fail-load', function (e) {
      // -3 = ERR_ABORTED：页面自己的跳转被打断，不算失败（参照项目同款判据）
      if (!o.alive || (e && e.errorCode === -3)) return;
      setStatus(o.key, 'fail');
      o.mask.classList.remove('gone');
      o.mask.innerHTML = '';
      o.mask.appendChild(el('div', 'webai-err', '加载失败：' + ((e && e.errorDescription) || '未知原因')));
      var retry = el('div', 'webai-act', '重试');
      retry.addEventListener('click', function () { try { wv.reload(); } catch (err) { /* ignore */ } });
      o.mask.appendChild(retry);
      var open = el('div', 'webai-act', '用系统浏览器打开');
      open.addEventListener('click', function () { openExternal(o.key); });
      o.mask.appendChild(open);
    });

    wv.addEventListener('did-navigate', function (e) {
      if (o.alive) o.hostEl.textContent = hostOf(e.url) || hostOf(o.site.url);
    });
    wv.addEventListener('did-navigate-in-page', function (e) {
      if (o.alive) o.hostEl.textContent = hostOf(e.url) || hostOf(o.site.url);
    });
    wv.addEventListener('page-title-updated', function (e) {
      if (!o.alive) return;
      var t = String((e && e.title) || '');
      o.titleEl.textContent = t ? (t.length > 24 ? t.slice(0, 24) + '…' : t) : o.site.name;
    });
  }

  function syncNav(o) {
    try {
      o.backBtn.disabled = !o.wv.canGoBack();
      o.fwdBtn.disabled = !o.wv.canGoForward();
    } catch (e) { /* ignore */ }
  }

  // ---- 窗口交互：拖动 / 按钮 / 抬升 / 记几何 ----
  function bindWindow(o) {
    var win = o.el;

    // 拖动：只能用 mousedown+mousemove（app-region:drag 会拖整个应用窗口）
    o.head.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target.closest && ev.target.closest('.webai-tb')) return;
      var r = win.getBoundingClientRect();
      var sx = ev.clientX;
      var sy = ev.clientY;
      var ox = r.left;
      var oy = r.top;
      function mv(e2) {
        var nx = ox + (e2.clientX - sx);
        var ny = oy + (e2.clientY - sy);
        win.style.left = Math.round(nx) + 'px';
        win.style.top = Math.round(Math.max(0, ny)) + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        recordGeometry(o);
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      ev.preventDefault();
    });

    // 标题栏按钮（事件委托，按 data-act 分发）
    o.head.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('.webai-tb');
      if (!b) return;
      ev.preventDefault();
      ev.stopPropagation();
      var act = b.dataset.act;
      if (act === 'back') { try { if (o.wv.canGoBack()) o.wv.goBack(); } catch (e) { /* ignore */ } }
      else if (act === 'fwd') { try { if (o.wv.canGoForward()) o.wv.goForward(); } catch (e) { /* ignore */ } }
      else if (act === 'reload') { try { o.wv.reload(); } catch (e) { /* ignore */ } }
      else if (act === 'free') free(o);
      else if (act === 'open') openExternal(o.key);
      else if (act === 'close') hide(o.key);
    });

    // 点窗口任意处抬到最前（capture 阶段，先于页面内容）
    win.addEventListener('mousedown', function () { raise(o); }, true);

    // 尺寸变化（CSS resize:both）也记住
    try {
      var ro = new ResizeObserver(function () { recordGeometry(o); });
      ro.observe(win);
      o.ro = ro;
    } catch (e) { /* 老内核没有 ResizeObserver，无所谓 */ }
  }

  function recordGeometry(o) {
    if (!o || !o.el) return;
    var r = o.el.getBoundingClientRect();
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 800;
    // 夹到视口内再存：否则一次异常尺寸会被永久记住，下次开窗就盖满整个工作台
    writeGeom(o.key, {
      x: Math.max(0, Math.min(Math.round(r.left), Math.max(0, vw - 120))),
      y: Math.max(0, Math.min(Math.round(r.top), Math.max(0, vh - 80))),
      w: Math.min(Math.round(r.width), Math.max(360, vw - 80)),
      h: Math.min(Math.round(r.height), Math.max(240, vh - 80))
    });
  }

  function openExternal(key) {
    var site = siteOf(key);
    if (!site) return;
    try {
      if (window.kun && window.kun.openExternal) window.kun.openExternal(site.url);
      else window.open(site.url, '_blank');
    } catch (e) { /* ignore */ }
  }

  // ---- 释放（销毁 webview，省内存）----
  function free(o) {
    try { if (o.ro) o.ro.disconnect(); } catch (e) { /* ignore */ }
    o.alive = false;
    try { if (o.wv && o.wv.parentNode) o.wv.parentNode.removeChild(o.wv); } catch (e) { /* ignore */ }
    try { if (o.el && o.el.parentNode) o.el.parentNode.removeChild(o.el); } catch (e) { /* ignore */ }
    delete ST.wins[o.key];
    setStatus(o.key, 'none');
    markOn();
  }

  // ---- 显 / 隐 ----
  function show(key) {
    var o = ensure(key);
    if (!o) return;
    o.el.classList.remove('warm', 'mini');
    raise(o);
    markOn();
  }

  // 收起只是加 warm（不销毁 webview）⇒ 下次点开秒开
  function hide(key) {
    var o = ST.wins[key];
    if (!o) return;
    recordGeometry(o);
    o.el.classList.add('warm');
    markOn();
  }

  function toggle(key, forceShow) {
    var o = ST.wins[key];
    var open = !!o && !o.el.classList.contains('warm');
    var want = forceShow === undefined ? !open : !!forceShow;
    if (want) show(key); else hide(key);
  }

  // ---- 图标条 ----
  function decorate() {
    var bar = document.getElementById('titlebar');
    if (!bar) return;
    var drag = bar.querySelector('.titlebar-drag');
    var brand = bar.querySelector('.brand');
    if (!drag || !brand) return;

    var strip = ST.strip;
    if (!strip || !strip.parentNode) {
      strip = document.getElementById('webai-strip');
      if (!strip) {
        strip = el('span', 'webai-strip');
        strip.id = 'webai-strip';
        strip.setAttribute('role', 'group');
        strip.setAttribute('aria-label', '网页版 AI');
        // 紧跟品牌名之后（与参照项目一致）
        brand.parentNode.insertBefore(strip, brand.nextSibling);
      }
      ST.strip = strip;
    }

    // 图标按钮（幂等：已存在的 key 不再建）
    WEB_AI.forEach(function (site) {
      var btn = strip.querySelector('.webai-btn[data-key="' + site.key + '"]');
      if (btn) return;
      btn = el('button', 'webai-btn');
      btn.type = 'button';
      btn.dataset.key = site.key;
      btn.dataset.st = 'none';
      btn.dataset.fb = site.fallback || site.name.slice(0, 1);
      btn.title = '打开 ' + site.name + '（网页版）';
      var img = document.createElement('img');
      img.src = site.icon;
      img.draggable = false;
      img.alt = site.name;
      img.onerror = function () {
        btn.classList.add('noimg');
        try { this.remove(); } catch (e) { /* ignore */ }
      };
      btn.appendChild(img);
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        toggle(site.key);
      });
      strip.appendChild(btn);
    });

    if (!ST.bound) {
      ST.bound = true;
      // 窗口尺寸变了：把跑出视口的窗口拉回来（用户改窗口大小后不至于"窗口不见了"）
      window.addEventListener('resize', function () {
        Object.keys(ST.wins).forEach(function (k) {
          var o = ST.wins[k];
          if (!o || !o.el) return;
          var r = o.el.getBoundingClientRect();
          var maxX = Math.max(0, (window.innerWidth || 1280) - 120);
          var maxY = Math.max(0, (window.innerHeight || 800) - 80);
          if (r.left > maxX) o.el.style.left = maxX + 'px';
          if (r.top > maxY) o.el.style.top = maxY + 'px';
        });
      });
    }

    markOn();
  }

  // 对外接口（renderers.js / 桥要用）
  window.__xiodraWebAiOpen = toggle;
  window.__xiodraWebAiEnsure = ensure;
  window.__xiodraWebAiDecorate = decorate;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorate);
  } else {
    decorate();
  }
})();
