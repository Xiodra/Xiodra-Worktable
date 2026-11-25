#!/usr/bin/env node
/**
 * 工作流.mjs —— M9 工作流可视化的**数据层与判据**
 *
 * Xiodra 的设计原文：
 *   【M9 工作流可视化】输入节点列表与依赖关系。输出：
 *     ① **机器可读 JSON**（节点 id / 类型 / 输入 / 输出 / 下一步）
 *     ② 每节点**光点状态** pending / running / done / error
 *     ③ 点「开始」按 JSON 执行并**实时更新光点**
 *     ④ **人可读流程图说明**
 *
 * ⛔ 分工（照 M7 的先例）：
 *   · **数据层与判据**（JSON 格式、状态机、校验、人可读说明）＝ 本工具，归 DSH改造。
 *   · **画面与交互**（光点怎么画、开始按钮、轮询点灯）＝ 派单给 GUI改造。
 *   判据只写一处：两处判据 = 两份结论（这个坑我们踩过）。
 *
 * 状态机（唯一出处，⛔ 别在别处再定一套）：
 *   pending → running → done
 *                    ↘ error
 *   · **只许单向**：done / error 是终态，不许回退（回退要显式 `--reset`）
 *   · 一个节点 running 时，它的**前置节点必须已 done**（依赖没满足就不许跑）
 *
 * 用法：
 *   node 工具\工作流.mjs --校验 <流程.json>        # 校验格式与依赖（环路/断链/重名）
 *   node 工具\工作流.mjs --说明 <流程.json>        # 生成「人可读流程图说明」
 *   node 工具\工作流.mjs --建   <名字>             # 生成一个空白流程模板
 *   node 工具\工作流.mjs --状态 <流程.json>         # 看当前各节点状态
 *   node 工具\工作流.mjs --标记 <流程.json> <节点id> <状态>   # 改状态（含依赖校验）
 *   node 工具\工作流.mjs --列表                    # 列出所有流程
 *   node 工具\工作流.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const WF_DIR = path.join(ROOT, '外壳', 'data', 'workflow');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

/** 状态机（唯一出处） */
export const STATES = ['pending', 'running', 'done', 'error'];
export const TERMINAL = ['done', 'error'];

/** 节点类型（与 flow 面板的 FLOW_TYPES 对齐，便于画图时直接用） */
export const NODE_TYPES = ['input', 'process', 'ai', 'tool', 'output', 'text'];

/**
 * 校验一个流程对象。返回 { bad, warn, ok }
 * ⛔ 判据要点：
 *   · 每个节点必须有 **id / type / 至少一个输出**（M9 原文要求"输入/输出/下一步"）
 *   · `next` 指向的 id 必须存在（断链 = 跑不下去）
 *   · **不许有环**（有环就跑不完；但允许多入口的 DAG）
 *   · id 不许重复
 *   · 状态值只许四个词
 */
export function validate(flow) {
  const bad = [], warn = [], ok = [];

  if (!flow || typeof flow !== 'object') { bad.push('不是一个对象'); return { bad, warn, ok }; }
  if (!flow.name) bad.push('缺 name（流程名）');
  if (!Array.isArray(flow.nodes) || !flow.nodes.length) { bad.push('缺 nodes 或为空'); return { bad, warn, ok }; }

  const ids = new Set();
  const dup = [];
  for (const n of flow.nodes) {
    if (!n || !n.id) { bad.push('有节点没写 id'); continue; }
    if (ids.has(n.id)) dup.push(n.id);
    ids.add(n.id);
  }
  if (dup.length) bad.push('节点 id 重复：' + dup.join(','));

  for (const n of flow.nodes) {
    if (!n || !n.id) continue;
    if (!n.type) bad.push(n.id + '：缺 type');
    else if (!NODE_TYPES.includes(n.type)) warn.push(n.id + '：type「' + n.type + '」不在常用类型里（' + NODE_TYPES.join('/') + '）');
    if (n.state && !STATES.includes(n.state)) bad.push(n.id + '：state「' + n.state + '」非法（只许 ' + STATES.join('/') + '）');
    // M9 明确要求"输出"；输入可以为空（起点节点）
    if (!n.output || (Array.isArray(n.output) && !n.output.length)) bad.push(n.id + '：没写 output（M9 要求每节点有输出）');
    // 下一步
    const nexts = Array.isArray(n.next) ? n.next : (n.next ? [n.next] : []);
    for (const t of nexts) if (!ids.has(t)) bad.push(n.id + '：next 指向不存在的节点「' + t + '」');
    if (!nexts.length && n.type !== 'output') warn.push(n.id + '：没有 next（若不是终点，链路就断了）');
  }

  // 环检测（DFS 三色）
  if (!dup.length) {
    const adj = {};
    for (const n of flow.nodes) {
      const nexts = Array.isArray(n.next) ? n.next : (n.next ? [n.next] : []);
      adj[n.id] = nexts;
    }
    const color = {};
    let cycle = [];
    const dfs = (u, stack) => {
      if (color[u] === 1) { cycle = stack.slice(stack.indexOf(u)).concat(u); return true; }
      if (color[u] === 2) return false;
      color[u] = 1;
      for (const v of adj[u] || []) if (dfs(v, stack.concat(u))) return true;
      color[u] = 2;
      return false;
    };
    for (const id of ids) if (dfs(id, [])) break;
    if (cycle.length) bad.push('有环：' + cycle.join(' → ') + '（跑不完）');
  }

  if (!bad.length) {
    const typeCount = {};
    for (const n of flow.nodes) typeCount[n.type] = (typeCount[n.type] || 0) + 1;
    ok.push(flow.nodes.length + ' 个节点、' + Object.keys(typeCount).length + ' 种类型');
    if (!flow.nodes.some((n) => n.type === 'output')) warn.push('没有 output 类型节点（链路可能没有终点）');
  }
  return { bad, warn, ok };
}

/** 前置节点（谁指向我）—— 用来判"依赖满足才能跑" */
export function parentsOf(flow) {
  const m = {};
  for (const n of flow.nodes || []) m[n.id] = [];
  for (const n of flow.nodes || []) {
    const nexts = Array.isArray(n.next) ? n.next : (n.next ? [n.next] : []);
    for (const t of nexts) if (m[t]) m[t].push(n.id);
  }
  return m;
}

/**
 * 状态流转校验（唯一出处）
 * @returns {{ok:boolean, why:string}}
 */
export function canTransition(flow, nodeId, to) {
  if (!STATES.includes(to)) return { ok: false, why: '目标状态「' + to + '」非法（只许 ' + STATES.join('/') + '）' };
  const node = (flow.nodes || []).find((n) => n.id === nodeId);
  if (!node) return { ok: false, why: '没有节点「' + nodeId + '」' };
  const cur = node.state || 'pending';

  // 无变化直接放过（幂等，避免界面重复点报错）
  if (cur === to) return { ok: true, why: cur + '（未变）' };

  // 终态不许自己动：done/error 要回 pending 必须显式 --reset
  if (TERMINAL.includes(cur) && to !== 'pending') {
    return { ok: false, why: '「' + nodeId + '」已是终态 ' + cur + '，不许改成 ' + to + '（要重跑请 --reset）' };
  }

  /**
   * ⚠ 2026-11-21 修（实测漏洞）：原来**只**在 `to === 'running'` 时查前置，
   *   于是 `pending → done` 能一步跳过去，**既跳过 running，也跳过前置检查**。
   *   实测：6 个节点全 pending 时，`--标记 n6 done` 直接成功 ⇒ 状态机形同虚设。
   *
   *   正确判据（照 M9「按 JSON 执行」的本意）：
   *     · 要进 running / done / error，**前置必须全部 done**（不能凭空完成）
   *     · 要进 **done / error 必须先 running**（running 是必经态，不许 pending 直达终态）
   */
  if (to !== 'pending') {
    const parents = parentsOf(flow)[nodeId] || [];
    const notDone = parents.filter((p) => {
      const pn = (flow.nodes || []).find((x) => x.id === p);
      return !pn || pn.state !== 'done';
    });
    if (notDone.length) return { ok: false, why: '「' + nodeId + '」的前置还没 done：' + notDone.join(',') };
  }
  if (TERMINAL.includes(to) && cur !== 'running') {
    return { ok: false, why: '「' + nodeId + '」当前是 ' + cur + '，要变成 ' + to + ' 必须先 running（⛔ running 是必经态，不许跳）' };
  }

  return { ok: true, why: cur + ' → ' + to };
}

/** 人可读说明（M9 ④） */
export function describe(flow) {
  const lines = [];
  lines.push('# ' + (flow.name || '（未命名流程）') + ' · 流程说明');
  lines.push('');
  if (flow.desc) { lines.push('> ' + flow.desc); lines.push(''); }
  const byId = {};
  for (const n of flow.nodes || []) byId[n.id] = n;
  const parents = parentsOf(flow);

  lines.push('## 一、节点（' + (flow.nodes || []).length + ' 个）');
  lines.push('');
  lines.push('| # | 节点 | 类型 | 输入 | 输出 | 下一步 | 当前状态 |');
  lines.push('|---|---|---|---|---|---|---|');
  (flow.nodes || []).forEach((n, i) => {
    const fmt = (x) => (Array.isArray(x) ? x.join(' / ') : (x || '—'));
    const nexts = Array.isArray(n.next) ? n.next : (n.next ? [n.next] : []);
    lines.push('| ' + (i + 1) + ' | ' + (n.name || n.id) + ' | ' + (n.type || '?') + ' | '
      + fmt(n.input) + ' | ' + fmt(n.output) + ' | ' + (nexts.join(' / ') || '（终点）') + ' | '
      + (n.state || 'pending') + ' |');
  });

  lines.push('');
  lines.push('## 二、执行顺序（拓扑序，前置在前）');
  lines.push('');
  const order = topo(flow);
  lines.push(order.length ? order.map((id, i) => (i + 1) + '. ' + (byId[id] ? (byId[id].name || id) : id)).join('  \n') : '（有环，排不出顺序）');

  lines.push('');
  lines.push('## 三、怎么读这张图');
  lines.push('');
  lines.push('- **光点**：`pending` 灰 / `running` 蓝（呼吸）/ `done` 绿 / `error` 红');
  lines.push('- **箭头**：`a → b` 表示 a 的输出是 b 的输入；**前置没 done 就不许开跑**（工具会拦）');
  lines.push('- 机器可读源就是上面这张表对应的 JSON（`' + (flow.file || '<流程>.json') + '`），界面只负责画它');
  lines.push('');
  return lines.join('\n');
}

/** 拓扑排序（Kahn），返回 id 数组；有环返回 [] */
export function topo(flow) {
  const nodes = flow.nodes || [];
  const indeg = {};
  const adj = {};
  for (const n of nodes) { indeg[n.id] = 0; adj[n.id] = []; }
  for (const n of nodes) {
    const nexts = Array.isArray(n.next) ? n.next : (n.next ? [n.next] : []);
    for (const t of nexts) if (adj[n.id] && indeg[t] !== undefined) { adj[n.id].push(t); indeg[t]++; }
  }
  const q = Object.keys(indeg).filter((k) => indeg[k] === 0);
  const out = [];
  while (q.length) {
    const u = q.shift();
    out.push(u);
    for (const v of adj[u]) { indeg[v]--; if (indeg[v] === 0) q.push(v); }
  }
  return out.length === nodes.length ? out : [];
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  const good = () => ({
    name: '测试流程',
    nodes: [
      { id: 'a', type: 'input', name: '取素材', output: ['素材.mp4'], next: ['b'], state: 'pending' },
      { id: 'b', type: 'process', name: '转码', input: ['素材.mp4'], output: ['成片.mp4'], next: ['c'], state: 'pending' },
      { id: 'c', type: 'output', name: '交付', input: ['成片.mp4'], output: ['完成'], next: [], state: 'pending' },
    ],
  });

  // ① 正例
  {
    const r = validate(good());
    add(r.bad.length === 0, '正例 合法流程通过', r.bad.join(' | '));
  }
  // ② 缺 output ⇒ ⛔（M9 明确要求每节点有输出）
  {
    const f = good(); delete f.nodes[1].output;
    const r = validate(f);
    add(r.bad.some((b) => b.includes('没写 output')), '反例① 节点缺 output ⇒ ⛔（M9 要求每节点有输出）', r.bad.join(' | '));
  }
  // ③ next 断链 ⇒ ⛔
  {
    const f = good(); f.nodes[0].next = ['不存在'];
    const r = validate(f);
    add(r.bad.some((b) => b.includes('next 指向不存在')), '反例② next 指向不存在的节点 ⇒ ⛔（断链跑不下去）', r.bad.join(' | '));
  }
  // ④ 有环 ⇒ ⛔
  {
    const f = good(); f.nodes[2].next = ['a'];
    const r = validate(f);
    add(r.bad.some((b) => b.includes('有环')), '反例③ 有环 ⇒ ⛔（跑不完）', r.bad.join(' | '));
  }
  // ⑤ id 重复 ⇒ ⛔
  {
    const f = good(); f.nodes[2].id = 'a';
    const r = validate(f);
    add(r.bad.some((b) => b.includes('重复')), '反例④ id 重复 ⇒ ⛔', r.bad.join(' | '));
  }
  // ⑥ 状态非法 ⇒ ⛔
  {
    const f = good(); f.nodes[0].state = '跑完了';
    const r = validate(f);
    add(r.bad.some((b) => b.includes('state')), '反例⑤ 状态写成「跑完了」⇒ ⛔（只许四词）', r.bad.join(' | '));
  }
  // ⑦ 前置没 done 不许 running
  {
    const f = good();
    const v = canTransition(f, 'b', 'running');
    add(!v.ok && v.why.includes('前置'), '反例⑥ 前置还没 done 就想跑 ⇒ 拦住', v.why);
  }
  // ⑧ 前置 done 后可以 running
  {
    const f = good(); f.nodes[0].state = 'done';
    const v = canTransition(f, 'b', 'running');
    add(v.ok, '正例 前置 done 之后可以 running', v.why);
  }
  // ⑨ 终态不许自己改
  {
    const f = good(); f.nodes[0].state = 'done';
    const v = canTransition(f, 'a', 'running');
    add(!v.ok, '反例⑦ 已是 done 还想改 running ⇒ 拦住（要重跑用 --reset）', v.why);
  }
  // ⑨ ★实测漏洞★ pending 不许直达 done（跳过 running = 跳过执行 + 跳过前置检查）
  {
    const f = good();   // 三个节点全 pending，a 没有前置
    const v = canTransition(f, 'a', 'done');
    add(!v.ok && v.why.includes('必须'), '反例⑨ 全 pending 时直接 done ⇒ **拦住**（running 是必经态，实测曾能一步跳过）', v.why);
  }
  {
    const f = good(); f.nodes[0].state = 'running';
    const v = canTransition(f, 'a', 'done');
    add(v.ok, '正例 先 running 再 done ⇒ 放行', v.why);
  }
  {
    const f = good(); f.nodes[0].state = 'done';
    const v = canTransition(f, 'a', 'done');
    add(v.ok, '正例 已是 done 再标 done ⇒ 幂等放过（界面重复点不该报错）', v.why);
  }
  {
    // 前置没 done 时也不许标记 done（不只是 running）
    const f = good(); f.nodes[0].state = 'done';
    const v = canTransition(f, 'c', 'done');
    add(!v.ok, '反例⑩ 前置 b 没 done 就想把 c 标 done ⇒ 拦住', v.why);
  }
  // ⑩ 拓扑序要对
  {
    const o = topo(good());
    add(JSON.stringify(o) === JSON.stringify(['a', 'b', 'c']), '正例 拓扑序 a→b→c', JSON.stringify(o));
  }
  // ⑪ 人可读说明必须含四列表头与执行顺序
  {
    const d = describe(good());
    add(d.includes('输入') && d.includes('输出') && d.includes('下一步') && d.includes('执行顺序'), '反例⑧ 说明必须含 输入/输出/下一步 + 执行顺序', '');
  }

  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- 入口 ---------------- */
function readFlow(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();

if (isMain) {
  if (has('--selftest')) process.exit(selftest());
  if (has('--help') || has('-h')) {
    console.log([
      '工作流.mjs —— M9 工作流的数据层与判据',
      '  node 工具\\工作流.mjs --校验 <流程.json>',
      '  node 工具\\工作流.mjs --说明 <流程.json>',
      '  node 工具\\工作流.mjs --建 <名字>',
      '  node 工具\\工作流.mjs --状态 <流程.json>',
      '  node 工具\\工作流.mjs --标记 <流程.json> <节点id> <状态>',
      '  node 工具\\工作流.mjs --列表',
      '  node 工具\\工作流.mjs --selftest',
      '状态机：pending → running → done/error（只许单向，终态要 --reset 才能重跑）',
      '⛔ 界面（光点/开始按钮/轮询点灯）派单给 GUI改造；数据与判据只在本工具。',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--列表')) {
    if (!fs.existsSync(WF_DIR)) { console.log('（还没有流程，用 --建 <名字> 生成一个）'); process.exit(0); }
    const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.json'));
    if (!files.length) { console.log('（还没有流程）'); process.exit(0); }
    console.log('工作流（' + WF_DIR + '）：\n');
    for (const f of files) {
      const fl = readFlow(path.join(WF_DIR, f));
      if (!fl) { console.log('  ' + f + '  ⛔ 坏 JSON'); continue; }
      const done = (fl.nodes || []).filter((n) => n.state === 'done').length;
      console.log('  ' + f.padEnd(30) + (fl.nodes || []).length + ' 节点 · 完成 ' + done + '/' + (fl.nodes || []).length);
    }
    process.exit(0);
  }

  if (has('--建')) {
    const name = val('--建');
    if (!name) { console.error('用法：--建 <名字>'); process.exit(2); }
    fs.mkdirSync(WF_DIR, { recursive: true });
    const f = path.join(WF_DIR, name.replace(/[\\/:*?"<>|]/g, '_') + '.json');
    if (fs.existsSync(f)) { console.error('✗ 已存在：' + f); process.exit(2); }
    const tpl = {
      name: name,
      desc: '（一句话说明这个流程干什么）',
      created: new Date().toISOString().slice(0, 10),
      nodes: [
        { id: 'start', type: 'input', name: '开始', input: [], output: ['（产出什么）'], next: ['end'], state: 'pending' },
        { id: 'end', type: 'output', name: '结束', input: ['（产出什么）'], output: ['（最终交付）'], next: [], state: 'pending' },
      ],
    };
    fs.writeFileSync(f, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
    console.log('✓ 已建流程模板：' + path.relative(ROOT, f));
    console.log('  改 nodes 的 input/output/next，再跑 --校验 确认格式对。');
    process.exit(0);
  }

  const file = val('--校验') || val('--说明') || val('--状态') || val('--标记');
  if (!file) { console.error('用法见 --help'); process.exit(2); }
  const p = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
  const flow = readFlow(p);
  if (!flow) { console.error('✗ 读不到或不是合法 JSON：' + p); process.exit(2); }

  if (has('--校验')) {
    const r = validate(flow);
    console.log('校验：' + path.basename(p) + '\n');
    for (const s of r.ok) console.log('  ✓ ' + s);
    for (const w of r.warn) console.log('  ⚠ ' + w);
    for (const b of r.bad) console.log('  ⛔ ' + b);
    console.log('\n' + (r.bad.length ? '⛔ ' + r.bad.length + ' 个问题' : '✓ 全部通过'));
    process.exit(r.bad.length ? 1 : 0);
  }

  if (has('--说明')) {
    flow.file = path.basename(p);
    console.log(describe(flow));
    process.exit(0);
  }

  if (has('--状态')) {
    console.log(path.basename(p) + ' 各节点状态：\n');
    const icon = { pending: '○', running: '◐', done: '●', error: '✕' };
    for (const n of flow.nodes || []) console.log('  ' + (icon[n.state || 'pending'] || '?') + ' ' + String(n.id).padEnd(14) + (n.name || ''));
    process.exit(0);
  }

  if (has('--标记')) {
    const idx = argv.indexOf('--标记');
    const nodeId = argv[idx + 2];
    const to = argv[idx + 3];
    if (!nodeId || !to) { console.error('用法：--标记 <流程.json> <节点id> <状态>'); process.exit(2); }
    // reset：把一个终态强行拉回 pending（唯一允许的回退）
    if (to === 'pending' && has('--reset')) {
      const n = (flow.nodes || []).find((x) => x.id === nodeId);
      if (!n) { console.error('✗ 没有节点 ' + nodeId); process.exit(2); }
      n.state = 'pending';
      fs.writeFileSync(p, JSON.stringify(flow, null, 2) + '\n', 'utf8');
      console.log('✓ ' + nodeId + ' 已 --reset 回 pending');
      process.exit(0);
    }
    const v = canTransition(flow, nodeId, to);
    if (!v.ok) { console.error('⛔ ' + v.why); process.exit(1); }
    const n = flow.nodes.find((x) => x.id === nodeId);
    n.state = to;
    n.updated = new Date().toISOString().slice(0, 19).replace('T', ' ');
    fs.writeFileSync(p, JSON.stringify(flow, null, 2) + '\n', 'utf8');
    console.log('✓ ' + nodeId + '：' + v.why);
    process.exit(0);
  }
}
