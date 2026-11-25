#!/usr/bin/env node
/**
 * 垃圾判据.mjs —— 「什么算垃圾」的唯一判据（照搬《08/机制清单》§2 清理规矩）
 *
 * ⛔ 为什么必须有这一条：**判据只能写一处**。
 *   `pc-junk` 面板要显示"哪些能清"、清理动作要判断"这条该不该清"、
 *   巡检要决定"发不发请求" —— 三处各写一份判断，早晚打架。
 *
 * 参照的原始规矩（《08/机制清单》§2）：
 *   「明确是垃圾（超期 `_临时`、散落 `.bak/.zip`、缓存/spill、旧快照）
 *     ⇒ **直接发清理请求**，⛔ 不许先问"要不要清"；只有**不可逆**或**判不准**才问」
 *   已知盲区：「只按**名字/后缀**判 ⇒ 叫 `abc` 的垃圾看不见」
 *
 * 所以本工具给每一类都写：**条件 + 危险度 + 建议动作 + 为什么**，且**承认盲区**。
 *
 * 危险度三档（决定"要不要问人"）：
 *   · `safe`   明确是垃圾、可再生 ⇒ **可以直接清**（不用问）
 *   · `ask`    可能有用 / 判不准 ⇒ **列清单问 Xiodra**
 *   · `never`  绝不清（资产 / 证据 / 配置 / 当前在用的）
 *
 * 用法：
 *   node 工具\垃圾判据.mjs --list                 # 看判据表
 *   node 工具\垃圾判据.mjs --scan [--root <目录>]  # 扫一遍（只列不删）
 *   node 工具\垃圾判据.mjs --scan --json          # 给 pc-junk 面板读
 *   node 工具\垃圾判据.mjs --check <路径>          # 判单个路径属于哪类
 *   node 工具\垃圾判据.mjs --selftest             # 反例：过期的报、新文件不许报、资产不许报
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const DAY = 86400000;

/**
 * 判据表 —— **唯一出处**。顺序即优先级（先判 never，最后才判 safe）。
 * `test(ctx)` 返回 true 即命中；`ctx = { name, full, isDir, size, mtimeMs, ageDays }`
 */
export const RULES = [
  // ---------- never：绝不清 ----------
  {
    id: 'N1', level: 'never', label: '资产 / 证据 / 配置',
    test: (c) => /^(node_modules|\.git)$/i.test(c.name) === false && (
      /(^|[\\/])(场景记忆|会话档案|归档|_共享记忆|项目记忆)([\\/]|$)/.test(c.full) ||
      /\.(md|json|jsonl|yml|yaml|mjs|js|html|css|svg|png|ico|vbs)$/i.test(c.name) === false && c.isDir === false && c.size > 0 && false
    ),
    why: '记忆 / 档案 / 归档是**证据**，删了不可回滚（参照：「不为了干净删证据」）',
    action: '不清',
  },
  {
    id: 'N2', level: 'never', label: '正在用的依赖与代码',
    test: (c) => /^(node_modules|\.git|dist|lib)$/i.test(c.name) || /(^|[\\/])(引擎|外壳[\\/]renderer|外壳[\\/]scenarios|工具|MCP)[\\/]/i.test(c.full + path.sep),
    why: '依赖可重建但是**正在用**（删了要重装 / 重装可能失败）；代码与场景配置是本体',
    action: '不清',
  },
  {
    id: 'N3', level: 'never', label: '本工作台的正式产物',
    test: (c) => /(^|[\\/])(12-版本|captures)([\\/]|$)/.test(c.full) || /^Xiodra-工作台-/.test(c.name),
    why: '回滚包与截图证据 — 回滚包删了就没得回滚',
    action: '不清',
  },

  // ---------- safe：明确是垃圾，可再生 ----------
  {
    id: 'S1', level: 'safe', label: '超期的 _临时 目录',
    test: (c) => c.isDir && c.name === '_临时' && c.ageDays >= 7,
    why: '_临时 是一次性区（参照：「超期 `_临时`」）',
    action: '可清（7 天以上）',
  },
  {
    id: 'S2', level: 'safe', label: '编辑器 / 系统临时文件',
    test: (c) => /(^~\$)|(\.tmp|\.temp|\.swp|\.part|\.crdownload)$/i.test(c.name),
    why: '锁文件与下载中间件，进程结束后就是垃圾',
    action: '可清',
  },
  {
    id: 'S3', level: 'safe', label: '日志（超 7 天）',
    test: (c) => /\.log(\.\d+)?$/i.test(c.name) && c.ageDays >= 7,
    why: '日志只对最近排障有用；旧的占地方',
    action: '可清（7 天以上）',
  },
  {
    id: 'S4', level: 'safe', label: '缓存 / spill 产物',
    test: (c) => /(^|[\\/])(cache|spill|\.cache)([\\/]|$)/i.test(c.full) || /-spill-/.test(c.name),
    why: '工具结果 spill 文件是可再生的（模型要时会重新生成）',
    action: '可清',
  },

  // ---------- ask：可能有用 / 判不准 ----------
  {
    id: 'A1', level: 'ask', label: '散落的 .bak / .zip / .7z',
    test: (c) => /\.(bak|zip|7z|rar)$/i.test(c.name),
    why: '参照明确把「散落 .bak/.zip」算垃圾，但**备份类也可能有用** ⇒ 列清单问',
    action: '问 Xiodra',
  },
  {
    id: 'A2', level: 'ask', label: '旧快照 / 手建备份目录',
    test: (c) => /(备份|旧版|backup|snapshot|快照)/i.test(c.name) && c.isDir,
    why: '旧快照可能还有用（参照列为垃圾，但**判不准就别删**）',
    action: '问 Xiodra',
  },
  {
    id: 'A3', level: 'ask', label: '空目录（可能是占位）',
    test: (c) => c.isDir && c.size === 0 && c.ageDays >= 30,
    why: '空目录通常是占位或残留，但也可能是"还没放东西的新夹子"',
    action: '问 Xiodra',
  },
];

/** 判一个条目属于哪类（返回命中的第一条规则；没有命中返回 null） */
export function classify(ctx) {
  for (const r of RULES) if (r.test(ctx)) return r;
  return null;
}

/** 扫一个根目录（默认工作台根），返回分组结果 */
export function scan(root = ROOT, maxDepth = 4) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const ctx = {
        name: e.name, full, isDir: e.isDirectory(), size: 0,
        mtimeMs: st.mtimeMs, ageDays: Math.floor((Date.now() - st.mtimeMs) / DAY),
      };

      /**
       * ⚠ 性能关键（2026-11-19 实测：原实现单次 **29.7 秒**，GUI改造 那边测到 75 秒）：
       *   原来**先算 dirSize 再分类**，等于把 `node_modules` / 记忆目录这些 500MB 级目录
       *   完整遍历一遍，只为得出一个"不用清"的结论 ⇒ 白扫整棵树。
       *   改为：**先用文件名/年龄分类**（classify 不依赖 size），
       *   只有 safe / ask（要显示体积的）才算 dirSize。never 类直接跳过。
       *   `classify()` 里唯一用到 size 的是 A3（空目录），对它单独补一次判断成本极低。
       */
      const preRule = classify(ctx);
      if (preRule && preRule.level === 'never') {
        hits.push({ ...ctx, rule: preRule.id, level: preRule.level, label: preRule.label, action: preRule.action });
        continue;
      }

      if (ctx.isDir) {
        try { ctx.size = dirSize(full, 0); } catch { ctx.size = 0; }
      } else ctx.size = st.size;

      const rule = classify(ctx);   // size 现在有了，A3（空目录）才判得准
      if (rule) hits.push({ ...ctx, rule: rule.id, level: rule.level, label: rule.label, action: rule.action });
      /**
       * ⛔ **命中后不再深入**（2026-11-21 修：本地电脑 报「垃圾判据重复计数」）。
       *
       *   实测 bug：`引擎数据\.dsh\cache` / `cache\attachments` / `cache\attachments\request-images`
       *   三层都命中 S4（缓存规则），于是**同一批文件被计数 3 次**：
       *     报"可清 23.0 MB"，实际只有 8.88 MB（`cache` 7.06 + `electron Cache` 1.82）——**虚高 2.6 倍**。
       *
       *   判据：**可清量按"最外层命中点"算一次**。因为清 `cache\` 时整棵子树都会走，
       *   `cache\attachments` 那行**永远是冗余的**，还让总量失去意义。
       *   ⇒ 命中即 `continue`（不再 walk 它的子目录）。
       *   ⚠ 副作用：子目录里若还有**别的类别**（比如 cache 里有 .bak）就看不见了。
       *     接受这个取舍：清最外层时那些子项一并清掉了，单独列出没有操作意义。
       */
      if (rule) continue;
      if (ctx.isDir) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return hits;
}

function dirSize(dir, depth) {
  if (depth > 6) return 0;
  let s = 0;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) s += dirSize(p, depth + 1);
      else s += fs.statSync(p).size;
    } catch { /* 跳过读不到的 */ }
  }
  return s;
}

const MB = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });
  const ctx = (o) => ({ name: 'x', full: 'C:\\x', isDir: false, size: 1, mtimeMs: Date.now(), ageDays: 0, ...o });

  // ① 7 天以上的 _临时 ⇒ safe
  {
    const r = classify(ctx({ name: '_临时', full: 'C:\\w\\_临时', isDir: true, ageDays: 10 }));
    add(r && r.level === 'safe' && r.id === 'S1', '正例 超 7 天的 _临时 ⇒ safe（可直接清）', r ? r.id : 'null');
  }
  // ② **新的** _临时 不许算垃圾（这条最容易错）
  {
    const r = classify(ctx({ name: '_临时', full: 'C:\\w\\_临时', isDir: true, ageDays: 1 }));
    add(!r || r.id !== 'S1', '反例① 刚建的 _临时（1 天）⇒ **不许**算垃圾', r ? r.id : 'null');
  }
  // ③ 记忆目录永远不清（never 优先）
  {
    const r = classify(ctx({ name: '场景记忆', full: 'C:\\w\\引擎数据\\.dsh\\场景记忆', isDir: true }));
    add(r && r.level === 'never', '反例② 场景记忆目录 ⇒ never（记忆是证据）', r ? r.id : 'null');
  }
  // ④ 回滚包不清
  {
    const r = classify(ctx({ name: 'v0.0.1-rc2.zip', full: 'C:\\w\\12-版本\\v0.0.1-rc2.zip', size: 1e6 }));
    add(r && r.level === 'never', '反例③ 12-版本 里的回滚包 ⇒ never（删了没得回滚）', r ? r.id : 'null');
  }
  // ⑤ .bak ⇒ ask，不是 safe（参照也说"判不准就问"）
  {
    const r = classify(ctx({ name: 'x.bak', full: 'C:\\w\\x.bak' }));
    add(r && r.level === 'ask' && r.id === 'A1', '反例④ .bak ⇒ ask（列清单问，⛔ 不自动删）', r ? r.id : 'null');
  }
  // ⑥ 普通源码文件不命中任何规则
  {
    const r = classify(ctx({ name: 'main.js', full: 'C:\\w\\外壳\\main.js' }));
    add(r === null || r.level === 'never', '反例⑤ 普通源码 main.js ⇒ 不算垃圾', r ? r.id + '/' + r.level : 'null');
  }
  // ⑦ ~$ 锁文件 ⇒ safe
  {
    const r = classify(ctx({ name: '~$报告.docx', full: 'C:\\w\\~$报告.docx' }));
    add(r && r.level === 'safe', '正例 ~$ 锁文件 ⇒ safe', r ? r.id : 'null');
  }
  // ⑧ 承认盲区：名字叫 abc 的垃圾判不出来（参照自己记的盲区）
  {
    const r = classify(ctx({ name: 'abc', full: 'C:\\w\\abc', size: 5e7, ageDays: 400 }));
    add(r === null, '反例⑥ 盲区：叫 abc 的 50MB 垃圾 **判不出来**（这是已知盲区，不是 bug）', r ? r.id : 'null');
  }
  // ⑨ 性能守门：never 类**不许**去算 dirSize（那是全场最贵的操作）
  //    判据：给一个名字就能判 never 的目录，preRule 必须在 size 还是 0 时就命中
  {
    const r = classify(ctx({ name: '场景记忆', full: 'C:\\w\\引擎数据\\.dsh\\场景记忆', isDir: true, size: 0 }));
    add(r && r.level === 'never', '反例⑦ 性能：never 类必须**在不知道体积时**就判出来（⛔ 别先 dirSize 再分类）', r ? r.id : 'null');
  }
  // ⑩ A3（空目录）依赖 size ⇒ 有了 size 之后要能判出来
  {
    const r = classify(ctx({ name: '空的夹子', full: 'C:\\w\\空的夹子', isDir: true, size: 0, ageDays: 40 }));
    add(r && r.id === 'A3', '正例 空目录（40 天）⇒ ask，靠 size=0 判出（说明分类要在算出体积后再跑一次）', r ? r.id : 'null');
  }
  // ⑪ 嵌套去重：父子都命中时，**不许**把同一批文件算两次
  //    （2026-11-21 本地电脑报的 bug：cache / cache\attachments / cache\...\request-images
  //     三层都命中 S4 ⇒ 报 23.0 MB，实际 8.88 MB，虚高 2.6 倍）
  {
    const probe = path.join(ROOT, '_临时', 'selftest-嵌套去重', 'cache', 'attachments', 'request-images');
    let okNest = false, detail = '';
    try {
      fs.mkdirSync(probe, { recursive: true });
      // ★1 MB 起（原来是 1 KB：量级太小，即使被数 3 遍也看不出"3 倍"）★
      const ONE_MB = 1024 * 1024;
      fs.writeFileSync(path.join(probe, 'a.bin'), Buffer.alloc(ONE_MB));
      const hits = scan(path.join(ROOT, '_临时', 'selftest-嵌套去重'));
      const safeHits = hits.filter((h) => h.level === 'safe');
      // 判据 1：只该有最外层 cache 一条
      const countOk = safeHits.length === 1;
      // 判据 2：★体积也只算一遍★（派单 ④ 要求 totalBytes ≈ 1MB，不是 3MB）
      const totalSafe = safeHits.reduce((a, h) => a + (Number(h.size) || 0), 0);
      const sizeOk = totalSafe >= ONE_MB * 0.9 && totalSafe <= ONE_MB * 1.1;
      okNest = countOk && sizeOk;
      detail = 'safe 命中 ' + safeHits.length + ' 条（' + safeHits.map((h) => h.name).join(',') + '）'
        + ' · 合计 ' + (totalSafe / 1024 / 1024).toFixed(2) + ' MB'
        + (countOk ? '' : ' · 条数应为 1')
        + (sizeOk ? '' : ' · 体积应为 ~1 MB（不是 3 MB）');
    } catch (e) { detail = '异常：' + e.message; }
    finally { try { fs.rmSync(path.join(ROOT, '_临时', 'selftest-嵌套去重'), { recursive: true, force: true }); } catch (e) { /* */ } }
    add(okNest, '反例⑧ 嵌套命中只算最外层（不许算 3 次）且体积只算一遍（1MB 不是 3MB）', detail);
  }

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
      '垃圾判据.mjs —— 「什么算垃圾」的唯一判据',
      '  node 工具\\垃圾判据.mjs --list            看判据表',
      '  node 工具\\垃圾判据.mjs --scan [--root X] 扫一遍（只列不删）',
      '  node 工具\\垃圾判据.mjs --scan --json     给 pc-junk 面板读',
      '  node 工具\\垃圾判据.mjs --check <路径>     判单个路径',
      '  node 工具\\垃圾判据.mjs --selftest        反例自证',
      '⛔ 三档：safe 可直接清 / ask 问 Xiodra / never 绝不清',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--list')) {
    console.log('垃圾判据表（唯一出处：工具\\垃圾判据.mjs 的 RULES）\n');
    for (const lv of ['never', 'safe', 'ask']) {
      const set = RULES.filter((r) => r.level === lv);
      console.log('── ' + lv + '（' + set.length + ' 条）' + (lv === 'safe' ? ' ← 可直接清' : lv === 'ask' ? ' ← 问 Xiodra' : ' ← 绝不清') + ' ──');
      for (const r of set) console.log('  ' + r.id + '  ' + r.label + '\n      动作：' + r.action + '\n      为什么：' + r.why);
      console.log('');
    }
    console.log('已知盲区（参照自己也记了）：只按名字/后缀判 ⇒ 名字正常的垃圾看不见。');
    process.exit(0);
  }

  if (has('--check')) {
    const p = val('--check');
    if (!p) { console.error('用法：--check <路径>'); process.exit(2); }
    let st; try { st = fs.statSync(p); } catch { console.error('✗ 不存在：' + p); process.exit(2); }
    const ctx = { name: path.basename(p), full: path.resolve(p), isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs, ageDays: Math.floor((Date.now() - st.mtimeMs) / DAY) };
    const r = classify(ctx);
    console.log(p);
    if (!r) { console.log('  → 判不准（不命中任何规则）⇒ 不算垃圾，别删'); process.exit(0); }
    console.log('  → ' + r.id + ' ' + r.label + '　[' + r.level + ']');
    console.log('    动作：' + r.action);
    console.log('    为什么：' + r.why);
    process.exit(r.level === 'never' ? 1 : 0);
  }

  // --scan（默认）
  const root = val('--root', ROOT);
  const hits = scan(root);
  const by = { safe: [], ask: [], never: [] };
  for (const h of hits) by[h.level].push(h);

  if (has('--json')) {
    console.log(JSON.stringify({
      root, at: Date.now(),
      safe: by.safe.map(({ full, rule, label, size }) => ({ path: full, rule, label, size })),
      ask: by.ask.map(({ full, rule, label, size }) => ({ path: full, rule, label, size })),
      neverCount: by.never.length,
      totalBytes: { safe: by.safe.reduce((a, x) => a + x.size, 0), ask: by.ask.reduce((a, x) => a + x.size, 0) },
    }, null, 2));
    process.exit(0);
  }

  console.log('扫描：' + root + '（只列不删）\n');
  for (const lv of ['safe', 'ask']) {
    const set = by[lv];
    console.log('── ' + lv + '：' + set.length + ' 项 · ' + MB(set.reduce((a, x) => a + x.size, 0)) + ' ──');
    if (!set.length) console.log('  （无）');
    for (const h of set.slice(0, 20)) {
      console.log('  ' + MB(h.size).padStart(10) + '  [' + h.rule + '] ' + path.relative(root, h.full));
    }
    if (set.length > 20) console.log('  … 其余 ' + (set.length - 20) + ' 项略');
    console.log('');
  }
  console.log('⛔ never 类命中 ' + by.never.length + ' 项（记忆/依赖/回滚包等）—— 一律不清，未列出。');
  console.log('\n动作判据：safe ⇒ 可直接清；ask ⇒ 列清单问 Xiodra；never ⇒ 不清。');
}
