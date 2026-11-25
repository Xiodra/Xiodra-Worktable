#!/usr/bin/env node
/**
 * 项目记忆.mjs —— 「一项目一份记忆，比会话活得久」（照搬拓扑 C5/C6）
 *
 * 参照拓扑的原话：
 *   C5 场景 → 项目：「按项目记忆路由：一项目一份 `项目记忆\<项目id>.md`，与项目清单 memory 对应」
 *   C6 项目 → 场景：「成果/证据回写：验收或结项后落项目记忆与 §五，不写过程流水」
 *
 * 治什么：我们之前**只有场景级记忆，没有项目级**。
 *   一个项目做两周、跨十几条会话，所有东西都堆在场景 §五 里 ⇒ 主文件超线、也找不到"这个项目到底到哪一步"。
 *
 * 判据（唯一出处 = 本文件）：
 *   ① **路由唯一**：`_共享记忆\项目.json` 的每个项目必须有 `id` / `name` / `scene` / `memory` / `status`，
 *      且 `memory` 指向的文件必须真实存在（⛔ 死路由 = 写着有其实没有）
 *   ② **四态**：`status` 只许 `进行中 / 等待外部 / 已结项 / 归档`
 *   ③ **体积**：项目记忆 ≤ 8 KB（⛔ 超了搬进该项目的 `归档\`）
 *   ④ **必备四节**：`§〇 当前状态` / `§一 目标` / `§二 产出` / `§五 决策与坑`
 *   ⑤ **归场景**：`scene` 必须是真实场景名（⛔ 指到不存在的场景 = 没人维护）
 *
 * 用法：
 *   node 工具\项目记忆.mjs list                 # 所有项目 + 状态 + 体积
 *   node 工具\项目记忆.mjs new --id X --name "中文名" --scene DSH·GUI [--status 进行中]
 *   node 工具\项目记忆.mjs check                # 体检（⛔ ⇒ exit 1）
 *   node 工具\项目记忆.mjs check --quiet
 *   node 工具\项目记忆.mjs status --id X --set 已结项
 *   node 工具\项目记忆.mjs --selftest           # 反例：死路由 / 非法状态 / 缺节 / 超线 / 假场景
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
const REG = path.join(SHARED, '项目.json');
const SCEN = path.join(ROOT, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const STATES = ['进行中', '等待外部', '已结项', '归档'];
const MAX_KB = 8;
const SECTIONS = ['## §〇 当前状态', '## §一 目标', '## §二 产出', '## §五 决策与坑'];

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const sceneNames = () => {
  const out = new Set();
  if (fs.existsSync(SCEN)) for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const j = readJson(path.join(SCEN, f)); if (j && j.name) out.add(j.name);
  }
  return out;
};

/** 纯函数：判路由是否合规 */
export function checkRegistry(reg, scenes) {
  const bad = [], warn = [], ok = [];
  const projects = (reg && reg.projects) || [];
  if (!projects.length) { warn.push('项目.json 里还没有项目（正常：等第一个真项目）'); return { bad, warn, ok, projects }; }
  const ids = new Set();
  for (const p of projects) {
    const tag = p.id || '(无 id)';
    if (!p.id) bad.push('有项目缺 id');
    else if (ids.has(p.id)) bad.push('项目 id 重复：' + p.id);
    else ids.add(p.id);

    if (!p.name) bad.push(`项目 ${tag} 缺 name`);
    if (!p.scene) bad.push(`项目 ${tag} 缺 scene（归哪个场景）`);
    else if (!scenes.has(p.scene)) bad.push(`项目 ${tag} 的 scene「${p.scene}」不是真实场景（没人维护）`);
    if (!p.memory) bad.push(`项目 ${tag} 缺 memory（记忆文件路径）`);
    else if (!fs.existsSync(p.memory)) bad.push(`项目 ${tag} 的 memory 是指向空处的死路由：${p.memory}`);
    if (!STATES.includes(p.status)) bad.push(`项目 ${tag} 的 status「${p.status}」非法（只许 ${STATES.join(' / ')}）`);
  }
  if (!bad.length) ok.push(projects.length + ' 个项目路由全部有效');
  return { bad, warn, ok, projects };
}

/** 判一个项目记忆文件是否合规 */
export function checkMemoryFile(file) {
  const bad = [], warn = [], ok = [];
  if (!fs.existsSync(file)) return { bad: ['记忆文件不存在：' + file], warn, ok };
  const t = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(t);
  if (bytes > MAX_KB * 1024) bad.push(`${path.basename(file)} ${(bytes / 1024).toFixed(1)} KB 超 ${MAX_KB} KB（搬进该项目的 归档\）`);
  else ok.push((bytes / 1024).toFixed(1) + ' KB');
  const miss = SECTIONS.filter((s) => !t.includes(s));
  if (miss.length) bad.push('缺必备小节：' + miss.join(' / '));
  else ok.push('四节齐');
  return { bad, warn, ok };
}

/* ---------------- 新建 ---------------- */
function create() {
  const id = val('--id'), name = val('--name'), scene = val('--scene');
  const status = val('--status', '进行中');
  if (!id || !name || !scene) { console.error('用法：new --id <项目id> --name "<中文名>" --scene <场景名> [--status 进行中]'); process.exit(2); }
  if (!sceneNames().has(scene)) { console.error('✗ 场景「' + scene + '」不存在（现有：' + [...sceneNames()].join(' / ') + '）'); process.exit(2); }
  if (!STATES.includes(status)) { console.error('✗ status 只许 ' + STATES.join(' / ')); process.exit(2); }

  const reg = readJson(REG) || { projects: [] };
  reg.projects = reg.projects || [];
  if (reg.projects.some((p) => p.id === id)) { console.error('✗ 项目「' + id + '」已存在'); process.exit(2); }

  const dir = path.join(MEM, scene, '项目记忆');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.md');
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, [
    '# ' + name + ' · 项目记忆',
    '',
    '> 项目 id：`' + id + '`　｜　归属场景：' + scene + '　｜　建立：' + today,
    '> ⛔ 这是**项目级**记忆（比会话活得久）。进度/下一步写 §〇，决策与新坑追加 §五。',
    '',
    '## §〇 当前状态',
    '',
    '- 状态：' + status,
    '- 到哪一步：',
    '- 下一步：',
    '- 卡点：',
    '',
    '## §一 目标',
    '',
    '- 这个项目要解决什么（一句话）：',
    '',
    '## §二 产出',
    '',
    '| 产出 | 位置 | 状态 |',
    '|---|---|---|',
    '| ',
    '',
    '## §五 决策与坑',
    '',
    '（只追加，带日期）',
    '',
  ].join('\n'), 'utf8');

  reg.projects.push({ id, name, scene, status, memory: file, createdAt: today });
  fs.writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  console.log('✓ 已建项目：' + name + '（' + id + '）');
  console.log('  记忆：' + path.relative(ROOT, file));
  console.log('  路由：_共享记忆\\项目.json');
}

function setStatus() {
  const id = val('--id'), s = val('--set');
  if (!id || !s) { console.error('用法：status --id <项目id> --set 进行中|等待外部|已结项|归档'); process.exit(2); }
  if (!STATES.includes(s)) { console.error('✗ status 只许 ' + STATES.join(' / ')); process.exit(2); }
  const reg = readJson(REG);
  const p = (reg && reg.projects || []).find((x) => x.id === id);
  if (!p) { console.error('✗ 没有项目「' + id + '」'); process.exit(2); }
  const old = p.status;
  p.status = s;
  fs.writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  console.log('✓ ' + p.name + '：' + old + ' → ' + s);
  console.log('  ⚠ 记得同步改记忆文件 §〇 的「状态：」那一行（本工具不替你改正文）');
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });
  const tmp = path.join(ROOT, '_临时', 'scrap', '项目记忆自测');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const scenes = new Set(['某场景']);

  const goodText = SECTIONS.map((s) => s + '\n\n- x\n').join('\n');

  // ① 死路由
  {
    const reg = { projects: [{ id: 'a', name: 'A', scene: '某场景', status: '进行中', memory: path.join(tmp, 'nope.md') }] };
    const r = checkRegistry(reg, scenes);
    add(r.bad.some((b) => b.includes('死路由')), '反例① memory 指向不存在的文件 ⇒ ⛔ 死路由', r.bad.join(' | '));
  }
  // ② 非法状态
  {
    const f = path.join(tmp, 'b.md'); fs.writeFileSync(f, goodText, 'utf8');
    const reg = { projects: [{ id: 'b', name: 'B', scene: '某场景', status: '在干', memory: f }] };
    const r = checkRegistry(reg, scenes);
    add(r.bad.some((b) => b.includes('非法')), '反例② status 不在四态里 ⇒ ⛔', r.bad.join(' | '));
  }
  // ③ 假场景
  {
    const f = path.join(tmp, 'c.md'); fs.writeFileSync(f, goodText, 'utf8');
    const reg = { projects: [{ id: 'c', name: 'C', scene: '不存在的场景', status: '进行中', memory: f }] };
    const r = checkRegistry(reg, scenes);
    add(r.bad.some((b) => b.includes('不是真实场景')), '反例③ scene 不是真实场景 ⇒ ⛔', r.bad.join(' | '));
  }
  // ④ 缺必备小节
  {
    const f = path.join(tmp, 'd.md'); fs.writeFileSync(f, '# D\n\n## §〇 当前状态\n\n- x\n', 'utf8');
    const r = checkMemoryFile(f);
    add(r.bad.some((b) => b.includes('缺必备小节')), '反例④ 缺 §一/§二/§五 ⇒ ⛔', r.bad.join(' | '));
  }
  // ⑤ 超 8 KB
  {
    const f = path.join(tmp, 'e.md');
    fs.writeFileSync(f, goodText + 'x'.repeat(9000), 'utf8');
    const r = checkMemoryFile(f);
    add(r.bad.some((b) => b.includes('超 8 KB')), '反例⑤ 超 8 KB ⇒ ⛔', r.bad.join(' | '));
  }
  // ⑥ 正例
  {
    const f = path.join(tmp, 'f.md'); fs.writeFileSync(f, goodText, 'utf8');
    const reg = { projects: [{ id: 'f', name: 'F', scene: '某场景', status: '进行中', memory: f }] };
    const r1 = checkRegistry(reg, scenes);
    const r2 = checkMemoryFile(f);
    add(r1.bad.length === 0 && r2.bad.length === 0, '正例 路由有效 + 四节齐 + 未超线 ⇒ 通过', (r1.bad.concat(r2.bad)).join(' | '));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- 入口 ---------------- */
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();

if (isMain) {
  const cmd = argv.find((a) => !a.startsWith('--')) || '';
  if (has('--selftest')) process.exit(selftest());
  if (has('--help') || has('-h')) {
    console.log([
      '项目记忆.mjs —— 一项目一份记忆（C5/C6）',
      '  node 工具\\项目记忆.mjs list',
      '  node 工具\\项目记忆.mjs new --id X --name "中文名" --scene <场景> [--status 进行中]',
      '  node 工具\\项目记忆.mjs status --id X --set 已结项',
      '  node 工具\\项目记忆.mjs check [--quiet]',
      '  node 工具\\项目记忆.mjs --selftest',
    ].join('\n'));
    process.exit(0);
  }
  if (cmd === 'new') { create(); process.exit(0); }
  if (cmd === 'status') { setStatus(); process.exit(0); }

  const reg = readJson(REG) || { projects: [] };
  const scenes = sceneNames();

  if (cmd === 'list') {
    const ps = reg.projects || [];
    if (!ps.length) { console.log('（还没有项目。建：node 工具\\项目记忆.mjs new --id X --name "名" --scene <场景>）'); process.exit(0); }
    console.log('项目清单：' + REG + '\n');
    for (const p of ps) {
      const sz = fs.existsSync(p.memory) ? (fs.statSync(p.memory).size / 1024).toFixed(1) + ' KB' : '⛔ 死路由';
      console.log(`  [${p.status}] ${p.name}（${p.id}）· 归 ${p.scene} · ${sz}`);
    }
    process.exit(0);
  }

  // check
  const r1 = checkRegistry(reg, scenes);
  const bad = [...r1.bad], warn = [...r1.warn], ok = [...r1.ok];
  for (const p of r1.projects) {
    if (p.memory && fs.existsSync(p.memory)) {
      const r2 = checkMemoryFile(p.memory);
      bad.push(...r2.bad.map((b) => p.id + '：' + b));
      warn.push(...r2.warn.map((b) => p.id + '：' + b));
    }
  }
  if (has('--quiet')) {
    console.log(bad.length ? `⛔ 项目记忆：${bad.length} 个问题（跑 node 工具\\项目记忆.mjs check 看明细）` : `✓ 项目记忆：${r1.projects.length} 个项目全合规${warn.length ? '（⚠ ' + warn.length + '）' : ''}`);
    process.exit(bad.length ? 1 : 0);
  }
  for (const s of ok) console.log('  ✓ ' + s);
  for (const w of warn) console.log('  ⚠ ' + w);
  for (const b of bad) console.log('  ⛔ ' + b);
  console.log('\n' + (bad.length ? '⛔ ' + bad.length + ' 个问题' : '✓ 全部通过'));
  process.exit(bad.length ? 1 : 0);
}
