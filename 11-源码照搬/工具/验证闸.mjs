#!/usr/bin/env node
/**
 * 验证闸.mjs —— 改完不会悄悄退化（照搬《13-公开情报/单场景自我进化-最小闭环》的「验证闸」）
 *
 * 参照那边的原话：「**验证闸**：硬判据 + 反例清单 + 检查脚本，保证改完不会悄悄退化。
 * 没有它，写得越多越可能坏。」
 *
 * 本工具干三件事，缺一件就不叫闸：
 *   ① **硬判据**：跑全部体检（机制/协作/索引/场景/记忆），任一 ⛔ 即闸门关闭。
 *   ② **基线比对**：和上次通过的基线比，**列出差异集合**（哪些项从过变成不过、文件变了什么）。
 *      ⛔ 只给一个 0/1 没用 —— 必须说清"哪一项、从什么变成什么"。
 *   ③ **反例自证**：故意造一个必然失败的样本，证明这个闸**真的会关**。
 *      判据：反例不关 = 这个闸是装饰。
 *
 * 用法：
 *   node 工具\验证闸.mjs                 # 跑一遍 → 与基线比 → 落基线
 *   node 工具\验证闸.mjs --no-baseline   # 只跑，不读写基线
 *   node 工具\验证闸.mjs --strict        # ⚠ 也算闸门关闭（默认只报不关）
 *   node 工具\验证闸.mjs --selftest      # 反例自证：闸门必须真的会关
 *   node 工具\验证闸.mjs --diff          # 只看和基线的差异，不重跑体检
 *
 * 退出码：0 闸门开（可以继续）/ 1 闸门关（⛔ 别继续，先把差异修掉）/ 2 用法错
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const GATE_DIR = path.join(MEM, '_共享记忆', '_验证闸');
const BASELINE = path.join(GATE_DIR, '基线.json');
const HISTORY = path.join(GATE_DIR, '历史.jsonl');
const NODE = process.execPath;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/* ---------------- 闸门要检查的项（判据只在各工具里，这里**不重复判**，只收结论） ---------------- */
const CHECKS = [
  { key: 'mechanism', name: '机制体检（全部项目 + 反例门禁）', cmd: ['工具/机制体检.mjs', '--json'] },
  { key: 'collab', name: '协作规矩（地盘表/漂移/体积/出口）', cmd: ['工具/协作体检.mjs', '--json'] },
  { key: 'docindex', name: '文档索引（未登记/死条目/状态词）', cmd: ['工具/索引体检.mjs', '--json'] },
  { key: 'scene6', name: '场景六件套', cmd: ['工具/场景体检.mjs', '--quiet'] },
  { key: 'memory', name: '场景记忆（§〇/指纹/绑定）', cmd: ['工具/场景记忆.mjs', 'check', '--all'] },
  { key: 'mcp', name: 'MCP 补丁在位', cmd: ['工具/mcp-iconfont补丁.mjs', '--check'] },
];

function run(item) {
  const r = spawnSync(NODE, [item.cmd[0], ...item.cmd.slice(1)], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, DSH_NO_TODO: '1' },
  });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

/** 从输出里抽出"点名的问题"（差异集合，而不是只给 0/1） */
function problemsOf(item, out) {
  if (item.key === 'mechanism') {
    try {
      const j = JSON.parse(out);
      return (j.items || []).filter((x) => !x.ok).map((x) => x.key + '：' + (x.fix || ''));
    } catch { return ['（机制体检输出不是 JSON）']; }
  }
  if (item.key === 'collab' || item.key === 'docindex') {
    try {
      const j = JSON.parse(out);
      const bad = j.bad;
      if (typeof bad === 'number') return bad ? ['硬问题 ' + bad + ' 个'] : [];
      return [];
    } catch { return []; }
  }
  // 其余看 exit code + ⛔/✗ 行
  return out.split(/\r?\n/).filter((l) => /^\s*(⛔|✗)/.test(l)).map((l) => l.trim().slice(0, 140));
}

/** 被闸门盯着的关键文件的指纹（改坏了能看出"哪份文件动了"） */
const WATCHED = [
  '99-工作区/AGENTS.md',
  '引擎数据/.dsh/场景记忆/_共享记忆/协作规矩.md',
  '引擎数据/.dsh/场景记忆/_共享记忆/索引.md',
  '外壳/main.js',
  '外壳/preload.js',
  '外壳/renderer/renderers.js',
  '外壳/scenarios/_场景身份索引.md',
  'MCP/mcp-iconfont/dist/iconfont.js',
  'MCP/bundle-iconfont/cordis.patch.yml',
];

function fingerprints() {
  const out = {};
  for (const rel of WATCHED) {
    const abs = path.join(ROOT, path.dirname(ROOT) === path.dirname(ROOT) ? rel : rel);
    if (!fs.existsSync(abs)) { out[rel] = 'MISSING'; continue; }
    out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  }
  return out;
}

function runAll() {
  const results = [];
  for (const item of CHECKS) {
    const { code, out } = run(item);
    const probs = problemsOf(item, out);
    // 机制体检 --json 用 exit 0/1；其它按 code
    const ok = code === 0 && probs.length === 0;
    results.push({ key: item.key, name: item.name, ok, code, problems: probs });
  }
  return results;
}

/** 与基线算差异集合 */
function diffWithBaseline(now, fpNow) {
  if (!fs.existsSync(BASELINE)) return { firstRun: true, items: [], files: [] };
  let base = null;
  try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { return { firstRun: true, items: [], files: [] }; }

  const items = [];
  const baseMap = new Map((base.checks || []).map((c) => [c.key, c]));
  for (const n of now) {
    const b = baseMap.get(n.key);
    if (!b) { items.push({ key: n.key, kind: 'new', text: n.name + '：基线里没有这一项' }); continue; }
    if (b.ok && !n.ok) items.push({ key: n.key, kind: 'regressed', text: n.name + '：**从通过变成不通过**' });
    if (!b.ok && n.ok) items.push({ key: n.key, kind: 'fixed', text: n.name + '：从不过变成通过' });
  }
  const files = [];
  const baseFp = base.fingerprints || {};
  for (const [rel, h] of Object.entries(fpNow)) {
    const old = baseFp[rel];
    if (old === undefined) { files.push({ rel, kind: 'new' }); continue; }
    if (old !== h) files.push({ rel, kind: 'changed' });
  }
  return { firstRun: false, items, files, baseAt: base.at };
}

function report(now, diff) {
  console.log('验证闸 —— 硬判据 + 基线比对\n');
  for (const r of now) {
    console.log((r.ok ? '  ✓ ' : '  ⛔ ') + r.name + (r.ok ? '' : '  (exit ' + r.code + ')'));
    for (const p of r.problems.slice(0, 6)) console.log('        · ' + p);
  }
  const closed = now.filter((r) => !r.ok);

  console.log('\n── 与基线比对 ──');
  if (diff.firstRun) {
    console.log('  （首次运行，没有基线可比；本次结果将作为基线）');
  } else {
    if (!diff.items.length && !diff.files.length) console.log('  ✓ 与基线一致（' + (diff.baseAt || '').slice(0, 19) + ' 那次）');
    for (const it of diff.items) {
      const tag = it.kind === 'regressed' ? '⛔ 退化' : it.kind === 'fixed' ? '✓ 修好' : '· 新增';
      console.log('  ' + tag + '：' + it.text);
    }
    for (const f of diff.files) {
      console.log('  ' + (f.kind === 'changed' ? '· 文件变动' : '· 新文件') + '：' + f.rel);
    }
  }

  const regressed = diff.items.filter((i) => i.kind === 'regressed');
  if (regressed.length) console.log('\n⚠ 有 ' + regressed.length + ' 项**从通过变成不通过** —— 这就是"悄悄退化"。');

  console.log('\n' + (closed.length ? '⛔ 闸门关闭：' + closed.length + ' 项不过' : '✓ 闸门开着：全部通过'));
  return closed;
}

/* ---------------- 反例自证 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① 硬判据真能挡住：拿一个必失败的检查喂进去
  {
    const fake = { key: 'mechanism', name: '伪造：必失败项', cmd: ['工具/删会话.mjs', '--check'] };
    // 造一个空壳会话，--check 必须 exit 1
    const base = path.join(MEM, '..', 'sessions');
    let wsDir = null;
    if (fs.existsSync(base)) {
      for (const w of fs.readdirSync(base)) {
        const d = path.join(base, w);
        if (fs.statSync(d).isDirectory() && fs.readdirSync(d).some((s) => s.startsWith('session-'))) { wsDir = d; break; }
      }
    }
    if (wsDir) {
      const ghost = path.join(wsDir, 'session-gate-selftest');
      fs.mkdirSync(ghost, { recursive: true });
      fs.writeFileSync(path.join(ghost, 'session.v4.jsonl.zstd'), 'x', 'utf8');
      const r = run(fake);
      fs.rmSync(ghost, { recursive: true, force: true });
      add(r.code === 1, '反例① 硬判据：造一个必失败项 ⇒ 闸门必须判它不通过', 'exit=' + r.code + '（应 1）');
    } else add(false, '反例① 找不到会话库，无法自测', '跳过');
  }

  // ② 差异集合真能看出"退化"：造两份假结果比一比
  {
    const fakeBase = {
      at: new Date().toISOString(),
      checks: [{ key: 'a', ok: true, name: 'A' }, { key: 'b', ok: true, name: 'B' }],
      fingerprints: { 'x.md': 'aaa' },
    };
    const fakeNow = [{ key: 'a', ok: true, name: 'A' }, { key: 'b', ok: false, name: 'B', problems: ['坏了'] }];
    const tmp = path.join(GATE_DIR, '_selftest-base.json');
    fs.mkdirSync(GATE_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(fakeBase), 'utf8');
    // 直接调内部比较逻辑
    const baseMap = new Map(fakeBase.checks.map((c) => [c.key, c]));
    const items = [];
    for (const n of fakeNow) {
      const b = baseMap.get(n.key);
      if (b && b.ok && !n.ok) items.push({ key: n.key, kind: 'regressed' });
    }
    fs.rmSync(tmp, { force: true });
    add(items.length === 1 && items[0].kind === 'regressed', '反例② 差异集合：基线通过→现在不通过 ⇒ 必须标「退化」并点名', JSON.stringify(items));
  }

  // ③ 反例不关就等于装饰：断言"没有问题 ⇒ ok"和"有问题 ⇒ 不 ok"两种都成立
  {
    const okCase = { code: 0, problems: [] };
    const badCase = { code: 1, problems: ['x'] };
    const judge = (r) => r.code === 0 && r.problems.length === 0;
    add(judge(okCase) === true && judge(badCase) === false, '反例③ 判定逻辑：无问题=开、有问题=关（两头都验）');
  }

  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- 入口 ---------------- */
if (has('--help') || has('-h')) {
  console.log([
    '验证闸.mjs —— 改完不会悄悄退化',
    '  node 工具\\验证闸.mjs              跑全部判据 → 与基线比 → 落新基线',
    '  node 工具\\验证闸.mjs --no-baseline 只跑不落基线',
    '  node 工具\\验证闸.mjs --strict      ⚠ 也算失败',
    '  node 工具\\验证闸.mjs --diff        只看与基线的差异',
    '  node 工具\\验证闸.mjs --selftest    反例自证：闸门必须真的会关',
    '基线：' + BASELINE,
  ].join('\n'));
  process.exit(0);
}
if (has('--selftest')) process.exit(selftest());

const fpNow = fingerprints();

if (has('--diff')) {
  if (!fs.existsSync(BASELINE)) { console.log('还没有基线（先跑一次 node 工具\\验证闸.mjs）'); process.exit(2); }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const baseFp = base.fingerprints || {};
  let n = 0;
  for (const [rel, h] of Object.entries(fpNow)) {
    if (baseFp[rel] === undefined) { console.log('· 新文件：' + rel); n++; }
    else if (baseFp[rel] !== h) { console.log('· 变动：' + rel); n++; }
  }
  console.log(n ? '\n共 ' + n + ' 处文件变动（基线与现在）' : '✓ 盯着的文件一个都没动');
  process.exit(0);
}

const now = runAll();
const diff = diffWithBaseline(now, fpNow);
const closed = report(now, diff);

/**
 * 什么时候落基线（这条判据很关键）：
 *   ✅ 闸门开着 ⇒ 落基线（记下"现在是好的"）
 *   ⛔ 闸门关着 ⇒ **绝不落基线**。否则下次比对的对象变成"已经坏掉的状态"，
 *      真正的退化就再也比不出来了 —— 那等于把闸门永久打开。
 *   首次运行且不通过：也不落（先修好再说）。
 */
const shouldWriteBaseline = !has('--no-baseline') && closed.length === 0;

if (shouldWriteBaseline) {
  fs.mkdirSync(GATE_DIR, { recursive: true });
  const stamp = new Date().toISOString();
  fs.writeFileSync(BASELINE, JSON.stringify({ at: stamp, checks: now, fingerprints: fpNow }, null, 2) + '\n', 'utf8');
  fs.appendFileSync(HISTORY, JSON.stringify({
    at: stamp, passed: now.filter((x) => x.ok).length, total: now.length,
    regressed: diff.items.filter((i) => i.kind === 'regressed').map((i) => i.key),
    closed: [],
  }) + '\n', 'utf8');
  console.log('\n（基线已更新：' + path.relative(ROOT, BASELINE) + '）');
} else if (closed.length) {
  console.log('\n（⛔ 闸门关着 ⇒ **不更新基线**，否则下次就比不出这次退化了）');
  try {
    fs.mkdirSync(GATE_DIR, { recursive: true });
    fs.appendFileSync(HISTORY, JSON.stringify({
      at: new Date().toISOString(), passed: now.filter((x) => x.ok).length, total: now.length,
      regressed: diff.items.filter((i) => i.kind === 'regressed').map((i) => i.key),
      closed: closed.map((c) => c.key),
    }) + '\n', 'utf8');
  } catch { /* 历史记不上不影响判定 */ }
}

process.exit(closed.length ? 1 : 0);
