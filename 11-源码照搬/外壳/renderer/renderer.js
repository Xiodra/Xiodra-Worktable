// renderer.js —— 外壳渲染层（纯 JS，无构建；改完重开窗口就生效）
// 职责：
//   1. 自绘标题栏（拖动靠 CSS 的 -webkit-app-region，这里只管三个按钮 + 版本卡）
//   2. 场景标签栏：场景 0「DSH 引擎」固定最前（引擎 Web UI，跑在 webview 里）+
//      scenarios\*.json 里的每个场景各占一个标签（点开 = 在 #grid 里组装面板）
//   3. 启动加载页：画进度 → 引擎就绪后把 <webview> 指过去 → 淡出
// 设计：引擎界面跑在 <webview partition="persist:harness"> 里，**不再用 location.replace 整页跳走** ——
//       整页跳走会把外壳自己的顶栏和标签栏一起丢掉（那是上一版的做法，本轮改掉）。
// 场景机制照搬文档《场景配置格式》：加场景 = 往 scenarios\ 丢一个 json，
//       文件名必须等于里面的 id；切场景 = 整块重建网格（旧面板的 cleanup 会被调用）。
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  const el = {
    // 标题栏
    brand: document.querySelector('.brand'),
    tip: $('brand-tip'),
    verEngine: $('ver-engine'),
    verGui: $('ver-gui'),
    verRuntime: $('ver-runtime'),
    verDir: $('ver-dir'),
    btnMin: $('btn-min'),
    btnMax: $('btn-max'),
    btnClose: $('btn-close'),
    btnRefresh: $('btn-refresh'),
    btnRestart: $('btn-restart'),
    btnTheme: $('btn-theme'),
    // 场景栏
    tabsNav: $('scenario-tabs'),
    statusDot: $('status-dot'),
    statusText: $('status-text'),
    // 视图
    webview: $('harness-webview'),
    grid: $('grid'),
    // 弹窗 / 轻提示
    mask: $('modal-mask'),
    modalTitle: $('modal-title'),
    modalBody: $('modal-body'),
    modalFoot: $('modal-foot'),
    modalX: $('modal-x'),
    // 启动页
    overlay: $('boot-overlay'),
    bar: $('boot-bar-in'),
    stage: $('boot-stage'),
    pct: $('boot-pct'),
    detail: $('boot-detail'),
    retry: $('boot-retry'),
    refreshBoot: $('boot-refresh'),
    bootLog: $('boot-log'),
    foot: $('boot-foot')
  };

  // 场景 0 是硬编码的引擎场景（不来自 scenarios\*.json，也不能被删）
  const HARNESS_ID = 'harness';
  const ICON_ENGINE = 'assets/deepseek-whale.png';

  let curPct = 0;
  let overlayDone = false;
  let harnessWatchTimer = null;

  // 场景状态
  let scenes = [];               // 主进程给的精简列表 [{id,name,description,icon,first,panelCount}]
  let curScene = HARNESS_ID;     // 当前场景 id
  let activeCleanups = [];       // 当前场景里各面板注册的 cleanup（切场景时逐个调用）
  let scenLoadToken = 0;         // 防止快速连点导致旧场景的异步结果覆盖新场景

  const kKit = function () { return window.__dshKit || {}; };
  const kRender = function () { return window.APP_RENDERERS || {}; };
  function mkEl(tag, cls, text) { const k = kKit(); return k.el ? k.el(tag, cls, text) : document.createElement(tag); }

  // ==================== 状态行（场景栏右侧那个小灯） ====================
  function setStatus(text, mode) {
    if (el.statusText) el.statusText.textContent = text;
    if (!el.statusDot) return;
    el.statusDot.className = 'status-dot' + (mode ? ' ' + mode : '');
  }

  // ==================== 轻提示 ====================
  let toastTimer = null;
  function toast(msg) {
    let box = $('toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast';
      box.className = 'toast';
      document.body.appendChild(box);
    }
    box.textContent = String(msg || '');
    box.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('show'); }, 2600);
  }

  // ==================== 弹窗 ====================
  function openModal(opts) {
    if (!el.mask) return;
    opts = opts || {};
    if (el.modalTitle) el.modalTitle.textContent = opts.title || '';
    if (el.modalBody) {
      el.modalBody.textContent = '';
      if (opts.body) el.modalBody.appendChild(opts.body);
    }
    if (el.modalFoot) {
      el.modalFoot.textContent = '';
      if (opts.foot) el.modalFoot.appendChild(opts.foot);
    }
    el.mask.classList.add('show');
  }
  function closeModal() {
    if (el.mask) el.mask.classList.remove('show');
  }

  // ==================== 启动页进度 ====================
  function paintBoot(st) {
    if (!st || !el.overlay) return;
    if (typeof st.pct === 'number' && st.pct > curPct) {
      curPct = Math.min(100, st.pct);
      if (el.bar) el.bar.style.width = curPct + '%';
      if (el.pct) el.pct.textContent = curPct + '%';
    }
    if (st.text && el.stage) el.stage.textContent = st.text;
    if (st.detail && el.detail) el.detail.textContent = String(st.detail).replace(/token=[^&\s]+/g, 'token=***');
    const isErr = st.stage === 'error';
    el.overlay.classList.toggle('err', isErr);
    if (el.retry) el.retry.style.display = isErr ? '' : 'none';
    if (el.bootLog) el.bootLog.style.display = isErr ? '' : 'none';
  }

  // 收起加载页（引擎界面已渲染出来 或 兜底超时）
  function finishBoot() {
    if (overlayDone) return;
    overlayDone = true;
    curPct = 100;
    if (el.bar) el.bar.style.width = '100%';
    if (el.pct) el.pct.textContent = '100%';
    if (el.stage) el.stage.textContent = '已就绪';
    if (el.overlay) el.overlay.classList.add('hide');
  }

  // ==================== 版本信息 ====================
  async function paintVersion() {
    try {
      const v = await window.kun.version();
      if (el.verEngine) el.verEngine.textContent = v.engine || '—';
      if (el.verGui) el.verGui.textContent = v.gui || '—';
      if (el.verRuntime) {
        el.verRuntime.textContent = 'Electron ' + (v.electron || '?') + ' · Chromium ' + (v.chrome || '?')
          + ' · Node ' + (v.node || '?') + ' · 端口 ' + (v.port || '?');
      }
      if (el.verDir) el.verDir.textContent = '引擎目录 ' + (v.engineDir || '—');
      if (el.foot) {
        el.foot.textContent = [
          '引擎 ' + (v.engine || '?') + ' · CLI ' + (v.cli || '?') + ' · 端口 ' + (v.port || '?'),
          'Electron ' + (v.electron || '?') + ' · Chromium ' + (v.chrome || '?'),
          '数据目录 ' + (v.dshHome || '?')
        ].join('\n');
      }
    } catch (e) { /* 版本拿不到不影响启动 */ }
  }

  // ==================== 标题栏 ====================
  function initTitlebar() {
    if (el.btnMin) el.btnMin.addEventListener('click', function () { window.kun.win.min(); });
    if (el.btnClose) el.btnClose.addEventListener('click', function () { window.kun.win.close(); });

    if (el.btnMax) {
      el.btnMax.addEventListener('click', async function () {
        const max = await window.kun.win.toggleMax();
        el.btnMax.textContent = max ? '❐' : '□';
      });
    }
    // 最大化状态可能被双击标题栏 / 系统快捷键改变，靠 resize 同步按钮字形
    window.addEventListener('resize', async function () {
      try {
        const max = await window.kun.win.isMax();
        if (el.btnMax) el.btnMax.textContent = max ? '❐' : '□';
      } catch (e) { /* ignore */ }
    });

    // 主题按钮（壁纸 / 外观）：开关由 theme.js 负责，这里只同步"抽屉开着"的按下态
    if (el.btnTheme) {
      el.btnTheme.addEventListener('click', function () {
        // theme.js 的监听在本文件之前注册（<script> 顺序），它已经把抽屉开/关了，
        // 这里用 setTimeout 0 读最终状态，免得和它抢同一次点击的先后。
        setTimeout(function () {
          const d = document.getElementById('theme-drawer');
          el.btnTheme.classList.toggle('on', !!(d && d.classList.contains('show')));
        }, 0);
      });
    }

    // 版本卡：品牌区是 no-drag（能收 hover），纯 CSS :hover 就够，这里不再挂 JS

    // ⟳ 刷新当前场景：
    //   引擎场景 → 重设 webview 的 src（等价于"切走再切回来"，不动引擎里的会话）
    //   普通场景 → 重载场景 json 并重建面板（改了 json 之后看效果就按这个）
    if (el.btnRefresh) {
      el.btnRefresh.addEventListener('click', function () {
        if (curScene === HARNESS_ID) { reloadHarness(); return; }
        loadScenario(curScene, true);
        toast('已重载场景「' + (sceneName(curScene) || curScene) + '」');
      });
    }

    // 🔄 重启外壳（2026-11-25 Xiodra 要求）：
    //   收掉引擎 + 重拉一个新实例。⚠ 会中断当前会话，这是预期行为。
    //   实现全在主进程（app:restart）——由 restart-helper.ps1 从外部完成重启，
    //   ⛔ 因为"被杀的进程不能自己重启自己"（2026-11-23 踩过，见 main.js 注释）。
    //   不做二次确认：Xiodra 要的是"一键重启"，误点代价是等约 30~60 秒重启回来。
    if (el.btnRestart) {
      el.btnRestart.addEventListener('click', function () {
        toast('正在重启外壳…（约 30~60 秒，期间窗口会消失）');
        // 先让上面这句 toast 画出来一帧，再发重启（主进程 300ms 后就会 exit）
        setTimeout(function () {
          try {
            Promise.resolve(window.kun.app.restart()).then(function (r) {
              if (!r || !r.ok) toast('重启失败：' + ((r && r.err) || '未知原因'));
            }).catch(function (e) {
              toast('重启失败：' + ((e && e.message) || e));
            });
          } catch (e) {
            toast('重启失败：' + ((e && e.message) || e));
          }
        }, 80);
      });
    }

    // 弹窗关闭
    if (el.modalX) el.modalX.addEventListener('click', closeModal);
    if (el.mask) {
      el.mask.addEventListener('click', function (ev) {
        if (ev.target === el.mask) closeModal();
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && el.mask && el.mask.classList.contains('show')) closeModal();
    });
  }

  // ==================== 场景标签栏 ====================
  // 结构照抄参照项目 07-顶栏与菜单栏\1-建标签（外壳侧）.js：
  //   <button class="tab" data-sc-id="..."><span class="tab-ico">…</span><span class="tab-label">…</span></button>
  // icon 是图片路径就建 <img class="tab-ico-img">，否则当 emoji 写字。
  // 场景 0 固定最前、不可拖（不设 data-movable）。
  function tabIconNode(icon, fallback) {
    const ico = document.createElement('span');
    ico.className = 'tab-ico';
    const s = String(icon || '');
    const isImg = s && (/^data:image\//i.test(s) || /\.(png|ico|jpe?g|webp|svg)$/i.test(s));
    if (isImg) {
      const img = document.createElement('img');
      img.className = 'tab-ico-img';
      img.src = s;
      img.alt = '';
      img.onerror = function () { ico.textContent = fallback || '🧱'; };
      ico.appendChild(img);
    } else {
      ico.textContent = s || fallback || '🧱';
    }
    return ico;
  }

  function makeTab(id, name, icon, active, movable) {
    const t = document.createElement('button');
    t.className = 'tab' + (active ? ' active' : '');
    t.dataset.scId = id;
    t.title = name;
    t.appendChild(tabIconNode(icon, id === HARNESS_ID ? '🕹' : '🧱'));
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = name;
    t.appendChild(label);
    // ⚠ 不设 t.draggable —— HTML5 DnD 拖标签会顺手切场景；拖拽走指针事件（见下）
    if (movable) t.dataset.movable = '1';
    t.addEventListener('click', function () { goScene(id); });
    return t;
  }

  function buildTabs() {
    if (!el.tabsNav) return;
    el.tabsNav.textContent = '';

    // 场景 0：引擎
    el.tabsNav.appendChild(makeTab(HARNESS_ID, 'DSH 引擎', ICON_ENGINE, curScene === HARNESS_ID, false));

    // 其余场景：按主进程给的顺序（first=true 的已经排在最前）
    for (const s of scenes) {
      el.tabsNav.appendChild(makeTab(s.id, s.name || s.id, s.icon || '', curScene === s.id, true));
    }
    initTabDrag();
    // 标签重建后要重新量宽度（新建的场景名长短不一），再按当前选中状态收一遍
    measureTabWidths();
    applyTabCollapse(null);
    initTabCollapse();
    // 标签重建后立刻补一次"工作中"状态（光效不能等下一轮轮询）
    syncTabWorking();
  }

  // ★把"场景是否工作中"同步到标签栏★（2026-11-20）
  // 数据来自 window.kun.console.model() 的 cards[].status —— 'busy' 就是工作中。
  // ⛔ 不改主进程、不新增 IPC：控制器卡片用的就是这份数据。
  // 只加/摘 class，光效全在 CSS 里（静态 box-shadow + 只动 opacity）。
  let tabWorkingTimer = null;
  const WORKING_STATUS = { busy: true, need: true };   // 工作中 / 待我决定 都算"有事在跑"
  async function syncTabWorking() {
    if (!el.tabsNav) return;
    let cards = [];
    try {
      const m = await window.kun.console.model();
      cards = (m && m.cards) || [];
    } catch (e) { cards = []; }
    const working = {};
    for (const c of cards) {
      if (c && c.id && WORKING_STATUS[String(c.status || '')]) working[c.id] = true;
    }
    el.tabsNav.querySelectorAll('.tab').forEach(function (t) {
      const on = !!working[t.dataset.scId];
      t.classList.toggle('tab-working', on);
      if (on) {
        const lb = t.querySelector('.tab-label');
        t.title = (lb ? lb.textContent : t.dataset.scId) + ' · 工作中';
      }
    });
  }
  function startTabWorkingPoll() {
    if (tabWorkingTimer) return;
    syncTabWorking();
    // 20 秒一轮即可：状态变化不需要秒级（引擎侧本来就有缓存）
    tabWorkingTimer = setInterval(function () {
      if (!document.hidden) syncTabWorking();
    }, 20000);
  }

  async function reloadTabs() {
    try {
      scenes = (await window.kun.scenarios.list()) || [];
    } catch (e) {
      scenes = [];
    }
    // 当前场景被删掉了 → 退回引擎场景
    if (curScene !== HARNESS_ID && !scenes.some(function (s) { return s.id === curScene; })) {
      curScene = HARNESS_ID;
      showView(HARNESS_ID);
    }
    buildTabs();
  }

  function sceneName(id) {
    if (id === HARNESS_ID) return 'DSH 引擎';
    const s = scenes.find(function (x) { return x.id === id; });
    return s ? s.name : id;
  }

  function goScene(id) {
    curScene = id;
    if (el.tabsNav) {
      el.tabsNav.querySelectorAll('.tab').forEach(function (x) {
        x.classList.toggle('active', x.dataset.scId === id);
      });
    }
    // 选中的那个要展开，其余（鼠标也没停在上面的）收起
    if (typeof applyTabCollapse === 'function') applyTabCollapse(null);
    showView(id);
    if (id === HARNESS_ID) loadHarness();
    else loadScenario(id, false);
  }
  window.__dshGoScene = goScene;
  window.__dshReloadTabs = reloadTabs;
  window.__dshOpenModal = openModal;
  // ==================== 顶栏负载胶囊（CPU / GPU / 内存）====================
  // Xiodra 2026-11-21 要求：每秒刷新一次。
  // 数据来自 main.js 的 sys:load（主进程**不常驻定时器**，只有这边轮询才去采）。
  // ⛔ 取不到的项显示「—」，不许编数字。

  /** 值 → 档位（绿/黄/红）。判据只写这一处。 */
  function loadLevel(pct) {
    if (pct == null || !isFinite(pct)) return '';
    if (pct >= 85) return 'lv-hi';
    if (pct >= 60) return 'lv-mid';
    return 'lv-ok';
  }

  function paintOne(id, text, pct) {
    const box = document.getElementById(id);
    if (!box) return;
    const v = box.querySelector('.lc-v');
    if (v) v.textContent = text;
    box.classList.remove('lv-ok', 'lv-mid', 'lv-hi');
    const lv = loadLevel(pct);
    if (lv) box.classList.add(lv);
  }

  let loadTimer = null;
  let loadBusy = false;

  async function refreshLoad() {
    if (loadBusy) return;                 // 上一轮还没回来就别叠加
    loadBusy = true;
    try {
      const r = await window.kun.sys.load();

      // --- CPU ---
      const cpu = (r && r.cpu) || {};
      const cpuPct = typeof cpu.pct === 'number' ? cpu.pct : null;
      paintOne('lc-cpu', cpuPct == null ? '—' : Math.round(cpuPct) + '%', cpuPct);

      // --- GPU ---
      const gpu = (r && r.gpu) || {};
      if (gpu.available && typeof gpu.pct === 'number') {
        paintOne('lc-gpu', Math.round(gpu.pct) + '%', gpu.pct);
      } else {
        paintOne('lc-gpu', '—', null);    // ⛔ 读不到就是「—」，不写 0%
      }

      // --- 内存 ---
      const mem = (r && r.mem) || {};
      const memPct = typeof mem.pct === 'number' ? mem.pct : null;
      paintOne('lc-mem', memPct == null ? '—' : Math.round(memPct) + '%', memPct);

      // --- 悬停详情（判据：鼠标放上去能看到明细）---
      const cap = document.getElementById('load-capsule');
      if (cap) {
        const lines = [];
        lines.push('CPU ' + (cpuPct == null ? '读不到' : cpuPct.toFixed(1) + '%（' + (cpu.cores || '?') + ' 核）'));
        if (gpu.available) {
          lines.push('GPU ' + (gpu.pct == null ? '?' : gpu.pct + '%')
            + (gpu.usedMB != null ? '　显存 ' + gpu.usedMB + '/' + gpu.totalMB + ' MB' : '')
            + (gpu.name ? '　' + gpu.name : ''));
        } else {
          lines.push('GPU 读不到：' + (gpu.err || '没有 nvidia-smi'));
        }
        if (memPct != null) {
          lines.push('内存 ' + memPct.toFixed(1) + '%　' + mem.usedGB.toFixed(1) + ' / ' + mem.totalGB.toFixed(1) + ' GB');
        } else {
          lines.push('内存 读不到');
        }
        lines.push('（每秒刷新）');
        cap.title = lines.join('\n');
      }
    } catch (e) {
      // 通道没接通（老 preload）⇒ 全部显示「—」，不影响其它功能
      paintOne('lc-cpu', '—', null);
      paintOne('lc-gpu', '—', null);
      paintOne('lc-mem', '—', null);
      const cap = document.getElementById('load-capsule');
      if (cap) cap.title = '负载通道不可用：' + ((e && e.message) || e) + '\n（多半要重启 Electron 让 main.js/preload.js 生效）';
    } finally {
      loadBusy = false;
    }
  }

  function startLoadCapsule() {
    if (loadTimer) return;
    refreshLoad();
    loadTimer = setInterval(refreshLoad, 1000);   // ★每秒一次★
  }

  // 页面隐藏时停（⛔ 后台不该每秒跑一次采 nvidia-smi，那会自己把 CPU/GPU 吃掉）
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (loadTimer) { clearInterval(loadTimer); loadTimer = null; }
    } else {
      startLoadCapsule();
    }
  });

  startLoadCapsule();


  // ==================== M7 顶栏三按钮：插件 / 技能 / 工具 ====================
  // 照搬参照《淋雨家的工作台》renderer.js 的 showPlugins / showSkills / showTools。
  // ⛔ 数据全部来自主进程（plugins:list / skills:list / tools:catalog），渲染层不读盘。

  function mkRow(cls, text) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  /** 通用：拿数据 → 画列表。失败一律显示原因，⛔ 不许留白 */
  function renderList(title, note, loader, paintItem, emptyText) {
    const body = mkRow('m7-body');
    body.appendChild(mkRow('m7-note', '正在读取…'));
    openModal({ title: title, body: body });
    Promise.resolve()
      .then(loader)
      .then(function (r) {
        body.textContent = '';
        if (r && r.error) {
          body.appendChild(mkRow('m7-note m7-err', '读不到：' + r.error));
          return;
        }
        const items = (r && r.items) || [];
        const head = mkRow('m7-note');
        head.textContent = note(r || {});
        body.appendChild(head);
        if (!items.length) {
          body.appendChild(mkRow('m7-note', emptyText || '（空）'));
          return;
        }
        for (const it of items) body.appendChild(paintItem(it));
      })
      .catch(function (e) {
        body.textContent = '';
        body.appendChild(mkRow('m7-note m7-err', '加载失败：' + ((e && e.message) || e)));
      });
  }

  /** 一张卡片：名字 + 版本/体积徽标 + 一句话用途 + 路径 */
  function m7Card(title, badge, desc, p, extra) {
    const card = mkRow('m7-card');
    const top = mkRow('m7-top');
    top.appendChild(mkRow('m7-name', title));
    if (badge) top.appendChild(mkRow('m7-badge', badge));
    if (p) {
      const open = document.createElement('button');
      open.className = 'm7-open';
      open.textContent = '打开目录';
      open.title = '在系统里打开所在目录';
      open.addEventListener('click', function () {
        try { window.kun.skills.open(p); } catch (e) { /* ignore */ }
      });
      top.appendChild(open);
    }
    card.appendChild(top);
    card.appendChild(mkRow('m7-desc', desc || '（没写说明）'));
    if (extra) card.appendChild(mkRow('m7-path', extra));
    if (p) card.appendChild(mkRow('m7-path', p));
    return card;
  }

  // ---- 插件 ----
  function showPluginsModal() {
    renderList('插件（Plugins）',
      function (r) { return '插件目录：' + (r.dir || '') + ' · 共 ' + ((r.items || []).length) + ' 个'; },
      function () {
        return window.kun.plugins.list().then(function (r) {
          return {
            dir: r.pluginsDir, error: r.error,
            items: (r.plugins || []).map(function (p) { return p; }),
          };
        });
      },
      function (p) {
        const extra = [p.cacheDir ? '🗄 缓存：' + p.cacheDir : '', p.configDir ? '⚙ 配置：' + p.configDir : '']
          .filter(Boolean).join('　');
        return m7Card(p.displayName || p.name, p.version ? 'v' + p.version : '未登记版本', p.description, p.path, extra);
      },
      '插件目录下暂无自定义插件。');
  }

  // ---- 技能 ----
  function showSkillsModal() {
    renderList('技能（Skills）',
      function (r) { return '技能目录：' + (r.dir || '') + ' · 共 ' + ((r.items || []).length) + ' 个'; },
      function () {
        return window.kun.skills.list().then(function (r) {
          return {
            dir: r.skillsDir, error: r.error,
            items: (r.skills || []).map(function (s) { return s; }),
          };
        });
      },
      function (s) {
        // 触发词从 description 里抽（铁律②要求索引里有触发词）
        const m = String(s.description || '').match(/触发词[：:]\s*(.+)$/);
        const trig = m ? m[1].trim().replace(/[。.]$/, '') : '';
        const desc = String(s.description || '').replace(/触发词[：:].*$/, '').trim();
        return m7Card(s.name, (s.bytes / 1024).toFixed(1) + ' KB', desc, s.path, trig ? '🔑 触发：' + trig : '⚠ 没写触发词');
      },
      'skills 目录下暂无技能。');
  }

  // ---- 工具 ----
  function showToolsModal() {
    renderList('工具（Tools）',
      function (r) { return '工具目录：' + (r.dir || '') + ' · 共 ' + ((r.items || []).length) + ' 个脚本'; },
      function () {
        return window.kun.tools.catalog().then(function (r) {
          return {
            dir: r.toolsDir, error: r.error,
            items: (r.tools || []).map(function (x) { return x; }),
          };
        });
      },
      function (x) {
        const badge = (x.internal ? '内部共用 · ' : '') + (x.bytes / 1024).toFixed(1) + ' KB';
        return m7Card(x.name + '.mjs', badge, x.description, x.path, '');
      },
      '工具目录下暂无脚本。');
  }

  // ---- 绑定按钮 ----
  // ---- MCP（派单 f6b6b4baa8 【二】）----
  // 数据来源：profiles/<profile>/package.json 的 bundles → 各 bundle 的 cordis.patch.yml
  // 里引用 dsh-mcp-client 的条目（主进程 mcp:list 已实测读到 iconfont / stdio）
  function showMcpModal() {
    renderList('MCP 服务',
      function (r) {
        return '扫描了 ' + ((r.dirsScanned || []).length) + ' 个 profile · 共 ' + ((r.items || []).length) + ' 个 MCP 服务';
      },
      function () {
        return window.kun.mcp.list().then(function (r) {
          return { error: r.error, items: (r.items || []).map(function (m) { return m; }) };
        });
      },
      function (m) {
        return m7Card(
          m.serverName || '(未命名)',
          m.transport || '',
          '来自 bundle「' + m.bundle + '」（profile: ' + m.profile + '）',
          '',
          '📄 配置：' + m.patchPath
        );
      },
      '没有配置任何 MCP 服务（或没找到配置位置）'
    );
  }

  // ---- 模型与提供方（派单 f6b6b4baa8 【三】）----
  // ★脱敏★：只显示"已配 / 未配" + 环境变量名，界面上绝不出现 key 内容
  function showModelsModal() {
    renderList('模型与提供方',
      function (r) {
        const ps = r.providers || [];
        return '共 ' + ps.length + ' 个提供方 · 已配凭据 ' + ps.filter(function (p) { return p.hasKey; }).length + ' 个';
      },
      function () {
        return window.kun.models.list().then(function (r) {
          return { error: r.error, items: (r.providers || []).map(function (p) { return p; }) };
        });
      },
      function (p) {
        const models = (p.models || []);
        const desc = models.length ? ('模型 ' + models.length + ' 个：' + models.join(' / ')) : '（没登记模型）';
        return m7Card(
          p.name,
          p.hasKey ? '已配凭据' : '未配凭据',
          desc,
          '',
          (p.baseURL ? '🌐 ' + p.baseURL + '　' : '') + (p.envName ? '🔑 环境变量：' + p.envName : '')
        );
      },
      '没有找到任何 provider 配置'
    );
  }

  (function bindM7() {
    const bind = function (id, fn) {
      const b = document.getElementById(id);
      if (!b) return;
      b.addEventListener('click', function () { try { fn(); } catch (e) { /* ignore */ } });
    };
    bind('btn-plugins', showPluginsModal);
    bind('btn-skills', showSkillsModal);
    bind('btn-tools', showToolsModal);
    bind('btn-mcp', showMcpModal);
    bind('btn-models', showModelsModal);
  })();


  window.__dshCloseModal = closeModal;
  window.__dshToast = toast;

  // 面板配置弹窗要知道"这个场景现在几列"（文档《布局与网格》：越界会生成隐式列，得提前说清楚）
  window.__dshGridMeta = function () {
    const t = (el.grid && el.grid.style.gridTemplateColumns) || '';
    const m = /repeat\(\s*(\d+)/.exec(t);
    return { cols: m ? Math.max(1, parseInt(m[1], 10)) : 4, scene: curScene };
  };

  function showView(id) {
    const viewId = id === HARNESS_ID ? 'harness-view' : 'scenario-view';
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === viewId);
    });
  }

  // ---- 标签栏折叠（照搬 07-顶栏与菜单栏\tabbar.css 的行为）----
  // 只有「选中的」和「鼠标正停在上面」的标签显示标题，其余收成只留图标（33px）。
  // 展开时的宽度与标题宽度必须**先量好写进 CSS 变量**，收起时才有对应数值可收缩，
  // 否则 max-width:none → 0 没有可插值的中间态，会瞬切而不是滑进去。
  const TAB_COLLAPSED_W = 33;   // 17px 图标 + 7px×2 内边距 + 2px 边框

  function tabList() {
    return el.tabsNav ? Array.prototype.slice.call(el.tabsNav.querySelectorAll('.tab')) : [];
  }

  // 量一遍：把每个标签展开态的真实宽度写进 --tab-w / --label-w。
  // ⚠ 量之前必须先摘掉 .tab-collapsed 与两个变量，否则量到的是收起后的宽度。
  function measureTabWidths() {
    const tabs = tabList();
    if (!tabs.length) return;
    for (const t of tabs) {
      t.classList.remove('tab-collapsed');
      t.style.removeProperty('--tab-w');
      t.style.removeProperty('--label-w');
    }
    for (const t of tabs) {
      const w = Math.ceil(t.getBoundingClientRect().width);
      if (!w) continue;
      t.style.setProperty('--tab-w', (w + 1) + 'px');   // +1：边框/取整误差，避免文字被裁 1px
      const lab = t.querySelector('.tab-label');
      if (lab) {
        // ⚠ 余量：scrollWidth 是整数、字体渲染有小数进位，+1 实测仍会差 1~2px（选中标签文字被截）。
        // 给 3px 余量最稳：既不会明显变宽，也不会截字。
        const PAD = 3;
        t.style.setProperty('--label-w', (Math.ceil(lab.scrollWidth) + PAD) + 'px');
      }
      t.style.setProperty('--tab-cw', TAB_COLLAPSED_W + 'px');
    }
  }

  // ★改字体/字号后必须重测标签宽度★（2026-11-20 用户报：换字体后选中标签的文字溢出）
  // 原因：--label-w 是**一次性量出来的**（scrollWidth），字体一换，旧宽度就不对了，
  // 而 .tab-label 的 max-width 卡着旧值 ⇒ 文字被截或溢出。这里给主题层一个重测入口。
  window.__dshRemeasureTabs = function () {
    try {
      // 让浏览器先按新字体完成排版，再量
      requestAnimationFrame(function () {
        try { measureTabWidths(); } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  };

  // 按「当前选中 + 鼠标位置」重算哪些标签收起。keepOpen = 鼠标停着的那个标签。
  function applyTabCollapse(keepOpen) {
    for (const t of tabList()) {
      const open = t === keepOpen
        || t.classList.contains('active')
        || t.classList.contains('tab-dragging');
      t.classList.toggle('tab-collapsed', !open);
    }
  }

  function initTabCollapse() {
    const nav = el.tabsNav;
    if (!nav || nav.getAttribute('data-tabcollapse') === 'v1') return;   // 幂等：重复 init 会叠监听器
    nav.setAttribute('data-tabcollapse', 'v1');

    // 用事件委托（mouseover/mouseout 冒泡），标签重建后不用重新绑
    nav.addEventListener('mouseover', function (ev) {
      const t = ev.target.closest ? ev.target.closest('.tab') : null;
      if (t) applyTabCollapse(t);
    });
    nav.addEventListener('mouseout', function (ev) {
      const t = ev.target.closest ? ev.target.closest('.tab') : null;
      if (!t) return;
      // 在同一个标签内部移动也会触发 mouseout，这种不算移出
      if (ev.relatedTarget && t.contains(ev.relatedTarget)) return;
      applyTabCollapse(null);
    });
  }

  // ---- 标签拖拽排序（指针事件 + setPointerCapture，不用 HTML5 DnD）----
  // 顺序的唯一权威在主进程（data\scene-tab-order.json）：这里只算出新顺序报上去，
  // 自己不存 —— 两份顺序同时存，迟早打架，重启后还会复位。
  function initTabDrag() {
    const nav = el.tabsNav;
    if (!nav || nav.getAttribute('data-tabbar') === 'v1') return;   // 幂等：重复 init 会让监听器叠加
    nav.setAttribute('data-tabbar', 'v1');

    let drag = null;   // { id, el, startX, fromIndex }

    // 固定位（不可被拖到的位置）：场景 0 永远第一
    const fixedCount = 1;

    function tabList() { return Array.prototype.slice.call(nav.querySelectorAll('.tab')); }

    function dropIndexAt(x) {
      const tabs = tabList();
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) return i;
      }
      return tabs.length;
    }

    // 拖动目标位钳制：固定区（场景 0）不许被挤走
    function clampTarget(target) {
      return Math.max(fixedCount, Math.min(target, tabList().length));
    }

    nav.addEventListener('pointerdown', function (ev) {
      const tab = ev.target.closest ? ev.target.closest('.tab') : null;
      if (!tab || tab.dataset.movable !== '1') return;
      if (ev.button !== 0) return;
      drag = { id: tab.dataset.scId, el: tab, startX: ev.clientX, moved: false };
      try { tab.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });

    nav.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      const dx = ev.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < 5) return;     // 小抖动不当拖拽，避免误触
      drag.moved = true;
      drag.el.classList.add('tab-dragging');
      nav.classList.add('tabs-dragging');
      drag.el.style.transform = 'translateX(' + dx + 'px)';
    });

    nav.addEventListener('pointerup', function (ev) {
      if (!drag) return;
      const d = drag;
      drag = null;
      try { d.el.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      d.el.classList.remove('tab-dragging');
      nav.classList.remove('tabs-dragging');
      d.el.style.transform = '';
      if (!d.moved) return;                             // 没真拖，保持原来的点击行为

      const tabs = tabList();
      const from = tabs.findIndex(function (t) { return t.dataset.scId === d.id; });
      if (from < 0) return;
      let to = clampTarget(dropIndexAt(ev.clientX));
      if (to > from) to -= 1;                           // 摘掉自己之后的落点
      if (to === from) return;

      // 只把 scenarios 的顺序报上去（场景 0 不在 scenarios 里，天然固定最前）
      const sceneOrder = tabs
        .map(function (t) { return t.dataset.scId; })
        .filter(function (id) { return id !== HARNESS_ID; });
      sceneOrder.splice(sceneOrder.indexOf(d.id), 1);
      sceneOrder.splice(Math.max(0, to - 1), 0, d.id);

      window.kun.scenarios.setOrder(sceneOrder).then(function () {
        reloadTabs().then(function () { toast('标签顺序已保存'); });
      }).catch(function () { reloadTabs(); });
    });

    nav.addEventListener('pointercancel', function () {
      if (!drag) return;
      drag.el.classList.remove('tab-dragging');
      nav.classList.remove('tabs-dragging');
      drag.el.style.transform = '';
      drag = null;
    });
  }

  // ==================== 场景面板网格 ====================
  // 照搬文档与参照项目的 loadScenario：
  //   ① 先跑上一个场景的 cleanup（清定时器，否则切走还在跑）
  //   ② 读场景 json → 算列数（cols 与面板实际占位取大者）
  //   ③ 逐面板建壳 + 按 type 查渲染器 → 没注册就画灰字「未知面板类型」
  //   ④ 面板对象注入 scenario 字段（面板知道自己属于哪个场景）
  async function loadScenario(id, forceReload) {
    if (!el.grid) return;

    const token = ++scenLoadToken;

    for (const fn of activeCleanups) {
      try { fn(); } catch (e) { /* 一个面板的 cleanup 失败不能连累别的 */ }
    }
    activeCleanups = [];

    let sc = null;
    try { sc = await window.kun.scenarios.get(id); } catch (e) { sc = null; }
    if (token !== scenLoadToken) return;               // 期间用户又切了场景，丢弃这次结果
    if (!sc) {
      el.grid.textContent = '';
      el.grid.appendChild(mkEl('div', 'stat-sub', '场景读不出来：scenarios\\' + id + '.json（文件不存在或 JSON 写坏了）'));
      return;
    }

    const panels = Array.isArray(sc.panels) ? sc.panels : [];
    const wantCols = Math.round(Number(sc.cols)) || 4;
    const needCols = panels.reduce(function (m, p) {
      return Math.max(m, (Number(p.col) || 1) + (Number(p.w) || 2) - 1);
    }, 0);
    const gridCols = Math.max(wantCols, needCols);
    if (needCols > wantCols) {
      console.warn('[grid] 场景 ' + id + ' 的面板占到第 ' + needCols + ' 列，超过 cols=' + wantCols + '，已按 ' + gridCols + ' 列渲染');
    }
    el.grid.style.gridTemplateColumns = gridCols === 4 ? '' : 'repeat(' + gridCols + ', 1fr)';
    // 越界只留控制台告警：场景底部状态栏已按要求删除，界面上不再显示列数

    el.grid.textContent = '';
    if (!panels.length) {
      el.grid.appendChild(mkEl('div', 'stat-sub', '这个场景还没有面板。在 scenarios\\' + id + '.json 里加 panels。'));
      return;
    }

    const renderers = kRender();
    panels.forEach(function (p, i) {
      p.scenario = sc.id;                              // 场景隔离：面板知道自己属于哪个场景
      // bindToScene：这个对话窗口跟随「场景绑定的那条会话」（控制器右侧那块就是它）。
      // 场景级 sessionId / sessionTitle / pinTarget 是给控制器卡片看的摘要，
      // 面板渲染器只认面板自己的三字段 —— 在这里抄一份，改绑定时主进程也会同步（见 patchScenario）。
      if (p.bindToScene) {
        if (!p.sessionId && sc.sessionId) p.sessionId = sc.sessionId;
        if (!p.sessionTitle && sc.sessionTitle) p.sessionTitle = sc.sessionTitle;
        if (!p.pinTarget && sc.pinTarget) p.pinTarget = sc.pinTarget;
      }
      // 场景级 projectDir 是"这个场景的活儿在哪个文件夹"。
      // file 面板的「📌 项目文件夹」按钮要能直接跳过去，所以没自己配的继承场景的。
      if (!p.projectDir && (p.type === 'file' || p.type === 'view') && sc.projectDir) {
        p.projectDir = sc.projectDir;
      }
      const kit = kKit();
      let parts;
      if (kit.makePanel) {
        parts = kit.makePanel(p, i);
      } else {
        // 兜底（renderers.js 没加载成功时也不至于整页崩）
        const wrap = document.createElement('section');
        wrap.className = 'panel';
        wrap.style.gridColumn = (p.col ? p.col + ' / span ' : 'span ') + (p.w || 2);
        wrap.style.gridRow = (p.row ? p.row + ' / span ' : 'span ') + (p.h || 2);
        const head = document.createElement('div'); head.className = 'panel-head';
        const title = document.createElement('span'); title.className = 'panel-title'; title.textContent = p.title || p.id;
        head.appendChild(title);
        const body = document.createElement('div'); body.className = 'panel-body'; body.dataset.kind = p.type || '';
        wrap.appendChild(head); wrap.appendChild(body);
        parts = { wrap: wrap, body: body, head: head };
      }

      const fn = renderers[p.type];
      if (typeof fn === 'function') {
        try {
          const cleanup = fn(parts.body, p, parts.head);
          if (typeof cleanup === 'function') activeCleanups.push(cleanup);
          // 渲染器可以是 async（面板选择器要拉类型目录）：返回 Promise<cleanup> 也要收
          else if (cleanup && typeof cleanup.then === 'function') {
            cleanup.then(function (c) { if (typeof c === 'function') activeCleanups.push(c); }).catch(function () { /* ignore */ });
          }
        } catch (err) {
          parts.body.appendChild(mkEl('div', 'stat-sub', '面板渲染失败: ' + ((err && err.message) || err)));
          console.error('[panel] ' + p.id + ' 渲染失败', err);
        }
      } else {
        // 类型没登记渲染器时分两种：目录里有（只是还没写）vs 连目录里都没有（写错字了）。
        // 区别很重要：前者是"功能还没做"，后者是"配置写错了"，修法完全不同。
        const kit2 = kKit();
        const def = kit2.typeDefOf ? kit2.typeDefOf(p.type) : null;
        if (def) {
          const box = mkEl('div', 'ph-box');
          box.appendChild(mkEl('div', 'ph-title', (def.label || def.type) + '：渲染器还没写'));
          box.appendChild(mkEl('div', 'ph-sub', '这种面板已经登记在类型目录里，但绘制它的代码还没写，所以这块格子暂时没有内容。'));
          const btn = mkEl('button', 'ph-btn', '换个类型');
          btn.addEventListener('click', function () {
            if (kit2.openPanelConfig) {
              const pd = kit2.typeDefOf ? kit2.typeDefOf(p.type) : null;
              kit2.openPanelConfig(p, pd || { type: p.type, label: p.type, fields: [] });
            }
          });
          box.appendChild(btn);
          parts.body.appendChild(box);
        } else {
          parts.body.appendChild(mkEl('div', 'stat-sub',
            '未知面板类型: ' + p.type + '（类型目录里没有这个 type，检查场景 json 是不是拼错了）'));
        }
      }
      el.grid.appendChild(parts.wrap);
    });
  }

  // ==================== 引擎界面（webview） ====================
  // 引擎没就绪时不再直接返回空界面 —— 保留加载页进度条，
  // 引擎就绪后由 onReady 自动触发加载（否则必须手点一次标签才会加载）。
  async function loadHarness() {
    let ready = false;
    try { ready = await window.kun.harness.ready(); } catch (e) { ready = false; }
    if (!ready) {
      setStatus('引擎启动中…', 'busy');
      return;
    }
    let url = '';
    try { url = await window.kun.harness.url(); } catch (e) { url = ''; }
    if (!url) return;

    if (!el.webview) return;
    if (el.webview.getAttribute('src') !== url) {
      el.webview.setAttribute('src', url);
      setStatus('加载界面…', 'busy');
      paintBoot({ stage: 'ui', pct: 94, text: '界面渲染中…', detail: 'DSH 前端正在渲染' });
      watchHarnessReady();
    } else {
      setStatus('已连接', 'ok');
      finishBoot();
    }
  }

  // 轮询 webview 内部：#root 渲染出真实 UI 才算加载完成（did-finish-load 早于 SPA 渲染）
  function watchHarnessReady() {
    if (harnessWatchTimer || !el.webview) return;
    const started = Date.now();
    const PROBE = '(() => { try {'
      + 'const root = document.getElementById("root");'
      + 'if (!root || root.children.length === 0) return false;'
      + 'if (document.querySelector("[data-side=\\"sidebar\\"]") || document.querySelector("[data-chat-flow]") || document.querySelector("[data-phase]")) return true;'
      + 'const txt = (root.innerText || "").trim(); return txt.length > 20;'
      + '} catch (e) { return false; } })()';

    harnessWatchTimer = setInterval(async function () {
      const elapsed = Date.now() - started;
      let ok = false;
      try { ok = await el.webview.executeJavaScript(PROBE); } catch (e) { ok = false; }
      if (ok) {
        clearInterval(harnessWatchTimer);
        harnessWatchTimer = null;
        setStatus('已连接', 'ok');
        finishBoot();
        return;
      }
      // 进度条继续爬（94 → 99），让等待有感；12 秒兜底直接进入，避免一直卡在加载页
      if (curPct < 99) {
        paintBoot({ stage: 'ui', pct: Math.min(99, curPct + 1), text: '界面渲染中…', detail: '已等待 ' + Math.round(elapsed / 1000) + 's（可点「立即进入」）' });
      }
      if (elapsed > 12000) {
        clearInterval(harnessWatchTimer);
        harnessWatchTimer = null;
        finishBoot();
      }
    }, 400);
  }

  // ⟳ 立即进入 / 顶栏刷新：重设 src 强制重载 + 立刻收起加载页
  async function reloadHarness() {
    if (harnessWatchTimer) { clearInterval(harnessWatchTimer); harnessWatchTimer = null; }
    overlayDone = false;
    if (el.overlay) el.overlay.classList.remove('hide');
    curPct = 0;
    paintBoot({ stage: 'ui', pct: 90, text: '正在刷新界面…', detail: '' });
    setStatus('刷新中…', 'busy');
    let url = '';
    try { url = await window.kun.harness.url(); } catch (e) { url = ''; }
    if (el.webview && url) el.webview.setAttribute('src', url);
    watchHarnessReady();
  }

  // ==================== 启动页按钮 ====================
  function initBoot() {
    if (el.retry) {
      el.retry.addEventListener('click', async function () {
        el.retry.disabled = true;
        overlayDone = false;
        if (el.overlay) el.overlay.classList.remove('hide', 'err');
        paintBoot({ stage: 'wait', pct: 4, text: '正在重试启动…', detail: '' });
        setStatus('重试中…', 'busy');
        try {
          const r = await window.kun.boot.retry();
          if (r && r.ok) { await loadHarness(); }
          else if (r && r.err) paintBoot({ stage: 'error', pct: 100, text: '重试失败', detail: r.err });
        } catch (e) {
          paintBoot({ stage: 'error', pct: 100, text: '重试失败', detail: String((e && e.message) || e) });
        } finally {
          el.retry.disabled = false;
        }
      });
    }

    if (el.bootLog) {
      el.bootLog.addEventListener('click', function () {
        window.kun.boot.openLog().catch(function () { /* ignore */ });
      });
    }

    if (el.refreshBoot) {
      el.refreshBoot.addEventListener('click', function () { reloadHarness(); });
    }
  }

  // ==================== 启动 ====================
  (function boot() {
    initTitlebar();
    initBoot();
    paintVersion();
    setStatus('连接中…', 'busy');

    // 先建好标签（引擎场景立即可见），再异步补上 scenarios 里的场景
    buildTabs();
    reloadTabs();

    // 「工作中」光效：起一轮 20 秒的轮询（状态源和控制器卡片同一份 console.model）
    startTabWorkingPoll();

    // 先订阅，再取快照：顺序反了会漏掉"取完快照到订阅成功"之间那一帧
    window.kun.boot.onProgress(function (st) {
      paintBoot(st);
      if (st && st.stage === 'ready') loadHarness();
    });

    window.kun.boot.state().then(function (st) {
      paintBoot(st);
      if (st && st.stage === 'ready') loadHarness();
    }).catch(function (e) {
      paintBoot({ stage: 'error', pct: 100, text: '拿不到启动状态', detail: String((e && e.message) || e) });
    });

    // 主进程广播「引擎就绪」：比轮询更及时
    window.kun.harness.onReady(function () { loadHarness(); });

    // 面板自刷新通道（文档《面板通用能力》§2）：主进程轮询到指令文件就广播，这里重载匹配场景。
    // 改了面板配置 / 换了类型，界面自己生效 —— 不用让用户去点顶栏 ⟳。
    try {
      window.kun.panels.onReload(function (msg) {
        const scope = (msg && msg.scope) || 'all';
        if (scope === 'all' || scope === curScene) {
          if (curScene && curScene !== HARNESS_ID) {
            loadScenario(curScene, true);
            toast('面板已重载');
          }
          reloadTabs();
        }
      });
    } catch (e) { /* 老版本 preload 没有这条通道时不影响启动 */ }

    // 兜底轮询：即使广播丢了，也能在 500ms 内发现引擎就绪（最多盯 100 秒）
    let tries = 0;
    const timer = setInterval(async function () {
      if (overlayDone) { clearInterval(timer); return; }
      tries += 1;
      if (tries > 200) { clearInterval(timer); return; }
      try {
        const ok = await window.kun.harness.ready();
        if (ok) { clearInterval(timer); loadHarness(); return; }
      } catch (e) { /* ignore */ }
      try {
        const st = await window.kun.boot.state();
        paintBoot(st);
      } catch (e) { /* ignore */ }
    }, 500);
  })();
})();
