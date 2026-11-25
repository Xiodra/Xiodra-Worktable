// renderers.js —— 面板渲染器注册表（纯 JS，无构建；改完重开窗口/顶栏 ⟳ 就生效）
// 约定（与文档《面板类型与注册》一致）：
//   渲染器 = 一个函数 fn(body, meta, head)，body 是面板内容区 DOM，meta 是场景 json 里的面板对象。
//   返回函数 ⇒ 视为 cleanup，切场景时会被调用（定时器必须在这里清，否则切走还在跑）。
//   类型没注册 ⇒ renderer.js 画一行灰字「未知面板类型: xxx」，不报错、不崩。
// 命名：面板 type 用小写连字符（console / harness / view / file …）。
// 当前阶段只实现 console（控制器场景）；其余类型等真要用时再加，预造的面板没人点。

(function () {
  'use strict';

  // ==================== 小工具（与参照项目 renderers.js 的 el/makePanel 同语义） ====================
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // 双击面板标题 → 就地变成输入框；Enter 保存、Esc 取消、失焦保存。
  // 保存走主进程 panel:patch（只写 title 一个字段），渲染层不碰文件。
  // ⚠ 编辑期间要 stopPropagation：面板标题在 .panel-head 里，有些面板的头部有拖拽/点击行为。
  function enableTitleEdit(titleEl, meta) {
    titleEl.addEventListener('dblclick', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (titleEl.dataset.editing === '1') return;
      titleEl.dataset.editing = '1';

      const before = titleEl.textContent;
      const input = document.createElement('input');
      input.className = 'panel-title-edit';
      input.type = 'text';
      input.value = before;
      input.spellcheck = false;
      // 宽度跟着原文字走，避免整行标题被输入框撑开
      input.style.width = Math.max(60, Math.min(320, Math.ceil(titleEl.getBoundingClientRect().width) + 24)) + 'px';

      let done = false;
      const finish = async function (commit) {
        if (done) return;
        done = true;
        const next = commit ? input.value.trim() : before;
        if (input.parentNode) input.parentNode.replaceChild(titleEl, input);
        titleEl.dataset.editing = '';
        titleEl.textContent = next || before;
        if (!commit || !next || next === before) return;

        const sceneId = String((meta && meta.scenario) || '');
        const panelId = String((meta && meta.id) || '');
        if (!sceneId || !panelId) { window.__dshToast && window.__dshToast('这个面板没有场景 id，改不了'); return; }
        let r = null;
        try { r = await window.kun.scenarios.patchPanel(sceneId, panelId, { title: next }); } catch (e) { r = { ok: false, err: (e && e.message) || String(e) }; }
        if (r && r.ok) {
          if (meta) meta.title = next;
          window.__dshToast && window.__dshToast('标题已保存：' + next);
        } else {
          titleEl.textContent = before;
          if (meta) meta.title = before;
          window.__dshToast && window.__dshToast('保存失败：' + ((r && r.err) || '未知错误'));
        }
      };

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
      input.addEventListener('dblclick', function (e) { e.stopPropagation(); });

      titleEl.parentNode.replaceChild(input, titleEl);
      input.focus();
      input.select();
    });
  }

  // 建一个面板外壳：<section class="panel"><div class="panel-head">…</div><div class="panel-body">…</div></section>
  // 坐标/跨度直接写进行内 gridColumn/gridRow —— 必须一次写完整简写，
  // 先设 gridRow="span N" 再覆盖 gridRowStart 会让 end 变 auto，高度塌成 1 行。
  //
  // ★标题栏结构（照搬参照项目《面板通用能力》§1，全类型统一）：
  //   [序号徽标] [标题] [小字 .panel-sub] …………………… [功能区 .panel-acts: 自定义按钮 + ▲ + ⇄]
  //   功能区必须固定在右上角（margin-left:auto，flex-shrink:0），且**永远排在最后** ——
  //   各渲染器往 head 里塞内容时一律塞进 acts，不要直接 appendChild 到 head
  //   （以前按钮摊在 head 里、靠 .panel-swap{margin-left:auto} 顶到右边，
  //     多一个按钮位置就乱，而且和副标题抢空间）。
  /** 开关某个面板的边缘流光（工作中 / 展开 都用它，判据不重复写） */
  function setPanelBeam(wrapEl, on) {
    if (!wrapEl) return;
    wrapEl.classList.toggle('panel-working', !!on);
  }

  function makePanel(meta, idx) {
    const wrap = el('section', 'panel');
    wrap.__meta = meta;
    wrap.style.gridColumn = (meta.col ? meta.col + ' / span ' : 'span ') + (meta.w || 2);
    wrap.style.gridRow = (meta.row ? meta.row + ' / span ' : 'span ') + (meta.h || 2);
    wrap.dataset.panelId = meta.id;
    // ★border beam 边缘流光层★（2026-11-23）
    //   默认不显示；「工作中」(.panel-working) 或「展开」(.panel-expanded) 时由 CSS 打开。
    //   ⛔ 不在这里判状态：状态由渲染器（harness 的 tick）从 console:model 拿，
    //      再调 setPanelBeam / classList 切换，判据只有一处。
    wrap.__beam = el('div', 'panel-beam');
    wrap.appendChild(wrap.__beam);

    const head = el('div', 'panel-head');
    // 面板序号徽标（方便用户说"改第 03 个窗口"）
    const badge = el('span', 'panel-badge', String(idx + 1).padStart(2, '0'));
    badge.title = '面板序号';
    head.appendChild(badge);

    const title = el('span', 'panel-title', meta.title || meta.id);
    title.title = '双击改名';
    enableTitleEdit(title, meta);
    head.appendChild(title);
    if (meta.sub) head.appendChild(el('span', 'panel-sub', meta.sub));

    // 功能区：右上角一横排。渲染器拿到 head 后通过 head.__acts 把自己的按钮塞进来。
    const acts = el('div', 'panel-acts');
    head.__acts = acts;
    head.appendChild(acts);
    // 小字（状态/路径/文件名）也要能塞进功能区左侧，统一从 head.__sub 拿
    const subEl = head.querySelector('.panel-sub');
    head.__sub = subEl || null;

    // 「▲ 展开到最高」：AI 面板默认就有；别的类型想有就在场景 json 里写 "expand": true。
    // 展开逻辑与按钮位置无关，是通用的：原格插一个占位格钉住版面，
    // 再把面板改成 position:fixed 撑满整个网格高度。
    if (meta.type === 'harness' || meta.expand) {
      const exp = el('button', 'panel-expand', '▲');
      exp.type = 'button';
      exp.title = '展开到最高（再点一次收起）';
      exp.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (wrap.classList.contains('panel-expanded')) collapsePanel(wrap, exp);
        else expandPanel(wrap, exp);
      });
      acts.appendChild(exp);
    }

    // 「换类型」入口（文档《面板通用能力》：自定义按钮统一追加在标题栏末尾）。
    // 点了就把这块面板变回「待配置」，由面板选择器重新挑类型 —— 不去猜原来的配置能不能沿用。
    // console 是场景的骨架，不给换（换了整个场景就没控制器了）。
    if (meta.type !== 'console') {
      const swap = el('button', 'panel-expand panel-swap', '⇄');
      swap.type = 'button';
      swap.title = '换一种面板类型';
      swap.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const sceneId = String(meta.scenario || '');
        const panelId = String(meta.id || '');
        if (!sceneId || !panelId) return;
        window.kun.scenarios.patchPanel(sceneId, panelId, { type: 'placeholder' })
          .then(function (r) {
            if (r && r.ok) return window.kun.panels.requestReload(sceneId);
            window.__dshToast && window.__dshToast('换类型失败：' + ((r && r.err) || '未知错误'));
            return null;
          })
          .catch(function () { /* ignore */ });
      });
      acts.appendChild(swap);
    }

    wrap.appendChild(head);
    const body = el('div', 'panel-body');
    body.dataset.kind = meta.type || '';
    wrap.appendChild(body);
    return { wrap: wrap, body: body, head: head, acts: acts };
  }

  // 往功能区塞按钮（渲染器统一走这个，别直接 head.appendChild）
  // 顺序规则：自定义按钮按加入顺序排在「系统按钮」（▲ 展开 / ⇄ 换类型）左边。
  // 早先用 insertBefore(acts.firstChild) 会把后加的排到前面（⟳🏠⬆ 变反序），
  // 所以锚点要取第一个系统按钮，而不是 always firstChild。
  function addAct(head, node) {
    if (!head || !node) return null;
    const acts = head.__acts || head.querySelector('.panel-acts');
    if (!acts) return null;
    const anchor = acts.querySelector('.panel-expand') || null;
    acts.insertBefore(node, anchor);
    return node;
  }

  // 设置标题行小字（状态 / 当前路径 / 文件名）。sub 在 json 里可能是只读的说明，
  // 这里只在没有 sub 时建一个，避免把用户写的 sub 冲掉。
  function setHeadSub(head, text) {
    if (!head) return null;
    let sub = head.__sub || head.querySelector('.panel-sub');
    if (!sub) {
      sub = el('span', 'panel-sub', '');
      const acts = head.__acts || null;
      if (acts && acts.parentNode === head) head.insertBefore(sub, acts);
      else head.appendChild(sub);
      head.__sub = sub;
    }
    sub.textContent = String(text || '');
    return sub;
  }

  // ---- 展开到最高（照搬参照项目 renderers.js 的 expandPanel 思路，去掉动画与拖拽那部分）----
  // 关键点（参照项目踩过的坑都写在注释里）：
  //   ① 原格插一个同坐标的占位格，其它面板位置完全不动；
  //   ② 必须用 position:fixed + 视口坐标 —— 带 grid-column 的项改成 absolute 后，
  //      包含块是它自己那一格，用"相对网格的偏移"会再叠加一次格子起点（面板会跑偏）；
  //   ③ 面板里有 webview 时，动画期间内容会重排很多次；这里不做动画，直接一次到位。
  let expandZ = 0;
  // ★展开态的几何计算（唯一出处）★
  // 为什么单独抽出来：expandPanel 与"窗口变化时重算"必须用同一套算法，
  // 写两份迟早走偏（以前就是因为只有 expandPanel 里算一次，resize 后不更新）。
  //
  // 关键点：slot 是原格的占位格（面板改 fixed 后它仍占着那一格），
  // 所以 slot.getBoundingClientRect() 永远等于"这个面板原本该在的地方"。
  // 窗口一变，slot 自己就跟着 grid 重排了 ⇒ 重读它即可，不用记旧值。
  function measureExpand(wrap) {
    const gridEl = wrap.parentElement;
    const slot = wrap.__expandSlot;
    if (!gridEl || !slot) return null;
    const g = gridEl.getBoundingClientRect();
    const s = slot.getBoundingClientRect();
    // ★保留上下缝隙★（2026-11-18 用户要求）：缝隙取网格自己的 padding（10px），
    // 让展开态的上下留白与左右完全对齐。
    const cs = getComputedStyle(gridEl);
    const seam = Math.max(0, Math.round(parseFloat(cs.paddingLeft) || 10));
    return {
      left: Math.round(s.left),
      top: Math.round(g.top + seam),
      width: Math.round(s.width),
      // 至少给它 120px，避免窗口极小时算出负数高度（那样面板会消失，更难排查）
      height: Math.max(120, Math.round(g.height - seam * 2)),
      seam: seam
    };
  }

  function applyExpandBox(wrap) {
    const box = measureExpand(wrap);
    if (!box) return false;
    wrap.style.left = box.left + 'px';
    wrap.style.top = box.top + 'px';
    wrap.style.width = box.width + 'px';
    wrap.style.height = box.height + 'px';
    return true;
  }

  // 把所有展开中的面板按当前窗口重算一遍（rAF 节流：拖窗口时一帧最多一次）
  let expandRaf = 0;
  function repositionExpanded() {
    if (expandRaf) return;
    expandRaf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
      expandRaf = 0;
      const opened = document.querySelectorAll('.panel-expanded');
      for (let i = 0; i < opened.length; i++) applyExpandBox(opened[i]);
    });
  }

  // 只装一次：渲染器会被自刷新反复求值（panels:reload），重复装会让一次 resize 触发多次重算，
  // 而且旧的监听器指向旧闭包（gridEl 已经没了）⇒ 白跑。
  (function initExpandResize() {
    if (window.__dshExpandResize) return;
    window.__dshExpandResize = true;
    window.addEventListener('resize', repositionExpanded);
    // ResizeObserver 补 window resize 抓不到的情况（比如侧栏/内边距变化导致 grid 变了但窗口没变）
    try {
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(repositionExpanded);
        const hook = function () {
          const g = document.getElementById('grid');
          if (g) { try { ro.observe(g); } catch (e) { /* ignore */ } return true; }
          return false;
        };
        if (!hook()) {
          // 启动页阶段 #grid 可能还没建，等 DOM 就绪再挂
          document.addEventListener('DOMContentLoaded', hook, { once: true });
        }
      }
    } catch (e) { /* ignore */ }
  })();

  function expandPanel(wrap, btn) {
    const gridEl = wrap.parentElement;
    if (!gridEl || wrap.classList.contains('panel-expanded')) return;
    const slot = el('div', 'panel-slot');
    slot.style.gridColumn = wrap.style.gridColumn;
    slot.style.gridRow = wrap.style.gridRow;
    gridEl.insertBefore(slot, wrap);
    wrap.__expandSlot = slot;
    wrap.__expandPrev = {
      position: wrap.style.position, zIndex: wrap.style.zIndex, left: wrap.style.left,
      top: wrap.style.top, width: wrap.style.width, height: wrap.style.height
    };
    wrap.style.position = 'fixed';
    wrap.style.zIndex = String(++expandZ);
    applyExpandBox(wrap);
    wrap.classList.add('panel-expanded');
    btn.textContent = '▼';
    btn.title = '收起（恢复原来的高度）';
  }

  function collapsePanel(wrap, btn) {
    const slot = wrap.__expandSlot;
    const prev = wrap.__expandPrev || {};
    wrap.classList.remove('panel-expanded');
    wrap.style.position = prev.position || '';
    wrap.style.zIndex = prev.zIndex || '';
    wrap.style.left = prev.left || '';
    wrap.style.top = prev.top || '';
    wrap.style.width = prev.width || '';
    wrap.style.height = prev.height || '';
    wrap.__expandSlot = null;
    wrap.__expandPrev = null;
    if (slot && slot.parentNode) slot.parentNode.removeChild(slot);
    if (btn) { btn.textContent = '▲'; btn.title = '展开到最高（再点一次收起）'; }
  }

  // ESC 收起最上层那个展开的面板（连按 = 逐个退栈，与参照项目一致）。
  // 只装一次：渲染器可能被反复加载（自刷新通道），重复装会让一次 ESC 收掉好几个。
  (function initExpandEsc() {
    if (window.__dshExpandEsc) return;
    window.__dshExpandEsc = true;
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      const opened = Array.prototype.slice.call(document.querySelectorAll('#grid .panel-expanded'));
      if (!opened.length) return;
      // 后展开的 z-index 更大 ⇒ 收起 z-index 最大的那个
      opened.sort(function (a, b) {
        return (parseInt(b.style.zIndex || '0', 10) || 0) - (parseInt(a.style.zIndex || '0', 10) || 0);
      });
      const top = opened[0];
      const btn = top.querySelector('.panel-expand:not(.panel-swap)');
      collapsePanel(top, btn);
      ev.preventDefault();
    });
  })();

  // ==================== 面板数据按场景分区（文档《面板通用能力》§5）====================
  // 面板自己的小状态（滚动位置、筛选条件、上次打开的文件…）一律挂在「场景 + 面板」这一格上，
  // 不共享 key —— 否则同一个渲染器在 A 场景记的设置会串到 B 场景。
  // 只暴露读写两个函数，别让渲染器各写各的 key。
  function sceneStore(meta) {
    const scene = String((meta && meta.scenario) || '_');
    const panel = String((meta && meta.id) || '_');
    const key = 'xiodra.panel:' + scene + ':' + panel;
    return {
      get: function (fallback) {
        try {
          const raw = localStorage.getItem(key);
          if (raw == null) return fallback === undefined ? null : fallback;
          return JSON.parse(raw);
        } catch (e) { return fallback === undefined ? null : fallback; }
      },
      set: function (v) {
        try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; }
      },
      clear: function () { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } },
      key: key
    };
  }

  // ==================== 控制器（console）渲染器 ====================
  // 照搬 dsh-worktable 的「控制室」：一张卡 = 一个场景（因为场景标签栏取代了原侧边栏的应用抽屉）。
  // 数据全由主进程算好（读引擎的 session_projcache 投影）：渲染层不读盘、不碰 fs、不调模型。
  // 状态语义（与 dsh-worktable consoleStatusOf 一致）：
  //   idle 空闲 / busy 工作中 / need 待你决定 / done 本轮已结束
  //   ⚠ done 只是"本轮已结束"的中性提醒，**不判断任务是否成功**。
  const STATUS_LABEL = { idle: '空闲', busy: '工作中', need: '待你决定', done: '本轮已结束' };

  // 控制器显示设置（主题/形状/背景/列数/网格线）存在本地，与参照项目一样不进场景 json
  const SETTINGS_KEY = 'xiodra.console.settings.v1';
  function readSettings() {
    const def = { theme: 'dark', shape: 'square', bg: 'glow', cols: 4, grid: 'on' };
    try {
      const j = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!j || typeof j !== 'object') return def;
      return {
        theme: ['dark', 'light', 'system'].indexOf(j.theme) >= 0 ? j.theme : def.theme,
        shape: ['square', 'circle'].indexOf(j.shape) >= 0 ? j.shape : def.shape,
        bg: ['plain', 'glow', 'photo'].indexOf(j.bg) >= 0 ? j.bg : def.bg,
        cols: Math.max(1, Math.min(6, Number(j.cols) || def.cols)),
        grid: j.grid === 'off' ? 'off' : 'on'
      };
    } catch (e) { return def; }
  }
  function writeSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  // 系统深浅色（theme=system 时用）
  function sysDark() {
    try {
      const cs = getComputedStyle(document.documentElement).colorScheme || '';
      if (cs.indexOf('dark') >= 0) return true;
      if (cs.indexOf('light') >= 0) return false;
    } catch (e) { /* ignore */ }
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { return true; }
  }

  // 用时格式：h>0 ? h:mm:ss : m:ss（mm/ss 两位补零）
  function fmtDur(ms) {
    if (ms == null) return '';
    const total = Math.max(0, Math.floor(Number(ms) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p2 = function (n) { return String(n).padStart(2, '0'); };
    return h > 0 ? (h + ':' + p2(m) + ':' + p2(s)) : (m + ':' + p2(s));
  }

  // 图标：图片路径（.png/.ico/.jpg/.webp/.svg 或 assets/ 开头）画 <img>，其余当 emoji 文字
  function isImageIcon(icon) {
    const s = String(icon || '');
    if (!s) return false;
    if (/^data:image\//i.test(s)) return true;
    return /\.(png|ico|jpe?g|webp|svg)$/i.test(s);
  }
  function makeIconNode(icon, fallback) {
    const n = el('span', 'dsh-wt_consoleIcon');
    const s = String(icon || '');
    if (isImageIcon(s)) {
      const img = document.createElement('img');
      img.src = s;
      img.alt = '';
      img.onerror = function () { n.textContent = fallback || '🧱'; };
      n.appendChild(img);
    } else {
      n.textContent = s || fallback || '🧱';
    }
    return n;
  }

  function renderConsole(body, meta) {
    const panelId = meta.id || 'console';
    let settings = readSettings();
    let disposed = false;
    let timer = null;
    let lastModel = null;
    let openDrop = null;          // 当前展开的 dock 下拉菜单元素

    // ---- 骨架 ----
    const root = el('div', 'dsh-wt_console');
    root.dataset.wtTheme = settings.theme;
    root.dataset.wtShape = settings.shape;
    root.dataset.wtBg = settings.bg;
    root.dataset.wtGrid = settings.grid;
    root.style.setProperty('--wt-cols', String(settings.cols));

    // 背景层（glow 背景的 4 团彩光；plain 时 CSS 里 opacity 会自然压掉）
    const bgLayer = el('span', 'dsh-wt_consoleBg');
    for (let i = 1; i <= 4; i++) bgLayer.appendChild(el('i', 'dsh-wt_blob dsh-wt_blob' + i));
    root.appendChild(bgLayer);

    const scroll = el('div', 'dsh-wt_consoleScroll');
    const grid = el('div', 'dsh-wt_consoleGrid');
    scroll.appendChild(grid);
    root.appendChild(scroll);

    // 底部 dock（主题 / 形状 / 背景 / 列数 / 网格线 —— 全是真设置，没有假按钮）
    const dockWrap = el('div', 'dsh-wt_consoleDockWrap');
    const dock = el('div', 'dsh-wt_consoleDock');
    dockWrap.appendChild(dock);
    root.appendChild(dockWrap);

    body.appendChild(root);

    // ---- 主题生效（theme=system 时按系统深浅落成 dark/light）----
    function applyTheme() {
      const t = settings.theme === 'system' ? (sysDark() ? 'dark' : 'light') : settings.theme;
      root.dataset.wtTheme = t;
    }

    function applySettings() {
      root.dataset.wtShape = settings.shape;
      root.dataset.wtBg = settings.bg;
      root.dataset.wtGrid = settings.grid;
      root.style.setProperty('--wt-cols', String(settings.cols));
      applyTheme();
      writeSettings(settings);
    }
    applySettings();

    // ---- 卡片 ----
    function cardTools(card) {
      const tools = el('div', 'card-tools' + ((card.bound || card.projectDir) ? ' has-state' : ''));
      // iconSrc 可选：给了就用 <img>（.card-tool-img），否则用 glyph 文字。
      // ⚠ 路径相对 renderer/index.html ⇒ 写 'assets/xxx.svg'。
      const mk = function (act, glyph, title, on, iconSrc) {
        const b = el('button', 'card-tool' + (on ? ' is-on' : ''), iconSrc ? '' : glyph);
        if (iconSrc) {
          const img = document.createElement('img');
          img.className = 'card-tool-img';
          img.src = iconSrc;
          img.alt = '';
          // 图片加载失败时退回字符，别留一个空按钮
          img.addEventListener('error', function () { b.textContent = glyph; });
          b.appendChild(img);
        }
        b.type = 'button';
        b.title = title;
        b.dataset.act = act;
        // 卡片本身是 role=button（点了进场景），入口按钮必须拦住冒泡，否则点入口会顺带切场景
        b.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          try { onPick(act, card); } catch (err) { console.warn('[console] 入口失败', err); }
        });
        return b;
      };
      tools.appendChild(mk('bind', '🔗', card.bound ? ('已绑定：' + (card.sessionTitle || card.sessionId)) : '会话绑定', card.bound));
      tools.appendChild(mk('folder', '📁', card.projectDir ? ('项目文件夹：' + card.projectDir) : '项目文件夹', !!card.projectDir));
      tools.appendChild(mk('icon', '🎨', '更换场景图标', !!card.icon));
      // 换布局（派单 49cf727f55）：保留全部面板与配置，只重排网格。
      // 图标用 assets/layout.svg（用户指定）；glyph '▦' 作为图片加载失败时的后备。
      tools.appendChild(mk('layout', '▦', '更换布局（保留面板与配置）', false, 'assets/layout.svg'));
      return tools;
    }

    function makeCard(card) {
      const status = card.status || 'idle';
      const cls = ['dsh-wt_consoleCard'];
      if (card.self) cls.push('dsh-wt_consoleCardSelf');
      if (status === 'busy') cls.push('dsh-wt_consoleCard-busy');
      if (card.glow && status === 'done') cls.push('dsh-wt_consoleCard-glowDone');
      if (card.glow && status === 'need') cls.push('dsh-wt_consoleCard-glowNeed');

      const c = el('div', cls.join(' '));
      c.setAttribute('role', 'button');
      c.tabIndex = 0;
      c.title = card.name || card.id;
      c.dataset.flip = card.id;

      // 场景 0「DSH 引擎」没有绑定/文件夹/图标的概念（它就是引擎本体界面），不给入口按钮，
      // 否则会出现"点了没反应"的假按钮。
      if (!card.fixed) c.appendChild(cardTools(card));

      const head = el('div', 'dsh-wt_consoleCardHead');
      head.appendChild(makeIconNode(card.icon, card.self ? '🕹' : '🧱'));
      head.appendChild(el('span', 'dsh-wt_consoleName', card.name || card.id));
      c.appendChild(head);

      c.appendChild(el('div', 'dsh-wt_consoleDivider'));

      const row = el('div', 'dsh-wt_consoleStatusRow');
      row.appendChild(el('span', 'dsh-wt_consoleStatus dsh-wt_consoleStatus-' + status, STATUS_LABEL[status] || status));
      if (card.runtimeMs != null) row.appendChild(el('span', 'dsh-wt_consoleRuntime', fmtDur(card.runtimeMs)));
      c.appendChild(row);

      if (status === 'busy') c.appendChild(el('span', 'dsh-wt_consoleSweep'));

      const preview = el('div', 'dsh-wt_consolePreview' + (card.preview ? '' : ' dsh-wt_consolePreviewNone'));
      preview.textContent = card.preview || (card.bound ? '这一轮还没有回复' : '未绑定对话');
      preview.title = card.preview || '';
      c.appendChild(preview);

      // 卡片底部两行小字：绑定的是哪条会话 / 项目文件夹（原应用抽屉里的信息，收到卡上）
      // 场景 0 是引擎本体，没有这两个概念，整块不画。
      if (!card.fixed) {
        const metaBox = el('div', 'card-meta');
        const l1 = el('div', 'card-meta-line');
        l1.appendChild(el('b', '', '对话 '));
        l1.appendChild(document.createTextNode(card.bound ? (card.sessionTitle || card.sessionId) : '未绑定'));
        const l2 = el('div', 'card-meta-line');
        l2.appendChild(el('b', '', '目录 '));
        l2.appendChild(document.createTextNode(card.projectDir || '未设置'));
        metaBox.appendChild(l1);
        metaBox.appendChild(l2);
        c.appendChild(metaBox);
      }

      // 点击卡片 = 切到那个场景
      // ⛔ 两种情况不响应：
      //   ① card.self（参照项目的 self 语义，目前等价于"第一个场景"）；
      //   ② **当前已经在这个场景**（2026-11-21 用户要求）——
      //      在「控制器」场景里点「控制器」卡片去"切到控制器"没有任何意义。
      //      ⚠ 这个判断必须**在点击那一刻现算**，不能在建卡时算死：
      //        paintGrid 每 3 秒重画一次，写死会在切场景后留下过期的值。
      c.addEventListener('click', function () {
        if (card.self) return;
        let cur = '';
        try {
          const g = window.__dshGridMeta ? window.__dshGridMeta() : null;
          cur = String((g && g.scene) || '');
        } catch (e) { cur = ''; }
        if (cur && cur === String(card.id)) return;
        if (typeof window.__dshGoScene === 'function') window.__dshGoScene(card.id);
      });
      c.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        c.click();
      });
      return c;
    }

    // 新建场景卡（替代原「添加项目」卡：一个场景 = 一个 json）
    function makeAddCard() {
      const c = el('div', 'dsh-wt_consoleCard dsh-wt_consoleAdd');
      c.setAttribute('role', 'button');
      c.tabIndex = 0;
      c.appendChild(el('span', 'dsh-wt_consoleAddPlus', '＋'));
      c.appendChild(el('span', 'dsh-wt_consoleAddLabel', '新建场景'));
      c.addEventListener('click', function () { openCreateScene(); });
      return c;
    }

    function paintGrid() {
      const cards = (lastModel && lastModel.cards) || [];
      // 滚动位置保留，避免每 3 秒刷新一次把用户正在看的位置弹回顶部
      const keepTop = scroll.scrollTop;
      grid.textContent = '';
      if (!cards.length) {
        grid.appendChild(el('div', 'dsh-wt_consoleEmpty', '还没有场景。点下面的「＋ 新建场景」建一个。'));
      } else {
        for (const card of cards) grid.appendChild(makeCard(card));
      }
      grid.appendChild(makeAddCard());
      scroll.scrollTop = keepTop;
    }

    // ---- 数据：主进程算好的模型 ----
    async function refresh() {
      if (disposed) return;
      try {
        lastModel = await window.kun.console.model();
      } catch (e) {
        lastModel = null;
      }
      if (disposed) return;
      paintGrid();
    }

    // ---- dock 下拉 ----
    function closeDrop() {
      if (!openDrop) return;
      try { openDrop.remove(); } catch (e) { /* ignore */ }
      openDrop = null;
      const mask = dockWrap.querySelector('.dsh-wt_dropMask');
      if (mask) mask.remove();
    }

    function openMenu(anchorBtn, items) {
      closeDrop();
      const mask = el('div', 'dsh-wt_dropMask');
      mask.addEventListener('click', function (ev) { ev.stopPropagation(); closeDrop(); });
      const drop = el('div', 'dsh-wt_drop');
      for (const it of items) {
        const b = el('button', 'dsh-wt_dropItem' + (it.on ? ' dsh-wt_dropItemOn' : ''), it.label);
        b.type = 'button';
        if (it.on) b.classList.add('dsh-wt_dropItemOn');
        b.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          it.run();
          closeDrop();
        });
        drop.appendChild(b);
      }
      // 下拉挂在 dockWrap（position:relative）里，bottom=100% 正好浮在 dock 上方
      dockWrap.appendChild(mask);
      dockWrap.appendChild(drop);
      openDrop = drop;
    }

    const ICONS = {
      theme: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" stroke-linecap="round"/></svg>',
      shape: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/></svg>',
      bg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 16c3-6 5-8 8-8s5 2 8 8" stroke-linecap="round"/><path d="M4 20h16" stroke-linecap="round"/></svg>',
      cols: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="4.5" width="7" height="15" rx="2"/><rect x="13.5" y="4.5" width="7" height="15" rx="2"/></svg>',
      grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>'
    };

    function dockBtn(key, title) {
      const b = el('button', 'dsh-wt_dockBtn');
      b.type = 'button';
      b.title = title;
      b.innerHTML = ICONS[key] || '';
      return b;
    }

    const btnTheme = dockBtn('theme', '主题（深色 / 浅色 / 跟随系统）');
    btnTheme.addEventListener('click', function () {
      openMenu(btnTheme, [
        { label: '深色', on: settings.theme === 'dark', run: function () { settings.theme = 'dark'; applySettings(); } },
        { label: '浅色', on: settings.theme === 'light', run: function () { settings.theme = 'light'; applySettings(); } },
        { label: '跟随系统', on: settings.theme === 'system', run: function () { settings.theme = 'system'; applySettings(); } }
      ]);
    });

    const btnShape = dockBtn('shape', '卡片形状（方形 / 圆形）');
    btnShape.addEventListener('click', function () {
      openMenu(btnShape, [
        { label: '方形', on: settings.shape === 'square', run: function () { settings.shape = 'square'; applySettings(); } },
        { label: '圆形', on: settings.shape === 'circle', run: function () { settings.shape = 'circle'; applySettings(); } }
      ]);
    });

    const btnBg = dockBtn('bg', '背景（纯色 / 流光）');
    btnBg.addEventListener('click', function () {
      openMenu(btnBg, [
        { label: '纯色', on: settings.bg === 'plain', run: function () { settings.bg = 'plain'; applySettings(); } },
        { label: '流光', on: settings.bg === 'glow', run: function () { settings.bg = 'glow'; applySettings(); } }
      ]);
    });

    const btnCols = dockBtn('cols', '每行几张卡片');
    btnCols.addEventListener('click', function () {
      const items = [];
      for (const n of [1, 2, 3, 4]) {
        items.push({
          label: n + ' 列', on: settings.cols === n,
          run: (function (nn) { return function () { settings.cols = nn; applySettings(); }; })(n)
        });
      }
      openMenu(btnCols, items);
    });

    const btnGrid = dockBtn('grid', '背景网格线');
    btnGrid.addEventListener('click', function () {
      openMenu(btnGrid, [
        { label: '显示网格', on: settings.grid === 'on', run: function () { settings.grid = 'on'; applySettings(); } },
        { label: '隐藏网格', on: settings.grid === 'off', run: function () { settings.grid = 'off'; applySettings(); } }
      ]);
    });

    dock.appendChild(btnTheme);
    dock.appendChild(btnShape);
    dock.appendChild(btnBg);
    dock.appendChild(btnCols);
    dock.appendChild(btnGrid);

    // ---- 三个入口的弹窗 ----
    async function onPick(act, card) {
      if (typeof window.__dshOpenModal !== 'function') return;
      if (act === 'bind') return openBind(card);
      if (act === 'folder') return openFolder(card);
      if (act === 'icon') return openIcon(card);
      if (act === 'layout') return openLayout(card);
    }

    async function openBind(card) {
      let sessions = [];
      try {
        const m = await window.kun.console.model();
        sessions = (m && m.sessions) || [];
      } catch (e) { sessions = []; }

      const wrap = el('div');
      wrap.appendChild(el('div', 'form-hint',
        '绑定之后：卡片的状态、用时、预览都读这条会话的投影；切到这个场景时右侧对话窗就跟着它。'));

      const list = el('div', 'pick-list');
      list.style.marginTop = '10px';
      if (!sessions.length) {
        list.appendChild(el('div', 'pick-empty', '引擎数据里还没有任何会话。先在「DSH 引擎」标签里开一条对话。'));
      } else {
        for (const s of sessions) {
          const b = el('button', 'pick-item' + (s.id === card.sessionId ? ' is-on' : ''));
          b.type = 'button';
          b.appendChild(el('div', 'pick-item-t', (s.title || '(未命名会话)') + ' · ' + (STATUS_LABEL[s.status] || s.status)));
          b.appendChild(el('div', 'pick-item-s', s.id));
          b.addEventListener('click', async function () {
            const r = await window.kun.scenarios.patch(card.id, {
              sessionId: s.id,
              sessionTitle: s.title || '',
              // pinTarget 是兜底点行用的候选名（模糊匹配，忽略大小写与空格）
              pinTarget: s.title ? [s.title] : []
            });
            window.__dshCloseModal();
            if (!r || !r.ok) { window.__dshToast('绑定失败：' + ((r && r.err) || '未知错误')); return; }
            window.__dshToast('已绑定到「' + (s.title || s.id) + '」');
            await refresh();
            if (typeof window.__dshReloadTabs === 'function') window.__dshReloadTabs();
          });
          list.appendChild(b);
        }
      }
      wrap.appendChild(list);

      const foot = document.createDocumentFragment();
      if (card.bound) {
        const clr = el('button', 'modal-btn danger', '解绑');
        clr.type = 'button';
        clr.addEventListener('click', async function () {
          const r = await window.kun.scenarios.patch(card.id, { sessionId: null, sessionTitle: null, pinTarget: null });
          window.__dshCloseModal();
          if (r && r.ok) { window.__dshToast('已解绑'); await refresh(); if (window.__dshReloadTabs) window.__dshReloadTabs(); }
        });
        foot.appendChild(clr);
      }
      const cancel = el('button', 'modal-btn', '关闭');
      cancel.type = 'button';
      cancel.addEventListener('click', function () { window.__dshCloseModal(); });
      foot.appendChild(cancel);

      window.__dshOpenModal({ title: '会话绑定 · ' + (card.name || card.id), body: wrap, foot: foot });
    }

    async function openFolder(card) {
      const wrap = el('div');
      const row = el('div', 'form-row');
      row.appendChild(el('div', 'form-label', '项目文件夹'));
      const val = el('div', 'form-input');
      val.style.fontFamily = 'var(--mono)';
      val.style.fontSize = '11.5px';
      val.style.color = card.projectDir ? 'var(--text)' : 'var(--text-dim)';
      val.style.userSelect = 'text';
      val.textContent = card.projectDir || '（未设置）';
      row.appendChild(val);
      row.appendChild(el('div', 'form-hint', '这个文件夹是场景的「归属目录」，将来 file / view 面板默认就看它。'));
      wrap.appendChild(row);

      const foot = document.createDocumentFragment();
      const pick = el('button', 'modal-btn primary', '选择文件夹…');
      pick.type = 'button';
      pick.addEventListener('click', async function () {
        const dir = await window.kun.dialog.pickFolder(card.projectDir || '');
        if (!dir) return;
        const r = await window.kun.scenarios.patch(card.id, { projectDir: dir });
        window.__dshCloseModal();
        if (r && r.ok) { window.__dshToast('项目文件夹已设为：' + dir); await refresh(); }
        else window.__dshToast('保存失败：' + ((r && r.err) || '未知错误'));
      });
      foot.appendChild(pick);

      if (card.projectDir) {
        const clr = el('button', 'modal-btn danger', '清除');
        clr.type = 'button';
        clr.addEventListener('click', async function () {
          const r = await window.kun.scenarios.patch(card.id, { projectDir: null });
          window.__dshCloseModal();
          if (r && r.ok) { window.__dshToast('已清除'); await refresh(); }
        });
        foot.appendChild(clr);
      }

      const cancel = el('button', 'modal-btn', '关闭');
      cancel.type = 'button';
      cancel.addEventListener('click', function () { window.__dshCloseModal(); });
      foot.appendChild(cancel);

      window.__dshOpenModal({ title: '项目文件夹 · ' + (card.name || card.id), body: wrap, foot: foot });
    }

    async function openIcon(card) {
      const wrap = el('div');
      const row = el('div', 'form-row');
      row.appendChild(el('div', 'form-label', '当前图标'));
      const box = el('div');
      box.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,.02)';
      box.appendChild(makeIconNode(card.icon, '🧱'));
      const cur = el('span', '', card.icon || '（未设置，使用默认 🧱）');
      cur.style.cssText = 'font-family:var(--mono);font-size:11px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis';
      box.appendChild(cur);
      row.appendChild(box);
      row.appendChild(el('div', 'form-hint', '选一张图（png / ico / jpg / webp / svg）。不在 assets 目录里的会自动复制进来。'));
      wrap.appendChild(row);

      const foot = document.createDocumentFragment();
      const pick = el('button', 'modal-btn primary', '选择图片…');
      pick.type = 'button';
      pick.addEventListener('click', async function () {
        const rel = await window.kun.dialog.pickIcon();
        if (!rel) return;
        const r = await window.kun.scenarios.patch(card.id, { icon: rel });
        window.__dshCloseModal();
        if (r && r.ok) {
          window.__dshToast('图标已更新');
          await refresh();
          // 标签栏上的图标也要跟着变
          if (typeof window.__dshReloadTabs === 'function') window.__dshReloadTabs();
        } else window.__dshToast('保存失败：' + ((r && r.err) || '未知错误'));
      });
      foot.appendChild(pick);

      const clr = el('button', 'modal-btn danger', '恢复默认');
      clr.type = 'button';
      clr.addEventListener('click', async function () {
        const r = await window.kun.scenarios.patch(card.id, { icon: null });
        window.__dshCloseModal();
        if (r && r.ok) { window.__dshToast('已恢复默认图标'); await refresh(); if (window.__dshReloadTabs) window.__dshReloadTabs(); }
      });
      foot.appendChild(clr);

      const cancel = el('button', 'modal-btn', '关闭');
      cancel.type = 'button';
      cancel.addEventListener('click', function () { window.__dshCloseModal(); });
      foot.appendChild(cancel);

      window.__dshOpenModal({ title: '更换场景图标 · ' + (card.name || card.id), body: wrap, foot: foot });
    }

    // ---- 新建场景（融合 dsh-worktable【添加项目】的布局模块 + 原需手改 json 的配置）----
    // 一个场景 = scenarios\<id>.json。以前面板/cols/会话绑定/项目文件夹都得手改文件，
    // 现在全在这个弹窗里选完 → 主进程按 LAYOUT_PRESETS 生成 panels 写盘。
    const PRESET_DEFS = [
      { id: '2h', label: '两栏' },
      { id: '3h', label: '三栏' },
      { id: 'l2', label: '左上下+聊' },
      { id: 'grid', label: '井字' },
      { id: 't3', label: '左一上下+聊' },
      { id: 'l13', label: '左一+下三' },
      { id: 'g4', label: '左2×2+聊' },
      { id: 'l23', label: '左2+3+聊' }
    ];

    // 缩略图：用 span 拼 54×36 的小格子（照搬 dsh-worktable presetThumb 的布局映射）
    function presetThumb(id) {
      const box = el('span', 'thumb');
      const row = function () { const r = el('span', 'thumb-row'); box.appendChild(r); return r; };
      const cols = function (parent) { const c = el('span', 'thumb-row thumb-cols'); parent.appendChild(c); return c; };
      const col = function (parent) { const c = el('span', 'thumb-col'); parent.appendChild(c); return c; };
      const cell = function (parent, chat) { parent.appendChild(el('span', 'thumb-cell' + (chat ? ' thumb-chat' : ''), '')); };

      if (id === '2h') { const r = row(); cell(r); cell(r, true); }
      else if (id === '3h') { const r = row(); cell(r); cell(r); cell(r, true); }
      else if (id === 'grid') {
        const r1 = row(); cell(r1); cell(r1);
        const r2 = row(); cell(r2); cell(r2, true);
      } else if (id === 'l2') {
        const c = cols(box);
        const L = col(c); cell(L); cell(L);
        const Rt = col(c); cell(Rt, true);
      } else if (id === 'g4') {
        const c = cols(box);
        const L = col(c);
        const l1 = el('span', 'thumb-row'); L.appendChild(l1); cell(l1); cell(l1);
        const l2 = el('span', 'thumb-row'); L.appendChild(l2); cell(l2); cell(l2);
        const Rt = col(c); cell(Rt, true);
      } else if (id === 'l13') {
        const c = cols(box);
        const L = col(c); cell(L); const l2 = el('span', 'thumb-row'); L.appendChild(l2); cell(l2); cell(l2); cell(l2);
        const Rt = col(c); cell(Rt, true);
      } else if (id === 'l23') {
        const c = cols(box);
        const L = col(c);
        const l1 = el('span', 'thumb-row'); L.appendChild(l1); cell(l1); cell(l1);
        const l2 = el('span', 'thumb-row'); L.appendChild(l2); cell(l2); cell(l2); cell(l2);
        const Rt = col(c); cell(Rt, true);
      } else { // t3
        const c = cols(box);
        const L = col(c); cell(L); const l2 = el('span', 'thumb-row'); L.appendChild(l2); cell(l2); cell(l2);
        const Rt = col(c); cell(Rt, true);
      }
      return box;
    }

    // ---- 换布局（派单 49cf727f55）：保留面板与配置，只重排网格 ----
    // 复用 PRESET_DEFS / presetThumb（与本函数同处 renderConsole 作用域，⛔ 不复制第二份）。
    async function openLayout(card) {
      if (typeof window.__dshOpenModal !== 'function') return;

      // 先把当前场景读出来：要知道有几个面板、有哪些类型、当前是不是某种预设
      let sc = null;
      try { sc = await window.kun.scenarios.get(String(card.id || '')); }
      catch (e) { sc = null; }
      if (!sc || !Array.isArray(sc.panels)) {
        window.__dshToast && window.__dshToast('这个场景读不出来，换不了布局');
        return;
      }

      const panels = sc.panels.filter(function (x) { return x && x.id; });
      const harnessCount = panels.filter(function (x) { return x.type === 'harness'; }).length;
      const contentCount = panels.length - harnessCount;

      // 当前是哪种预设：优先读 json 里的 layoutPreset；没有就按列数大致提示
      const curPreset = String(sc.layoutPreset || '');
      const curLabel = curPreset
        ? ((PRESET_DEFS.filter(function (d) { return d.id === curPreset; })[0] || {}).label || curPreset)
        : ('未记录（约 ' + (Number(sc.cols) || 0) + ' 列）');

      const wrap = el('div');

      // 现状说明：让用户看清楚"换布局不会丢东西"
      const info = el('div', 'form-hint');
      info.style.cssText = 'margin-bottom:10px;line-height:1.8';
      info.textContent = '当前布局：' + curLabel
        + '　·　这个场景有 ' + panels.length + ' 块面板（内容 ' + contentCount
        + (harnessCount ? (' + AI 会话 ' + harnessCount) : '') + '）';
      wrap.appendChild(info);

      const keepNote = el('div', 'form-hint');
      keepNote.style.cssText = 'margin-bottom:12px;line-height:1.8;color:var(--ok)';
      keepNote.textContent = '✓ 换布局只重排格子位置与大小：面板类型、标题、以及它们的配置（网址 / 目录 / 文件…）全部保留。'
        + (harnessCount > 1 ? '\n⚠ 有 ' + harnessCount + ' 个 AI 会话面板，只有第一个会落在会话格，其余按普通内容面板排。' : '');
      wrap.appendChild(keepNote);

      // 布局选择
      wrap.appendChild(el('div', 'scene-menu-label', '选择新布局'));
      const presetBox = el('div', 'presets');
      let preset = curPreset || '2h';
      const presetBtns = [];
      for (const d of PRESET_DEFS) {
        const b = el('button', 'preset');
        b.type = 'button';
        b.setAttribute('data-on', d.id === preset ? 'true' : 'false');
        b.appendChild(presetThumb(d.id));
        b.appendChild(el('span', 'preset-add-text', d.label));
        b.addEventListener('click', function () {
          preset = d.id;
          presetBtns.forEach(function (x) { x.setAttribute('data-on', x === b ? 'true' : 'false'); });
          syncHint();
        });
        presetBtns.push(b);
        presetBox.appendChild(b);
      }
      wrap.appendChild(presetBox);

      // 选完给一句"会发生什么"，避免盲点
      const hint = el('div', 'form-hint');
      hint.style.cssText = 'margin-top:10px;line-height:1.7';
      wrap.appendChild(hint);

      function contentCellsOf(id) {
        // ⚠ 与 main.js 的 panelsOfPreset() 同步！这是**两份各自维护的真相**：
        //   主进程那份负责真的生成格子，这份只用于弹窗里的"会自动补几行/多几格"提示。
        //   ⛔ 改了 main.js 的预设格数（或加新预设），**必须回来改这里的 M**，
        //      否则弹窗会说错话（比如实际 4 格却说 5 格）。
        //   彻底解决要由主进程暴露 presetCells 共用一个来源 —— 还没做，见回执"还差什么"。
        // 当前对应：2h 1格 / 3h 2格 / l2 2格 / grid 3格 / t3 3格 / l13 4格 / g4 4格 / l23 5格
        const M = { '2h': 1, '3h': 2, 'l2': 2, 'grid': 3, 't3': 3, 'l13': 4, 'g4': 4, 'l23': 5 };
        return M[id] || 1;
      }
      function syncHint() {
        if (!preset) { hint.textContent = ''; return; }
        const cells = contentCellsOf(preset);
        const label = (PRESET_DEFS.filter(function (d) { return d.id === preset; })[0] || {}).label || preset;
        let t = '「' + label + '」有 ' + cells + ' 个内容格';
        if (contentCount > cells) {
          t += '，你有 ' + contentCount + ' 块内容面板 ⇒ 会**自动往下补 ' + (contentCount - cells) + ' 行**，一块都不丢';
        } else if (contentCount < cells) {
          t += '，你有 ' + contentCount + ' 块内容面板 ⇒ 多出的 ' + (cells - contentCount) + ' 格会是空占位（可以之后再挑类型）';
        } else {
          t += '，正好和你现在的 ' + contentCount + ' 块内容面板对上';
        }
        hint.textContent = t;
      }
      syncHint();

      const err = el('div', 'form-hint');
      err.style.cssText = 'margin-top:8px;color:var(--err)';
      wrap.appendChild(err);

      const foot = el('div');
      foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const cancel = el('button', 'modal-btn', '取消');
      cancel.type = 'button';
      cancel.addEventListener('click', function () { window.__dshCloseModal(); });
      const ok = el('button', 'modal-btn', '应用新布局');
      ok.type = 'button';
      ok.style.cssText = 'border-color:var(--accent);color:var(--accent)';
      ok.addEventListener('click', async function () {
        if (!preset) { err.textContent = '先选一种布局'; return; }
        ok.disabled = true;
        ok.textContent = '重排中…';
        let res = null;
        try { res = await window.kun.scenarios.relayout(String(card.id || ''), preset); }
        catch (e) { res = { ok: false, err: (e && e.message) || String(e) }; }
        if (res && res.ok) {
          window.__dshCloseModal();
          window.__dshToast && window.__dshToast('布局已换成「' + preset + '」· ' + res.panelCount + ' 块面板 · ' + res.cols + ' 列');
        } else {
          ok.disabled = false;
          ok.textContent = '应用新布局';
          err.textContent = (res && res.err) || '换布局失败';
        }
      });
      foot.appendChild(cancel);
      foot.appendChild(ok);

      window.__dshOpenModal({ title: '更换布局 · ' + (card.name || card.id), body: wrap, foot: foot });
    }

    async function openCreateScene() {
      if (typeof window.__dshOpenModal !== 'function') return;
      const wrap = el('div');

      // ---- ① 布局（融合自【添加项目】）----
      wrap.appendChild(el('div', 'scene-menu-label', '选择布局模式'));
      const presetBox = el('div', 'presets');
      let preset = '2h';
      const presetBtns = [];
      for (const d of PRESET_DEFS) {
        const b = el('button', 'preset');
        b.type = 'button';
        b.setAttribute('data-on', d.id === preset ? 'true' : 'false');
        b.appendChild(presetThumb(d.id));
        b.appendChild(el('span', 'preset-add-text', d.label));
        b.addEventListener('click', function () {
          preset = d.id;
          presetBtns.forEach(function (x) { x.setAttribute('data-on', x === b ? 'true' : 'false'); });
          sync();
        });
        presetBtns.push(b);
        presetBox.appendChild(b);
      }
      wrap.appendChild(presetBox);

      // ---- ② 基本配置（以前要手改 json 的都在这里）----
      const r1 = el('div', 'form-row');
      r1.appendChild(el('div', 'form-label', '场景 id（英文小写、数字、短横）'));
      const idIn = document.createElement('input');
      idIn.className = 'form-input';
      idIn.placeholder = 'my-scene';
      idIn.spellcheck = false;
      r1.appendChild(idIn);
      r1.appendChild(el('div', 'form-hint', '同时是文件名：scenarios\\my-scene.json。建好不能改名。'));
      wrap.appendChild(r1);

      const r2 = el('div', 'form-row');
      r2.appendChild(el('div', 'form-label', '标签文字'));
      const nameIn = document.createElement('input');
      nameIn.className = 'form-input';
      nameIn.placeholder = '我的场景';
      r2.appendChild(nameIn);
      wrap.appendChild(r2);

      const r3 = el('div', 'form-row');
      r3.appendChild(el('div', 'form-label', '图标（emoji 或图片名，可留空）'));
      const iconIn = document.createElement('input');
      iconIn.className = 'form-input';
      iconIn.placeholder = '🧪  或  assets/favicon.png';
      r3.appendChild(iconIn);
      wrap.appendChild(r3);

      // ---- ③ 项目文件夹（原【应用抽屉】的入口，现在建场景时就能设）----
      let projectDir = '';
      const r4 = el('div', 'form-row');
      r4.appendChild(el('div', 'form-label', '项目文件夹'));
      const folderRow = el('div', 'folder-row');
      const folderPath = el('span', 'folder-path none', '（未设置）');
      const pickBtn = el('button', 'folder-btn', '选择位置…');
      pickBtn.type = 'button';
      const manualBtn = el('button', 'folder-btn', '手动输入');
      manualBtn.type = 'button';
      folderRow.appendChild(folderPath);
      folderRow.appendChild(pickBtn);
      folderRow.appendChild(manualBtn);
      r4.appendChild(folderRow);

      const manualRow = el('div', 'folder-row');
      manualRow.style.display = 'none';
      const manualIn = document.createElement('input');
      manualIn.className = 'form-input';
      manualIn.placeholder = 'D:\\path\\to\\project';
      manualIn.style.flex = '1';
      const manualOk = el('button', 'folder-btn', '确定');
      manualOk.type = 'button';
      manualRow.appendChild(manualIn);
      manualRow.appendChild(manualOk);
      r4.appendChild(manualRow);
      wrap.appendChild(r4);

      function setFolder(dir) {
        projectDir = dir || '';
        folderPath.textContent = projectDir || '（未设置）';
        folderPath.classList.toggle('none', !projectDir);
      }
      pickBtn.addEventListener('click', async function () {
        pickBtn.disabled = true;
        const dir = await window.kun.dialog.pickFolder(projectDir);
        pickBtn.disabled = false;
        if (dir) setFolder(dir);
      });
      manualBtn.addEventListener('click', function () {
        const show = manualRow.style.display === 'none';
        manualRow.style.display = show ? 'flex' : 'none';
        if (show) { manualIn.value = projectDir; manualIn.focus(); }
      });
      manualOk.addEventListener('click', function () {
        setFolder(manualIn.value.trim());
        manualRow.style.display = 'none';
      });
      manualIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); setFolder(manualIn.value.trim()); manualRow.style.display = 'none'; }
      });

      // ---- ④ 会话绑定（同上，建场景时就能绑）----
      let sessions = [];
      try { sessions = ((await window.kun.console.model()) || {}).sessions || []; } catch (e) { sessions = []; }
      let sessionId = '';
      let sessionTitle = '';
      const r5 = el('div', 'form-row');
      r5.appendChild(el('div', 'form-label', '绑定会话（可留空，之后再绑）'));
      const sel = document.createElement('select');
      sel.className = 'form-select';
      const opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = '（不绑定）';
      sel.appendChild(opt0);
      for (const s of sessions) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = (s.title || '(未命名会话)') + ' · ' + s.id.slice(0, 18);
        o.dataset.title = s.title || '';
        sel.appendChild(o);
      }
      sel.addEventListener('change', function () {
        const o = sel.options[sel.selectedIndex];
        sessionId = sel.value || '';
        sessionTitle = sessionId ? (o && o.dataset.title) || '' : '';
      });
      r5.appendChild(sel);
      r5.appendChild(el('div', 'form-hint', '选一条会话，右侧「AI 对话」窗口就会钉到它上面；建好后也可以点卡片右上角再改。'));
      wrap.appendChild(r5);

      // ---- ⑤ 有没有对话窗口 ----
      let withChat = true;
      const r6 = el('div', 'form-row');
      const chkWrap = el('label', '');
      chkWrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = true;
      chkWrap.appendChild(chk);
      chkWrap.appendChild(document.createTextNode('再加一个「AI 对话」窗口（落在布局图里那个蓝色格）'));
      r6.appendChild(chkWrap);
      wrap.appendChild(r6);

      const err = el('div', 'form-hint');
      err.style.color = 'var(--err)';
      wrap.appendChild(err);

      function sync() {
        // 两栏/井字这类不带聊天的预设，勾选框自动互斥提示没意义，这里只更新说明文字
        withChat = chk.checked;
      }
      chk.addEventListener('change', sync);
      sync();

      const foot = document.createDocumentFragment();
      const ok = el('button', 'modal-btn primary', '创建');
      ok.type = 'button';
      ok.addEventListener('click', async function () {
        const id = idIn.value.trim();
        const name = nameIn.value.trim() || id;
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { err.textContent = 'id 只能用英文小写字母、数字、短横，且以字母/数字开头'; return; }
        ok.disabled = true;
        const r = await window.kun.scenarios.create({
          id: id,
          name: name,
          icon: iconIn.value.trim(),
          preset: preset,
          chat: chk.checked,
          projectDir: projectDir,
          sessionId: sessionId,
          sessionTitle: sessionTitle,
          pinTarget: sessionTitle ? [sessionTitle] : []
        });
        ok.disabled = false;
        if (!r || !r.ok) { err.textContent = '创建失败：' + ((r && r.err) || '未知错误'); return; }
        window.__dshCloseModal();
        window.__dshToast('已创建场景「' + name + '」');
        await refresh();
        if (typeof window.__dshReloadTabs === 'function') window.__dshReloadTabs();
      });
      foot.appendChild(ok);
      const cancel = el('button', 'modal-btn', '取消');
      cancel.type = 'button';
      cancel.addEventListener('click', function () { window.__dshCloseModal(); });
      foot.appendChild(cancel);

      window.__dshOpenModal({ title: '新建场景', body: wrap, foot: foot });
      setTimeout(function () { try { idIn.focus(); } catch (e) { /* ignore */ } }, 30);
    }

    // ---- 起转：先画一帧骨架，再拉数据；之后每 3 秒刷新（读的是本地投影文件，零 Token）----
    paintGrid();
    refresh();
    timer = setInterval(refresh, 3000);

    // 主题跟随系统时，系统切换深浅色要跟着变
    let mq = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', function () { if (settings.theme === 'system') applyTheme(); });
    } catch (e) { mq = null; }

    // cleanup：切场景时被调用（定时器不清会一直跑）
    return function cleanup() {
      disposed = true;
      try { setPanelBeam(hostPanel(), false); } catch (e) { /* ignore */ }
      if (timer) { clearInterval(timer); timer = null; }
      try { if (mq) mq.removeEventListener('change', applyTheme); } catch (e) { /* ignore */ }
      closeDrop();
    };
  }

  // ==================== AI 对话（harness）渲染器 ====================
  // 场景里的「AI 对话」窗口：内嵌一个引擎界面（<webview>），用注入脚本把会话钉到绑定那条。
  // 依据文档《会话定位与跟随》：三字段 sessionId / sessionTitle / pinTarget，
  //   sessionId 验明正身（写进本面板自己分区的 localStorage「当前会话」键），
  //   sessionTitle / pinTarget 用来在侧栏找到那一行点下去（兜底）。
  // ⚠ 一板一分区：partition = persist:ai-panel-<面板id>。共用 defaultSession 会让多面板抢同一键。
  // ⚠ 「已钉住」的判据只能看本面板画面（侧栏高亮行标题 + 有对话流），不能拿"我写进去的值"当证据。

  // 面板里的引擎界面：藏掉侧栏/详情栏/顶栏，聊天流铺满（照搬参照项目的 HARNESS_CHAT_CSS 意图）
  const AI_PANEL_CSS = [
    '[data-side="sidebar"],[data-side="details"],[data-width-handle]{display:none !important}',
    '[data-phase] > header{display:none !important}',
    '[data-chat-flow]{max-width:calc(100% - 16px) !important;margin:0 auto !important}'
  ].join('\n');

  // 注入到 webview 里的钉住逻辑（自包含，不闭包外变量；返回值给宿主当判据）
  //   'pinned' 当前高亮行就是绑定那条 / 'click' 已点下去 / 'norow' 没找到 / 'idle' 什么都没做
  function pinBody(A) {
    try {
      var norm = function (x) { return String(x || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
      var SEL_KEY = 'dsh.sessions.current';
      var diag = window.__pinDiag || (window.__pinDiag = {});
      diag.panel = A.panel;
      diag.sessionTitle = A.sessionTitle;
      diag.sessionId = A.sessionId;
      diag.targets = A.targets;

      // ★★ 输入中直接返回，绝不碰 localStorage ★★（2026-11-24 真根因）
      // 为什么：这个脚本每 5 秒由外壳 executeJavaScript 跑一次，里面会访问
      //   localStorage（getItem/setItem）。**在 Chromium 里访问 localStorage 会打断
      //   输入法的 composition 状态** ⇒ 组字被打断、候选词消失、退回英文直通。
      // 实测：最小 Electron 程序加载同一个引擎页、不注入 ⇒ IME 完全正常（能拿到「你好」）；
      //   一旦每 5 秒注入一次 ⇒ 候选词立刻消失。
      // 判据（在 guest 内部判断，比在外壳里猜准得多）：
      //   ① 焦点在可编辑元素上  ② 正在 composition  ③ 最近 1.5 秒内有过输入
      // 跳过的代价只是"钉会话"晚几秒，比打不了中文轻得多。
      try {
        var now = Date.now();
        var ae = document.activeElement;
        var editable = !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
        // ⚠ editable 不再作为跳过条件（2026-11-24 修）：
        //   引擎对话输入框是 contenteditable，焦点只要落进去就一直留在那儿
        //   ⇒ 原来 editable 一命中就每轮 skip ⇒ **面板永远判不出"已钉住"**，
        //     标题行永远显示「侧栏里没找到 XXX」（实测 __pinDiag.state = skip-typing / editable）。
        //   「焦点在输入框」≠「正在输入」；真正会打断 IME 的是 composition 期间和刚打完的那一下。
        //   ⇒ 只认 composing / recent；焦点在可编辑元素时把 recent 窗口放宽到 3 秒（更保守但不会永久跳过）。
        var win = editable ? 3000 : 1500;
        var recent = (window.__lastInputAt && now - window.__lastInputAt < win);
        if (window.__composing || recent) {
          diag.state = 'skip-typing';
          diag.skipReason = (window.__composing ? 'composing' : '') + (recent ? ' recent' : '') + (editable ? ' (editable)' : '');
          return 'skip-typing';
        }
      } catch (e) { /* ignore */ }

      // 首次运行时装一个"用户是否在输入"的探针（只装一次，成本极低）
      if (!window.__inputProbe) {
        window.__inputProbe = true;
        window.__composing = false;
        window.__lastInputAt = 0;
        var mark = function () { window.__lastInputAt = Date.now(); };
        document.addEventListener('compositionstart', function () { window.__composing = true; mark(); }, true);
        document.addEventListener('compositionend', function () { window.__composing = false; mark(); }, true);
        document.addEventListener('beforeinput', mark, true);
        document.addEventListener('input', mark, true);
        document.addEventListener('keydown', mark, true);
      }

      // ⚠ 没绑定时必须把这个分区里残留的「当前会话」键清掉。
      // 每个面板一个分区，绑过一次之后那个键会一直留在分区里；解绑后不清，
      // 面板就会自动回到上一条绑过的会话 —— 看起来像"串台到当前会话"，其实是被遗忘的旧键。
      var hasBind = !!(A.sessionId || A.sessionTitle || (A.targets && A.targets.length));
      if (!hasBind) {
        try {
          if (localStorage.getItem(SEL_KEY) !== null) {
            localStorage.removeItem(SEL_KEY);
            diag.clearedSel = true;
          }
        } catch (e) { /* ignore */ }
        diag.state = 'idle';
        return 'idle';
      }

      var rowsOf = function () {
        return Array.prototype.slice.call(document.querySelectorAll('[role="treeitem"][aria-selected]'));
      };
      var isGroupHead = function (e) { return e.hasAttribute('aria-expanded'); };
      var rowTitle = function (r) {
        var n = r.querySelector('[class*="title"]');
        var t = n ? n.textContent : r.textContent;
        return String(t || '').replace(/\s*[—–\-]\s*DSH.*$/, '').trim();
      };
      // ⚠ 本面板把侧栏藏了（AI_PANEL_CSS 里 [data-side="sidebar"] display:none），
      // 所以「侧栏高亮行」基本不存在；而裸写 [aria-selected="true"] 会捞出别的东西
      // （实测捞到过文本「对话」），于是每轮都判成「没对上」⇒ 显示「侧栏里没找到」，
      // 可画面其实早就切对了。判据按可信度重排：
      //   ① 面包屑当前段（侧栏隐藏后，画面上唯一写着「当前是哪条会话」的地方）
      //   ② 侧栏高亮行（侧栏可见时最准，但必须限定 role=treeitem）
      //   ③ 对话区顶栏（[data-phase] > header，被 CSS 藏了但 DOM 还在）
      //   ④ document.title
      var crumbTitle = function () {
        var n = document.querySelector('[class*="crumbCurrent"]');
        return n ? String(n.textContent || '').trim() : '';
      };
      var headTitle = function () {
        var h = document.querySelector('[data-phase] > header');
        if (!h) return '';
        var txt = String(h.textContent || '').replace(/\s+/g, ' ').trim();
        // 顶栏第一个文本常是页签名「对话」，那种不算标题
        return /^(对话|chat|新视图|new view)$/i.test(txt) ? '' : txt;
      };
      var currentTitle = function () {
        var b = crumbTitle();
        if (b) return b;
        var sel = document.querySelector('[role="treeitem"][aria-selected="true"]');
        var a = sel ? rowTitle(sel) : '';
        if (a) return a;
        var c = headTitle();
        if (c) return c;
        return String(document.title || '').replace(/\s*[—–\-]\s*DSH.*$/, '').trim();
      };

      // ① 写键直达（sessionId 写进本分区自己的「当前会话」键）
      if (A.sessionId) {
        try {
          var raw = localStorage.getItem(SEL_KEY);
          var cur = raw ? JSON.parse(raw) : null;
          if (!cur || typeof cur !== 'object') cur = {};
          if (cur.sessionId !== A.sessionId) {
            cur.sessionId = A.sessionId;
            localStorage.setItem(SEL_KEY, JSON.stringify(cur));
            diag.wroteSel = true;
          }
        } catch (e) { /* 引擎没这个键就跳过，靠下面点行 */ }
      }

      // ② 已经对了吗（只看画面：侧栏高亮行的标题）
      var want = [];
      if (A.sessionTitle) want.push(A.sessionTitle);
      (A.targets || []).forEach(function (t) { if (t && want.indexOf(t) < 0) want.push(t); });
      if (!want.length) { diag.state = 'idle'; return 'idle'; }

      var cur2 = norm(currentTitle());
      diag.current = cur2;
      for (var i = 0; i < want.length; i++) {
        if (cur2 && norm(want[i]) === cur2) { diag.state = 'pinned'; return 'pinned'; }
      }

      // ②' 写键之后引擎不会自己切（SPA 只在启动时读一次这个键）⇒ 主动 reload 一次。
      // 用 sessionStorage 记次防死循环：同一个分区里来回 reload 超过 3 次就放弃，改走点行。
      if (diag.wroteSel) {
        var RK = 'xiodra.pin.reloads';
        var n = 0;
        try { n = Number(sessionStorage.getItem(RK) || 0) || 0; } catch (e) { n = 0; }
        if (n < 3) {
          try { sessionStorage.setItem(RK, String(n + 1)); } catch (e) { /* ignore */ }
          diag.reloads = n + 1;
          diag.state = 'reload';
          return 'reload';
        }
        diag.reloads = n;
      }

      // ③ 兜底：在侧栏找那一行点下去（永不点分组头）
      var rows = rowsOf();
      diag.rows = rows.length;
      var best = null;
      var bestRank = 99;
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        if (isGroupHead(r)) continue;
        var t = norm(rowTitle(r));
        if (!t || t.length > 160) continue;
        for (var k = 0; k < want.length; k++) {
          var w = norm(want[k]);
          if (!w) continue;
          var rank = (t === w) ? 0 : (t.indexOf(w) >= 0 ? 1 : 99);
          if (rank < bestRank) { bestRank = rank; best = r; }
        }
      }
      if (!best) { diag.state = 'norow'; return 'norow'; }
      diag.state = 'click';
      var tgt = best.querySelector('button,[role="button"],a') || best;
      tgt.click();
      return 'click';
    } catch (e) {
      return 'err';
    }
  }

  function renderHarness(body, meta, head) {
    const panelId = String(meta.id || 'ai-panel');
    const key = panelId.replace(/[^A-Za-z0-9_-]/g, '') || 'panel';
    const partition = 'persist:ai-panel-' + key;
    // 绑定签名变了（改了会话）⇒ 换一代，注入脚本重新接管旧记忆自动失效
    const PIN_SIG = String(meta.sessionId || meta.sessionTitle || (meta.pinTarget || []).join('|') || 'none');
    const GEN = 'pin_v3:' + panelId + ':' + PIN_SIG;

    // 状态小字走统一的 setHeadSub（功能区左侧）。顺序照参照项目 harness：
    // 按钮在左、状态字在右 —— 窄面板下长状态文字不会把按钮挤到换行（小字自己用省略号）。
    const subEl = setHeadSub(head, '');
    const note = function (t) { if (subEl) subEl.textContent = t || ''; };

    // ★ 输入法提示（2026-11-24，方案 C）★
    // 结论（20 个对照实验确认）：Electron 的 <webview> 基于 OOPIF（进程外 iframe），
    //   IME 跨进程边界时不完整。实测矩阵：
    //     记事本                        ✅ 中文
    //     Electron 主 frame + textarea   ✅ 中文
    //     Electron 主 frame + Lexical    ✅ 中文
    //     <webview> + 普通 contenteditable ✅ 中文
    //     <webview> + Lexical（引擎页）   ❌ 只出英文
    //     WebContentsView + Lexical      ✅ 中文（但要重构，且原生 View 会盖住 DOM）
    //   ⇒ Xiodra 2026-11-24 决定走方案 C：保留 webview，加提示条。
    //   有效的绕法（Xiodra 实测）：点面板空白处 → 敲一下键盘 → 再点输入框。
    //   提示只显示一次（localStorage 记住），不反复打扰。
    const wrap = el('div', 'ai-wrap');
    const IME_HINT_KEY = 'xiodra.ime-hint-dismissed';
    try {
      if (localStorage.getItem(IME_HINT_KEY) !== '1') {
        const hint = el('div', 'ai-ime-hint');
        hint.innerHTML = '<b>中文输入提示</b>：面板里直接打字可能只出英文字母。'
          + '<br>办法：先点一下面板空白处 → 随便敲一个键 → 再点输入框。'
          + '<button type="button" class="ai-ime-hint-x">知道了</button>';
        const x = hint.querySelector('.ai-ime-hint-x');
        if (x) {
          x.addEventListener('click', function () {
            try { localStorage.setItem(IME_HINT_KEY, '1'); } catch (e) { /* ignore */ }
            hint.remove();
          });
        }
        wrap.appendChild(hint);
      }
    } catch (e) { /* ignore */ }

    const tip = el('div', 'ai-tip', '正在准备会话…');
    wrap.appendChild(tip);
    body.appendChild(wrap);

    // ★引擎侧边栏档位★（2026-11-24 方案 A+D）
    //   'hide' = 隐藏（默认，用户要求）｜'auto' = 引擎按宽度自适应，外壳不干预
    //   存在 webview 的 dataset 上，theme.js 的 tintGuest 据此注入/摘除 CSS。
    let sidebarMode = String(meta.engineSidebar || 'hide');
    if (sidebarMode !== 'auto') sidebarMode = 'hide';

    // 「隐藏侧栏」的完整动作 = ①隐藏侧栏元素 ②把引擎 grid 第一列压成 0。
    //   ⚠ 只做 ① 会留 56px 纯空白（引擎 grid-template-columns: 56px … 的占位），
    //     这是实测出来的，别退回去只写 display:none。
    const SIDEBAR_APPLY_JS = [
      "(function(){",
      "var id='xiodra-hide-sidebar';",
      "if(!document.getElementById(id)){",
      "var st=document.createElement('style');st.id=id;",
      "st.textContent='[class*=\"sidebarCol\"]{display:none !important}';",
      "(document.head||document.documentElement).appendChild(st);}",
      "var nodes=document.querySelectorAll('div');",
      "for(var i=0;i<nodes.length;i++){",
      "var n=nodes[i],cs=getComputedStyle(n);",
      "if(cs.display!=='grid')continue;",
      "var cols=String(cs.gridTemplateColumns||'').trim().split(/\\s+/);",
      "if(cols.length!==3)continue;",
      "if(parseFloat(cols[0])===0)continue;",   // 已经压好，别重排
      "n.style.setProperty('grid-template-columns','0px minmax(0,1fr) 0px','important');",
      "break;}",
      "return 'ok';})()"
    ].join('');

    // 切回 auto：摘掉 style + 撤销 grid 上的内联覆盖，交还给引擎自适应
    const SIDEBAR_RESTORE_JS = [
      "(function(){",
      "var n=document.getElementById('xiodra-hide-sidebar');if(n)n.remove();",
      "var nodes=document.querySelectorAll('div');",
      "for(var i=0;i<nodes.length;i++){",
      "var g=nodes[i],cs=getComputedStyle(g);",
      "if(cs.display!=='grid')continue;",
      "var cols=String(cs.gridTemplateColumns||'').trim().split(/\\s+/);",
      "if(cols.length!==3)continue;",
      "g.style.removeProperty('grid-template-columns');",
      "break;}",
      "return 'ok';})()"
    ].join('');

    let view = null;
    let tickTimer = null;
    let disposed = false;
    let shotTimer = null;      // 首帧后的一次性截图
    let shotTimer2 = null;     // 之后的低频截图
    let visTimer = null;       // 可见性轮询（输入法焦点：由不可见变可见时把焦点交给 guest）
    let wasVisible = false;    // 上一轮的可见状态（只在「由不可见变可见」那一刻聚焦）
    let focusTries = 0;        // 可见后已尝试聚焦的次数（guest attach 完之前会失败，要重试）
    let guestHasFocus = false; // guest 自己拿到过焦点（避免轮询反复抢）

    note(meta.sessionTitle ? ('绑 ' + meta.sessionTitle) : '未绑定');

    // 「重新加载这个面板」：功能区按钮（以前这个能力只存在于全场景刷新 ⟳，粒度过粗）
    const reBtn = el('button', 'file-btn', '⟳');
    reBtn.type = 'button';
    reBtn.title = '重新加载这个对话面板';
    reBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      try { if (view) view.reload(); } catch (e) { /* ignore */ }
      note('正在重新加载…');
    });
    addAct(head, reBtn);

    // ★引擎侧边栏开关★（2026-11-24 方案 D）
    //   用户要求：AI 会话面板里的引擎**默认收起/隐藏侧边栏**。
    //   默认 'hide'；想让引擎自己按宽度决定时点一下切到 'auto'。
    const sidebarBtn = el('button', 'file-btn', sidebarMode === 'hide' ? '⊟' : '⊞');
    sidebarBtn.type = 'button';
    const syncSidebarBtn = function () {
      sidebarBtn.textContent = sidebarMode === 'hide' ? '⊟' : '⊞';
      sidebarBtn.title = sidebarMode === 'hide'
        ? '引擎侧边栏：已隐藏（点击改为让引擎按宽度自适应）'
        : '引擎侧边栏：引擎自适应（点击改为隐藏）';
    };
    syncSidebarBtn();

    /** 把档位立刻应用到当前 guest（不等下一轮 tintGuest） */
    const applySidebarNow = function () {
      if (!view) return;
      try { view.dataset.engineSidebar = sidebarMode; } catch (e) { /* ignore */ }
      try {
        view.executeJavaScript(sidebarMode === 'hide' ? SIDEBAR_APPLY_JS : SIDEBAR_RESTORE_JS);
      } catch (e) { /* guest 还没就绪，下一轮 tintGuest 会补上 */ }
    };

    sidebarBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      sidebarMode = (sidebarMode === 'hide') ? 'auto' : 'hide';
      syncSidebarBtn();
      applySidebarNow();
      // 存回场景 json（⛔ 存的是档位字符串，不是"当前是否显示"）
      const sceneId = String(meta.scenario || '');
      if (sceneId) {
        Promise.resolve(window.kun.scenarios.patchPanel(sceneId, String(meta.id || ''), { engineSidebar: sidebarMode }))
          .then(function (r) {
            if (!r || !r.ok) note('侧边栏设置没存上：' + ((r && r.err) || '未知'));
            else meta.engineSidebar = sidebarMode;
          })
          .catch(function () { /* ignore */ });
      }
    });
    addAct(head, sidebarBtn);

    // 判据二（《02-会话定位与跟随/三-跟着窗口走》）：把这一格的实况截一张、按面板 id 覆盖保存。
    // 只截自己这一格（不是整页），所以看到的就是「这个面板现在长什么样」。
    // 「写对了 localStorage 的键」不等于「画面切过去了」—— 这条通道专门用来回答后者。
    function captureShot() {
      if (disposed || !view || typeof view.capturePage !== 'function') return;
      let p = null;
      try { p = view.capturePage(); } catch (e) { return; }
      Promise.resolve(p).then(function (img) {
        if (disposed || !img || img.isEmpty()) return;
        let url = '';
        try { url = img.toDataURL(); } catch (e) { return; }
        if (!url || url.length < 200) return;
        try { window.kun.panel.capture(panelId, url).catch(function () { /* 截图失败不影响绑定 */ }); } catch (e) { /* ignore */ }
      }).catch(function () { /* 页面在导航中，忽略 */ });
    }

    // ⚠ renderHarness 的签名里没有 wrap（只有 body/meta/head）
    //   ⇒ 从 body 反查面板元素。⛔ 别再直接引用 wrap（会 ReferenceError 并被 catch 吞掉）。
    const hostPanel = function () {
      try { return body.closest ? body.closest('.panel') : null; } catch (e) { return null; }
    };

    // ★「工作中」状态 → border beam★（2026-11-23 用户要求）
    //   判据只认 console:model 的 status（引擎侧栏真实状态），⛔ 不自己推断。
    //   只在**变化时**才改 class，避免每轮都触发重排。
    let lastWorking = null;
    function syncWorkingBeam() {
      if (disposed) return;
      const sid = String(meta.sessionId || '');
      const stitle = String(meta.sessionTitle || '');
      if (!sid && !stitle) {   // 未绑定 ⇒ 不可能是"工作中"
        if (lastWorking !== false) {
          lastWorking = false;
          setPanelBeam(hostPanel(), false);
        }
        return;
      }
      Promise.resolve(window.kun.console.model()).then(function (m) {
        if (disposed) return;
        const list = (m && m.sessions) || [];
        // 优先按 id 认，退而按标题认（会话改名后 id 仍可靠）
        const hit = list.filter(function (x) {
          return (sid && x.id === sid) || (!sid && stitle && x.title === stitle);
        })[0];
        const on = !!(hit && hit.status === 'busy');
        if (on !== lastWorking) {
          lastWorking = on;
          setPanelBeam(hostPanel(), on);
        }
      }).catch(function (e) {
        // ⚠ 以前这里是完全静默 ⇒ 上面那个 ReferenceError 被吞了很久才发现。
        //   现在留一行警告：引擎没起来是常态（不刷屏），但别的错要能看见。
        if (e && !/not ready|not found|ECONNREFUSED/i.test(String(e.message || e))) {
          console.warn('[beam] 状态同步失败：', e && e.message ? e.message : e);
        }
      });
    }

    function tick() {
      if (disposed || !view) return;
      // 侧栏兜底：引擎自己会重算 grid（实测会冲掉"0px 1fr 0px"）⇒ 每轮补一枪。
      //   幂等（已压好就跳过），且不影响 pinBody 的 IME 保护。
      if (sidebarMode === 'hide') {
        try { view.executeJavaScript(SIDEBAR_APPLY_JS); } catch (e) { /* ignore */ }
      }
      syncWorkingBeam();
      // ⚠ 没绑定时**也要注入**（只是不点行）：注入脚本负责把这个分区里残留的
      // 「当前会话」键清掉。以前这里直接 return，结果解绑后旧键还在，面板会悄悄
      // 回到上一条绑过的会话，看起来像串台。
      const args = {
        gen: GEN,
        panel: panelId,
        sessionTitle: String(meta.sessionTitle || ''),
        sessionId: String(meta.sessionId || ''),
        targets: Array.isArray(meta.pinTarget) ? meta.pinTarget : []
      };
      const js = '(' + pinBody.toString() + ')(' + JSON.stringify(args) + ')';
      let p = null;
      try { p = view.executeJavaScript(js); } catch (e) { return; }   // webview 还没挂上，下一轮再来
      Promise.resolve(p).then(function (r) {
        if (disposed) return;
        if (r === 'pinned') note('已钉住 · ' + (meta.sessionTitle || ''));
        else if (r === 'reload') { note('正在切到这条会话…'); try { view.reload(); } catch (e) { /* ignore */ } }
        else if (r === 'click') note('正在切到这条会话…');
        else if (r === 'norow') note('侧栏里没找到「' + (meta.sessionTitle || '') + '」');
        else if (r === 'idle') note('未绑定会话');
        // 'skip-typing'：用户正在输入，本轮故意跳过 —— 不更新提示（别在打字时闪字）
      }).catch(function () { /* 页面在导航中，忽略 */ });
    }

    // ★ 输入中不注入（2026-11-24 定位到的真根因）★
    // 现象：在面板输入框里打中文，输入法不出候选词，只能出英文字母。
    // 根因：tick() 每 5 秒 executeJavaScript 跑一次 pinBody，里面会访问
    //   localStorage（getItem/setItem）。**在 Chromium 里访问 localStorage 会打断
    //   输入法的 composition 状态** ⇒ 组字被打断，候选词消失，退回英文直通。
    //   实测：用最小 Electron 程序加载同一个引擎页，不注入时 IME 完全正常
    //   （composerText 能拿到「你好」）；一旦每 5 秒注入一次，候选词立刻消失。
    // 判据：用户正在输入（焦点在可编辑元素 / 正在 composition）⇒ 本轮跳过注入。
    //   跳过的代价只是"钉会话"晚几秒生效，比打不了中文轻得多。
    let composing = false;
    let lastComposeAt = 0;
    try {
      view.addEventListener('ipc-message', function (ev) {
        // 引擎页不主动发 IPC，这里只是占位；真正的判断在 guest 内部做（见下）
        if (ev && ev.channel === 'dsh-composing') composing = !!ev.args[0];
      });
    } catch (e) { /* ignore */ }

    function isUserTyping() {
      // ① 壳自己这边：焦点在输入框 / 正在 composition
      try {
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return true;
      } catch (e) { /* ignore */ }
      // ② 最近 2 秒内有过 composition（刚打完字，别立刻打断）
      if (composing || Date.now() - lastComposeAt < 2000) return true;
      return false;
    }

    function tickSafe() {
      if (disposed || !view) return;
      // 焦点在 guest 里、且用户在打字 ⇒ 跳过本轮（下一轮再来）
      if (isUserTyping()) return;
      tick();
    }

    (async function boot() {
      let url = '';
      try { url = await window.kun.panel.prime(partition); } catch (e) { url = ''; }
      if (disposed) return;
      if (!url) {
        tip.textContent = '引擎还没就绪，或这个面板分区的登录态没种成。切到别的场景再回来会重试。';
        note('未就绪');
        return;
      }
      tip.remove();

      view = document.createElement('webview');
      // 侧边栏档位写进 dataset，tintGuest 靠它决定要不要隐藏引擎左侧栏
      try { view.dataset.engineSidebar = sidebarMode; } catch (e) { /* ignore */ }
      view.className = 'ai-webview';
      view.setAttribute('partition', partition);   // 必须在插入 DOM 之前设
      view.setAttribute('allowpopups', '');
      view.setAttribute('src', url);
      wrap.appendChild(view);

      view.addEventListener('dom-ready', function () {
        if (disposed || !view) return;
        try { view.insertCSS(AI_PANEL_CSS); } catch (e) { /* ignore */ }
        tick();
        // guest 真正就绪的时机 —— 这时 webContents 一定 attach 完了，聚焦成功率最高。
        // （切场景时 checkVisible 的早期尝试会落空，靠这里补上）
        if (typeof focusGuest === 'function') focusGuest('dom-ready');
      });
      view.addEventListener('did-navigate-in-page', function () { tick(); });

      // ★输入法焦点（方案 C：点击 + 显示，双保险）★
      // 为什么：Windows 输入法只跟「拥有系统焦点的窗口」走，而 Electron 的 <webview>
      // 不会自动接管焦点 ⇒ 焦点留在壳里时，面板输入框打不出中文（实测会退回英文直通）。
      // 实测：把焦点交给 guest 后 IME 组合链完整、中文正常输入。
      //
      // ① 显示即聚焦：面板从隐藏变可见（切场景 / 展开收起 / 标签切换）时把焦点交过去。
      //    ⚠ 只在「由不可见变可见」的那一刻做，且用户正在壳里的输入框打字时不抢。
      function focusGuest(reason) {
        if (disposed || !view) return;
        try {
          // 用户在壳自己的输入框里打字时别抢焦点（会打断输入）
          const ae = document.activeElement;
          const tag = ae && ae.tagName ? ae.tagName.toUpperCase() : '';
          const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (ae && ae.isContentEditable);
          if (typing) return;
          if (typeof window.kun?.panel?.focus === 'function') {
            window.kun.panel.focus(panelId).catch(function () { /* ignore */ });
          }
        } catch (e) { /* ignore */ }
      }

      // ① 点击 / 键盘进入面板 → 聚焦
      // ⚠ 2026-11-23 踩坑记录（连踩三次，都记在这）：
      //   ① `wrap` 在 renderHarness 里**有定义**（第 1449 行 const wrap），但点击
      //      **webview 内部**时事件进了 guest，不会冒泡到 shell ⇒ 挂 wrap 上的
      //      mousedown 收不到。所以只挂 wrap 不够。
      //   ② renderHarness 签名没有 wrap 参数，从 body 反查要用 hostPanel()。
      //   ⇒ 三条路一起上：webview 自己的 focus 事件 + wrap 上的点击 + 可见性轮询。
      const hostEl = hostPanel() || body;
      if (hostEl && hostEl.addEventListener) {
        hostEl.addEventListener('mousedown', function () { focusGuest('mousedown'); }, true);
      }
      // webview 元素本身拿到焦点时（用户点进去、或 Tab 进来）⇒ 说明焦点已进 guest，
      // 记下来避免轮询反复抢。同时用 guest 的 focus 事件兜底把 IPC 再送一次。
      view.addEventListener('focus', function () { guestHasFocus = true; });
      view.addEventListener('blur', function () { guestHasFocus = false; });

      // ② 可见性变化 → 聚焦（切场景回来、展开收起都会触发）
      // ⚠ 2026-11-23 修（实测踩到）：原来只在「由不可见变可见」那一刻试**一次**。
      //   但切场景时面板是新建的，那一刻 guest 的 webContents 还没 attach 完，
      //   IPC 落空之后 wasVisible 已是 true，就再也不会重试 ⇒ 焦点永远进不去。
      //   ⇒ 可见期间**持续重试**，直到成功或试满次数（有节流，不会刷屏）。
      wasVisible = false;
      focusTries = 0;
      function checkVisible() {
        if (disposed || !view) return;
        let vis = false;
        try {
          const r = (hostPanel() || body).getBoundingClientRect();
          vis = r.width > 40 && r.height > 40 && document.visibilityState === 'visible';
        } catch (e) { vis = false; }
        if (!vis) { wasVisible = false; focusTries = 0; return; }
        // 刚变可见 ⇒ 重置计数，开始尝试
        if (!wasVisible) { wasVisible = true; focusTries = 0; }
        // 试满就停（12 次 × 800ms ≈ 10 秒，足够等 guest attach）
        if (focusTries >= 12) return;
        focusTries++;
        focusGuest('visible#' + focusTries);
      }
      checkVisible();
      visTimer = setInterval(checkVisible, 800);

      tickTimer = setInterval(tickSafe, 5000);   // 常驻轻量重注入（引擎内部重载后仍生效）
      // ⚠ 必须用 tickSafe 而不是 tick：tick 里的 pinBody 会访问 localStorage，
      //   而访问 localStorage 会打断输入法的 composition ⇒ 打不出中文。
      //   tickSafe 在"用户正在输入"时跳过本轮（判据在 guest 内部，见 pinBody 开头）。
      // 实况截图：进去 4 秒后截第一张（等引擎把侧栏画出来），之后每 20 秒刷一张。
      // 低频是故意的 —— 截图要走 GPU 读回，密了白烧 CPU。
      shotTimer = setTimeout(function () { captureShot(); shotTimer2 = setInterval(captureShot, 20000); }, 4000);
    })();

    return function cleanup() {
      disposed = true;
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      if (visTimer) { clearInterval(visTimer); visTimer = null; }
      if (shotTimer) { clearTimeout(shotTimer); shotTimer = null; }
      if (shotTimer2) { clearInterval(shotTimer2); shotTimer2 = null; }
      try { if (view && view.parentNode) view.parentNode.removeChild(view); } catch (e) { /* ignore */ }
      view = null;
    };
  }

  // ==================== 占位窗口（placeholder）====================
  // ==================== 面板类型目录（主进程是唯一来源） ====================
  // 渲染层不自己维护一份名单 —— 否则两边迟早对不上（症状：能选到、但渲染器没写）。
  // 启动时拉一次缓存；选择器打开时再拉一次（新增类型不用重启）。
  let TYPE_CACHE = null;

  async function loadPanelTypes(force) {
    if (TYPE_CACHE && !force) return TYPE_CACHE;
    try {
      const list = await window.kun.scenarios.panelTypes();
      TYPE_CACHE = Array.isArray(list) ? list : [];
    } catch (e) { TYPE_CACHE = TYPE_CACHE || []; }
    return TYPE_CACHE;
  }

  function typeDefOf(type) {
    const list = TYPE_CACHE || [];
    for (const t of list) if (t && t.type === type) return t;
    return null;
  }

  function hasRenderer(type) {
    return typeof (window.APP_RENDERERS || {})[type] === 'function';
  }

  // ==================== 面板选择器（窗口还没配内容时显示） ====================
  // 对应 dsh-worktable「添加项目」里左侧窗口先让人挑面板类型那一步：
  // 这里直接把 24 种（7 族）摆出来，选完填该类型的配置项，写回场景 json。
  // ⚠ 渲染器还没写的类型也**允许选**（写进 json 是真的配置），但面板会明确说"渲染器还没写"，
  //   不给一片白 —— 白屏是最难排查的故障。
  async function renderPlaceholder(body, meta) {
    const box = el('div', 'picker');

    const head = el('div', 'picker-head');
    head.appendChild(el('div', 'picker-title', '为「' + (meta.title || meta.id || '这个窗口') + '」选一种面板'));
    head.appendChild(el('div', 'picker-sub', '选完可以随时再换。配置会写进这个场景的 json。'));
    box.appendChild(head);

    const hint = el('div', 'picker-hint', '正在读面板类型…');
    box.appendChild(hint);

    const listBox = el('div', 'picker-list');
    box.appendChild(listBox);

    const types = await loadPanelTypes(true);
    hint.textContent = '';

    if (!types.length) {
      hint.textContent = '读不到面板类型目录（主进程的 panel:types 没回话）。重启工作台可以重试。';
      body.appendChild(box);
      return;
    }

    // 按族分组（族顺序 = 目录里的首次出现顺序，跟文档《面板类型总览》一致）
    const families = [];
    const byFam = {};
    for (const t of types) {
      const f = t.family || '其它';
      if (!byFam[f]) { byFam[f] = []; families.push(f); }
      byFam[f].push(t);
    }

    for (const fam of families) {
      const group = el('div', 'picker-group');
      group.appendChild(el('div', 'picker-group-name', fam));
      const grid = el('div', 'picker-grid');
      for (const t of byFam[fam]) {
        const ready = hasRenderer(t.type);
        const card = el('button', 'picker-card' + (ready ? '' : ' is-todo'));
        card.type = 'button';
        card.title = (t.label || t.type) + ' · ' + t.type
          + (t.desc ? '\n' + t.desc : '')
          + (ready ? '' : '\n（渲染器还没写，选了会显示待实现说明）');
        // 卡片只留「图标 + 标题」：24 种类型一起摆出来时，描述会把面板撑成一张说明书。
        // 完整说明放进 title 属性（鼠标滑入才弹），这跟顶栏"不许给假按钮"是同一条取舍：
        // 想看的细节一定有地方看得到，但默认画面只留能一眼扫完的东西。
        const top = el('div', 'picker-card-top');
        const ico = el('span', 'picker-card-icon', t.icon || '🧱');
        ico.setAttribute('aria-hidden', 'true');
        top.appendChild(ico);
        top.appendChild(el('span', 'picker-card-name', t.label || t.type));
        if (!ready) top.appendChild(el('span', 'picker-card-tag', '待实现'));
        card.appendChild(top);
        card.addEventListener('click', function () { openPanelConfig(meta, t); });
        grid.appendChild(card);
      }
      group.appendChild(grid);
      listBox.appendChild(group);
    }

    body.appendChild(box);

    // 这块面板被「换类型」重建时要清掉注入的监听（选择器没有定时器，留个空 cleanup 保持契约一致）
    return function cleanup() { /* 选择器无外部资源 */ };
  }

  // 选完类型 → 填配置 → 写回场景 json（面板自己换类型，不用去改文件）
  function openPanelConfig(meta, def) {
    if (typeof window.__dshOpenModal !== 'function') return;
    const wrap = el('div');
    const sceneId = String((meta && meta.scenario) || '');
    const panelId = String((meta && meta.id) || '');

    wrap.appendChild(el('div', 'form-row', ''));
    const headRow = wrap.lastChild;
    headRow.appendChild(el('div', 'form-label', '面板类型'));
    headRow.appendChild(el('div', 'picker-chosen', (def.label || def.type) + ' · ' + def.type));
    if (!hasRenderer(def.type)) {
      const warn = el('div', 'form-hint');
      warn.style.color = 'var(--warn)';
      warn.textContent = '这种面板的渲染器还没写。配置会真的写进 json，但窗口里会显示"待实现"说明 —— 等渲染器补上就自动生效。';
      headRow.appendChild(warn);
    }

    // 标题
    const rTitle = el('div', 'form-row');
    rTitle.appendChild(el('div', 'form-label', '窗口标题'));
    const titleIn = document.createElement('input');
    titleIn.className = 'form-input';
    titleIn.value = (meta && meta.title) || def.label || def.type;
    rTitle.appendChild(titleIn);
    wrap.appendChild(rTitle);

    // 布局四件套（文档《布局与网格》：col/row 从 1 开始，w/h 是跨几格）
    const gridMeta = (function () { try { return window.__dshGridMeta ? window.__dshGridMeta() : null; } catch (e) { return null; } })();
    const rPos = el('div', 'form-row');
    rPos.appendChild(el('div', 'form-label', '位置与大小（列 / 行从 1 开始）'));
    const posRow = el('div', 'num-row');
    const posIn = {};
    [['col', '起始列'], ['row', '起始行'], ['w', '跨几列'], ['h', '跨几行']].forEach(function (pair) {
      const box = el('label', 'num-box');
      box.appendChild(el('span', 'num-label', pair[1]));
      const inp = document.createElement('input');
      inp.className = 'form-input num-input';
      inp.type = 'number';
      inp.min = '1';
      inp.max = '60';
      inp.value = String((meta && meta[pair[0]]) || (pair[0] === 'w' || pair[0] === 'h' ? 2 : 1));
      box.appendChild(inp);
      posIn[pair[0]] = inp;
      posRow.appendChild(box);
    });
    rPos.appendChild(posRow);
    rPos.appendChild(el('div', 'form-hint',
      gridMeta ? ('这个场景现在是 ' + gridMeta.cols + ' 列。列数可在新建场景时选布局预设，或在场景 json 里改 cols。')
               : '这个场景的列数看面板实际占位：越界会自动多出隐式列。'));
    wrap.appendChild(rPos);

    // 该类型的配置项（目录里的 fields）
    const inputs = {};
    for (const f of (def.fields || [])) {
      const row = el('div', 'form-row');
      row.appendChild(el('div', 'form-label', f.label || f.key));
      if (f.kind === 'session') {
        // 会话：拿控制器模型里的会话清单（读本地投影，零 Token）
        const sel = document.createElement('select');
        sel.className = 'form-select';
        const o0 = document.createElement('option');
        o0.value = '';
        o0.textContent = '（不绑定）';
        sel.appendChild(o0);
        row.appendChild(sel);
        const cur = String((meta && meta.sessionId) || '');
        (async function () {
          let sessions = [];
          try { sessions = ((await window.kun.console.model()) || {}).sessions || []; } catch (e) { sessions = []; }
          for (const s of sessions) {
            const o = document.createElement('option');
            o.value = s.id;
            o.textContent = (s.title || '(未命名会话)') + ' · ' + s.id.slice(0, 18);
            o.dataset.title = s.title || '';
            if (s.id === cur) o.selected = true;
            sel.appendChild(o);
          }
        })();
        inputs[f.key] = function () {
          const id = sel.value || '';
          const o = sel.options[sel.selectedIndex];
          return { sessionId: id, sessionTitle: id ? ((o && o.dataset.title) || '') : '', pinTarget: id ? [((o && o.dataset.title) || '')] : [] };
        };
      } else if (f.kind === 'panel') {
        // 选"本场景里的另一个面板"：file 面板的 viewPanel 就靠它，
        // 让用户手填面板 id 是不现实的（id 长得像 scene-test-20261117001-p1）。
        const sel = document.createElement('select');
        sel.className = 'form-select';
        const o0 = document.createElement('option');
        o0.value = '';
        o0.textContent = '（不指定，点文件时用系统默认程序打开）';
        sel.appendChild(o0);
        row.appendChild(sel);
        const cur = String((meta && meta[f.key]) || '');
        (async function () {
          let panels = [];
          try {
            const sc = await window.kun.scenarios.get(sceneId);
            panels = (sc && sc.panels) || [];
          } catch (e) { panels = []; }
          for (const pn of panels) {
            if (!pn || pn.id === panelId) continue;      // 不列自己
            const o = document.createElement('option');
            o.value = String(pn.id);
            o.textContent = (pn.title || pn.id) + ' · ' + (pn.type || '?') + ' · ' + String(pn.id).slice(-12);
            if (String(pn.id) === cur) o.selected = true;
            sel.appendChild(o);
          }
        })();
        inputs[f.key] = function () { return sel.value || ''; };
      } else {
        const inp = document.createElement('input');
        inp.className = 'form-input';
        inp.placeholder = f.kind === 'path' ? 'D:\\path\\to\\folder' : '';
        inp.value = String((meta && meta[f.key]) || '');
        row.appendChild(inp);
        if (f.kind === 'path') {
          const btns = el('div', 'folder-row');
          const pick = el('button', 'folder-btn', '选择位置…');
          pick.type = 'button';
          pick.addEventListener('click', async function () {
            pick.disabled = true;
            const dir = await window.kun.dialog.pickFolder(inp.value || '');
            pick.disabled = false;
            if (dir) inp.value = dir;
          });
          btns.appendChild(pick);
          row.appendChild(btns);
        }
        inputs[f.key] = function () { return inp.value.trim(); };
      }
      wrap.appendChild(row);
    }

    const err = el('div', 'form-hint');
    err.style.color = 'var(--err)';
    wrap.appendChild(err);

    const foot = document.createDocumentFragment();
    const ok = el('button', 'modal-btn primary', '用这个类型');
    ok.type = 'button';
    ok.addEventListener('click', async function () {
      const patch = {
        type: def.type,
        title: titleIn.value.trim() || def.label || def.type
      };
      // 布局四件套一起提交（只提交有值且是真数字的，防止空字符串把字段删了）
      for (const k of ['col', 'row', 'w', 'h']) {
        const el2 = posIn[k];
        if (!el2) continue;
        const raw = String(el2.value || '').trim();
        if (!raw) continue;
        const n = Math.round(Number(raw));
        if (!(n >= 1)) { err.textContent = '布局的列/行/宽/高都得是 1 以上的整数'; return; }
        patch[k] = n;
      }
      for (const k of Object.keys(inputs)) {
        const v = inputs[k]();
        if (v && typeof v === 'object') Object.assign(patch, v);
        else if (v) patch[k] = v;
      }
      ok.disabled = true;
      let r = null;
      try { r = await window.kun.scenarios.patchPanel(sceneId, panelId, patch); } catch (e) { r = { ok: false, err: (e && e.message) || String(e) }; }
      ok.disabled = false;
      if (!r || !r.ok) { err.textContent = '保存失败：' + ((r && r.err) || '未知错误'); return; }
      // 面板对象就地更新（这样重载面板时用的是新配置）
      for (const k of Object.keys(patch)) if (patch[k] !== undefined) meta[k] = patch[k];
      window.__dshCloseModal();
      window.__dshToast('已设为「' + (def.label || def.type) + '」，正在重载面板…');
      // 走面板自刷新通道（改完界面自己生效，别让用户去点 ⟳）
      try { await window.kun.panels.requestReload(sceneId); } catch (e) { /* ignore */ }
    });
    foot.appendChild(ok);
    const cancel = el('button', 'modal-btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { window.__dshCloseModal(); });
    foot.appendChild(cancel);

    window.__dshOpenModal({ title: '配置面板 · ' + (def.label || def.type), body: wrap, foot: foot });
  }

  // ==================== 预留占位（reserved） ====================
  function renderReserved(body, meta) {
    const box = el('div', 'ph-box');
    box.appendChild(el('div', 'ph-title', meta.title || '预留'));
    box.appendChild(el('div', 'ph-sub', '这块格子先空着（reserved）。双击标题可以改名；要放内容就点下面按钮换个类型。'));
    const btn = el('button', 'ph-btn', '选一种面板');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      // 换回 placeholder 类型 → 走面板选择器
      window.kun.scenarios.patchPanel(String(meta.scenario || ''), String(meta.id || ''), { type: 'placeholder' })
        .then(function () { return window.kun.panels.requestReload(String(meta.scenario || '')); })
        .catch(function () { /* ignore */ });
    });
    box.appendChild(btn);
    body.appendChild(box);
  }

  // ==================== 内嵌网页（embed / web） ====================
  // 用 <webview> 而不是 <iframe>：要独立进程与独立登录态（文档《面板类型与注册》经验 5）。
  // 分区按面板 id 走 persist:panel-<id>：同一个网址在两个面板里登录态互不影响。
  // ⚠ 没填 url 时必须显示空态（不然后面一片白，排查会以为面板坏了）。
  function renderEmbedWeb(body, meta, head) {
    const url = String((meta && meta.url) || '').trim();
    const wrap = el('div', 'web-wrap');

    if (!url) {
      const box = el('div', 'ph-box');
      box.appendChild(el('div', 'ph-title', meta.title || '网页'));
      box.appendChild(el('div', 'ph-sub', '还没填网址。双击标题可以改名；要填网址请用「⇄」重新配置这一块。'));
      wrap.appendChild(box);
      body.appendChild(wrap);
      return;
    }

    const addr = el('span', 'web-addr', url);
    addr.title = url;
    const reload = el('button', 'web-btn', '⟳');
    reload.type = 'button';
    reload.title = '重新加载这个网页';
    const open = el('button', 'web-btn', '↗');
    open.type = 'button';
    open.title = '用系统浏览器打开';
    addAct(head, reload);
    addAct(head, open);
    // 网址上标题行做小字（内容区只留网页本身）
    const subEl = setHeadSub(head, '');
    if (subEl) { subEl.textContent = ''; subEl.appendChild(addr); }

    const wv = document.createElement('webview');
    wv.className = 'web-view';
    // ⚠ partition 必须在插入 DOM 之前设：插进去之后设不生效（会退化成 default session）
    if (meta.type === 'embed') {
      const part = 'persist:panel-' + String(meta.id || 'x').replace(/[^A-Za-z0-9_-]/g, '');
      wv.setAttribute('partition', part);
      wv.setAttribute('allowpopups', '');
    }
    wv.setAttribute('src', url);
    wrap.appendChild(wv);
    body.appendChild(wrap);

    reload.addEventListener('click', function () { try { wv.reload(); } catch (e) { /* ignore */ } });
    open.addEventListener('click', function () {
      // 渲染层没有 shell：交给主进程（will-navigate 之外的口子在这里）
      try { window.kun.openExternal ? window.kun.openExternal(url) : window.open(url, '_blank'); } catch (e) { /* ignore */ }
    });

    // 新窗口一律交给系统浏览器（面板里的网页不该在工作台里开新窗口）
    wv.addEventListener('new-window', function (e) { e.preventDefault(); });

    return function cleanup() {
      try { if (wv.parentNode) wv.parentNode.removeChild(wv); } catch (e) { /* ignore */ }
    };
  }



  // ==================== 文件管理（file） + 预览（view）====================
  // 这一对面板是《面板类型总览》里"第 1 天就该有"的三个之二（另一个是 harness）。
  // 分工：file 负责"在哪儿、有哪些东西"，view 负责"这个东西长什么样"。
  // 数据全走 window.kun.fs（主进程只读通道：roots / list / readText / stat / openPath / reveal），
  // 渲染层不碰 fs、不拼路径、不读盘 —— 面板↔外壳一律经过接口。
  //
  // 两者的联动（文档《面板类型总览》：file 的 viewPanel 字段指向预览面板的 id）：
  //   file 里点一个文件 → 优先交给同场景里 viewPanel 指定的预览面板（自定义事件 + 本地存放兜底），
  //   找不到那个面板就直接用系统默认程序打开（宁可打开，也不要点了没反应）。
  const PREVIEW_EVT = 'xiodra:preview';

  function fmtSize(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtTime(ms) {
    const t = Number(ms) || 0;
    if (!t) return '';
    const d = new Date(t);
    const p = function (x) { return (x < 10 ? '0' : '') + x; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function baseName(p) {
    const s2 = String(p || '').replace(/[\\/]+$/, '');
    const i = Math.max(s2.lastIndexOf('\\'), s2.lastIndexOf('/'));
    return i >= 0 ? s2.slice(i + 1) : s2;
  }

  function parentDir(p) {
    const s2 = String(p || '').replace(/[\\/]+$/, '');
    const i = Math.max(s2.lastIndexOf('\\'), s2.lastIndexOf('/'));
    if (i < 0) return '';
    const up = s2.slice(0, i);
    if (/^[A-Za-z]:$/.test(up)) return up + '\\';
    return up;
  }

  // 按扩展名给个小图标（emoji 全部取自实测本机有字形的那些，见《面板类型与注册》经验 2 的放宽版：
  // 只有确实缺字形的那几个才不用 —— 🎛🎚🗑⚙🗄🖴🗜 这类）
  function iconOfFile(name, isDir) {
    if (isDir) return '📁';
    const n = String(name || '').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/.test(n)) return '🖼';
    if (/\.(mp4|mkv|mov|avi|webm)$/.test(n)) return '🎬';
    if (/\.(mp3|wav|flac|m4a|ogg)$/.test(n)) return '🎵';
    if (/\.(zip|7z|rar|gz|zst|tar)$/.test(n)) return '📦';
    if (/\.(pdf)$/.test(n)) return '📕';
    if (/\.(md|txt|log|ini|conf|yml|yaml|toml)$/.test(n)) return '📝';
    if (/\.(js|mjs|cjs|ts|tsx|jsx|json|css|html|py|ps1|bat|cmd|sh)$/.test(n)) return '📜';
    if (/\.(docx?|rtf)$/.test(n)) return '📘';
    if (/\.(xlsx?|csv)$/.test(n)) return '📗';
    if (/\.(pptx?)$/.test(n)) return '📙';
    if (/\.(exe|msi)$/.test(n)) return '⚡';
    return '📄';
  }

  // 明确知道不是文本的扩展名：这些不去读文件，直接给"用系统程序打开"。
  // 反过来说，**不在这里的也不当文本读** —— 走主进程的 NUL 探测，二进制会自己露馅。
  const BIN_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|7z|rar|gz|zst|tar|exe|msi|mp4|mkv|mov|avi|webm|mp3|wav|flac|m4a|ogg|psd|ai|blend|skp|dwg|apk|iso|bin|dat|db|sqlite|woff2?|ttf|otf|eot)$/i;
  function looksBinaryExt(p) { return BIN_EXT.test(String(p || '')); }

  function isImagePath(p) {
    return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(String(p || ''));
  }

  // 视频（2026-11-25，按**实测**重定）
  // 实测（ffmpeg 造样本 + Electron 真解）：mp4/mkv(h264)/mkv(h265)/mov/webm 全部 ✓ 能播，
  //   avi ✗（error.code=4 DEMUXER_ERROR_COULD_NOT_OPEN）。
  // canPlayType：video/x-matroska → maybe；video/x-msvideo、video/quicktime、video/mp2t → 空。
  const VIDEO_ANY = /\.(mp4|m4v|webm|ogv|mkv|mov|avi|rmvb|rm|flv|wmv|mpg|mpeg|ts|m2ts|3gp|vob|asf|divx|f4v|mts)$/i;
  // 已知**不行**的容器：不建 <video>，直接给外部播放器按钮（避免先闪黑框）
  const VIDEO_NEVER = /\.(avi|rmvb|rm|flv|wmv|mpg|mpeg|ts|m2ts|vob|asf|divx|f4v|mts)$/i;
  function isVideoPath(p) { return VIDEO_ANY.test(String(p || '')); }
  /** 是否直接尝试内嵌播放（mkv/mov 现在也算了 —— 实测能播） */
  function isVideoPlayable(p) { return isVideoPath(p) && !VIDEO_NEVER.test(String(p || '')); }

  // 把"路径"变成能塞进 <img src> 的地址。file:// + 逐段编码，盘符和斜杠保持不变。
  function fileUrlOf(p) {
    let s2 = String(p || '').replace(/\\/g, '/');
    if (!s2) return '';
    const drive = /^[A-Za-z]:/.test(s2);
    const parts = s2.split('/').map(function (seg, i) {
      if (i === 0 && drive) return seg;            // "D:" 不编码
      return encodeURIComponent(seg);
    });
    s2 = parts.join('/');
    return 'file:///' + (s2.charAt(0) === '/' ? s2.slice(1) : s2);
  }

  // ---------- file 面板 ----------
  // 标题栏功能区（照搬参照项目：文件管理的工具按钮与当前路径都上标题栏，内容区只留列表）。
  async function renderFile(body, meta, head) {
    const store = sceneStore(meta);
    // 上次停留的目录存在本地（按场景+面板分区），换会话/重启还在原地
    const startDir = String((meta && meta.cwd) || store.get('') || '');

    const wrap = el('div', 'file-wrap');
    // 功能区按钮：全部进标题栏右上角（不再在内容区顶上加一条 bar，省一行高度）
    const upBtn = el('button', 'file-btn', '⬆');
    upBtn.type = 'button';
    upBtn.title = '上一级';
    const homeBtn = el('button', 'file-btn', '🏠');
    homeBtn.type = 'button';
    homeBtn.title = '回到磁盘列表';
    const reBtn = el('button', 'file-btn', '⟳');
    reBtn.type = 'button';
    reBtn.title = '刷新这个目录';
    addAct(head, upBtn);
    addAct(head, homeBtn);
    addAct(head, reBtn);
    // 「跳到项目文件夹」也放功能区（原来塞在 body 的 bar 里）
    if (meta && meta.projectDir) {
      const pj = el('button', 'file-btn', '📌');
      pj.type = 'button';
      pj.title = '跳到这个场景的项目文件夹：' + meta.projectDir;
      pj.addEventListener('click', function () { go(String(meta.projectDir)); });
      addAct(head, pj);
    }
    // 当前路径用小字显示在标题行（文档《面板通用能力》：状态小字把"我以为"变"看得见"）
    const cwdEl = el('span', 'file-cwd', '…');
    const subEl = setHeadSub(head, '…');
    if (subEl) { subEl.textContent = ''; subEl.appendChild(cwdEl); }

    const listBox = el('div', 'file-list');
    wrap.appendChild(listBox);
    const hint = el('div', 'file-hint', '');
    wrap.appendChild(hint);

    body.appendChild(wrap);

    let cwd = startDir;
    let alive = true;

    // drives 字段：留空 = 全部盘。只在"磁盘列表"这一层生效。
    const driveFilter = String((meta && meta.drives) || '')
      .split(/[,，\s]+/).map(function (x) { return x.trim().toUpperCase(); })
      .filter(Boolean);

    function rowClickable(row, onClick) {
      row.classList.add('is-click');
      row.addEventListener('click', onClick);
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick(); }
      });
      row.tabIndex = 0;
    }

    function makeRow(iconText, name, right, isDir) {
      const row = el('div', 'file-row' + (isDir ? ' is-dir' : ''));
      row.appendChild(el('span', 'file-ico', iconText));
      const nm = el('span', 'file-name', name);
      nm.title = name;
      row.appendChild(nm);
      const rr = el('span', 'file-meta', right || '');
      row.appendChild(rr);
      return row;
    }

    // 在根这一层：列磁盘 + 主目录
    async function paintRoots() {
      cwdEl.textContent = '这台电脑';
      cwdEl.title = '';
      listBox.innerHTML = '';
      hint.textContent = '选一个盘或直接进主目录。';
      let roots = [];
      let home = null;
      try {
        const r = await window.kun.fs.roots();
        roots = (r && r.roots) || [];
        home = (r && r.home) || null;
      } catch (e) { /* ignore */ }
      if (!alive) return;
      if (home) {
        const row = makeRow('🏠', (home.name || '主目录') + '（' + home.path + '）', '', true);
        rowClickable(row, function () { go(home.path); });
        listBox.appendChild(row);
      }
      const shown = driveFilter.length
        ? roots.filter(function (r) { return driveFilter.indexOf(String(r.path || '').replace('\\', '').toUpperCase()) >= 0; })
        : roots;
      if (!shown.length) {
        hint.textContent = driveFilter.length
          ? '按这个面板的 drives 配置（' + driveFilter.join(',') + '）没找到可显示的盘。'
          : '没读到任何磁盘。';
        return;
      }
      for (const r of shown) {
        const row = makeRow('💾', r.name || r.path, '', true);
        rowClickable(row, function () { go(r.path); });
        listBox.appendChild(row);
      }
    }

    async function paintDir(dir) {
      cwdEl.textContent = dir;
      cwdEl.title = dir;
      listBox.innerHTML = '';
      hint.textContent = '正在读目录…';
      let res = null;
      try { res = await window.kun.fs.list(dir); } catch (e) { res = { ok: false, err: (e && e.message) || String(e) }; }
      if (!alive) return;
      if (!res || !res.ok) {
        hint.textContent = '读不了这个目录：' + ((res && res.err) || '未知错误');
        return;
      }
      // 面板自己记住停在哪（按场景+面板分区）
      store.set(dir);
      const rows = res.rows || [];
      if (!rows.length) { hint.textContent = '这个目录是空的。'; return; }
      hint.textContent = rows.length + ' 项 · 点文件夹进去，点文件交给预览面板';
      for (const f of rows) {
        const right = f.isDir ? '' : fmtSize(f.size);
        const row = makeRow(iconOfFile(f.name, f.isDir), f.name, right, f.isDir);
        row.title = (f.isDir ? f.name : f.name + ' · ' + fmtSize(f.size)) + (f.mtime ? ' · ' + fmtTime(f.mtime) : '');
        const full = dir.replace(/[\\/]+$/, '') + '\\' + f.name;
        if (f.isDir) {
          rowClickable(row, function () { go(full); });
        } else {
          rowClickable(row, function () { openFile(full); });
          // 右键 = 在资源管理器里定位（比"点了没反应"更明确）
          row.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            try { window.kun.fs.reveal(full); } catch (e) { /* ignore */ }
          });
        }
        listBox.appendChild(row);
      }
    }

    function openFile(full) {
      const targetPanel = String((meta && meta.viewPanel) || '');
      const scene = String((meta && meta.scenario) || '');
      // ① 先试着交给同场景里指定的预览面板（它就挂在这个页面上，能收到事件）
      if (targetPanel) {
        // 存一份兜底：那个预览面板要是刚建/刚重载，起来时能自己捡回来
        try { localStorage.setItem('xiodra.preview:' + scene + ':' + targetPanel, full); } catch (e) { /* ignore */ }
        try {
          const detail = { sceneId: scene, panelId: targetPanel, path: full };
          window.dispatchEvent(new CustomEvent(PREVIEW_EVT, { detail: detail }));
        } catch (e) { /* ignore */ }
        // 事件是不是真的有人接？没人接（面板没挂/类型不对）就走系统打开，别静默失败
        setTimeout(function () {
          if (window.__dshPreviewHandled === full) { window.__dshPreviewHandled = ''; return; }
          try { window.kun.fs.openPath(full); } catch (e) { /* ignore */ }
        }, 60);
        return;
      }
      // ② 没配预览面板：直接用系统默认程序打开
      try { window.kun.fs.openPath(full); } catch (e) { /* ignore */ }
    }

    function go(dir) {
      if (!dir) { paintRoots(); return; }
      paintDir(dir);
    }

    upBtn.addEventListener('click', function () {
      if (!cwd) return;
      const up = parentDir(cwd);
      if (!up) { paintRoots(); return; }
      go(up);
    });
    homeBtn.addEventListener('click', function () { paintRoots(); });
    reBtn.addEventListener('click', function () { if (cwd) paintDir(cwd); else paintRoots(); });

    if (cwd) paintDir(cwd); else paintRoots();

    return function cleanup() { alive = false; };
  }

  // ---------- view 面板 ----------
  // 只读预览：图片直接画、文本按文本显示、其它类型给出明确的"用什么打开"。
  // ⚠ 判据：没内容时必须显示空态，不许一片白（文档《面板类型总览》的硬要求）。
  // 标题栏功能区（照搬参照项目 view 面板的做法）：按钮全上标题栏右上角，文件名作小字跟在标题后。
  // 参照项目注释里踩过的坑：把东西塞进标题行后必须阻断指针事件，否则标题行是拖拽把手，点了没反应
  // （本壳标题行没做拖拽把手，这里仍保留 preventDefault/stopPropagation 的习惯，成本为零）。
  /**
   * 「用 MPV 打开」按钮（2026-11-25）
   * @param {string} p 视频路径
   * @param {object|null} player 探测结果（null = 没探测/没找到）
   */
  function makeVideoOpenBtn(p, player) {
    const found = !!(player && player.ok && player.found);
    const b = el('button', 'ph-btn video-open', found ? ('用 ' + (player.kind || 'MPV') + ' 打开') : '用外部播放器打开');
    b.type = 'button';
    b.title = found
      ? ('用 ' + player.exe + ' 播放')
      : '本机没检测到 mpv / MPV-EASY-Player，将用系统默认程序打开';
    b.addEventListener('click', async function () {
      b.disabled = true;
      const old = b.textContent;
      b.textContent = '正在打开…';
      try {
        const r = await window.kun.video.open(p);
        if (!r || !r.ok) {
          b.textContent = '打开失败：' + ((r && r.err) || '未知');
          setTimeout(function () { b.textContent = old; b.disabled = false; }, 2200);
          return;
        }
        b.textContent = '已用「' + (r.via || '外部播放器') + '」打开';
        setTimeout(function () { b.textContent = old; b.disabled = false; }, 1600);
      } catch (e) {
        b.textContent = '打开失败：' + ((e && e.message) || e);
        setTimeout(function () { b.textContent = old; b.disabled = false; }, 2200);
      }
    });
    return b;
  }

  /** 是不是 markdown（按扩展名） */
  function isMdPath(p) {
    return /\.(md|markdown|mdown|mkd|mdx)$/i.test(String(p || ''));
  }

  /**
   * 把 markdown 画进宿主容器（带 TOC / 源码切换 / 自动刷新）
   * @param {HTMLElement} host  .md-wrap
   * @param {string} mdText     原文
   * @param {object} opt        { mode: 'render'|'source', tocOpen: bool, onModeChange, onTocToggle }
   */
  function paintMarkdown(host, mdText, opt) {
    const o = opt || {};
    const MD = window.__dshMarkdown;
    host.innerHTML = '';
    if (!MD) {
      const err = el('div', 'md-fallback');
      err.textContent = 'markdown.js 没加载成功，先按纯文本显示。';
      const pre0 = el('pre', 'view-text');
      pre0.textContent = mdText;
      host.appendChild(err);
      host.appendChild(pre0);
      return null;
    }

    // 源码模式：原样 <pre>
    if (o.mode === 'source') {
      const pre = el('pre', 'view-text md-source');
      pre.textContent = mdText;
      host.appendChild(pre);
      return { toc: [] };
    }

    let out;
    try { out = MD.render(mdText); } catch (e) {
      const err = el('div', 'md-fallback');
      err.textContent = 'markdown 解析失败：' + ((e && e.message) || e);
      const pre1 = el('pre', 'view-text');
      pre1.textContent = mdText;
      host.appendChild(err);
      host.appendChild(pre1);
      return null;
    }

    const layout = el('div', 'md-layout');

    // TOC 侧栏（只在有标题时画）
    if (out.toc && out.toc.length) {
      const tocBox = el('nav', 'md-toc');
      if (!o.tocOpen) tocBox.style.display = 'none';
      const tt = el('div', 'md-toc-title', '目录');
      tocBox.appendChild(tt);
      out.toc.forEach(function (h) {
        // 层级缩进：h1 不缩，h2 缩 1 档…
        const a = el('a', 'md-toc-item md-toc-lv' + h.level, h.text || '(无标题)');
        a.href = '#' + h.id;
        a.title = h.text || '';
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          const tgt = host.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(h.id) : h.id));
          if (tgt) {
            try { tgt.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { tgt.scrollIntoView(); }
            // 闪一下，方便看清跳到哪了
            tgt.classList.remove('md-flash');
            void tgt.offsetWidth;
            tgt.classList.add('md-flash');
          }
        });
        tocBox.appendChild(a);
      });
      layout.appendChild(tocBox);
    }

    const doc = el('div', 'md-body');
    doc.innerHTML = out.html;
    layout.appendChild(doc);
    host.appendChild(layout);

    // 外链一律交给系统浏览器（webview 里别自己跳走）
    doc.addEventListener('click', function (ev) {
      const a = ev.target && ev.target.closest ? ev.target.closest('a.md-a') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        ev.preventDefault();
        try { window.kun.openExternal(href); } catch (e) { /* ignore */ }
      }
    });

    return { toc: out.toc || [] };
  }

  async function renderView(body, meta, head) {
    const scene = String((meta && meta.scenario) || '');
    const panelId = String((meta && meta.id) || '');
    const store = sceneStore(meta);
    const STORE_PATH = 'xiodra.preview:' + scene + ':' + panelId;
    const PICK_KEY = 'path';

    const wrap = el('div', 'view-wrap');
    const nameEl = el('span', 'view-name', '未选择文件');
    const pickBtn = el('button', 'view-btn', '选文件…');
    pickBtn.type = 'button';
    pickBtn.title = '选一个文件来预览';
    const openBtn = el('button', 'view-btn', '↗');
    openBtn.type = 'button';
    openBtn.title = '用系统默认程序打开';
    openBtn.disabled = true;
    const revealBtn = el('button', 'view-btn', '📌');
    revealBtn.type = 'button';
    revealBtn.title = '在资源管理器里定位';
    revealBtn.disabled = true;
    addAct(head, pickBtn);
    addAct(head, openBtn);
    addAct(head, revealBtn);
    // 文件名作小字（原来在 body 顶上的 bar 里）
    const subEl = setHeadSub(head, '未选择文件');
    if (subEl) { subEl.textContent = ''; subEl.appendChild(nameEl); }

    const bodyBox = el('div', 'view-body');
    wrap.appendChild(bodyBox);
    body.appendChild(wrap);

    let alive = true;
    // 注意：store.get(x) 的 x 是「没有值时的兜底返回值」，键由 sceneStore 内部按场景+面板生成。
    // 早先误传了 PICK_KEY 常量，导致面板一打开就显示「这个路径读不到：path」。
    let curPath = (meta && meta.path) || store.get('') || '';
    let curCleanup = null;

    function setName(p) {
      nameEl.textContent = p ? baseName(p) : '未选择文件';
      nameEl.title = p || '';
      openBtn.disabled = !p;
      revealBtn.disabled = !p;
    }

    function paintEmpty(text) {
      bodyBox.innerHTML = '';
      const box = el('div', 'ph-box');
      box.appendChild(el('div', 'ph-title', '预览'));
      box.appendChild(el('div', 'ph-sub', text));
      const btn = el('button', 'ph-btn', '选一个文件…');
      btn.type = 'button';
      btn.addEventListener('click', function () { pick(); });
      box.appendChild(btn);
      bodyBox.appendChild(box);
    }

    // 只认"像绝对路径"的东西（D:\... 或 \\\\server\share 或 /...）。
    // 存进来的历史脏值（早期 bug 把常量 'path' 写进了 localStorage）在门口就被挡掉，
    // 不然面板会永远显示「这个路径读不到：path」，用户只能去清缓存。
    function sanePath(v) {
      const t = String(v || '').trim();
      if (!t) return '';
      if (/^[A-Za-z]:[\\/]/.test(t)) return t;
      if (/^[\\/]{2}/.test(t)) return t;
      if (/^[\\/]/.test(t)) return t;
      return '';
    }

    async function paint(p) {
      p = sanePath(p);
      if (p) { store.set(PICK_KEY, p); try { localStorage.setItem(STORE_PATH, p); } catch (e) { /* ignore */ } }
      if (curCleanup) { try { curCleanup(); } catch (e) { /* ignore */ } curCleanup = null; }
      bodyBox.innerHTML = '';
      // 换文件时重置横向滚动（2026-11-25）：
      //   曾经表格溢出把 view-body 横向滚过去，滚动位置残留 ⇒ 左侧 TOC 被滚出视野，
      //   看起来像"目录没渲染"，其实 DOM 正常。换文件一律从左上角看起。
      try { bodyBox.scrollLeft = 0; bodyBox.scrollTop = 0; } catch (e) { /* ignore */ }
      if (!alive) return;
      if (!p) { setName(''); paintEmpty('还没挑文件。左边用「文件管理」面板点文件会送到这里，也可以直接点上面的「选文件…」。'); return; }
      setName(p);

      let st = null;
      try { st = await window.kun.fs.stat(p); } catch (e) { st = null; }
      if (!alive) return;
      if (!st || !st.ok) { paintEmpty('这个路径读不到：' + p); return; }
      if (st.isDir) { paintEmpty('这是个文件夹，不是文件：' + p); return; }

      // 图片：直接给 <img>（file:// 已经在 CSP 的 img-src 里放行了）
      if (isImagePath(p)) {
        const img = document.createElement('img');
        img.className = 'view-img';
        img.src = fileUrlOf(p) + '?v=' + (Date.now());
        img.alt = baseName(p);
        img.addEventListener('error', function () {
          paintEmpty('图片解码失败（可能是格式不支持，或文件被占用）：' + p);
        });
        bodyBox.appendChild(img);
        const info = el('div', 'view-info', fmtSize(st.size) + (st.mtime ? ' · ' + fmtTime(st.mtime) : ''));
        bodyBox.appendChild(info);
        return;
      }

      // 明显不是文本的格式：不读文件，直接给"用系统程序打开"的明确说明。
      // 为什么先判扩展名：23.9MB 的 pdf 若先去读，用户看到的是"文件太大"，
      // 而真正的原因是"这种格式面板本来就不内建预览"—— 两个说法指向完全不同的动作。
      // ★视频（2026-11-25）★ 内嵌播放 + 外部播放器兜底
      if (isVideoPath(p)) {
        const playable = isVideoPlayable(p);
        const vwrap = el('div', 'video-wrap');

        if (playable) {
          const v = document.createElement('video');
          v.className = 'video-el';
          v.controls = true;
          v.preload = 'metadata';
          v.src = fileUrlOf(p) + '?v=' + Date.now();
          // 播不了（codec 不支持/文件损坏）⇒ 就地降级成"用外部播放器打开"，⛔ 不留一块黑
          v.addEventListener('error', function () {
            vwrap.innerHTML = '';
            const box = el('div', 'ph-box');
            box.appendChild(el('div', 'ph-title', baseName(p)));
            box.appendChild(el('div', 'ph-sub', '这个视频的内嵌解码失败了（编码格式 Chromium 不带，或文件不完整）。\n建议用 MPV 打开：'));
            box.appendChild(makeVideoOpenBtn(p));
            vwrap.appendChild(box);
          });
          vwrap.appendChild(v);
        }

        // 信息行 + 外部播放器按钮（两种情况都给：能播的也可能想用 MPV 看）
        const bar = el('div', 'video-bar');
        const info = el('div', 'view-info', fmtSize(st.size) + (st.mtime ? ' · ' + fmtTime(st.mtime) : ''));
        bar.appendChild(info);

        // 探测本机播放器：找到 MPV 才把按钮文案写成"用 MPV 打开"
        let player = null;
        try { player = await window.kun.video.player(); } catch (e) { player = null; }
        const found = !!(player && player.ok && player.found);
        const bOpen = makeVideoOpenBtn(p, found ? player : null);
        bar.appendChild(bOpen);
        vwrap.appendChild(bar);

        bodyBox.appendChild(vwrap);

        // 不可内嵌的格式：给一句明确原因（⛔ 不能只给一个空播放器）
        if (!playable) {
          const why = el('div', 'video-note',
            '这种格式（' + (String(p).split('.').pop() || '?') + '）Chromium 不能内嵌解码，' +
            (found ? '已检测到 ' + (player.kind || 'MPV') + '，点上面的按钮用它打开。' : '点上面的按钮用系统默认播放器打开。') +
            (found ? '' : '（提示：装了 MPV-EASY-Player 后这里会自动优先用它）'));
          vwrap.insertBefore(why, bar);
        }
        return;
      }

      if (looksBinaryExt(p)) {
        const box = el('div', 'ph-box');
        box.appendChild(el('div', 'ph-title', baseName(p)));
        box.appendChild(el('div', 'ph-sub', '这个格式不在内建预览里（只内建了图片与纯文本）。\n' + p));
        box.appendChild(el('div', 'view-info', fmtSize(st.size) + (st.mtime ? ' · ' + fmtTime(st.mtime) : '')));
        const b0 = el('button', 'ph-btn', '用系统程序打开');
        b0.type = 'button';
        b0.addEventListener('click', function () { try { window.kun.fs.openPath(p); } catch (e) { /* ignore */ } });
        box.appendChild(b0);
        bodyBox.appendChild(box);
        return;
      }

      // 文本类：走 fs.readText（主进程会挡二进制与超大文件）
      let res = null;
      try { res = await window.kun.fs.readText(p, 1024 * 1024); } catch (e) { res = { ok: false, err: (e && e.message) || String(e) }; }
      if (!alive) return;
      if (res && res.ok) {
        const info = el('div', 'view-info', fmtSize(st.size) + (st.mtime ? ' · ' + fmtTime(st.mtime) : '') + (res.truncated ? ' · 已截断' : ''));

        // ★markdown：GFM 渲染（2026-11-25）★
        if (isMdPath(p)) {
          // 清掉上一轮加的 md 按钮（paint 会被调用多次：换文件/重读）
          //   ⛔ 不清就会累积 —— 实测截到过两组「☰ </> ⟳」。
          try {
            Array.prototype.slice.call(head.querySelectorAll('.md-act')).forEach(function (b0) {
              if (b0.parentNode) b0.parentNode.removeChild(b0);
            });
          } catch (e) { /* ignore */ }
          const mdWrap = el('div', 'md-wrap');
          bodyBox.appendChild(mdWrap);
          bodyBox.appendChild(info);

          // 每份文档自己的视图状态（源码/渲染、TOC 开合）
          let mdMode = 'render';
          let tocOpen = true;
          const redraw = function () {
            const keepTop = bodyBox.scrollTop;
            paintMarkdown(mdWrap, res.text, { mode: mdMode, tocOpen: tocOpen });
            bodyBox.scrollTop = keepTop;   // 自动刷新后滚动位置不丢（参考项目的卖点）
            if (tocBtn) tocBtn.classList.toggle('is-on', tocOpen);
            if (srcBtn) srcBtn.textContent = mdMode === 'source' ? '◆' : '</>';
          };

          // 工具栏：TOC 开关 + 源码/渲染 + 立即重读
          const tocBtn = el('button', 'view-btn md-act', '☰');
          tocBtn.type = 'button';
          tocBtn.title = '目录（TOC）开关';
          tocBtn.addEventListener('click', function () {
            tocOpen = !tocOpen;
            redraw();
          });
          const srcBtn = el('button', 'view-btn md-act', '</>');
          srcBtn.type = 'button';
          srcBtn.title = '源码 / 渲染 切换';
          srcBtn.addEventListener('click', function () {
            mdMode = (mdMode === 'render') ? 'source' : 'render';
            redraw();
          });
          const reBtn = el('button', 'view-btn md-act', '⟳');
          reBtn.type = 'button';
          reBtn.title = '立即重新读取这个文件';
          addAct(head, tocBtn);
          addAct(head, srcBtn);
          addAct(head, reBtn);

          redraw();

          // 自动刷新：2 秒轮询 mtime（跟参考项目一致），变了才重绘
          let lastMtime = Number(st.mtime) || 0;
          let polling = false;
          const timer = setInterval(async function () {
            if (!alive || polling) return;
            polling = true;
            try {
              const st2 = await window.kun.fs.stat(p);
              if (alive && st2 && st2.ok && !st2.isDir) {
                const mt = Number(st2.mtime) || 0;
                if (mt && mt !== lastMtime) {
                  lastMtime = mt;
                  const r2 = await window.kun.fs.readText(p, 1024 * 1024);
                  if (alive && r2 && r2.ok) {
                    res.text = r2.text;
                    redraw();
                  }
                }
              }
            } catch (e) { /* ignore */ }
            polling = false;
          }, 2000);

          reBtn.addEventListener('click', async function () {
            try {
              const r3 = await window.kun.fs.readText(p, 1024 * 1024);
              if (alive && r3 && r3.ok) { res.text = r3.text; redraw(); }
            } catch (e) { /* ignore */ }
          });

          // 面板换文件/销毁时停掉轮询
          curCleanup = function () { clearInterval(timer); };
          return;
        }

        // 非 markdown：仍按纯文本
        const pre = el('pre', 'view-text');
        pre.textContent = res.text;
        bodyBox.appendChild(pre);
        bodyBox.appendChild(info);
        return;
      }

      // 剩下的（pdf / office / 视频 / 二进制 …）：不假装能预览，明确告诉用户怎么打开
      const box = el('div', 'ph-box');
      box.appendChild(el('div', 'ph-title', baseName(p)));
      let why = '这个格式不在内建预览里（只内建了图片与文本）。';
      if (res && res.binary) why = '看起来是二进制文件，不能当文本显示。';
      else if (res && res.tooBig) why = '文件太大（' + fmtSize(res.size || st.size) + '），不在面板里整份读。';
      else if (res && res.err) why = res.err;
      box.appendChild(el('div', 'ph-sub', why + '\n' + p));
      const b1 = el('button', 'ph-btn', '用系统程序打开');
      b1.type = 'button';
      b1.addEventListener('click', function () { try { window.kun.fs.openPath(p); } catch (e) { /* ignore */ } });
      box.appendChild(b1);
      bodyBox.appendChild(box);
    }

    async function pick() {
      let p = '';
      try { p = await window.kun.dialog.pickFile(curPath || ((meta && meta.homeFolders) || '')); } catch (e) { p = ''; }
      if (!p) return;
      apply(p);
    }

    function apply(p) {
      curPath = String(p || '');
      store.set(PICK_KEY, curPath);
      try { localStorage.setItem(STORE_PATH, curPath); } catch (e) { /* ignore */ }
      paint(curPath);
    }

    // 接住 file 面板发来的预览请求（只认发给自己的那条）
    function onPreview(ev) {
      const d = (ev && ev.detail) || {};
      if (String(d.sceneId || '') !== scene) return;
      if (String(d.panelId || '') !== panelId) return;
      window.__dshPreviewHandled = String(d.path || '');
      apply(d.path);
    }
    window.addEventListener(PREVIEW_EVT, onPreview);

    pickBtn.addEventListener('click', function () { pick(); });
    openBtn.addEventListener('click', function () { if (curPath) { try { window.kun.fs.openPath(curPath); } catch (e) { /* ignore */ } } });
    revealBtn.addEventListener('click', function () { if (curPath) { try { window.kun.fs.reveal(curPath); } catch (e) { /* ignore */ } } });

    // 起来时：json 里的 path > 本地存的 path > 本地兜底键 > 起始文件夹转成"从里面挑一个"
    if (!curPath) {
      try { curPath = sanePath(localStorage.getItem(STORE_PATH) || ''); } catch (e) { curPath = ''; }
    }
    await paint(curPath);

    return function cleanup() {
      alive = false;
      window.removeEventListener(PREVIEW_EVT, onPreview);
      if (curCleanup) { try { curCleanup(); } catch (e) { /* ignore */ } curCleanup = null; }
    };
  }

  // ==================== 仪表盘（dash）====================
  // 参照项目那一版是「OA 服务器状态」（SSH 轮询 CPU/内存/服务）。本壳没有那套后端，也不该假装有。
  // 这一版看的是**工作台自己**：几个场景、几条会话、引擎通不通、哪些场景在等我。
  // 数据全来自 window.kun（console.model / scenarios.list / harness.ready）—— 渲染层不读盘。
  // 铁律：任何一路取不到都必须显式说"取不到"，⛔ 不能一片白，也不能把失败画成 0。
  function renderDash(body, meta, head) {
    const wrap = el('div', 'dash-wrap');

    // 标题行：状态小字 + 手动刷新（不占内容区，照 §1 统一进 acts）
    const subEl = setHeadSub(head, '正在读…');
    const refreshBtn = el('button', 'file-btn', '⟳');
    refreshBtn.type = 'button';
    refreshBtn.title = '立即重新采集（不等自动周期）';
    addAct(head, refreshBtn);

    const grid = el('div', 'dash-grid');
    const list = el('div', 'dash-list');
    wrap.appendChild(grid);
    wrap.appendChild(list);
    body.appendChild(wrap);

    let alive = true;
    let busy = false;
    let timer = null;
    let lastAt = 0;

    function fmtWhen(ms) {
      const t = Number(ms) || 0;
      if (!t) return '';
      const d = new Date(t);
      const p2 = function (x) { return (x < 10 ? '0' : '') + x; };
      return (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }

    // 一张 KPI 卡：label / 大数字 / 可选进度条 / 可选脚注
    function kpi(label, value, pct, foot) {
      const c = el('div', 'dash-card');
      c.appendChild(el('div', 'dash-kpi-label', label));
      const v = el('div', 'dash-kpi-value', value);
      c.appendChild(v);
      if (pct != null) {
        const bar = el('div', 'dash-bar');
        const fill = el('div', 'dash-bar-fill ' + (pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo'));
        fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
        bar.appendChild(fill);
        c.appendChild(bar);
      }
      if (foot) c.appendChild(el('div', 'dash-foot', foot));
      return c;
    }

    // 明确空态：这一屏没有任何内容时用，⛔ 不许留白
    function emptyBox(title, sub, btnText, onBtn) {
      grid.textContent = '';
      list.textContent = '';
      const box = el('div', 'ph-box');
      box.appendChild(el('div', 'ph-title', title));
      box.appendChild(el('div', 'ph-sub', sub));
      if (btnText) {
        const b = el('button', 'ph-btn', btnText);
        b.type = 'button';
        b.addEventListener('click', onBtn);
        box.appendChild(b);
      }
      list.appendChild(box);
    }

    async function paint() {
      if (busy || !alive) return;
      busy = true;
      refreshBtn.disabled = true;
      try {
        // 三路并行取，任何一路挂了都要能单独说清楚是谁挂了
        const rs = await Promise.all([
          window.kun.console.model().catch(function (e) { return { __err: (e && e.message) || String(e) }; }),
          window.kun.scenarios.list().catch(function (e) { return { __err: (e && e.message) || String(e) }; }),
          window.kun.harness.ready().catch(function (e) { return { __err: (e && e.message) || String(e) }; })
        ]);
        if (!alive) return;
        const model = rs[0], scenes = rs[1], ready = rs[2];

        const modelBad = !!(model && model.__err);
        const scenesBad = !!(scenes && scenes.__err);
        const cards = (!modelBad && model && Array.isArray(model.cards)) ? model.cards : null;
        const sessions = (!modelBad && model && Array.isArray(model.sessions)) ? model.sessions : [];
        const sceneList = (!scenesBad && Array.isArray(scenes)) ? scenes : null;

        // ---- 三路全挂：这是"数据源拔掉"的样子，必须显式报错 ----
        if (!cards && !sceneList && ready !== true) {
          subEl.textContent = '数据源取不到';
          emptyBox('仪表盘读不到数据',
            '三路数据都没取到：控制台模型、场景列表、引擎状态。'
            + '\n· 控制台模型：' + ((model && model.__err) || '无数据')
            + '\n· 场景列表：' + ((scenes && scenes.__err) || '无数据')
            + '\n· 引擎：' + (typeof ready === 'string' ? ready : String(ready)),
            '重试一次', function () { paint(); });
          return;
        }

        grid.textContent = '';
        list.textContent = '';

        // ---- KPI 第一排：场景 / 会话 / 等我 / 引擎 ----
        const busyCnt = sessions.filter(function (s) { return s.status === 'busy'; }).length;
        const needCnt = sessions.filter(function (s) { return s.status === 'need'; }).length;
        const boundCnt = cards ? cards.filter(function (c) { return c.bound; }).length : null;
        const glowCnt = cards ? cards.filter(function (c) { return c.glow; }).length : null;

        grid.appendChild(kpi('场景', sceneList ? String(sceneList.length) : '—', null,
          sceneList ? '面板 ' + sceneList.reduce(function (a, s) { return a + (Number(s.panelCount) || 0); }, 0) + ' 块' : '场景列表取不到'));
        grid.appendChild(kpi('会话', sessions.length ? String(sessions.length) : '—', null,
          sessions.length ? ('工作中 ' + busyCnt + ' · 待决定 ' + needCnt) : '没有会话记录'));
        grid.appendChild(kpi('已绑定', boundCnt == null ? '—' : String(boundCnt), null,
          cards ? (boundCnt == null ? '' : '共 ' + cards.length + ' 个场景') : '控制台模型取不到'));
        grid.appendChild(kpi('引擎', ready === true ? '已就绪' : (typeof ready === 'string' ? '未知' : '未就绪'), null,
          typeof ready === 'string' ? ready : (ready === true ? '可以开会话' : '引擎没起来，AI 面板会空')));

        // ---- 第二排：会话状态分布（有数据才画进度条）----
        if (sessions.length) {
          const tot = sessions.length;
          const idleCnt = sessions.filter(function (s) { return s.status === 'idle'; }).length;
          const doneCnt = sessions.filter(function (s) { return s.status === 'done'; }).length;
          const pct = function (n) { return Math.round(n * 100 / tot); };
          grid.appendChild(kpi('工作中', String(busyCnt), pct(busyCnt), '空闲 ' + idleCnt + ' · 已结束 ' + doneCnt));
          grid.appendChild(kpi('待我决定', String(needCnt), pct(needCnt),
            needCnt ? '有 ' + needCnt + ' 条会话在等我' : '没有待办'));
          const turns = sessions.reduce(function (a, s) { return a + (Number(s.turns) || 0); }, 0);
          grid.appendChild(kpi('累计轮次', String(turns), null, '所有会话加总'));
          const last = sessions.reduce(function (a, s) { return Math.max(a, Number(s.lastPromptAt) || 0); }, 0);
          // 值只放时间（HH:MM），日期放脚注 —— 全放一起在窄卡里会折成两行
          const lastT = last ? (function () {
            const d = new Date(last);
            const p2 = function (x) { return (x < 10 ? '0' : '') + x; };
            return p2(d.getHours()) + ':' + p2(d.getMinutes());
          })() : '—';
          grid.appendChild(kpi('最近活动', lastT, null,
            last ? ((function () {
              const d = new Date(last);
              const p2 = function (x) { return (x < 10 ? '0' : '') + x; };
              return (d.getMonth() + 1) + '-' + p2(d.getDate());
            })()) : '还没有会话跑过'));
        }

        // ---- 场景清单：哪个场景、什么状态、钉的哪条会话 ----
        const head2 = el('div', 'dash-sec-title', '场景状态');
        list.appendChild(head2);
        if (!cards) {
          const w = el('div', 'dash-warn', '控制台模型取不到：' + ((model && model.__err) || '无数据') + '（下面按场景列表兜底显示）');
          list.appendChild(w);
        }
        const rows = cards || (sceneList || []).map(function (s) {
          return { id: s.id, name: s.name, status: '', bound: false, sessionTitle: '', preview: '', glow: false };
        });
        if (!rows.length) {
          list.appendChild(el('div', 'dash-empty-line', '还没有场景。'));
        } else {
          rows.forEach(function (c) {
            const row = el('div', 'dash-row');
            row.appendChild(el('span', 'dash-row-name', c.name || c.id || '—'));
            const st = String(c.status || '');
            const tag = el('span', 'dash-tag ' + (st === 'busy' ? 'busy' : st === 'need' ? 'need' : st === 'done' ? 'done' : 'idle'),
              STATUS_LABEL[st] || (st || '未知'));
            if (c.glow) { tag.classList.add('glow'); tag.title = '有新变化还没看'; }
            row.appendChild(tag);
            const info = el('span', 'dash-row-info',
              c.bound ? ('已钉住 · ' + (c.sessionTitle || '（没写会话名）')) : '未绑定会话');
            row.appendChild(info);
            const pv = String(c.preview || '').replace(/\s+/g, ' ').trim();
            if (pv) {
              const p = el('span', 'dash-row-preview', pv.slice(0, 60));
              p.title = pv;
              row.appendChild(p);
            }
            list.appendChild(row);
          });
        }

        // ---- 会话清单（最多 6 条，按最近活动排）----
        if (sessions.length) {
          list.appendChild(el('div', 'dash-sec-title', '最近会话'));
          sessions.slice().sort(function (a, b) {
            return (Number(b.lastPromptAt) || 0) - (Number(a.lastPromptAt) || 0);
          }).slice(0, 6).forEach(function (s) {
            const row = el('div', 'dash-row');
            row.appendChild(el('span', 'dash-row-name', s.title || s.id || '—'));
            const st = String(s.status || '');
            row.appendChild(el('span', 'dash-tag ' + (st === 'busy' ? 'busy' : st === 'need' ? 'need' : st === 'done' ? 'done' : 'idle'),
              STATUS_LABEL[st] || (st || '未知')));
            row.appendChild(el('span', 'dash-row-info', (Number(s.turns) || 0) + ' 轮' + (s.lastPromptAt ? ' · ' + fmtWhen(s.lastPromptAt) : '')));
            const pv = String(s.preview || '').replace(/\s+/g, ' ').trim();
            if (pv) {
              const p = el('span', 'dash-row-preview', pv.slice(0, 60));
              p.title = pv;
              row.appendChild(p);
            }
            list.appendChild(row);
          });
        }

        lastAt = Date.now();
        subEl.textContent = '每 20 秒自刷 · 上次 ' + fmtWhen(lastAt);
      } catch (e) {
        // 意外异常也要有画面（⛔ 不白屏）
        if (!alive) return;
        subEl.textContent = '读取失败';
        emptyBox('仪表盘读取出错', (e && e.message) || String(e), '重试一次', function () { paint(); });
      } finally {
        busy = false;
        if (alive) refreshBtn.disabled = false;
      }
    }

    refreshBtn.addEventListener('click', function () { paint(); });

    // 自动周期 20 秒：窗口不可见就跳过（省得后台空转），回来自动补一次。
    timer = setInterval(function () {
      if (document.hidden) return;
      paint();
    }, 20000);
    // 切回前台补一次（隐藏期间的周期被跳过了）
    const onVis = function () { if (!document.hidden && Date.now() - lastAt > 20000) paint(); };
    document.addEventListener('visibilitychange', onVis);

    paint();

    return function cleanup() {
      alive = false;
      if (timer) { clearInterval(timer); timer = null; }
      document.removeEventListener('visibilitychange', onVis);
    };
  }

  // ==================== 节点画布（flow）====================
  // 参照项目那版 2611 行，带多画布 / 磁盘快照 / AI 反向填图 / 端口探测 / 模板。那些都依赖本壳没有的
  // 通道（app.file.write、快照目录、btn-refresh），照抄过来只会是一堆死代码。这一版只做**画布本身**：
  //   拖节点、缩放平移、拉线、双击改名、右键增删、自动存 localStorage。
  // 图存在面板自己的 sceneStore 里（按 场景+面板 分键，⛔ 不共享 key —— 否则 A 场景的图和 B 场景串）。
  // 数据形状照参照项目 v2：{ v:2, nodes:[{id,type,name,desc,x,y}], edges:[{from,to}] }
  const FLOW_TYPES = {
    text:   { name: '文案',   icon: '📝', color: '#4f8cff' },
    video:  { name: '视频',   icon: '🎬', color: '#e56b8c' },
    image:  { name: '图片',   icon: '🖼', color: '#8a7bff' },
    audio:  { name: '音频',   icon: '🎵', color: '#3fc0a8' },
    folder: { name: '文件夹', icon: '📁', color: '#e5b355' },
    web:    { name: '网页',   icon: '🌐', color: '#34c98f' },
    note:   { name: '便签',   icon: '💡', color: '#9aa4b2' },
    step:   { name: '工序',   icon: '⚙', color: '#ff9f43' }
  };
  const FLOW_TYPE_ORDER = ['text', 'video', 'image', 'audio', 'folder', 'web', 'step', 'note'];
  function flowTypeOf(t) { return FLOW_TYPES[t] || FLOW_TYPES.text; }

  function renderFlow(body, meta, head) {
    const SVGNS = 'http://www.w3.org/2000/svg';
    const store = sceneStore(meta);
    const panelId = String((meta && meta.id) || 'flow');

    // 图：坏数据一律当空图处理（不抛、不白屏）
    function loadGraph() {
      const raw = store.get(null);
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null;
      const nodes = raw.nodes.filter(function (n) { return n && n.id; }).map(function (n) {
        return {
          id: String(n.id), type: FLOW_TYPES[n.type] ? n.type : 'text',
          name: String(n.name == null ? flowTypeOf(n.type).name : n.name),
          desc: String(n.desc || ''),
          x: Number(n.x) || 0, y: Number(n.y) || 0
        };
      });
      const ids = {};
      nodes.forEach(function (n) { ids[n.id] = 1; });
      const edges = (Array.isArray(raw.edges) ? raw.edges : []).filter(function (e) {
        return e && ids[e.from] && ids[e.to] && e.from !== e.to;
      }).map(function (e) { return { from: String(e.from), to: String(e.to) }; });
      return { v: 2, nodes: nodes, edges: edges };
    }
    let g = loadGraph();
    if (!g) g = { v: 2, nodes: [], edges: [] };
    function save() { store.set(g); }

    let seq = 1;
    function nextId() { while (g.nodes.some(function (n) { return n.id === 'n' + seq; })) seq++; return 'n' + seq++; }
    let view = { x: 20, y: 20, k: 1 };
    let sel = null;
    let nodeEls = {};
    let drag = null;
    let alive = true;

    body.classList.add('flow-panel');
    body.style.flexDirection = 'column';

    const viewport = el('div', 'flow-viewport');
    viewport.tabIndex = 0;
    const world = el('div', 'flow-world');
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'flow-wires');
    const wireLayer = document.createElementNS(SVGNS, 'g');
    svg.appendChild(wireLayer);
    const tempWire = document.createElementNS(SVGNS, 'path');
    tempWire.setAttribute('class', 'flow-wire-temp');
    tempWire.style.display = 'none';
    svg.appendChild(tempWire);
    viewport.appendChild(world);
    viewport.appendChild(svg);

    // ---- 工具条 ----
    const bar = el('div', 'flow-bar');
    const mkBtn = function (label, title) {
      const b = el('button', 'file-refresh', label);
      b.type = 'button';
      b.title = title || '';
      return b;
    };
    const addBtn = mkBtn('＋ 节点 ▾', '加一个节点（选类型）');
    const fitBtn = mkBtn('⤢ 适应', '缩放到能看见全部节点');
    const clrBtn = mkBtn('🗑 清空', '清空整张图（节点和连线都删掉）');
    [addBtn, fitBtn, clrBtn].forEach(function (x) { bar.appendChild(x); });
    const catStat = el('span', 'flow-cat-stat', '');
    bar.appendChild(catStat);
    viewport.appendChild(bar);
    // 标题行小字：这一块有几节点几连线（标题行是空的时候看不出它是什么状态）
    const headSub = setHeadSub(head, '还没有节点');

    // ==================== M9 工作流状态层（派单 f6b6b4baa8）====================
    // ⚠ 与上面的 store 图是**两层东西**：store 存的是"画在画布上的节点/连线"（可拖可加），
    //   这里接的是 外壳\data\workflow\*.json 的**真实工序状态**。
    //   ⛔ 判据（状态机 / 依赖校验）只在 工具\工作流.mjs，这里只显示它的结果。
    let wfFile = String((meta && meta.wfFile) || '');
    let wfData = null;        // 工作流 JSON（含 nodes[].state）
    let wfBusy = false;       // 「开始」演练进行中

    /** 把工作流各节点的 state 贴到画布节点上（按 id 或按名字匹配） */
    function wfApplyStates() {
      const byId = {};
      const byName = {};
      ((wfData && wfData.nodes) || []).forEach(function (n) {
        if (!n) return;
        if (n.id) byId[String(n.id)] = n;
        if (n.name) byName[String(n.name)] = n;
      });
      Object.keys(nodeEls).forEach(function (nid) {
        const d = nodeEls[nid];
        if (!d) return;
        const titleEl = d.querySelector('.flow-node-title');
        const title = titleEl ? String(titleEl.textContent || '').trim() : '';
        const src = byId[nid] || byName[title] || null;
        const st = src && src.state ? String(src.state) : '';
        d.classList.remove('state-pending', 'state-running', 'state-done', 'state-error');
        if (st) d.classList.add('state-' + st);
        d.dataset.wfState = st;
      });
    }

    /** 工作流 JSON → 画布节点（只在画布为空时播种，⛔ 不覆盖用户布局） */
    function wfSeedCanvas() {
      if (!wfData || !Array.isArray(wfData.nodes) || !wfData.nodes.length) return false;
      if (g.nodes.length) return false;          // 画布已有东西 ⇒ 不动

      // 工作流 type → 画布 type（画布类型见 FLOW_TYPES）
      const mapType = function (t) {
        const k = String(t || '').toLowerCase();
        if (k === 'input') return 'input';
        if (k === 'ai') return 'ai';
        if (k === 'output') return 'output';
        if (k === 'tool' || k === 'process') return 'process';
        return 'text';
      };

      const order = wfOrder();
      const seq = {};
      order.forEach(function (id, i) { seq[id] = i; });

      const byWfId = {};
      wfData.nodes.forEach(function (n) {
        if (!n || !n.id) return;
        byWfId[String(n.id)] = n;
      });

      // 一行排开：x = i*230，y 居中
      const seeded = [];
      order.forEach(function (wid, i) {
        const n = byWfId[wid];
        if (!n) return;
        seeded.push({
          id: String(n.id),
          type: mapType(n.type),
          name: String(n.name || n.id),
          desc: String(n.note || ''),
          x: 40 + i * 230,
          y: 60
        });
      });

      // 连线：按 next
      const edges = [];
      wfData.nodes.forEach(function (n) {
        if (!n || !n.id) return;
        (n.next || []).forEach(function (to) {
          if (byWfId[String(to)]) edges.push({ from: String(n.id), to: String(to) });
        });
      });

      g = { v: 2, nodes: seeded, edges: edges };
      save();
      render();
      return true;
    }

    /** 读工作流（没指定文件就取第一个） */
    async function wfLoad() {
      if (!window.kun || !window.kun.wf) return false;
      try {
        if (!wfFile) {
          const r = await window.kun.wf.list();
          const items = (r && r.items) || [];
          if (!items.length) return false;
          wfFile = items[0].file;
        }
        const r2 = await window.kun.wf.load(wfFile);
        if (!r2 || !r2.ok) { say('读工作流失败：' + ((r2 && r2.err) || '未知')); return false; }
        wfData = r2.data;
        // 画布空 ⇒ 按工作流 JSON 播种节点（否则光点没地方显示）
        wfSeedCanvas();
        wfApplyStates();
        return true;
      } catch (e) { say('读工作流异常：' + ((e && e.message) || e)); return false; }
    }

    /** 拓扑序：优先用工作流节点的 next 链；缺失就按数组顺序 */
    function wfOrder() {
      const ns = ((wfData && wfData.nodes) || []).filter(function (n) { return n && n.id; });
      if (!ns.length) return [];
      const indeg = {}, adj = {};
      ns.forEach(function (n) { indeg[n.id] = indeg[n.id] || 0; adj[n.id] = []; });
      ns.forEach(function (n) {
        (n.next || []).forEach(function (t) {
          if (!indeg.hasOwnProperty(t)) return;
          adj[n.id].push(t);
          indeg[t] = (indeg[t] || 0) + 1;
        });
      });
      const q = ns.filter(function (n) { return !indeg[n.id]; }).map(function (n) { return n.id; });
      const out = [];
      while (q.length) {
        const cur = q.shift();
        out.push(cur);
        (adj[cur] || []).forEach(function (t) {
          indeg[t] -= 1;
          if (!indeg[t]) q.push(t);
        });
      }
      // 有环或断链：把没排进去的按原顺序补在后面（不让它卡死）
      ns.forEach(function (n) { if (out.indexOf(n.id) < 0) out.push(n.id); });
      return out;
    }

    /** 改一个节点的状态 —— ★全部交给 工作流.mjs 判依赖★ */
    async function wfMark(nodeId, state) {
      const r = await window.kun.wf.mark(wfFile, nodeId, state);
      if (r && r.ok) {
        // 同步本地副本，画面立刻变
        const n = ((wfData && wfData.nodes) || []).filter(function (x) { return x && String(x.id) === String(nodeId); })[0];
        if (n) n.state = state;
        wfApplyStates();
        return { ok: true };
      }
      // ⛔ 不自己判依赖：把工具的原话显示出来
      const msg = ((r && (r.err || r.out)) || '工作流工具拒绝了这次改动').trim();
      say(msg.split('\n').filter(Boolean).slice(0, 2).join(' · ') || '被拒绝');
      return { ok: false, msg: msg };
    }

    /** ▶ 开始：演练模式（逐个 running → 0.8s → done）。⛔ 不假装真在执行。 */
    async function wfRun() {
      if (wfBusy) { say('正在演练中，先等这一轮跑完'); return; }
      if (!wfData) { if (!(await wfLoad())) { say('没有可用的工作流文件'); return; } }
      const order = wfOrder();
      if (!order.length) { say('这个工作流没有节点'); return; }

      wfBusy = true;
      startBtn.disabled = true;
      startBtn.textContent = '▶ 演练中…';
      let stopped = false;
      // ★跳过已是 done 的节点★（2026-11-21 修）
      //   done 是**终态**：再置 running 会被 工作流.mjs 拒绝（要重跑必须先 --reset）。
      //   实测 bug：n1/n2 已经是 done 时，循环第一步就被拒 ⇒ break ⇒ 整轮一步没走。
      let skipped = 0;
      for (const nid of order) {
        if (!alive) break;
        const cur = ((wfData && wfData.nodes) || []).filter(function (x) { return x && String(x.id) === String(nid); })[0];
        if (cur && cur.state === 'done') { skipped += 1; continue; }
        // 1) 置 running（工具会拦"前置没 done"）
        const r1 = await wfMark(nid, 'running');
        if (!r1.ok) { stopped = true; break; }
        await new Promise(function (r) { setTimeout(r, 800); });
        if (!alive) break;
        // 2) 置 done
        const r2 = await wfMark(nid, 'done');
        if (!r2.ok) { stopped = true; break; }
        await new Promise(function (r) { setTimeout(r, 120); });
      }
      wfBusy = false;
      if (alive) {
        startBtn.disabled = false;
        startBtn.textContent = '▶ 开始';
        say(stopped ? '演练中断（看上面的提示）'
          : ('演练完成' + (skipped ? '（跳过 ' + skipped + ' 个已是 done 的）' : '') + '（演练模式：只走状态，不真执行工序）'));
      }
    }

    // 「▶ 开始」按钮 + 演练说明条
    const drillTip = el('div', 'flow-drill-tip', '演练模式：只演示状态流转，不真正执行工序（视频工序尚未接入）');
    drillTip.style.display = 'none';
    const startBtn = mkBtn('▶ 开始', '按拓扑序逐个演示状态流转（演练模式，不真执行）');
    startBtn.addEventListener('click', function () { wfRun(); });
    bar.appendChild(startBtn);
    viewport.appendChild(drillTip);

    // 面板起来就拉一次状态（光点要能立刻显示）
    wfLoad().then(function (ok) {
      if (ok && alive) {
        const n = ((wfData && wfData.nodes) || []).length;
        headSub.textContent = (wfData.name || wfFile) + ' · ' + n + ' 个工序';
        drillTip.style.display = '';
      }
    });

    const hint = el('div', 'flow-hint', '拖动节点=移动 · 拖动空白=平移 · 滚轮=缩放 · 拖 ● 到另一个节点=连线 · 双击节点=改名 · 右键=菜单');
    const stat = el('div', 'flow-stat', '');
    const toast = el('div', 'flow-toast', '');
    viewport.appendChild(hint);
    viewport.appendChild(stat);
    viewport.appendChild(toast);
    body.appendChild(viewport);

    let toastTimer = null;
    function say(msg) {
      toast.textContent = msg;
      toast.classList.add('on');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.classList.remove('on'); toastTimer = null; }, 1700);
    }

    // 右键菜单 / 添加菜单共用一个容器
    let menuEl = null;
    function closeMenu() {
      if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
      menuEl = null;
    }
    function showMenu(x, y, items) {
      closeMenu();
      const m = el('div', 'flow-menu');
      items.forEach(function (it) {
        if (it.sep) { m.appendChild(el('div', 'flow-menu-sep')); return; }
        const b = el('button', 'flow-menu-item' + (it.danger ? ' danger' : ''), it.label);
        b.type = 'button';
        if (it.off) { b.classList.add('off'); b.disabled = true; }
        else b.addEventListener('click', function (ev) { ev.stopPropagation(); closeMenu(); it.run(); });
        m.appendChild(b);
      });
      viewport.appendChild(m);
      const r = viewport.getBoundingClientRect();
      const mw = m.offsetWidth || 150, mh = m.offsetHeight || 120;
      m.style.left = Math.max(4, Math.min(x, r.width - mw - 4)) + 'px';
      m.style.top = Math.max(4, Math.min(y, r.height - mh - 4)) + 'px';
      menuEl = m;
    }

    function screenToWorld(clientX, clientY) {
      const r = viewport.getBoundingClientRect();
      return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
    }

    // ---- 建一个节点卡片 ----
    function makeNodeEl(n) {
      const t = flowTypeOf(n.type);
      const d = el('div', 'flow-node');
      d.dataset.id = n.id;
      d.style.borderLeftColor = t.color;
      const hd = el('div', 'flow-node-head');
      hd.appendChild(el('span', 'flow-node-icon', t.icon));
      hd.appendChild(el('span', 'flow-node-title', n.name || t.name));
      d.appendChild(hd);
      const note = el('div', 'flow-node-note', n.desc || '');
      if (!n.desc) note.style.display = 'none';
      d.appendChild(note);
      // 接线口：四个面都能拉线
      ['l', 'r', 't', 'b'].forEach(function (side) {
        const p = el('div', 'flow-port flow-port-' + side + (side === 'l' ? ' flow-port-in' : ' flow-port-out'));
        p.dataset.side = side;
        // ⚠ 必须在捕获阶段就拦下：口在 .flow-node 里面，冒泡到节点会触发 startDrag
        // ⇒ drag 被覆盖成 {kind:'node'}，startWire 的 from 丢失，线永远连不上（实测踩过）。
        p.addEventListener('mousedown', function (ev) { startWire(ev, n.id); }, true);
        d.appendChild(p);
      });
      d.addEventListener('mousedown', function (ev) { startDrag(ev, n.id); });
      d.addEventListener('dblclick', function (ev) { ev.stopPropagation(); editNode(n.id); });
      d.addEventListener('contextmenu', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        const r = viewport.getBoundingClientRect();
        showMenu(ev.clientX - r.left, ev.clientY - r.top, [
          { label: '✎ 改名 / 改描述', run: function () { editNode(n.id); } },
          { sep: true },
          { label: '🗑 删掉这个节点', danger: true, run: function () { removeNode(n.id); } }
        ]);
      });
      return d;
    }

    // ---- 画连线（坐标换算成屏幕坐标）----
    function wirePath(a, b) {
      const r = viewport.getBoundingClientRect();
      const ax = a.x * view.k + view.x, ay = a.y * view.k + view.y;
      const bx = b.x * view.k + view.x, by = b.y * view.k + view.y;
      const dx = Math.max(30, Math.abs(bx - ax) * 0.45);
      return 'M ' + ax + ' ' + ay + ' C ' + (ax + dx) + ' ' + ay + ', ' + (bx - dx) + ' ' + by + ', ' + bx + ' ' + by;
    }
    function nodeOut(n) { return { x: n.x + 190, y: n.y + 20 }; }
    function nodeIn(n) { return { x: n.x, y: n.y + 20 }; }
    function byId(id) { return g.nodes.filter(function (n) { return n.id === id; })[0] || null; }

    function drawWires() {
      while (wireLayer.firstChild) wireLayer.removeChild(wireLayer.firstChild);
      g.edges.forEach(function (e, i) {
        const a = byId(e.from), b = byId(e.to);
        if (!a || !b) return;
        const p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('class', 'flow-wire');
        p.setAttribute('d', wirePath(nodeOut(a), nodeIn(b)));
        p.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (window.confirm('删掉这条连线？')) {
            g.edges.splice(i, 1); save(); render();
          }
        });
        wireLayer.appendChild(p);
      });
      // 先把线画出来，再叠节点（线段在节点下面）
      drawWiresLate();
    }
    // 线在 viewport 的 svg 里、节点在 world 里，层级由 appendChild 顺序决定：
    // svg 在 world 之后 append ⇒ 线盖在节点上。所以把 svg 挪到 world 前面。
    function fixLayering() {
      if (svg.nextSibling !== null && viewport.firstChild !== svg) {
        try { viewport.insertBefore(svg, world); } catch (e) { /* ignore */ }
      }
    }
    function drawWiresLate() { fixLayering(); }

    // ---- 重绘 ----
    function render() {
      const seen = {};
      g.nodes.forEach(function (n) {
        seen[n.id] = true;
        let d = nodeEls[n.id];
        if (!d) { d = makeNodeEl(n); nodeEls[n.id] = d; world.appendChild(d); }
        d.style.left = n.x + 'px';
        d.style.top = n.y + 'px';
        const t = flowTypeOf(n.type);
        d.style.borderLeftColor = t.color;
        d.querySelector('.flow-node-icon').textContent = t.icon;
        d.querySelector('.flow-node-title').textContent = n.name || t.name;
        const note = d.querySelector('.flow-node-note');
        note.textContent = n.desc || '';
        note.style.display = n.desc ? '' : 'none';
        d.title = (n.name || t.name) + (n.desc ? '\n' + n.desc : '') + '\n类型：' + t.name
          + '\n双击改名 · 右键菜单 · 拖 ● 连线';
        d.classList.toggle('on', !!(sel && sel.type === 'node' && sel.id === n.id));
      });
      Object.keys(nodeEls).forEach(function (id) {
        if (!seen[id]) {
          try { world.removeChild(nodeEls[id]); } catch (e) { /* ignore */ }
          delete nodeEls[id];
        }
      });
      world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
      drawWires();
      stat.textContent = '节点 ' + g.nodes.length + ' · 连线 ' + g.edges.length + ' · ' + Math.round(view.k * 100) + '%';
      if (headSub) {
        // 有工作流时标题小字要让位给"工序状态"，否则盖掉光点的说明
        if (wfData) {
          const total = ((wfData.nodes) || []).length;
          const doneN = ((wfData.nodes) || []).filter(function (x) { return x && x.state === 'done'; }).length;
          headSub.textContent = (wfData.name || wfFile) + ' · 完成 ' + doneN + '/' + total;
        } else {
          headSub.textContent = g.nodes.length ? ('节点 ' + g.nodes.length + ' · 连线 ' + g.edges.length) : '还没有节点';
        }
      }
      renderCatStat();
      renderEmpty();
      // ★每次重画都要重新贴工作流状态★（新增/删除节点后光点不能丢）
      if (wfData) wfApplyStates();
    }
    function renderCatStat() {
      const cnt = {};
      g.nodes.forEach(function (n) { cnt[n.type] = (cnt[n.type] || 0) + 1; });
      const parts = FLOW_TYPE_ORDER.filter(function (k) { return cnt[k]; }).map(function (k) {
        return flowTypeOf(k).name + ' ' + cnt[k];
      });
      catStat.textContent = parts.join(' · ');
    }
    // 空画布必须显式给一句话（⛔ 不许一片空白）
    let emptyEl = null;
    function renderEmpty() {
      if (g.nodes.length) {
        if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
        emptyEl = null;
        return;
      }
      if (emptyEl) return;
      emptyEl = el('div', 'flow-empty');
      emptyEl.appendChild(el('div', 'ph-title', '画布是空的'));
      emptyEl.appendChild(el('div', 'ph-sub', '点左上「＋ 节点 ▾」加一个，或右键空白处添加。'));
      viewport.appendChild(emptyEl);
    }

    // ---- 拖动节点 ----
    function startDrag(ev, id) {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      const n = byId(id);
      if (!n) return;
      sel = { type: 'node', id: id };
      const startW = screenToWorld(ev.clientX, ev.clientY);
      drag = { kind: 'node', id: id, ox: n.x - startW.x, oy: n.y - startW.y, moved: false };
      try { viewport.focus(); } catch (e) { /* ignore */ }
      render();
    }
    // ---- 拖空白平移 ----
    viewport.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target !== viewport && ev.target !== svg && ev.target !== world) return;
      closeMenu();
      sel = null;
      drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y };
      render();
    });
    // 右键空白处：加节点
    viewport.addEventListener('contextmenu', function (ev) {
      if (ev.target !== viewport && ev.target !== svg && ev.target !== world) return;
      ev.preventDefault();
      const r = viewport.getBoundingClientRect();
      const w = screenToWorld(ev.clientX, ev.clientY);
      showMenu(ev.clientX - r.left, ev.clientY - r.top, FLOW_TYPE_ORDER.map(function (k) {
        const t = flowTypeOf(k);
        return {
          label: t.icon + ' 加一个' + t.name,
          run: function () { addNode(k, w.x, w.y); }
        };
      }));
    });

    // ---- 拉线 ----
    // 连线：用**自己的**状态（不碰共享 drag —— 早先共用 drag 时，节点的 startDrag
    // 会把 drag 覆盖成 {kind:'node'}，导致 onUp 读不到 from，线永远连不上。实测踩过。）
    let wiring = null;
    function startWire(ev, fromId) {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      ev.preventDefault();
      wiring = { from: fromId };

      const onMove = function (e) {
        if (!wiring) return;
        const a = byId(wiring.from);
        if (!a) return;
        const r = viewport.getBoundingClientRect();
        const p1 = nodeOut(a);
        const ax = p1.x * view.k + view.x, ay = p1.y * view.k + view.y;
        const bx = e.clientX - r.left, by = e.clientY - r.top;
        const dx = Math.max(30, Math.abs(bx - ax) * 0.45);
        tempWire.setAttribute('d', 'M ' + ax + ' ' + ay + ' C ' + (ax + dx) + ' ' + ay + ', ' + (bx - dx) + ' ' + by + ', ' + bx + ' ' + by);
        tempWire.style.display = '';
      };
      const onUp = function (e) {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        tempWire.style.display = 'none';
        const from = wiring && wiring.from;
        wiring = null;
        if (!from) return;
        // 落点上找节点（svg 是 pointer-events:none，不会挡住）
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const host = hit && hit.closest ? hit.closest('.flow-node') : null;
        const toId = host && host.dataset ? host.dataset.id : null;
        if (!toId || toId === from) { say('要拖到另一个节点上才算连上'); return; }
        if (g.edges.some(function (x) { return x.from === from && x.to === toId; })) { say('这两点之间已经有一条线了'); return; }
        g.edges.push({ from: from, to: toId });
        save(); render();
        say('已连上');
      };
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
    }

    // ---- 全局 mousemove / mouseup（拖动 / 平移）----
    const onDocMove = function (ev) {
      if (!drag || !alive) return;
      if (drag.kind === 'node') {
        const n = byId(drag.id);
        if (!n) return;
        const w = screenToWorld(ev.clientX, ev.clientY);
        n.x = Math.round(w.x + drag.ox);
        n.y = Math.round(w.y + drag.oy);
        drag.moved = true;
        const d = nodeEls[n.id];
        if (d) { d.style.left = n.x + 'px'; d.style.top = n.y + 'px'; }
        drawWires();
      } else if (drag.kind === 'pan') {
        view.x = drag.vx + (ev.clientX - drag.sx);
        view.y = drag.vy + (ev.clientY - drag.sy);
        world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
        drawWires();
      }
    };
    const onDocUp = function () {
      if (drag && drag.kind === 'node' && drag.moved) save();
      drag = null;
    };
    window.addEventListener('mousemove', onDocMove, true);
    window.addEventListener('mouseup', onDocUp, true);

    // ---- 滚轮缩放 ----
    const onWheel = function (ev) {
      ev.preventDefault();
      const r = viewport.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const before = { x: (mx - view.x) / view.k, y: (my - view.y) / view.k };
      const k2 = Math.min(2.2, Math.max(0.25, view.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
      view.k = k2;
      view.x = mx - before.x * k2;
      view.y = my - before.y * k2;
      world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
      drawWires();
      stat.textContent = '节点 ' + g.nodes.length + ' · 连线 ' + g.edges.length + ' · ' + Math.round(view.k * 100) + '%';
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });

    // ---- 增 / 改 / 删 ----
    function addNode(type, wx, wy) {
      const id = nextId();
      const t = flowTypeOf(type);
      const x = Math.round(wx == null ? 40 + (g.nodes.length % 5) * 30 : wx);
      const y = Math.round(wy == null ? 40 + (g.nodes.length % 5) * 26 : wy);
      g.nodes.push({ id: id, type: type, name: t.name, desc: '', x: x, y: y });
      sel = { type: 'node', id: id };
      save(); render(); closeMenu();
      say('加了「' + t.name + '」，双击可以改名');
    }
    function removeNode(id) {
      g.nodes = g.nodes.filter(function (n) { return n.id !== id; });
      g.edges = g.edges.filter(function (e) { return e.from !== id && e.to !== id; });
      if (sel && sel.id === id) sel = null;
      save(); render();
    }
    // 改名 / 改描述：就地弹一个简单输入（不引第三方组件）
    function editNode(id) {
      const n = byId(id);
      if (!n) return;
      const t = flowTypeOf(n.type);
      const mask = el('div', 'flow-dlg');
      const box = el('div', 'flow-dlg-box');
      box.appendChild(el('div', 'flow-dlg-title', '编辑节点 · ' + t.name));
      const r1 = el('div', 'flow-dlg-row');
      r1.appendChild(el('span', 'flow-dlg-label', '名称'));
      const i1 = document.createElement('input');
      i1.className = 'flow-dlg-input'; i1.type = 'text'; i1.value = n.name || '';
      r1.appendChild(i1);
      const r2 = el('div', 'flow-dlg-row');
      r2.appendChild(el('span', 'flow-dlg-label', '说明'));
      const i2 = document.createElement('input');
      i2.className = 'flow-dlg-input'; i2.type = 'text'; i2.value = n.desc || '';
      i2.placeholder = '可留空';
      r2.appendChild(i2);
      box.appendChild(r1); box.appendChild(r2);
      const btns = el('div', 'flow-dlg-btns');
      const ok = el('button', 'file-refresh primary', '保存');
      ok.type = 'button';
      const cancel = el('button', 'file-refresh', '取消');
      cancel.type = 'button';
      btns.appendChild(cancel); btns.appendChild(ok);
      box.appendChild(btns);
      mask.appendChild(box);
      viewport.appendChild(mask);
      i1.focus(); i1.select();
      const close = function () { if (mask.parentNode) mask.parentNode.removeChild(mask); };
      cancel.addEventListener('click', close);
      const commit = function () {
        const nm = i1.value.trim();
        n.name = nm || t.name;
        n.desc = i2.value.trim();
        save(); render(); close();
      };
      ok.addEventListener('click', commit);
      mask.addEventListener('mousedown', function (ev) { if (ev.target === mask) close(); });
      [i1, i2].forEach(function (inp) {
        inp.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
        });
      });
    }

    // ---- 工具条动作 ----
    addBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      const r = addBtn.getBoundingClientRect();
      const vr = viewport.getBoundingClientRect();
      showMenu(r.left - vr.left, r.bottom - vr.top + 4, FLOW_TYPE_ORDER.map(function (k) {
        const t = flowTypeOf(k);
        return { label: t.icon + ' ' + t.name, run: function () { addNode(k, null, null); } };
      }));
    });
    fitBtn.addEventListener('click', function () {
      if (!g.nodes.length) { view = { x: 20, y: 20, k: 1 }; render(); return; }
      const minX = Math.min.apply(null, g.nodes.map(function (n) { return n.x; }));
      const minY = Math.min.apply(null, g.nodes.map(function (n) { return n.y; }));
      const maxX = Math.max.apply(null, g.nodes.map(function (n) { return n.x + 190; }));
      const maxY = Math.max.apply(null, g.nodes.map(function (n) { return n.y + 60; }));
      const r = viewport.getBoundingClientRect();
      const pad = 28;
      const k = Math.min((r.width - pad * 2) / Math.max(1, maxX - minX), (r.height - pad * 2) / Math.max(1, maxY - minY));
      view.k = Math.min(1.6, Math.max(0.25, k));
      view.x = pad - minX * view.k;
      view.y = pad - minY * view.k;
      render();
    });
    clrBtn.addEventListener('click', function () {
      if (!g.nodes.length && !g.edges.length) { say('已经是空的了'); return; }
      if (!window.confirm('清空整张图？节点和连线都会删掉（只影响这一块面板）。')) return;
      g = { v: 2, nodes: [], edges: [] };
      sel = null; nodeEls = {};
      while (world.firstChild) world.removeChild(world.firstChild);
      save(); render();
      say('已清空');
    });
    // 点空白收起菜单
    document.addEventListener('mousedown', function (ev) {
      if (menuEl && !menuEl.contains(ev.target)) closeMenu();
    }, true);

    render();

    return function cleanup() {
      alive = false;
      closeMenu();
      window.removeEventListener('mousemove', onDocMove, true);
      window.removeEventListener('mouseup', onDocUp, true);
      viewport.removeEventListener('wheel', onWheel);
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    };
  }

  // ==================== 各盘容量（pc-drives）====================
  // 数据源：window.kun.sys.disks()（主进程 statfsSync）。⛔ 渲染层不读盘。
  // 2026-11-20 按用户给的图重做：顶部汇总 + 环形进度卡片 + 危险度图例。
  // 主进程现在返回 C..F 四个固定盘位（不存在的标 missing:true）⇒ 能显示「无此分区」。
  // ==================== 磁盘「跟随」跨面板联动（2026-11-20 派单 7a5f58c15b）====================
  // 面板之间不互相调用（面板通用能力 §5）：走 **单一真源 + 事件**。
  //   · 真源：localStorage['xiodra.drive-follow:<场景id>'] = {letter, mount}
  //   · 事件：'xiodra:drive-select'，detail={sceneId, letter, mount}；mount 为空 = 取消
  //   · pc-drives 写；pc-toplarge 读 + 监听。切场景回来仍然一致（真源在 localStorage）。
  function driveFollowKey(sceneId) {
    return 'xiodra.drive-follow:' + String(sceneId || '');
  }
  function readDriveFollow(sceneId) {
    try {
      const raw = localStorage.getItem(driveFollowKey(sceneId));
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || !j.mount) return null;
      return { letter: String(j.letter || ''), mount: String(j.mount || '') };
    } catch (e) { return null; }
  }
  function writeDriveFollow(sceneId, sel) {
    try {
      if (sel && sel.mount) {
        localStorage.setItem(driveFollowKey(sceneId), JSON.stringify({ letter: sel.letter, mount: sel.mount }));
      } else {
        localStorage.removeItem(driveFollowKey(sceneId));
      }
    } catch (e) { /* 隐私模式等：忽略 */ }
    try {
      window.dispatchEvent(new CustomEvent('xiodra:drive-select', {
        detail: {
          sceneId: String(sceneId || ''),
          letter: sel && sel.mount ? String(sel.letter || '') : '',
          mount: sel && sel.mount ? String(sel.mount) : ''
        }
      }));
    } catch (e) { /* ignore */ }
  }

  function renderPcDrives(body, meta, head) {
    const wrap = el('div', 'pcd-wrap');
    const subEl = setHeadSub(head, '正在读…');
    const refresh = el('button', 'file-btn', '⟳');
    refresh.type = 'button';
    refresh.title = '重新读取磁盘容量';
    addAct(head, refresh);

    const sumBar = el('div', 'pcd-sum');       // ① 顶部汇总条
    const grid = el('div', 'pcd-grid');        // ② 盘卡片网格
    const legend = el('div', 'pcd-legend');    // ③ 底部图例
    wrap.appendChild(sumBar);
    wrap.appendChild(grid);
    wrap.appendChild(legend);
    body.appendChild(wrap);

    let alive = true, busy = false, timer = null;
    let follow = readDriveFollow(meta && meta.scenario);   // 当前"跟随"的盘 {letter, mount} | null

    // 别的面板/窗口改了选中 ⇒ 本面板立刻重画（选中态要跟着变）
    const onDriveSelect = function (ev) {
      const d = (ev && ev.detail) || {};
      if (String(d.sceneId || '') !== String((meta && meta.scenario) || '')) return;
      if (alive) paint();
    };
    window.addEventListener('xiodra:drive-select', onDriveSelect);

    function fmtSize(n) {
      const v = Number(n) || 0;
      if (v <= 0) return '—';
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
      if (v < 1024 * 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(1) + ' GB';
      return (v / 1024 / 1024 / 1024 / 1024).toFixed(2) + ' TB';
    }
    // 危险度：>=90 红 / >=70 黄 / 其余绿（与图例一致）
    function levelOf(pct) { return pct >= 90 ? 'hi' : pct >= 70 ? 'mid' : 'lo'; }
    const LEVEL_TEXT = { lo: '宽裕', mid: '该留意', hi: '该清' };

    // 盘符 → 用途标签（图的写法；可在场景 json 的 meta.diskLabels 覆盖）
    function labelOf(letter) {
      const custom = (meta && meta.diskLabels) || {};
      if (custom[letter]) return custom[letter];
      const M = { C: '系统盘', D: '软件盘', E: '文件盘', F: '游戏盘' };
      return M[letter] || '';
    }

    function emptyBox(title, sub2, btnText, onBtn) {
      grid.textContent = '';
      sumBar.textContent = '';
      legend.textContent = '';
      const box = el('div', 'ph-box');
      box.appendChild(el('div', 'ph-title', title));
      box.appendChild(el('div', 'ph-sub', sub2));
      if (btnText) {
        const b = el('button', 'ph-btn', btnText);
        b.type = 'button';
        b.addEventListener('click', onBtn);
        box.appendChild(b);
      }
      grid.appendChild(box);
    }

    // 环形进度（SVG，无依赖）。pct=null ⇒ 画一个灰色空环
    function ring(pct, lv) {
      const size = 74, stroke = 7;
      const r = (size - stroke) / 2;
      const c = 2 * Math.PI * r;
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'pcd-ring');
      svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));

      const track = document.createElementNS(NS, 'circle');
      track.setAttribute('class', 'pcd-ring-track');
      track.setAttribute('cx', String(size / 2));
      track.setAttribute('cy', String(size / 2));
      track.setAttribute('r', String(r));
      track.setAttribute('fill', 'none');
      track.setAttribute('stroke-width', String(stroke));
      svg.appendChild(track);

      if (pct != null) {
        const val = Math.max(0, Math.min(100, pct));
        const bar = document.createElementNS(NS, 'circle');
        bar.setAttribute('class', 'pcd-ring-bar ' + lv);
        bar.setAttribute('cx', String(size / 2));
        bar.setAttribute('cy', String(size / 2));
        bar.setAttribute('r', String(r));
        bar.setAttribute('fill', 'none');
        bar.setAttribute('stroke-width', String(stroke));
        bar.setAttribute('stroke-linecap', 'round');
        bar.setAttribute('stroke-dasharray', c.toFixed(2));
        bar.setAttribute('stroke-dashoffset', (c * (1 - val / 100)).toFixed(2));
        // 从 12 点方向起画
        bar.setAttribute('transform', 'rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')');
        svg.appendChild(bar);
      }

      const holder = el('div', 'pcd-ring-wrap');
      holder.appendChild(svg);
      holder.appendChild(el('div', 'pcd-ring-text ' + (pct != null ? lv : 'na'),
        pct != null ? (pct + '%') : '—'));
      return holder;
    }

    async function paint() {
      if (busy || !alive) return;
      busy = true;
      refresh.disabled = true;
      // 每次重画都读一次真源 —— 别的面板/别的窗口改了也能跟上
      follow = readDriveFollow(meta && meta.scenario);
      try {
        let r = null;
        try { r = await window.kun.sys.disks(); }
        catch (e) { r = { ok: false, err: (e && e.message) || String(e) }; }
        if (!alive) return;
        if (!r || !r.ok) {
          subEl.textContent = '读不到';
          emptyBox('读不到磁盘容量', (r && r.err) || '主进程没有返回数据。', '重试一次', function () { paint(); });
          return;
        }
        const all = Array.isArray(r.disks) ? r.disks : [];
        if (!all.length) {
          subEl.textContent = '没有盘';
          emptyBox('没有找到任何磁盘', '主进程返回了空列表 —— 可能是权限或平台限制。', '重试一次', function () { paint(); });
          return;
        }

        const present = all.filter(function (d) { return !d.missing && Number(d.total) > 0; });
        const missing = all.filter(function (d) { return d.missing || !Number(d.total); });

        // ---- ① 顶部汇总条 ----
        const sumTotal = present.reduce(function (a, d) { return a + (Number(d.total) || 0); }, 0);
        const sumUsed = present.reduce(function (a, d) { return a + (Number(d.used) || 0); }, 0);
        const sumFree = present.reduce(function (a, d) { return a + (Number(d.free) || 0); }, 0);
        let tight = null;
        present.forEach(function (d) {
          const p = Math.round((Number(d.used) || 0) * 100 / (Number(d.total) || 1));
          if (!tight || p > tight.pct) tight = { name: d.name, pct: p, lv: levelOf(p) };
        });

        sumBar.textContent = '';
        const kv = function (label, value, cls) {
          const w = el('div', 'pcd-sum-item');
          w.appendChild(el('span', 'pcd-sum-k', label));
          w.appendChild(el('span', 'pcd-sum-v' + (cls ? ' ' + cls : ''), value));
          return w;
        };
        sumBar.appendChild(kv('总容量', fmtSize(sumTotal)));
        sumBar.appendChild(kv('已用', fmtSize(sumUsed)));
        sumBar.appendChild(kv('剩余', fmtSize(sumFree)));
        if (tight) {
          sumBar.appendChild(kv('最紧张', tight.name + ' ' + tight.pct + '%', tight.lv));
        }
        const sumRight = el('div', 'pcd-sum-right');
        const now = new Date();
        const p2 = function (x) { return (x < 10 ? '0' : '') + x; };
        sumRight.textContent = present.length + ' 个分区 · 读数 '
          + p2(now.getHours()) + ':' + p2(now.getMinutes()) + ' · 每 60 秒自刷';
        sumBar.appendChild(sumRight);

        // ---- ② 盘卡片网格 ----
        grid.textContent = '';
        all.forEach(function (d) {
          const letter = String(d.letter || String(d.name || '').replace(':', ''));
          const isMissing = !!d.missing || !Number(d.total);
          const total = Number(d.total) || 0;
          const free = Number(d.free) || 0;
          const used = Math.max(0, total - free);
          const pct = total > 0 ? Math.round(used * 100 / total) : 0;
          const lv = levelOf(pct);

          const card = el('div', 'pcd-card' + (isMissing ? ' pcd-card-missing' : ''));

          // ★可点：选中 = 让「磁盘大户排行」只看这个盘★（派单 7a5f58c15b）
          // 再点一次已选中的卡 = 取消（排行榜回上次手选目录，不自动扫）
          if (!isMissing) {
            const sel = follow && follow.mount && String(follow.mount).toUpperCase() === String(d.mount || '').toUpperCase();
            card.classList.add('pcd-card-clickable');
            if (sel) card.classList.add('pcd-card-selected');
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.title = sel ? ('已选中：大户排行只看 ' + letter + ' 盘（再点一次取消）')
              : ('点一下：让「磁盘大户排行」只看 ' + letter + ' 盘');
            const doToggle = function (ev) {
              if (ev) { ev.preventDefault(); ev.stopPropagation(); }
              if (sel) writeDriveFollow(meta && meta.scenario, null);

              else writeDriveFollow(meta && meta.scenario, { letter: letter, mount: d.mount || (letter + ':\\') });
              paint();     // 立刻重画本面板，选中态当场变
            };
            card.addEventListener('click', doToggle);
            card.addEventListener('keydown', function (ev) {
              if (ev.key === 'Enter' || ev.key === ' ') doToggle(ev);
            });
          }

          // 左：环形
          card.appendChild(ring(isMissing ? null : pct, lv));

          // 右：文字区
          const info = el('div', 'pcd-card-info');
          const hd = el('div', 'pcd-card-head');
          hd.appendChild(el('span', 'pcd-card-letter', letter));
          const lb = labelOf(letter);
          if (lb) hd.appendChild(el('span', 'pcd-card-label', lb));
          if (!isMissing && lv === 'hi') {
            const tag = el('span', 'pcd-card-tag hi', '该清');
            tag.title = '已用 ≥90%，建议清理';
            hd.appendChild(tag);
          }
          info.appendChild(hd);

          if (isMissing) {
            const st = el('div', 'pcd-card-rows');
            st.appendChild(el('div', 'pcd-card-missing-text', d.err ? ('读不到：' + d.err) : '无此分区'));
            info.appendChild(st);
          } else {
            const rows = el('div', 'pcd-card-rows');
            const row = function (k, v) {
              const r2 = el('div', 'pcd-card-row');
              r2.appendChild(el('span', 'pcd-card-k', k));
              r2.appendChild(el('span', 'pcd-card-v', v));
              return r2;
            };
            rows.appendChild(row('已用', fmtSize(used)));
            rows.appendChild(row('剩余', fmtSize(free)));
            rows.appendChild(row('总量', fmtSize(total)));
            info.appendChild(rows);

            const bar = el('div', 'pcd-card-bar');
            const fill = el('div', 'pcd-card-fill ' + lv);
            fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
            bar.appendChild(fill);
            info.appendChild(bar);
          }
          card.appendChild(info);
          grid.appendChild(card);
        });

        // ---- ③ 底部图例 ----
        legend.textContent = '';
        const lg = function (lv, text) {
          const w = el('span', 'pcd-legend-item');
          const dot = el('span', 'pcd-legend-dot ' + lv, '');
          w.appendChild(dot);
          w.appendChild(document.createTextNode(text));
          return w;
        };
        legend.appendChild(lg('lo', '<70% 宽裕'));
        legend.appendChild(lg('mid', '70~89% 该留意'));
        legend.appendChild(lg('hi', '≥90% 该清'));
        const lr = el('span', 'pcd-legend-note', '清理纪律：先列清单等你点头 → 直接删（无暂存）');
        legend.appendChild(lr);

        subEl.textContent = present.length + ' 个分区'
          + (missing.length ? (' · ' + missing.length + ' 个无此分区') : '')
          + ' · 每 60 秒自刷';
      } catch (e) {
        if (!alive) return;
        subEl.textContent = '出错';
        emptyBox('读取磁盘容量出错', (e && e.message) || String(e), '重试一次', function () { paint(); });
      } finally {
        busy = false;
        if (alive) refresh.disabled = false;
      }
    }

    refresh.addEventListener('click', function () { paint(); });
    timer = setInterval(function () { if (!document.hidden) paint(); }, 60000);
    paint();

    return function cleanup() {
      alive = false;
      if (timer) { clearInterval(timer); timer = null; }
      try { window.removeEventListener('xiodra:drive-select', onDriveSelect); } catch (e) { /* ignore */ }
    };
  }

  // ==================== 大户排行（pc-toplarge）====================
  // ⚠ 派单要求：**异步 + 可中断 + 有进度**，⛔ 不许同步扫全盘。
  // 做法：scanBegin 拿 token → scanDir 开扫（主进程分批 + setImmediate 让出事件循环）
  //       → 面板卸载/切走立刻 scanAbort（cleanup 里保证）。
  function renderPcTopLarge(body, meta, head) {
    const store = sceneStore(meta);
    const saved = store.get({}) || {};

    const wrap = el('div', 'ptl-wrap');
    const subEl = setHeadSub(head, '选一个目录开始');
    // 只留图标（窄面板放不下带文字的按钮，会把标题挤成竖排）—— 完整说明在 title
    const pickBtn = el('button', 'file-btn', '📁');
    pickBtn.type = 'button';
    pickBtn.title = '选一个目录扫描体积';
    const scanBtn = el('button', 'file-btn', '▶');
    scanBtn.type = 'button';
    scanBtn.title = '开始扫描（可随时中断）';
    scanBtn.disabled = true;
    const stopBtn = el('button', 'file-btn', '■');
    stopBtn.type = 'button';
    stopBtn.title = '立刻停止扫描（不再吃 CPU）';
    stopBtn.disabled = true;
    addAct(head, pickBtn);
    addAct(head, scanBtn);
    addAct(head, stopBtn);

    // 当前目录一行
    let curDir = String((meta && meta.dir) || saved.dir || '');
    const dirRow = el('div', 'ptl-dir');
    const dirText = el('span', 'ptl-dir-text', curDir || '（还没选目录）');
    dirText.title = curDir || '';
    dirRow.appendChild(dirText);
    wrap.appendChild(dirRow);

    // 进度条
    const prog = el('div', 'ptl-prog');
    const progBar = el('div', 'ptl-prog-bar');
    const progFill = el('div', 'ptl-prog-fill');
    progBar.appendChild(progFill);
    const progText = el('span', 'ptl-prog-text', '');
    prog.appendChild(progBar);
    prog.appendChild(progText);
    prog.style.display = 'none';
    wrap.appendChild(prog);

    const list = el('div', 'ptl-list');
    wrap.appendChild(list);
    body.appendChild(wrap);

    let alive = true, scanning = false, token = null, offProg = null;
    // ★跟随选中盘★（派单 7a5f58c15b）：真源在 localStorage，pc-drives 写、这里读
    let follow = readDriveFollow(meta && meta.scenario);

    // 选中变化 ⇒ 立刻同步小字与目标目录；不自动扫（扫盘有代价，必须用户点）
    const onDriveSelect = function (ev) {
      const d = (ev && ev.detail) || {};
      if (String(d.sceneId || '') !== String((meta && meta.scenario) || '')) return;
      if (!alive) return;
      follow = readDriveFollow(meta && meta.scenario);
      applyFollow();
    };
    window.addEventListener('xiodra:drive-select', onDriveSelect);

    function fmtSize(n) {
      const v = Number(n) || 0;
      if (v <= 0) return '0 B';
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
      if (v < 1024 * 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
      return (v / 1024 / 1024 / 1024 / 1024).toFixed(2) + ' TB';
    }

    function emptyBox(title, sub, btnText, onBtn) {
      list.textContent = '';
      const box = el('div', 'ph-box');
      box.appendChild(el('div', 'ph-title', title));
      box.appendChild(el('div', 'ph-sub', sub));
      if (btnText) {
        const b = el('button', 'ph-btn', btnText);
        b.type = 'button';
        b.addEventListener('click', onBtn);
        box.appendChild(b);
      }
      list.appendChild(box);
    }

    function setDir(d) {
      curDir = String(d || '');
      dirText.textContent = curDir || '（还没选目录）';
      dirText.title = curDir || '';
      scanBtn.disabled = !curDir || scanning;
      const s2 = store.get({}) || {};
      s2.dir = curDir;
      store.set(s2);
    }

    async function stop(showMsg) {
      if (!token) return;
      const t = token;
      token = null;
      scanning = false;
      try { await window.kun.fs.scanAbort(t); } catch (e) { /* ignore */ }
      if (offProg) { try { offProg(); } catch (e) { /* ignore */ } offProg = null; }
      stopBtn.disabled = true;
      scanBtn.disabled = !curDir;
      if (showMsg && alive) subEl.textContent = '已停止';
    }

    // 当前扫描目标：跟随中 = 选中的盘；否则 = 手选目录
    function targetDir() {
      if (follow && follow.mount) return follow.mount;
      return curDir;
    }

    // 同步"跟随"相关的小字与按钮可用性
    function applyFollow() {
      if (follow && follow.mount) {
        const lb = follow.letter || String(follow.mount).replace(':\\', '');
        subEl.textContent = '跟随 ' + lb + ': · 待扫描';
        dirText.textContent = '跟随选中盘：' + follow.mount;
        dirText.title = follow.mount;
        scanBtn.disabled = scanning;
      } else {
        dirText.textContent = curDir || '（还没选目录）';
        dirText.title = curDir || '';
        scanBtn.disabled = !curDir || scanning;
        if (!scanning) subEl.textContent = curDir ? '点「▶ 扫描」开始' : '选一个目录开始';
      }
    }

    async function scan() {
      const tgt = targetDir();
      if (scanning || !tgt) return;
      if (!window.kun || !window.kun.fs || !window.kun.fs.scanDir) {
        emptyBox('这个外壳还没有扫描通道', '主进程缺 fs:scan-dir。需要重启 Electron 让 main.js 生效。', null, null);
        return;
      }
      scanning = true;
      scanBtn.disabled = true;
      pickBtn.disabled = true;
      stopBtn.disabled = false;
      subEl.textContent = '扫描中…';
      prog.style.display = '';
      progFill.style.width = '0%';
      progText.textContent = '准备…';
      list.textContent = '';

      let r = null;
      try {
        const b = await window.kun.fs.scanBegin();
        if (!b || !b.ok) throw new Error((b && b.err) || '拿不到扫描 token');
        token = b.token;
        // 进度订阅（主进程每扫完一个子项发一次）
        offProg = window.kun.fs.onScanProgress(function (p) {
          if (!alive || !p || p.token !== token) return;
          // 顶层项数进度（粗）
          const pct = p.total ? Math.min(100, Math.round(p.done * 100 / p.total)) : 0;
          progFill.style.width = pct + '%';
          // ★二级进度★：显示"已扫字节 / 已扫文件数"，否则全量扫 C 盘时进度条几乎不动
          const parts = [];
          parts.push(p.done + ' / ' + p.total + ' · ' + pct + '%');
          if (p.bytes) parts.push('已扫 ' + fmtSize(p.bytes));
          if (p.files) parts.push(p.files.toLocaleString() + ' 文件');
          if (p.phase === 'deep' && p.inner) parts.push('正在 ' + p.inner);
          progText.textContent = parts.join(' · ');
        });
        // ★全量扫★：预算 120 万（C 盘实测 841,840 文件；200 万上限留余量），
        // maxDepth: 0 = 不限深度（用户明确否掉"限深 1 层"）
        r = await window.kun.fs.scanDir(targetDir(), { token: token, maxDepth: 0, maxFiles: 1200000 });
      } catch (e) {
        r = { ok: false, err: (e && e.message) || String(e) };
      }

      const wasAborted = r && r.aborted;
      if (token) { try { await window.kun.fs.scanAbort(token); } catch (e) { /* ignore */ } token = null; }
      if (offProg) { try { offProg(); } catch (e) { /* ignore */ } offProg = null; }
      scanning = false;
      if (!alive) return;
      pickBtn.disabled = false;
      stopBtn.disabled = true;
      scanBtn.disabled = !curDir;
      prog.style.display = 'none';

      if (!r || !r.ok) {
        subEl.textContent = '扫描失败';
        emptyBox('扫描失败', (r && r.err) || '主进程没返回数据。', '再试一次', function () { scan(); });
        return;
      }

      const rows = Array.isArray(r.rows) ? r.rows : [];
      if (!rows.length) {
        subEl.textContent = wasAborted ? '已中断（还没扫到东西）' : '这个目录是空的';
        emptyBox(wasAborted ? '扫描已中断' : '这个目录里没有子项',
          wasAborted ? '点「▶ 扫描」可以重新开始。' : '换一个目录试试。', null, null);
        return;
      }

      // 只显示前 20 个（大户排行，够了），并画占比条
      const maxSize = rows.reduce(function (m, x) { return Math.max(m, Number(x.size) || 0); }, 0) || 1;
      const totalSize = rows.reduce(function (a, x) { return a + (Number(x.size) || 0); }, 0);
      list.textContent = '';
      rows.slice(0, 20).forEach(function (x) {
        const row = el('div', 'ptl-row');
        const top = el('div', 'ptl-row-top');
        top.appendChild(el('span', 'ptl-row-name', x.name + (x.isDir ? '/' : '')));
        top.appendChild(el('span', 'ptl-row-size', fmtSize(x.size)));
        row.appendChild(top);
        const bar = el('div', 'ptl-row-bar');
        const fill = el('div', 'ptl-row-fill');
        fill.style.width = Math.max(1, Math.round((Number(x.size) || 0) * 100 / maxSize)) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        list.appendChild(row);
      });
      const tail = el('div', 'ptl-tail',
        '共 ' + rows.length + ' 项 · 合计 ' + fmtSize(totalSize)
        + (wasAborted ? ' · ⚠ 已中断（数字偏小）' : '')
        + (r.overBudget ? ' · ⚠ 达到文件数上限（数字偏小）' : ''));
      list.appendChild(tail);
      // 跟随中：小字要写清"跟随哪个盘 + 它自身的占用比"（派单要求的画面判据）
      if (follow && follow.mount) {
        const lb = follow.letter || String(follow.mount).replace(':\\', '');
        let pctTxt = '';
        try {
          const dk = await window.kun.sys.disks();
          const dd = ((dk && dk.disks) || []).filter(function (x) {
            return String(x.mount || '').toUpperCase() === String(follow.mount).toUpperCase();
          })[0];
          if (dd && Number(dd.total) > 0) {
            pctTxt = ' · ' + Math.round(Number(dd.used) * 100 / Number(dd.total)) + '%';
          }
        } catch (e) { /* ignore */ }
        subEl.textContent = '跟随 ' + lb + ':' + pctTxt
          + (wasAborted ? ' · 已中断' : '')
          + ' · ' + fmtSize(totalSize);
        const tag = el('span', 'ptl-follow-pct', '跟随 ' + lb + ':');
        void tag;
      } else {
        subEl.textContent = wasAborted ? ('已中断 · ' + rows.length + ' 项') : (rows.length + ' 项 · ' + fmtSize(totalSize));
      }
    }

    pickBtn.addEventListener('click', async function () {
      try {
        const d = await window.kun.dialog.pickFolder(curDir || '');
        if (!alive || !d) return;
        setDir(d);
        subEl.textContent = '已选目录，点「▶ 扫描」开始';
      } catch (e) { /* 用户取消 */ }
    });
    scanBtn.addEventListener('click', function () { scan(); });
    stopBtn.addEventListener('click', function () { stop(true); });

    // 起来时：先把"跟随"状态画出（切场景回来仍然一致 —— 用户要求记住）
    if (follow && follow.mount) {
      applyFollow();
      emptyBox('已跟随 ' + (follow.letter || follow.mount) + ' 盘',
        '扫描目标：' + follow.mount + '\n点「▶ 扫描」看哪个子目录最占地方（全量扫，可随时中断）。',
        '▶ 扫描', function () { scan(); });
    }

    // 起来时：有上次的目录就提示一句，但不自动扫（扫盘有代价，必须用户主动点）
    if (follow && follow.mount) {
      // 已在上面处理
    } else if (curDir) {
      dirText.textContent = curDir;
      scanBtn.disabled = false;
      subEl.textContent = '点「▶ 扫描」开始';
      emptyBox('还没扫描', '目录：' + curDir + '\n点「▶ 扫描」看哪个子目录最占地方。', '▶ 扫描', function () { scan(); });
    } else {
      emptyBox('先选一个目录', '点标题行「📁 选目录」，或双击面板配置目录。\n扫描会限深 2 层、可随时中断。', '📁 选目录', function () { pickBtn.click(); });
    }

    return function cleanup() {
      alive = false;
      // ★必须中断★：切走面板就停，别让后台继续吃 CPU（派单明确要求）
      if (token) { try { window.kun.fs.scanAbort(token); } catch (e) { /* ignore */ } token = null; }
      if (offProg) { try { offProg(); } catch (e) { /* ignore */ } offProg = null; }
      try { window.removeEventListener('xiodra:drive-select', onDriveSelect); } catch (e) { /* ignore */ }
    };
  }

  // ==================== 组合容器（combo）====================
  // 一个面板里分几块，每块挂一个已有渲染器。不依赖主进程数据。
  // 配置：meta.cells = [{ type, title, url?, path? }]，或 meta.combo = [...]
  // 缺省：上下两块，上 dash 下 flow —— 保证一挂上就有画面（⛔ 不留白）。
  function renderCombo(body, meta, head) {
    const META_MAP = window.__dshKit && window.__dshKit.typeDefOf ? window.__dshKit.typeDefOf : null;
    const reg = window.APP_RENDERERS || {};

    // 取配置：cells > combo > 默认
    let cells = Array.isArray(meta && meta.cells) ? meta.cells
      : (Array.isArray(meta && meta.combo) ? meta.combo : null);
    if (!cells || !cells.length) {
      cells = [{ type: 'dash', title: '仪表盘' }, { type: 'flow', title: '节点画布' }];
    }
    // 只收"有渲染器"的类型，避免一格空白
    const usable = cells.filter(function (c) { return c && typeof reg[c.type] === 'function'; });
    const dropped = cells.length - usable.length;

    const subEl = setHeadSub(head, usable.length + ' 块' + (dropped ? (' · ' + dropped + ' 块没有渲染器') : ''));

    const wrap = el('div', 'combo-wrap');
    wrap.style.gridTemplateRows = 'repeat(' + Math.max(1, usable.length) + ', minmax(0, 1fr))';
    body.appendChild(wrap);

    if (!usable.length) {
      const box = el('div', 'ph-box');
      box.appendChild(el('div', 'ph-title', '组合容器里没有可用的块'));
      box.appendChild(el('div', 'ph-sub',
        '配置项 cells 里写的类型都还没渲染器（已实现：'
        + Object.keys(reg).join(' / ') + '）。\n在场景 json 的该面板里写 cells: [{ "type": "dash" }] 试试。'));
      wrap.appendChild(box);
      return;
    }

    const cleanups = [];
    usable.forEach(function (cell, i) {
      const cellEl = el('div', 'combo-cell');
      cellEl.dataset.cellType = cell.type || '';
      // 每块自己的小标题（组合容器里需要知道这块是什么）
      if (cell.title || cell.type) {
        const h = el('div', 'combo-cell-head');
        h.appendChild(el('span', 'combo-cell-title', cell.title || cell.type));
        const td = META_MAP ? META_MAP(cell.type) : null;
        if (td && td.label) h.appendChild(el('span', 'combo-cell-type', td.label));
        cellEl.appendChild(h);
      }
      const cellBody = el('div', 'combo-cell-body');
      cellBody.dataset.kind = cell.type || '';
      cellEl.appendChild(cellBody);
      wrap.appendChild(cellEl);

      // 子渲染器拿到的 meta：继承外层，但 id 要区分开（sceneStore 才不会串）
      const childMeta = Object.assign({}, meta, cell, {
        id: String(meta.id || 'combo') + '-' + i,
        type: cell.type,
        title: cell.title || (META_MAP && META_MAP(cell.type) ? META_MAP(cell.type).label : cell.type)
      });
      // 子面板不需要自己的标题行按钮，给一个空 head 占位即可
      const childHead = el('div', 'panel-head');
      childHead.style.display = 'none';
      try {
        const c = reg[cell.type](cellBody, childMeta, childHead);
        if (typeof c === 'function') cleanups.push(c);
        else if (c && typeof c.then === 'function') {
          c.then(function (cc) { if (typeof cc === 'function') cleanups.push(cc); }).catch(function () { /* ignore */ });
        }
      } catch (e) {
        cellBody.appendChild(el('div', 'stat-sub', '这一块渲染失败: ' + ((e && e.message) || e)));
      }
    });

    return function cleanup() {
      cleanups.forEach(function (c) { try { c(); } catch (e) { /* ignore */ } });
    };
  }

  // ==================== 可清理项（pc-junk）====================
  // 展示"哪些能清"。判据**不在这里** —— 唯一出处是 工具\垃圾判据.mjs。
  // 面板通过主进程跑它（pc:junk-scan），拿到 safe / ask 两组，按危险度分组显示。
  // ⛔ 不做"删除按钮"：本轮只做展示（派单边界），真要清由清理流程去做。
  function renderPcJunk(body, meta, head) {
    const wrap = el('div', 'pcj-wrap');
    const subEl = setHeadSub(head, '正在读…');
    const refresh = el('button', 'file-btn', '⟳');
    refresh.type = 'button';
    refresh.title = '重新扫一遍（只列不删）';
    addAct(head, refresh);
    const list = el('div', 'pcj-list');
    wrap.appendChild(list);
    body.appendChild(wrap);

    let alive = true, busy = false;

    function fmtSize(n) {
      const v = Number(n) || 0;
      if (v <= 0) return '0 B';
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
      return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function emptyBox(title, sub2, btnText, onBtn) {
      list.textContent = '';
      const box = el('div', 'ph-box');
      box.appendChild(el('div', 'ph-title', title));
      box.appendChild(el('div', 'ph-sub', sub2));
      if (btnText) {
        const b = el('button', 'ph-btn', btnText);
        b.type = 'button';
        b.addEventListener('click', onBtn);
        box.appendChild(b);
      }
      list.appendChild(box);
    }

    // 一组（safe / ask）→ 一块可折叠区
    function paintGroup(name, items, tone) {
      const box = el('div', 'pcj-group');
      const hd = el('div', 'pcj-group-head');
      hd.appendChild(el('span', 'pcj-group-name ' + tone, name));
      hd.appendChild(el('span', 'pcj-group-count', items.length + ' 项'));
      box.appendChild(hd);
      if (!items.length) {
        box.appendChild(el('div', 'pcj-none', '（这一类没有东西）'));
      } else {
        items.slice(0, 40).forEach(function (x) {
          const row = el('div', 'pcj-row');
          row.appendChild(el('span', 'pcj-row-rule', x.rule || '?'));
          const nm = el('span', 'pcj-row-path', String(x.path || '').split(/[\\/]/).slice(-2).join('/'));
          nm.title = x.path || '';
          row.appendChild(nm);
          row.appendChild(el('span', 'pcj-row-label', x.label || ''));
          row.appendChild(el('span', 'pcj-row-size', fmtSize(x.size)));
          box.appendChild(row);
        });
        if (items.length > 40) {
          box.appendChild(el('div', 'pcj-none', '… 还有 ' + (items.length - 40) + ' 项没列出'));
        }
      }
      list.appendChild(box);
    }

    async function paint() {
      if (busy || !alive) return;
      busy = true;
      refresh.disabled = true;
      try {
        if (!window.kun || !window.kun.pc || !window.kun.pc.junkScan) {
          subEl.textContent = '缺通道';
          emptyBox('这个外壳还没有垃圾判据通道',
            '主进程缺 pc:junk-scan。需要重启 Electron 让 main.js 生效。', null, null);
          return;
        }
        // 工具实测单次 75 秒（要遍历整棵工作台）⇒ 必须先给可见提示，
        // 否则面板一直空着，看起来就像卡死了。续 75 秒后自动套上真数据。
        subEl.textContent = '扫描中…';
        list.textContent = '';
        const waitBox = el('div', 'ph-box');
        waitBox.appendChild(el('div', 'ph-title', '正在扫描…'));
        waitBox.appendChild(el('div', 'ph-sub', '第一次扫描要几十秒（要遍历整棵工作台），结果会缓存 10 分钟。'));
        list.appendChild(waitBox);
        let r = null;
        try { r = await window.kun.pc.junkScan(); }
        catch (e) { r = { ok: false, err: (e && e.message) || String(e) }; }
        if (!alive) return;
        if (!r || !r.ok) {
          subEl.textContent = '读不到';
          emptyBox('读不到垃圾判据', (r && r.err) || '主进程没返回数据。', '重试一次', function () { paint(); });
          return;
        }
        const safe = Array.isArray(r.safe) ? r.safe : [];
        const ask = Array.isArray(r.ask) ? r.ask : [];
        list.textContent = '';
        paintGroup('可清理（safe）', safe, 'safe');
        paintGroup('要问一下（ask）', ask, 'ask');

        const tail = el('div', 'pcj-tail');
        tail.appendChild(el('div', '', '根目录：' + (r.root || '?')));
        tail.appendChild(el('div', '', '可清合计：' + fmtSize(r.totalBytes && r.totalBytes.safe)
          + ' · 待确认：' + fmtSize(r.totalBytes && r.totalBytes.ask)
          + ' · 受保护：' + (Number(r.neverCount) || 0) + ' 类'));
        tail.appendChild(el('div', 'pcj-tip', '判据唯一出处：工具\\垃圾判据.mjs（这里只显示，不删）'));
        list.appendChild(tail);

        subEl.textContent = 'safe ' + safe.length + ' · ask ' + ask.length
          + ' · 可清 ' + fmtSize(r.totalBytes && r.totalBytes.safe)
          + (r.cached ? (' · 缓存 ' + Math.round((r.ageMs || 0) / 60000) + '分钟前') : '');
      } catch (e) {
        if (!alive) return;
        subEl.textContent = '出错';
        emptyBox('读垃圾判据出错', (e && e.message) || String(e), '重试一次', function () { paint(); });
      } finally {
        busy = false;
        if (alive) refresh.disabled = false;
      }
    }

    refresh.addEventListener('click', function () { paint(); });
    paint();

    return function cleanup() { alive = false; };
  }

  // ==================== 清理台账（pc-ledger）====================
  // 只读展示 外壳\data\pc-cleanup-log.json（只追加，永不改）。倒序显示最新在前。
  function renderPcLedger(body, meta, head) {
    const wrap = el('div', 'pcl-wrap');
    const subEl = setHeadSub(head, '正在读…');
    const refresh = el('button', 'file-btn', '⟳');
    refresh.type = 'button';
    refresh.title = '重新读台账';
    addAct(head, refresh);
    const list = el('div', 'pcl-list');
    wrap.appendChild(list);
    body.appendChild(wrap);

    let alive = true, busy = false;

    function fmtSize(n) {
      const v = Number(n) || 0;
      if (v <= 0) return '0 B';
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
      return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function fmtAt(iso) {
      const t = Date.parse(iso || '');
      if (!Number.isFinite(t)) return String(iso || '');
      const d = new Date(t);
      const p2 = function (x) { return (x < 10 ? '0' : '') + x; };
      return (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }
    function emptyBox(title, sub2, btnText, onBtn) {
      list.textContent = '';
      const box = el('div', 'ph-box');
      box.appendChild(el('div', 'ph-title', title));
      box.appendChild(el('div', 'ph-sub', sub2));
      if (btnText) {
        const b = el('button', 'ph-btn', btnText);
        b.type = 'button';
        b.addEventListener('click', onBtn);
        box.appendChild(b);
      }
      list.appendChild(box);
    }

    async function paint() {
      if (busy || !alive) return;
      busy = true;
      refresh.disabled = true;
      try {
        if (!window.kun || !window.kun.pc || !window.kun.pc.ledger) {
          subEl.textContent = '缺通道';
          emptyBox('这个外壳还没有台账通道', '主进程缺 pc:ledger。需要重启 Electron。', null, null);
          return;
        }
        let r = null;
        try { r = await window.kun.pc.ledger('read'); }
        catch (e) { r = { ok: false, err: (e && e.message) || String(e) }; }
        if (!alive) return;
        if (!r || !r.ok) {
          subEl.textContent = '读不到';
          emptyBox('读不到清理台账', (r && r.err) || '主进程没返回数据。', '重试一次', function () { paint(); });
          return;
        }
        const rows = Array.isArray(r.rows) ? r.rows : [];
        if (!rows.length) {
          subEl.textContent = '还没有记录';
          emptyBox('台账还是空的',
            '这里只**追加**、不删改 —— 每次清理都会记一行，删了不可回滚。\n文件：' + (r.file || ''),
            null, null);
          return;
        }
        list.textContent = '';
        let total = 0;
        rows.slice().reverse().slice(0, 100).forEach(function (row) {
          total += Number(row.bytes) || 0;
          const it = el('div', 'pcl-row');
          const top = el('div', 'pcl-top');
          top.appendChild(el('span', 'pcl-at', fmtAt(row.at)));
          top.appendChild(el('span', 'pcl-size', fmtSize(row.bytes)));
          if (row.kind) top.appendChild(el('span', 'pcl-kind', row.kind));
          it.appendChild(top);
          const p = el('div', 'pcl-path', row.path || '');
          p.title = row.path || '';
          it.appendChild(p);
          if (row.note) it.appendChild(el('div', 'pcl-note', row.note));
          list.appendChild(it);
        });
        subEl.textContent = rows.length + ' 条' + (rows.length > 100 ? '（只显示最近 100）' : '')
          + ' · 合计 ' + fmtSize(total);
      } catch (e) {
        if (!alive) return;
        subEl.textContent = '出错';
        emptyBox('读台账出错', (e && e.message) || String(e), '重试一次', function () { paint(); });
      } finally {
        busy = false;
        if (alive) refresh.disabled = false;
      }
    }

    refresh.addEventListener('click', function () { paint(); });
    paint();

    return function cleanup() { alive = false; };
  }

  // ==================== 注册表 ====================
  // 只有真做过的类型才登记。没登记的 type 由 renderer.js 画「未知面板类型」，不会报错。
  window.APP_RENDERERS = {
    console: renderConsole,
    harness: renderHarness,
    placeholder: renderPlaceholder,
    reserved: renderReserved,
    embed: renderEmbedWeb,
    web: renderEmbedWeb,
    view: renderView,
    file: renderFile,
    dash: renderDash,
    flow: renderFlow,
    combo: renderCombo,
    'pc-drives': renderPcDrives,
    'pc-toplarge': renderPcTopLarge,
    'pc-junk': renderPcJunk,
    'pc-ledger': renderPcLedger
  };

  // 给 renderer.js 用的工具（面板外壳、建元素）
  window.__dshKit = {
    el: el,
    makePanel: makePanel,
    fmtDur: fmtDur,
    STATUS_LABEL: STATUS_LABEL,
    loadPanelTypes: loadPanelTypes,
    typeDefOf: typeDefOf,
    hasRenderer: hasRenderer,
    openPanelConfig: openPanelConfig,
    renderPlaceholder: renderPlaceholder,
    sceneStore: sceneStore,
    setPanelBeam: setPanelBeam,
    expandPanel: expandPanel,
    collapsePanel: collapsePanel,
    fmtSize: fmtSize,
    iconOfFile: iconOfFile
  };
})();
