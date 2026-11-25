#!/usr/bin/env node
/**
 * 技能索引.mjs —— 技能只建索引，执行时按需读取（铁律②）
 *
 * Xiodra 的设计原文：
 *   ② **私有技能只建索引**（技能名 | 触发关键词 | 一句话用途 | 存储位置），
 *      执行时**先读索引按需读取，禁止全量读取**；
 *   M4 技能索引化：①建全量索引表 ②今后先读索引按需读取
 *      ③识别可合并 / 可固化为底层工具（脚本/自动化）的重复技能并给固化建议
 *
 * ⛔ 为什么这很重要：技能全文一次全读，等于每轮都花 token 读**不相关**的内容。
 *   索引表通常 1 KB，全量技能 10 KB ⇒ 省 90% 的无效读取。
 *
 * 用法：
 *   node 工具\技能索引.mjs              # 生成/刷新索引表 引擎数据\.dsh\skills\_索引.md
 *   node 工具\技能索引.mjs --check      # 体检：索引与实际技能是否一致（缺/多/过期）
 *   node 工具\技能索引.mjs --固化建议    # 找"重复技能"和"该写成脚本的固定套路"
 *   node 工具\技能索引.mjs --selftest    # 反例：缺技能/多死条目/缺触发词 都要报
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const SKILLS = path.join(ROOT, '引擎数据', '.dsh', 'skills');
const INDEX = path.join(SKILLS, '_索引.md');
const SCEN = path.join(ROOT, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/** 读所有技能的 frontmatter（name / description）与体积 */
export function readSkills() {
  const out = [];
  if (!fs.existsSync(SKILLS)) return out;
  for (const e of fs.readdirSync(SKILLS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = path.join(SKILLS, e.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    const bytes = Buffer.byteLength(t);
    const fm = t.match(/^---\s*\n([\s\S]*?)\n---/);
    const body = fm ? fm[1] : '';
    const name = (body.match(/^name:\s*(.+)$/m) || [])[1] || '';
    const desc = (body.match(/^description:\s*(.+)$/m) || [])[1] || '';
    out.push({ dir: e.name, name: name.trim(), desc: desc.trim(), bytes, file: 'skills/' + e.name + '/SKILL.md' });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * 技能归属哪个场景 —— 判据唯一出处。
 *
 * 两条来源（2026-11-21 派单 9f04ae5f54 新增第二条）：
 *   ① 场景 json 的 `skill` 字段（主技能，一个场景一个）；
 *   ② **定位卡 `外壳\scenarios\<场景id>-context.md` 里的明确引用**（第二技能）。
 *      背景：Xiodra 拍板 embed-panel-debug 不占 json 的 skill 字段
 *      （dsh-gui 有两个分工不同的会话，场景只能挂一个主技能），只在卡里引用。
 *      若只认 ①，这类"第二技能"会永远被判孤儿 ⇒ 判据与实际做法打架。
 *
 * ⛔ 判据**不能放松**成"随便提一句就算有主"：
 *   · 只认 skills/ 下**真实存在的技能目录名**（逐字）；
 *   · 且必须作为**独立词**出现（前后不是字母/数字/下划线），
 *     避免 `embed-panel-debug-xxx` 这种前缀误命中；
 *   · 引用一个**不存在的**技能名 → 不算认领（不会让体检变绿）。
 */
/**
 * 定位卡文本里**认领了哪些技能**（纯函数，便于反例直接测它，不用碰真实场景文件）。
 *
 * ⛔ 判据（派单 d7b0450dd1 明确要求"别放宽成随便提一句就算有主"）：
 *   · 只认 `realSkills` 里**真实存在的技能目录名**（逐字）；
 *   · 必须作为**独立词**出现（前后不是 [A-Za-z0-9_-]），
 *     避免 `embed-panel-debug-xxx` 这种前缀误命中；
 *   · 写一个**不存在的**技能名 → 返回空（不算认领，体检不会因此变绿）。
 *
 * @param {string} txt 定位卡全文
 * @param {Set<string>} realSkills skills/ 下真实存在的目录名
 * @returns {string[]} 认领到的技能名
 */
export function cardClaims(txt, realSkills) {
  const hit = [];
  const body = String(txt || '');
  if (!body) return hit;
  for (const sk of (realSkills || [])) {
    const esc = String(sk).replace(/[.*+?^${}()|[\]\\]/g, '\\export function skillOwners() {');
    const re = new RegExp('(^|[^A-Za-z0-9_-])' + esc + '($|[^A-Za-z0-9_-])');
    if (re.test(body)) hit.push(sk);
  }
  return hit;
}

export function skillOwners() {
  const m = {};
  if (!fs.existsSync(SCEN)) return m;

  // skills/ 下真实存在的技能目录名（收紧判据用）
  const realSkills = new Set();
  try {
    for (const d of fs.readdirSync(SKILLS, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.')) realSkills.add(d.name);
    }
  } catch (e) { /* 没有 skills 目录就当空 */ }

  for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }

    // ① json 的 skill 字段（主技能）
    if (j && j.skill) m[j.skill] = j.name || j.id;

    // ② 定位卡引用（第二技能）
    const sceneId = String((j && j.id) || f.replace(/\.json$/i, ''));
    const card = path.join(SCEN, sceneId + '-context.md');
    if (!fs.existsSync(card)) continue;
    let txt = '';
    try { txt = fs.readFileSync(card, 'utf8'); } catch (e) { continue; }
    for (const sk of cardClaims(txt, realSkills)) {
      // 已有归属的不覆盖；只补没登记过的
      if (!m[sk]) m[sk] = (j && (j.name || j.id)) || sceneId;
    }
  }
  return m;
}

/** 从 description 里抽触发关键词（「触发词：」后的内容） */
export function triggersOf(desc) {
  const s = String(desc || '');
  const m = s.match(/触发词[：:]\s*(.+)$/);
  if (!m) {
    const m2 = s.match(/「([^」]{1,20})」/);
    return m2 ? m2[1] : '';
  }
  /**
   * ⚠ 修（2026-11-21 实测）：原写法 `.replace(/[」』"]/g,'')` 把**开引号留下、闭引号删掉**，
   *   抽出来是 `「控制器「命令台「分诊。` —— 难看且不像"关键词"。
   *   ⇒ 正确做法：把「X」「Y」拆成 X/Y，去掉尾句号。
   */
  const tail = m[1].trim().replace(/[。.]$/, '');
  const quoted = [...tail.matchAll(/[「『"]([^」』"]{1,20})[」』"]/g)].map((x) => x[1].trim());
  if (quoted.length) return quoted.join(' / ');
  return tail.replace(/[「」『』"]/g, '').trim();
}

/** 一句话用途：description 的第一句（去触发词部分） */
export function purposeOf(desc) {
  const s = String(desc || '').replace(/触发词[：:].*$/, '').trim();
  const first = s.split(/[。；;]/)[0] || s;
  return first.slice(0, 80).trim() || '（description 没写用途）';
}

/** 生成索引表 */
export function buildIndex() {
  const skills = readSkills();
  const owners = skillOwners();
  const rows = skills.map((s) => {
    const owner = owners[s.dir] || '（无场景引用）';
    return '| `' + s.dir + '` | ' + (triggersOf(s.desc) || '⚠ 未写触发词') + ' | ' + purposeOf(s.desc) + ' | `' + s.file + '` | ' + owner + ' |';
  });

  return [
    '# 技能索引（唯一出处：`工具\\技能索引.mjs` 生成，⛔ 别手改）',
    '',
    '> **执行时先读这张表，按需再读具体技能全文** —— ⛔ 禁止一上来就全量读技能。',
    '> 判据：表 ≤2 KB 能一次读完；全量技能通常 10 KB+，全读等于每轮花 token 读不相关的东西。',
    '> 「触发关键词」匹配上你的任务时，再按「存储位置」去读那一个文件。',
    '',
    '| 技能名 | 触发关键词 | 一句话用途 | 存储位置 | 归属场景 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '> 刷新：`node 工具\\技能索引.mjs`　体检：`--check`　固化建议：`--固化建议`',
    '',
  ].join('\n');
}

/** 体检：索引 ↔ 实际技能双向核对 */
export function check() {
  const bad = [], warn = [], ok = [];
  const skills = readSkills();
  if (!skills.length) { bad.push('一个技能都没有'); return { bad, warn, ok, skills }; }

  if (!fs.existsSync(INDEX)) bad.push('缺技能索引表 `skills\\_索引.md`（跑 node 工具\\技能索引.mjs 生成）');
  else {
    const idx = fs.readFileSync(INDEX, 'utf8');
    for (const s of skills) {
      if (!idx.includes('`' + s.dir + '`')) bad.push('技能「' + s.dir + '」没在索引表里（新加的没登记）');
    }
    // 索引里列了但实际不存在 ⇒ 死条目
    const listed = [...idx.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);
    for (const n of listed) {
      if (n === '技能名') continue;
      if (!skills.some((s) => s.dir === n)) bad.push('索引里有死条目「' + n + '」（技能已删，索引没更新）');
    }
    if (!bad.length) ok.push('索引与实际技能一致（' + skills.length + ' 个）');
    if (Buffer.byteLength(idx) > 2048) warn.push('索引表 ' + (Buffer.byteLength(idx) / 1024).toFixed(1) + ' KB 超 2 KB（索引要能一次读完）');
  }

  for (const s of skills) {
    if (!triggersOf(s.desc)) bad.push('技能「' + s.dir + '」description 里没写「触发词：…」（索引表就没法按需检索）');
  }

  const owners = skillOwners();
  for (const s of skills) {
    if (!owners[s.dir]) warn.push('技能「' + s.dir + '」没有场景 json 引用它（孤儿技能：每轮花 token 没人用）');
  }

  return { bad, warn, ok, skills };
}

/** 固化建议：找重复套路与该写成脚本的 */
export function suggest() {
  const skills = readSkills();
  const out = [];
  const descs = skills.map((s) => ({ ...s, d: (s.desc + ' ' + purposeOf(s.desc)).toLowerCase() }));

  // ① 关键词高度重叠的 ⇒ 可合并
  for (let i = 0; i < descs.length; i++) {
    for (let j = i + 1; j < descs.length; j++) {
      const a = new Set(descs[i].d.split(/[^\u4e00-\u9fffA-Za-z0-9]+/).filter((w) => w.length > 1));
      const b = new Set(descs[j].d.split(/[^\u4e00-\u9fffA-Za-z0-9]+/).filter((w) => w.length > 1));
      if (!a.size || !b.size) continue;
      let inter = 0; for (const w of a) if (b.has(w)) inter++;
      const jac = inter / (a.size + b.size - inter);
      if (jac >= 0.5) out.push('可合并：「' + descs[i].dir + '」与「' + descs[j].dir + '」关键词重合 ' + Math.round(jac * 100) + '%');
    }
  }

  // ② 体积大 + 含大量"步骤/命令" ⇒ 该固化成脚本
  for (const s of skills) {
    const t = fs.readFileSync(path.join(SKILLS, s.dir, 'SKILL.md'), 'utf8');
    const cmdCount = (t.match(/node 工具\\|powershell|pwsh|```powershell/g) || []).length;
    if (s.bytes > 4096 && cmdCount >= 5) {
      out.push('可固化：「' + s.dir + '」' + (s.bytes / 1024).toFixed(1) + ' KB、含 ' + cmdCount + ' 处命令 ⇒ 考虑把固定套路写成脚本，技能里只留"什么时候跑哪个脚本"');
    }
  }

  if (!out.length) out.push('（暂无可合并 / 可固化的技能）');
  return out;
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① 触发词抽得出
  add(triggersOf('【场景：控制器】…触发词：「控制器」「命令台」「分诊」。') === '控制器」「命令台」「分诊'
    || /控制器/.test(triggersOf('【场景：控制器】…触发词：「控制器」「命令台」「分诊」。')), '正例 能从 description 抽出触发词', triggersOf('触发词：「控制器」「命令台」'));

  // ② 没写触发词 ⇒ 抽不出（体检必须报）
  add(triggersOf('这个技能干一些事情。') === '', '反例① 没写「触发词：」⇒ 抽不出（体检要报）', JSON.stringify(triggersOf('这个技能干一些事情。')));

  // ③ 一句话用途要截断，别整段塞进表
  {
    const long = '很长'.repeat(100);
    add(purposeOf(long).length <= 80, '反例② 用途必须截到 80 字内（索引要能一次读完）', String(purposeOf(long).length));
  }

  // ④ 索引必须含四列 + 归属列
  {
    const idx = buildIndex();
    const need = ['技能名', '触发关键词', '一句话用途', '存储位置'];
    add(need.every((k) => idx.includes(k)), '反例③ 索引表必须含四列（技能名/触发关键词/用途/存储位置）', '');
  }

  // ⑤ 索引体积要小
  {
    const idx = buildIndex();
    add(Buffer.byteLength(idx) < 2048, '反例④ 索引表必须 <2 KB（否则"按需读取"没意义）', (Buffer.byteLength(idx) / 1024).toFixed(1) + ' KB');
  }

  // ⑥ 死条目识别：索引里有但技能不存在
  {
    const fakeIdx = '| 技能名 | 触发关键词 | 一句话用途 | 存储位置 | 归属场景 |\n|---|---|---|---|---|\n| `不存在的技能` | x | y | z | w |\n';
    const listed = [...fakeIdx.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);
    const skills = readSkills();
    const dead = listed.filter((n) => n !== '技能名' && !skills.some((s) => s.dir === n));
    add(dead.length === 1, '反例⑤ 索引里的死条目能被识别（技能删了索引没更新）', dead.join(','));
  }

  // ⑦ 定位卡认领：真实技能名出现在卡里 ⇒ 算认领（派单 d7b0450dd1）
  {
    const real = new Set(readSkills().map((x) => x.dir));
    const txt = '本场景还用到技能 embed-panel-debug（内嵌网页排障）';
    const hit = cardClaims(txt, real);
    add(hit.indexOf('embed-panel-debug') >= 0, '反例⑥ 定位卡里写了真实技能名 ⇒ 算认领（第二技能能挂卡）', hit.join(',') || '（没认到）');
  }

  // ⑧ ★核心反例★：只写不存在的技能名 ⇒ 不许认领（否则体检会被"随便提一句"骗绿）
  {
    const real = new Set(readSkills().map((x) => x.dir));
    const txt = '本场景还用了技能 not-a-real-skill-xyz 和 embed-panel-debug-v2 这类东西';
    const hit = cardClaims(txt, real);
    add(hit.length === 0, '反例⑦ 定位卡只写不存在的技能名 ⇒ 不算认领（⛔ 别放宽成随便提一句）', hit.join(',') || '（正确：没认领）');
  }

  // ⑨ 带后缀不许误命中（embed-panel-debug-extra 不能算 embed-panel-debug）
  {
    const real = new Set(['embed-panel-debug']);
    const hit = cardClaims('参见 embed-panel-debug-extra 这个不存在的东西', real);
    add(hit.length === 0, '反例⑧ 带后缀的近似名不许误命中（独立词才算）', hit.join(',') || '（正确：没误命中）');
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
      '技能索引.mjs —— 技能只建索引，按需读取（铁律②）',
      '  node 工具\\技能索引.mjs            生成/刷新索引表',
      '  node 工具\\技能索引.mjs --check    体检：索引 ↔ 实际技能双向核对',
      '  node 工具\\技能索引.mjs --固化建议  找可合并 / 该写成脚本的',
      '  node 工具\\技能索引.mjs --selftest',
      '⛔ 执行时先读索引，匹配触发词后再读那一个技能全文。',
    ].join('\n'));
    process.exit(0);
  }

  if (has('--固化建议')) {
    console.log('固化建议（M4 ③）：\n');
    for (const s of suggest()) console.log('  · ' + s);
    process.exit(0);
  }

  if (has('--check')) {
    const r = check();
    console.log('技能索引体检\n');
    for (const s of r.ok) console.log('  ✓ ' + s);
    for (const w of r.warn) console.log('  ⚠ ' + w);
    for (const b of r.bad) console.log('  ⛔ ' + b);
    console.log('\n' + (r.bad.length ? '⛔ ' + r.bad.length + ' 个问题' : '✓ 全部通过'));
    process.exit(r.bad.length ? 1 : 0);
  }

  // 生成
  fs.mkdirSync(SKILLS, { recursive: true });
  const idx = buildIndex();
  fs.writeFileSync(INDEX, idx, 'utf8');
  const skills = readSkills();
  console.log('✓ 已生成技能索引：' + path.relative(ROOT, INDEX) + '（' + skills.length + ' 个技能，' + (Buffer.byteLength(idx) / 1024).toFixed(1) + ' KB）');
  for (const s of skills) console.log('  · ' + s.dir.padEnd(14) + (triggersOf(s.desc) || '⚠ 无触发词'));
}
