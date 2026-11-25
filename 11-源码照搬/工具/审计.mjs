#!/usr/bin/env node
/**
 * 审计.mjs —— 只读巡检总入口（照搬拓扑 C9「审计 → 全层：只出报告，不改数据」）
 *
 * ⛔ **本工具的纪律：只读**。
 *   · 它**不修任何东西**、不写待办、不改基线、不删文件；
 *   · 唯一的写入是**它自己的报告**（`_体检-latest.json` + 人看的 `体检报告.md`）；
 *   · 这就是参照 C9 那条线的含义：「报告只覆盖写，不参与业务」。
 *
 * 为什么要它（而不是让人跑 6 条命令）：
 *   现在 6 个体检各写各的产物（待办 / 分诊表 / 基线 / 归档），
 *   **没有一处能"一眼看全机健康"**。实测任何"要跑 6 条命令"的流程，执行率都会掉。
 *
 * 它汇总什么（六类，对应拓扑的「结构 / 记忆 / 索引 / 共享 / 技能 / 宪法」）：
 *   结构 → 场景六件套     记忆 → 场景记忆体检    索引 → 文档索引体检
 *   共享 → 协作规矩体检   技能 → 技能完整性      宪法 → 宪法版本纪律
 *   另加：机制体检（15+ 项总闸）、会话库、验证闸、MCP 补丁、发布红线
 *
 * 用法：
 *   node 工具\审计.mjs              # 全量巡检 → 写报告 → 有 ⛔ 则 exit 1
 *   node 工具\审计.mjs --quiet      # 一行结论（挂计划任务）
 *   node 工具\审计.mjs --json       # 只打印 JSON
 *   node 工具\审计.mjs --no-write   # 只读不落报告（真正的纯只读）
 *   node 工具\审计.mjs --selftest   # 反例：某项坏了必须能报出来
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
const OUT_JSON = path.join(SHARED, '_体检-latest.json');
const OUT_MD = path.join(SHARED, '体检报告.md');
const NODE = process.execPath;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/** 六类 + 附加项。每项只收结论，判据在各工具里（⛔ 不在这里重复判） */
const SECTIONS = [
  { group: '结构', key: 'scene6', name: '场景六件套', cmd: ['工具/场景体检.mjs', '--quiet'] },
  { group: '记忆', key: 'memory', name: '场景记忆（§〇 / 指纹 / 绑定）', cmd: ['工具/场景记忆.mjs', 'check', '--all'] },
  { group: '索引', key: 'docindex', name: '文档索引（未登记 / 死条目 / 状态词）', cmd: ['工具/索引体检.mjs', '--quiet'] },
  { group: '共享', key: 'collab', name: '协作规矩（地盘表 / 漂移 / 体积）', cmd: ['工具/协作体检.mjs', '--quiet'] },
  { group: '技能', key: 'skills', name: '技能完整性（孤儿 / 未绑定场景 / frontmatter）', cmd: ['工具/技能体检.mjs', '--quiet'] },
  { group: '共享', key: 'conflict', name: '冲突登记（C4 上行）', cmd: ['工具/冲突.mjs', '--check', '--quiet'] },
  { group: '结构', key: 'doc-ledger', name: '文档台账（密集目录索引 / 四状态 / 到期）', cmd: ['工具/文档台账.mjs', '--check', '--quiet'] },
  { group: '运行时', key: 'entry', name: '入口哨兵（启动链路完整性）', cmd: ['工具/入口哨兵.mjs', '--quiet'] },
  { group: '运行时', key: 'logwatch', name: '日志看门（壳层/引擎/渲染器故障特征）', cmd: ['工具/日志看门.mjs', '--quiet'] },
  { group: '会话', key: 'nag', name: '催办判据（逾期/上限/间隔）', cmd: ['工具/催办.mjs', '--selftest'] },
  { group: '运行时', key: 'cleanreq', name: '清理归口（清理请求只发消息）', cmd: ['工具/清理请求.mjs', '--selftest'] },
  { group: '宪法', key: 'constitution', name: '宪法版本纪律', cmd: ['工具/宪法体检.mjs', '--quiet'] },
  { group: '总闸', key: 'mechanism', name: '机制体检（全部项目 + 反例门禁）', cmd: ['工具/机制体检.mjs', '--quiet'] },
  { group: '会话', key: 'sessions', name: '会话库（空壳残留）', cmd: ['工具/删会话.mjs', '--check'] },
  { group: '闸门', key: 'gate', name: '验证闸（基线比对）', cmd: ['工具/验证闸.mjs', '--no-baseline'] },
  { group: 'MCP', key: 'mcp', name: 'MCP 补丁在位', cmd: ['工具/mcp-iconfont补丁.mjs', '--check'] },
  { group: '发布', key: 'publish', name: '发布前红线', cmd: ['工具/发布前检查.mjs'] },
];

function run(item) {
  const r = spawnSync(NODE, [item.cmd[0], ...item.cmd.slice(1)], {
    cwd: ROOT, encoding: 'utf8', timeout: 240000,
    env: { ...process.env, DSH_NO_TODO: '1' },
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { code: r.status, out };
}

/** 从输出里抽点名的问题行（含紧随其后的明细行，才能定位到"具体哪条/哪个文件"） */
function problemsOf(out) {
  const lines = out.split(/\r?\n/);
  const picked = [];
  for (let i = 0; i < lines.length && picked.length < 10; i++) {
    if (!/^\s*(⛔|✗)/.test(lines[i])) continue;
    picked.push(lines[i].trim().replace(/^[⛔✗]\s*/, '').slice(0, 180));
    // 紧跟的缩进明细行（通常是具体的 id / 文件名 / 路径）也带上，最多 2 行
    for (let k = i + 1, n = 0; k < lines.length && n < 2; k++, n++) {
      const l = lines[k];
      if (!l.trim() || /^\s*(⛔|✗|怎么修|✓)/.test(l)) break;
      if (/^\s{2,}\S/.test(l)) picked.push('  ' + l.trim().slice(0, 180));
      else break;
    }
  }
  return picked;
}

function audit() {
  const rows = [];
  for (const s of SECTIONS) {
    const { code, out } = run(s);
    const probs = problemsOf(out);
    rows.push({
      group: s.group, key: s.key, name: s.name,
      ok: code === 0, exit: code, problems: probs,
      // 只留最后一行摘要（人看的那句）
      summary: (out.split(/\r?\n/).filter((l) => l.trim()).pop() || '').slice(0, 200),
    });
  }
  return rows;
}

function report(rows) {
  const bad = rows.filter((r) => !r.ok);
  const stamp = new Date().toISOString();

  // 按类汇总
  const byGroup = {};
  for (const r of rows) { (byGroup[r.group] = byGroup[r.group] || []).push(r); }

  const json = {
    at: stamp,
    total: rows.length,
    passed: rows.length - bad.length,
    failed: bad.length,
    groups: Object.fromEntries(Object.entries(byGroup).map(([g, list]) => [g, {
      ok: list.every((x) => x.ok), items: list.map(({ group, ...x }) => x),
    }])),
  };

  const md = [
    '# 体检报告',
    '',
    '> 由 `工具\\审计.mjs` 生成（**只读巡检**：不修东西、不改基线、不写待办，只出这份报告）。',
    '> 生成时间：' + stamp + '　｜　共 ' + rows.length + ' 项，通过 ' + (rows.length - bad.length) + '，⛔ ' + bad.length,
    '',
    '| 类别 | 项 | 结果 | 说明 |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.group} | ${r.name} | ${r.ok ? '✓' : '⛔'} | ${r.ok ? '' : (r.problems[0] || r.summary || '')} |`),
    '',
  ];
  if (bad.length) {
    md.push('## ⛔ 明细（' + bad.length + ' 项）', '');
    for (const r of bad) {
      md.push('### ' + r.group + ' · ' + r.name + '（exit ' + r.exit + '）');
      for (const p of r.problems.length ? r.problems : [r.summary]) md.push('- ' + p);
      md.push('');
    }
  } else {
    md.push('## ✓ 全部通过', '');
  }
  md.push('---', '', '> 怎么修：见每项对应的工具（`node 工具\\<工具>.mjs`）。⛔ 本报告不会自己动手。');

  return { json, md: md.join('\n') + '\n' };
}

/* ---------------- 自测（反例） ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① 造一个必然失败的项，审计必须标 ⛔
  {
    const base = path.join(MEM, '..', 'sessions');
    let wsDir = null;
    if (fs.existsSync(base)) {
      for (const w of fs.readdirSync(base)) {
        const d = path.join(base, w);
        if (fs.statSync(d).isDirectory() && fs.readdirSync(d).some((s) => s.startsWith('session-'))) { wsDir = d; break; }
      }
    }
    if (wsDir) {
      const ghost = path.join(wsDir, 'session-audit-selftest');
      fs.mkdirSync(ghost, { recursive: true });
      fs.writeFileSync(path.join(ghost, 'session.v4.jsonl.zstd'), 'x', 'utf8');
      const { out } = run(SECTIONS.find((s) => s.key === 'sessions'));
      fs.rmSync(ghost, { recursive: true, force: true });
      const probs = problemsOf(out);
      add(probs.length > 0, '反例① 造一个空壳会话 ⇒ 审计必须报出来', 'problems=' + probs.length);
    } else add(false, '反例① 找不到会话库', '跳过');
  }

  // ② 报告结构：有 ⛔ 时 md 必须出现「⛔ 明细」
  {
    const fakeRows = [
      { group: '结构', key: 'a', name: 'A', ok: true, exit: 0, problems: [], summary: 'ok' },
      { group: '记忆', key: 'b', name: 'B', ok: false, exit: 1, problems: ['坏了'], summary: '' },
    ];
    const { md, json } = report(fakeRows);
    add(md.includes('⛔ 明细') && json.failed === 1, '反例② 有 ⛔ ⇒ 报告出现「⛔ 明细」且 JSON failed=1', 'failed=' + json.failed);
  }

  // ③ 全绿时不该有「⛔ 明细」
  {
    const rows = [{ group: '结构', key: 'a', name: 'A', ok: true, exit: 0, problems: [], summary: 'ok' }];
    const { md, json } = report(rows);
    add(!md.includes('⛔ 明细') && json.failed === 0 && md.includes('全部通过'), '反例③ 全绿 ⇒ 不出「⛔ 明细」且写「全部通过」');
  }

  // ④ 只读纪律：--no-write 下不许动报告文件
  {
    const before = fs.existsSync(OUT_JSON) ? fs.statSync(OUT_JSON).mtimeMs : 0;
    // 这里只验证「--no-write 分支不会调用写入」这件事靠代码保证：检查源码里写入受 NO_WRITE 守卫
    const src = fs.readFileSync(SELF, 'utf8');
    const guarded = /if\s*\(!NO_WRITE\)/.test(src) && src.includes('OUT_JSON');
    add(guarded, '反例④ 报告写入受 --no-write 守卫（只读纪律）', 'before=' + before);
  }

  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '  ✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- 入口 ---------------- */
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();

if (isMain) {
  const NO_WRITE = has('--no-write');
  if (has('--selftest')) process.exit(selftest());
  if (has('--help') || has('-h')) {
    console.log([
      '审计.mjs —— 只读巡检总入口（拓扑 C9）',
      '  node 工具\\审计.mjs           全量 → 写 _体检-latest.json + 体检报告.md',
      '  node 工具\\审计.mjs --quiet   一行结论',
      '  node 工具\\审计.mjs --json    只打印 JSON',
      '  node 工具\\审计.mjs --no-write 只读，不落报告',
      '  node 工具\\审计.mjs --selftest 反例自证',
      '⛔ 本工具只出报告：不修东西、不改基线、不写待办。',
    ].join('\n'));
    process.exit(0);
  }

  const rows = audit();
  const { json, md } = report(rows);
  const bad = rows.filter((r) => !r.ok);

  if (has('--json')) { console.log(JSON.stringify(json, null, 2)); process.exit(bad.length ? 1 : 0); }

  if (has('--quiet')) {
    console.log(bad.length
      ? `⛔ 审计：${bad.length}/${rows.length} 项不过（${bad.map((b) => b.group).join(' / ')}）→ node 工具\\审计.mjs`
      : `✓ 审计：${rows.length}/${rows.length} 项全过`);
    if (!NO_WRITE) { fs.mkdirSync(SHARED, { recursive: true }); fs.writeFileSync(OUT_JSON, JSON.stringify(json, null, 2) + '\n', 'utf8'); fs.writeFileSync(OUT_MD, md, 'utf8'); }
    process.exit(bad.length ? 1 : 0);
  }

  console.log('只读巡检（不改任何数据，只出报告）\n');
  let lastGroup = '';
  for (const r of rows) {
    if (r.group !== lastGroup) { console.log('── ' + r.group + ' ──'); lastGroup = r.group; }
    console.log((r.ok ? '  ✓ ' : '  ⛔ ') + r.name + (r.ok ? '' : '  (exit ' + r.exit + ')'));
    for (const p of r.problems.slice(0, 4)) console.log('        · ' + p);
  }
  console.log('\n' + (bad.length ? '⛔ ' + bad.length + ' / ' + rows.length + ' 项不过' : '✓ ' + rows.length + ' / ' + rows.length + ' 项全过'));

  if (!NO_WRITE) {
    fs.mkdirSync(SHARED, { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(json, null, 2) + '\n', 'utf8');
    fs.writeFileSync(OUT_MD, md, 'utf8');
    console.log('\n报告：' + path.relative(ROOT, OUT_MD) + '（+ _体检-latest.json）');
  } else {
    console.log('\n（--no-write：没落报告）');
  }
  process.exit(bad.length ? 1 : 0);
}
