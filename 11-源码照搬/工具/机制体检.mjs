#!/usr/bin/env node
/**
 * 机制体检.mjs —— 一条命令看全貌：把每个「已经变成机制」的规矩跑一遍
 *
 * 照搬《08-升级与改造清单》：
 *   · `把规矩变成机制.md` 第 5 步「挂到节奏上」+ 第 4 步「必须有反例」
 *   · `机制清单.md` 末尾「验证入口（一条命令看全貌）」
 *
 * 设计三条（别改）：
 *   ① **每项都真跑**：调真工具、看真 exit code。⛔ 不复制判据（两处判据 = 两份结论）
 *   ② **失败进待办**：⛔ 项去重写进 `_共享记忆\_待办.md` 的 `## 机制体检 ⛔` 段
 *   ③ **反例门禁**：`--selftest` 会故意造违规样本，确认每一项**真的会报**。
 *      「反例不报 = 这个检查是假的」—— 一个永远通过的检查是装饰。
 *
 * 用法：
 *   node 工具\机制体检.mjs              # 全量（约 3~10 秒）
 *   node 工具\机制体检.mjs --quiet      # 一行结论（挂计划任务 / 开场自检）
 *   node 工具\机制体检.mjs --json       # 给别的脚本读
 *   node 工具\机制体检.mjs --list       # 只列有哪些机制项，不跑
 *   node 工具\机制体检.mjs --selftest   # 反例门禁：逐项造违规，确认会报
 *   node 工具\机制体检.mjs --no-待办
 *
 * 退出码：0 全过 / 1 有 ⛔ / 2 用法错
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '引擎数据', '.dsh', '场景记忆');
const TODO = path.join(MEM, '_共享记忆', '_待办.md');
const NODE = process.execPath;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

/** 机制项目录 —— 每一项都必须能「输出差异集合」并给出非 0 退出码 */

/** 末行是不是 "PASS x/x" 且 x === 分母（全部通过）。⛔ 不绑定具体条数 —— 自测一加就不该红。 */
function isAllPass(out) {
  const m = String(out || '').match(/selftest:\s*PASS\s+(\d+)\/(\d+)/);
  if (!m) return false;
  return Number(m[1]) === Number(m[2]) && Number(m[2]) > 0;
}

export const ITEMS = [
  {
    key: 'temp-path',
    name: '临时路径（落点唯一判据）',
    cmd: ['工具/临时路径.mjs', '--selftest'],
    fix: 'node 工具\\临时路径.mjs --selftest',
    doc: '08-升级与改造清单/把规矩变成机制.md · 例 1 第 1~2 步',
  },
  {
    key: 'temp-sentinel',
    name: '临时哨兵（违规区扫描）',
    cmd: ['工具/临时哨兵.mjs', '--quiet'],
    fix: 'node 工具\\临时哨兵.mjs',
    doc: '08-升级与改造清单/把规矩变成机制.md · 例 1 第 3 步',
  },
  {
    key: 'dispatch-ledger',
    name: '派单欠账（逾期 / 空投 / 知悉 / 陈旧）',
    cmd: ['工具/派单.mjs', '--list'],
    fix: 'node 工具\\派单.mjs --list',
    doc: '08-升级与改造清单/把规矩变成机制.md · 例 3',
  },
  {
    key: 'scene-memory',
    name: '场景记忆体检（§〇 ≤4 KB / 指纹 / 绑定）',
    cmd: ['工具/场景记忆.mjs', 'check', '--all', '--no-待办'],
    fix: 'node 工具\\场景记忆.mjs check --all',
    doc: '08-升级与改造清单/例 2（输出侧）+ 机制清单 §10',
  },
  {
    key: 'scene-six',
    name: '场景六件套（json / 记忆 / 定位卡 / 身份索引）',
    cmd: ['工具/场景体检.mjs', '--quiet'],
    fix: 'node 工具\\场景体检.mjs',
    doc: '08-升级与改造清单/机制清单 §4',
  },
  {
    key: 'doc-index',
    name: '文档索引（未登记 / 死条目 / 状态词 / 到期）',
    cmd: ['工具/索引体检.mjs', '--quiet'],
    fix: 'node 工具\\索引体检.mjs',
    doc: '05-协作与规矩/二-标准化规范 §2.7 + §2.10',
  },
  {
    key: 'profile',
    name: '机主画像纪律（依据声明 / 出处 / 禁区 / 8 KB）',
    cmd: ['工具/画像体检.mjs', '--quiet'],
    fix: 'node 工具\\画像体检.mjs',
    doc: '05-协作与规矩/一-全局铁律 · 记忆分两级（权威 + 参考件）',
  },
  {
    key: 'skills',
    name: '技能体检（frontmatter / 一技能一场景 / 体积 / 指针触发句）',
    cmd: ['工具/技能体检.mjs', '--quiet'],
    fix: 'node 工具\\技能体检.mjs',
    doc: '04-工作台搭建/自检清单 + 参照的技能完整性体检',
  },
  {
    key: 'projects',
    name: '项目记忆（路由有效 / 四态 / 必备小节 / 8 KB）',
    cmd: ['工具/项目记忆.mjs', 'check', '--quiet'],
    fix: 'node 工具\\项目记忆.mjs check',
    doc: '拓扑 C5/C6 一项目一份记忆',
  },
  {
    key: 'session-archive',
    name: '会话档案（绑定会话都有档）',
    cmd: ['工具/会话档案.mjs', '--check', '--quiet'],
    fix: 'node 工具\\会话档案.mjs --capture',
    doc: '拓扑 C7 交接归档',
  },
  {
    key: 'schedule',
    name: '计划任务（3 个只读任务在册）',
    cmd: ['工具/计划任务.mjs', '--selftest'],
    fix: 'node 工具\\计划任务.mjs --install',
    doc: '08-升级与改造清单/把规矩变成机制 第 5 步「挂到节奏上」',
  },
  {
    key: 'conflict',
    name: '冲突登记（C4 上行：未裁决超 24h / 裁决缺依据）',
    cmd: ['工具/冲突.mjs', '--check', '--quiet'],
    fix: 'node 工具\\冲突.mjs --list',
    doc: '05-协作与规矩/三-跨场景协作 §三（没列到的/都没写的）+ 拓扑 C4',
  },
  {
    key: 'doc-ledger',
    name: '文档台账（密集目录必须有索引 / 状态四词 / 到期）',
    cmd: ['工具/文档台账.mjs', '--check', '--quiet'],
    fix: 'node 工具\\文档台账.mjs --scan',
    doc: '05-协作与规矩/二-标准化规范 §2.7 / §2.10',
  },
  {
    key: 'entry-sentinel',
    name: '入口哨兵（启动链路：vbs 编码 / config 指得到 / electron.exe 指纹）',
    cmd: ['工具/入口哨兵.mjs', '--quiet'],
    fix: 'node 工具\\入口哨兵.mjs',
    doc: '04-工作台搭建/事故复盘-三起 · 事故一（改 exe 全灰白）',
  },
  {
    key: 'log-watch',
    name: '日志看门（launch-failed / 连不上引擎 / 异常堆栈）',
    cmd: ['工具/日志看门.mjs', '--quiet'],
    fix: 'node 工具\\日志看门.mjs --tail 50',
    doc: '04-工作台搭建/自检清单 §3 排查顺序',
  },
  {
    key: 'reload-ack',
    name: '面板刷新有回执（投递 ≠ 生效）',
    cmd: ['工具/刷新面板.mjs', '--selftest'],
    fix: 'node 工具\\刷新面板.mjs all',
    doc: '铁律：投递成功 ≠ 已生效；回执只证明广播已发出，画面对不对要靠截图',
  },
  {
    key: 'nag',
    name: '催办判据（逾期≥20min / ≤2次 / 间隔≥30min）',
    cmd: ['工具/催办.mjs', '--selftest'],
    fix: 'node 工具\\催办.mjs --stats',
    doc: '08-升级与改造清单/机制清单 §6「对方一直不回」',
  },
  {
    key: 'cleanup-request',
    name: '清理归口（清理请求只发消息，⛔ 不许自己删）',
    cmd: ['工具/清理请求.mjs', '--selftest'],
    fix: 'node 工具\\清理请求.mjs "<要清什么>" --from <你的场景>',
    doc: '05-协作与规矩/三-跨场景协作 §一 + §二 规矩 1（清理活全归本地电脑场景）',
  },
  {
    key: 'pointer-squash',
    name: '归档指针压缩（指针不许无限堆积 / 只动指针不动正文）',
    cmd: ['工具/指针压缩.mjs', '--selftest'],
    fix: 'node 工具\\指针压缩.mjs --场景 <场景名> --go',
    doc: '05-协作与规矩/一-全局铁律：§五只追加；指针只需能找回，不需读起来舒服',
  },
  {
    key: 'memory-core10',
    name: '铁律① 私有记忆核心职责 ≤10 行',
    cmd: ['工具/场景记忆.mjs', 'check', '--all'],
    fix: '把非核心内容搬进 原始层\\，核心职责只留 ≤10 行',
    doc: 'Xiodra 设计铁律①：只留每天上班必须知道的事',
  },
  {
    key: 'skill-index',
    name: '铁律② 技能索引化（先读索引按需读取）',
    cmd: ['工具/技能索引.mjs', '--check'],
    fix: 'node 工具\\技能索引.mjs',
    doc: 'Xiodra 设计铁律② + M4 技能索引化',
  },
  {
    key: 'handoff',
    name: 'M2/M3 交接摘要 ≤200 字',
    cmd: ['工具/交接.mjs', '--check', '--quiet'],
    fix: 'node 工具\\交接.mjs --场景 <名>',
    doc: 'Xiodra 设计 M2 ④ / M3：换会话交接与新会话接续',
  },
  {
    key: 'raw-layer',
    name: 'M2 ③ 原始层有索引（归档不等于埋掉）',
    cmd: ['工具/原始层.mjs', '--check', '--quiet'],
    fix: 'node 工具\\原始层.mjs',
    doc: 'Xiodra 设计 M2 ③：非核心细节归档标记原始层 + 可再提炼关键词',
  },
  {
    key: 'topbar-m7',
    name: 'M7 顶栏三按钮（插件/技能/工具：按钮+handler+IPC+桥+隔离）',
    cmd: ['工具/顶栏体检.mjs', '--quiet'],
    fix: 'node 工具\\顶栏体检.mjs',
    doc: 'Xiodra 设计 M7：顶栏按钮 + 已安装列表 + 用途 + 启用状态；引擎更新不影响壳',
  },
  {
    key: 'workflow-m9',
    name: 'M9 工作流数据层（JSON 格式 / 状态机 / 依赖校验）',
    cmd: ['工具/工作流.mjs', '--selftest'],
    fix: 'node 工具\\工作流.mjs --校验 <流程.json>',
    doc: 'Xiodra 设计 M9：机器可读 JSON + 光点四态 + 按 JSON 执行 + 人可读说明',
  },
  {
    key: 'panel-probe',
    name: '面板探针（guest 截图字节数才是判据，不是元素属性）',
    cmd: ['工具/面板探针.mjs', '--selftest'],
    fix: 'node 工具\\面板探针.mjs --panel <面板id>',
    doc: '自我复盘 M10 建议：把三天手写 12 次的 CDP 临时脚本固化',
  },
  {
    key: 'constitution',
    name: '宪法版本纪律（版本号 / 变更记录 / 改过没升版 / 旧版留档）',
    cmd: ['工具/宪法体检.mjs', '--quiet'],
    fix: 'node 工具\\宪法体检.mjs --bump "改了什么"',
    doc: '拓扑 C1：改一次版本 +1、旧版留档',
  },
  {
    key: 'collab-rules',
    name: '协作规矩体检（地盘表 / 身份漂移 / 体积 / 待确认出口）',
    cmd: ['工具/协作体检.mjs', '--quiet'],
    fix: 'node 工具\\协作体检.mjs',
    doc: '05-协作与规矩/README 第 5 步 + 三-跨场景协作 §六',
  },
  {
    key: 'receipt',
    name: '回执四件套（结论/证据带数字/落盘/还差 + 200 字上限）',
    cmd: ['工具/回执.mjs', '--selftest'],
    fix: 'node 工具\\回执.mjs --selftest',
    doc: '05-协作与规矩/回执闭环协议 · 三条铁律',
  },
  {
    key: 'ownership',
    name: '修改权五档判据（归属.mjs）',
    cmd: ['工具/归属.mjs', '--selftest'],
    fix: 'node 工具\\归属.mjs --selftest',
    doc: '05-协作与规矩/二-标准化规范 §6.8',
  },
  {
    key: 'session-cleanup',
    name: '会话库无空壳残留（无绑定 + <4 KB）',
    cmd: ['工具/删会话.mjs', '--check'],
    fix: 'node 工具\\删会话.mjs --list',
    doc: '删会话.mjs（引擎无 deleteSession 接口，只能落盘三处）',
  },
  {
    key: 'verify-gate',
    name: '验证闸（硬判据 + 基线比对 + 反例自证）',
    cmd: ['工具/验证闸.mjs', '--selftest'],
    fix: 'node 工具\\验证闸.mjs',
    doc: '13-公开情报/单场景自我进化-最小闭环 · 验证闸',
  },
  {
    key: 'auto-archive',
    name: '自动归档（只搬不丢 / 保护区不动 / 带触发句指针）',
    cmd: ['工具/自动归档.mjs', '--selftest'],
    fix: 'node 工具\\自动归档.mjs',
    doc: '13-公开情报/单场景自我进化-最小闭环 · 自动归档',
  },
  {
    key: 'mcp-iconfont',
    name: 'MCP iconfont（接口变更补丁在位）',
    cmd: ['工具/mcp-iconfont补丁.mjs', '--check'],
    fix: 'node 工具\\mcp-iconfont补丁.mjs',
    doc: 'MCP/bundle-iconfont/docs/DETAIL.md（iconfont 现在要求 Cookie: ctoken=null）',
  },
  {
    key: 'gpu-gate',
    name: 'GPU 判据（只有三类活能上 GPU）',
    cmd: ['工具/gpu.mjs', 'llm', '--json'],
    fix: 'node 工具\\gpu.mjs <task>',
    doc: '00-核心机制/五-GPU优先.md',
  },
  {
    key: 'publish-scan',
    name: '发布前红线（本机路径 / 密钥 / 会话 id）',
    cmd: ['工具/发布前检查.mjs'],
    fix: 'node 工具\\发布前检查.mjs',
    doc: '机制清单 §9 前置关卡',
  },
];

function run(item, extra = []) {
  const r = spawnSync(NODE, [item.cmd[0], ...item.cmd.slice(1), ...extra], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_NO_TODO: '1' }, timeout: 120000,
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { code: r.status, out };
}

/* ---------------- 待办：⛔ 去重写进板子 ---------------- */
function pushTodo(bads) {
  const HEAD = '## 机制体检 ⛔';
  let text = fs.existsSync(TODO) ? fs.readFileSync(TODO, 'utf8') : '# _待办\n\n（暂无）\n';
  const lines = text.split(/\r?\n/).filter((l) => !l.startsWith('- [ ] [机制⛔] '));
  text = lines.join('\n');
  const items = bads.map((b) => `- [ ] [机制⛔] ${b.name}（机制项 ${b.key}）：怎么修 → \`${b.fix}\``);
  const hi = text.indexOf(HEAD);
  if (hi < 0) text = text.replace(/\s*$/, '\n') + '\n' + HEAD + '\n\n' + (items.length ? items.join('\n') : '（暂无）') + '\n';
  else {
    const after = text.indexOf('\n## ', hi + HEAD.length);
    const head = text.slice(0, hi);
    const tail = after > 0 ? text.slice(after) : '';
    text = head + HEAD + '\n\n' + (items.length ? items.join('\n') : '（暂无）') + '\n' + (tail ? '\n' + tail.replace(/^\n+/, '') : '');
  }
  text = text.replace(/\n{3,}/g, '\n\n');
  try { fs.writeFileSync(TODO, text, 'utf8'); } catch (e) { console.error('⚠ 待办板写不动：' + e.message); }
}

/* ---------------- 全量体检 ---------------- */
function main() {
  const results = [];
  for (const it of ITEMS) {
    const { code, out } = run(it);
    // gpu 那项是"探针"：只要给出结论（JSON）就算通过，use 与否都不是失败
    const ok = it.key === 'gpu-gate' ? code === 0 && out.includes('"use"') : code === 0;
    results.push({ ...it, ok, code, out });
  }
  const bads = results.filter((r) => !r.ok);

  if (has('--json')) { console.log(JSON.stringify({ total: results.length, bad: bads.length, items: results.map(({ out, ...r }) => r) }, null, 2)); }
  else if (has('--quiet')) {
    console.log(bads.length
      ? `⛔ 机制体检：${bads.length}/${results.length} 项不过（${bads.map((b) => b.key).join(' / ')}）→ 跑 node 工具\\机制体检.mjs`
      : `✓ 机制体检：${results.length}/${results.length} 项全过`);
  } else {
    console.log('机制体检 —— 每项都真跑，看真 exit code\n');
    for (const r of results) {
      const tag = r.ok ? '✓' : '⛔';
      console.log(`${tag} ${r.name}  [${r.key}]  exit=${r.code}`);
      if (!r.ok) {
        for (const line of r.out.split(/\r?\n/).slice(0, 12)) console.log('    ' + line);
        console.log('    怎么修：' + r.fix);
      }
    }
    console.log('\n' + (bads.length ? `⛔ ${bads.length}/${results.length} 项不过` : `✓ ${results.length}/${results.length} 项全过`));
    if (bads.length) console.log('  ⇒ 已写进 _共享记忆\\_待办.md 的「机制体检 ⛔」段（下次开会话第一眼能看到）');
  }
  /**
   * ⚠ 2026-11-21 改：`--quiet` 原来**完全不写待办板**。
   *   后果：日常都用 `--quiet` 跑（计划任务也是）⇒ 待办板只会越来越旧，
   *   我实测看到一条早就修好的 `collab-rules` 挂在那里 ⇒ **待办板变成狼来了**。
   *   现在：`--quiet` 也维护（清过期 + 写当前 ⛔）。
   *   ⛔ 只有 `--json` 跳过 —— 机器读的输出必须纯净，不能顺带改文件。
   */
  if (!has('--no-待办') && !has('--json')) pushTodo(bads);
  return bads.length ? 1 : 0;
}

/* ---------------- 反例门禁：造违规，确认会报 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });

  // ① 临时路径：%TEMP% 必须判违规
  {
    const { code, out } = run(ITEMS.find((x) => x.key === 'temp-path'));
    add(code === 0 && isAllPass(out), '反例① 临时路径 --selftest = PASS 8/8（含 %TEMP% / 盘根 / 裸放 四个反例）', out.split(/\r?\n/).slice(-1)[0]);
  }
  // ② 临时哨兵：在工作台根造一个 .tmp，必须 exit 1
  {
    const p = path.join(ROOT, '_selftest-机制体检.tmp');
    fs.writeFileSync(p, 'x', 'utf8');
    const { code, out } = run(ITEMS.find((x) => x.key === 'temp-sentinel'));
    fs.rmSync(p, { force: true });
    add(code === 1 && /违规/.test(out), '反例② 工作台根造 .tmp ⇒ 临时哨兵 exit 1', 'exit=' + code);
  }
  // ③ 派单欠账：派生 7 个 shape（5 类欠账判据 + 2 个时区反例）必须全过
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '派单台账.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例③ 派单欠账 7 个 shape = PASS 7/7（空投 / 逾期 / 知悉 / 陈旧 / 干净 / 时区新旧两格式）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ④ 场景记忆：造第二个 §〇 头，check 必须 exit 1；恢复后必须回绿
  {
    const tgt = path.join(MEM, '控制器', '场景私有记忆.md');
    const backup = fs.existsSync(tgt) ? fs.readFileSync(tgt) : null;
    let ok = false, detail = '找不到控制器记忆（跳过）';
    if (backup) {
      fs.writeFileSync(tgt, backup.toString('utf8') + '\n## §〇 反例当前交接（自测，马上删）\n\n- 造双头\n', 'utf8');
      const bad = spawnSync(NODE, [path.join(ROOT, '工具', '场景记忆.mjs'), 'check', '--场景', '控制器', '--no-待办'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      const badOut = (bad.stdout || '') + (bad.stderr || '');
      fs.writeFileSync(tgt, backup);
      const good = spawnSync(NODE, [path.join(ROOT, '工具', '场景记忆.mjs'), 'check', '--场景', '控制器', '--no-待办'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      const goodOut = (good.stdout || '') + (good.stderr || '');
      ok = bad.status === 1 && /§〇 头出现 2 个/.test(badOut) && good.status === 0;
      detail = '造双头 exit=' + bad.status + ' · 恢复后 exit=' + good.status;
      if (!good.status) fs.writeFileSync(tgt, backup);
    }
    add(ok, '反例④ 第二个 §〇 头 ⇒ 场景记忆 check exit 1；恢复后回绿', detail);
  }
  // ⑤ 场景六件套：造一个缺定位卡的场景，必须 exit 1
  //   ⚠ 2026-11-19 修：反例造的场景**不能再用 tmp- 前缀**。
  //     场景体检已按约定跳过 `tmp-*`（那是"验收用的临时场景，验完即删"），
  //     所以用 tmp- 造的反例会被跳过 ⇒ 反例永远 exit 0 ⇒ **门禁假绿**。
  //     改成 `zz-` 前缀（同样不会被当成真场景发布，但会进体检）。
  {
    const f = path.join(ROOT, '外壳', 'scenarios', 'zz-selftest-scene.json');
    fs.writeFileSync(f, JSON.stringify({
      id: 'zz-selftest-scene', name: '机制体检反例场景',
      panels: [{ id: 'zz-x', title: 'X', type: 'harness', sessionId: 'session-XX-机制体检占位', sessionTitle: 'X', pinTarget: ['X'] }],
    }, null, 2), 'utf8');
    const { code } = run(ITEMS.find((x) => x.key === 'scene-six'));
    fs.rmSync(f, { force: true });
    // 再加一条：tmp- 场景必须**被跳过**（否则上面这条修法就成了"把检查关掉"）
    const f2 = path.join(ROOT, '外壳', 'scenarios', 'tmp-selftest-scene.json');
    fs.writeFileSync(f2, JSON.stringify({
      id: 'tmp-selftest-scene', name: 'TMP反例场景',
      panels: [{ id: 'tmpx', title: 'X', type: 'harness', sessionId: 'session-XX-机制体检占位', sessionTitle: 'X', pinTarget: ['X'] }],
    }, null, 2), 'utf8');
    const skip = run(ITEMS.find((x) => x.key === 'scene-six'));
    fs.rmSync(f2, { force: true });
    add(code === 1, '反例⑤ 缺记忆/定位卡/身份索引的 zz- 场景 ⇒ 场景体检 exit 1', 'exit=' + code);
    add(skip.code === 0, '反例⑤-2 tmp- 测试场景 ⇒ 场景体检**跳过**（验收临时场景不该让全机假红）', 'exit=' + skip.code);
  }
  // ⑤b 文档索引：造 3 个反例（未登记 / 死条目 / 状态带注）
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '索引体检.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例⑤b 文档索引 4 个反例 = PASS 4/4（未登记/死条目/状态带注/到期）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ⑤c 协作规矩：造 4 个反例（地盘表多行 / 身份漂移 / 超体积 / 缺待确认出口）
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '协作体检.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例⑤c 协作规矩 4 个反例 = PASS 4/4（地盘表/漂移/体积/出口）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ⑥ GPU 判据：llm 必须判「不上 GPU」且给 why
  {
    const { code, out } = run(ITEMS.find((x) => x.key === 'gpu-gate'));
    let j = null; try { j = JSON.parse(out); } catch { /* */ }
    add(code === 0 && j && j.use === false && /不在这三类里/.test(j.why || ''), '反例⑥ gpu.mjs llm ⇒ use=false 并给出 why（判据只写一处）', out.split(/\r?\n/)[1] || '');
  }
  // ⑧ 会话库空壳：造一个无绑定的小会话，—check 必须 exit 1；删掉后回绿
  {
    const base = path.join(MEM, '..', 'sessions');
    let wsDir = null;
    if (fs.existsSync(base)) {
      for (const w of fs.readdirSync(base)) { const d = path.join(base, w); if (fs.statSync(d).isDirectory() && fs.readdirSync(d).some((s) => s.startsWith('session-'))) { wsDir = d; break; } }
    }
    let ok = false, detail = '找不到会话库（跳过）';
    if (wsDir) {
      // ⚠ 名字要两头兼顾：
      //   ① 必须 `session-` 开头（删会话.mjs --check 只认这种前缀）
      //   ② 后面 **不能** 接 8 位十六进制（发布前检查的 /session-[0-9a-f]{8}/ 会把它当真会话 id 报红线）
      const ghost = path.join(wsDir, 'session-selftest-ghost-shell');
      const countGhosts = () => {
        const r = spawnSync(NODE, [path.join(ROOT, '工具', '删会话.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
        const out = (r.stdout || '') + (r.stderr || '');
        const m = out.match(/发现\s*(\d+)\s*条空壳/);
        return { code: r.status, n: m ? Number(m[1]) : 0, sawGhost: /selftest-ghost-shell/.test(out) };
      };
      // ⚠ 判据用**前后差值**，不假设环境本来就干净
      //   （真实场景里可能已经有一条待处理的空壳，写死"删掉后必须 exit 0"会假失败）
      const before = countGhosts();
      fs.mkdirSync(ghost, { recursive: true });
      fs.writeFileSync(path.join(ghost, 'session.v4.jsonl.zstd'), 'x', 'utf8');
      const during = countGhosts();
      fs.rmSync(ghost, { recursive: true, force: true });
      const after = countGhosts();
      ok = during.code === 1
        && during.sawGhost                       // 造的那条必须被点名
        && during.n === before.n + 1             // 空壳数 +1
        && after.n === before.n                  // 删掉后回到原数（不是"变 0"）
        && !after.sawGhost;
      detail = `造之前 ${before.n} 条(exit ${before.code}) · 造之后 ${during.n} 条(exit ${during.code}) · 删掉后 ${after.n} 条(exit ${after.code})`;
    }
    add(ok, '反例⑧ 造一个空壳 ⇒ --check 空壳数 +1 且点名；删掉后回到原数（不假设环境本来干净）', detail);
  }
  // ⑨ 验证闸：它自己的反例自证（硬判据会关 / 差异集合能标退化 / 两头都验）
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '验证闸.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例⑨ 验证闸 3 个反例 = PASS 3/3（闸门真会关 / 退性能点名 / 两头都验）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ⑩ 自动归档：保护区不动 / 已是指针不再搬 / 不丢字 / 未超线不搬 / 指针带触发句
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '自动归档.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例⑩ 自动归档 6 个反例 = PASS 6/6（保护区/指针/不丢字/不越线搬/触发句）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ⑪ 宪法版本纪律 / 技能体检 / 项目记忆 / 会话档案 / 计划任务：各自跑反例
  {
    const cases = [
      ['宪法体检.mjs', null, '宪法 6'],
      ['技能体检.mjs', null, '技能 6'],
      ['项目记忆.mjs', null, '项目 6'],
      ['会话档案.mjs', null, '档案 5'],
      ['计划任务.mjs', null, '计划任务 5'],
    ];
    let ok = 0;
    const failed = [];
    for (const [file, want, label] of cases) {
      const r = spawnSync(NODE, [path.join(ROOT, '工具', file), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
      const out = (r.stdout || '') + (r.stderr || '');
      if (r.status === 0 && (want === null ? isAllPass(out) : out.includes(want))) ok++; else failed.push(label);
    }
    add(ok === cases.length, '反例⑪ 五套新体检的自测全过（' + ok + '/' + cases.length + '）', failed.length ? '失败：' + failed.join(',') : '');
  }
  // ⑫ 派单不许"猜面板"：多会话场景缺 --panel 必须报错（事故：投给了自己）
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '派单.mjs'), '--to', 'DSH·GUI', '--from', 'selftest', '测试'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status !== 0 && /必须用 --panel/.test(out), '反例⑫ 多会话场景不给 --panel ⇒ 派单必须拒绝（⛔ 不许猜一条投）', 'exit=' + r.status);
  }
  // ⑬ 不许把派单投给自己（事故：投进了自己的会话，绕一圈又回来）
  {
    const env = { ...process.env };
    // 取本场景第二个面板的 id 作为「自己」，模拟自投
    const sj = JSON.parse(fs.readFileSync(path.join(ROOT, '外壳', 'scenarios', 'dsh-gui.json'), 'utf8').replace(/^\uFEFF/, ''));
    const h = (sj.panels || []).filter((p) => p.type === 'harness' && p.sessionId);
    let ok = false, detail = '找不到两块面板（跳过）';
    if (h.length >= 2) {
      env.DSH_SESSION_ID = h[0].sessionId;   // 假装我是第一块
      const r = spawnSync(NODE, [path.join(ROOT, '工具', '派单.mjs'), '--to', 'DSH·GUI', '--panel', h[0].id, '--from', 'selftest', '测试'], { cwd: ROOT, encoding: 'utf8', timeout: 60000, env });
      const out = (r.stdout || '') + (r.stderr || '');
      ok = r.status !== 0 && /就是\*\*你自己\*\*/.test(out);
      detail = 'exit=' + r.status;
    }
    add(ok, '反例⑬ 派单投给自己 ⇒ 必须拒绝（⛔ 自己给自己派单只会绕一圈回来）', detail);
  }
  // ⑭ 回执也不许"猜面板/投给自己"（和派单同源事故：回执投进了自己会话）
  {
    const env = { ...process.env };
    const sj = JSON.parse(fs.readFileSync(path.join(ROOT, '外壳', 'scenarios', 'dsh-gui.json'), 'utf8').replace(/^\uFEFF/, ''));
    const h = (sj.panels || []).filter((p) => p.type === 'harness' && p.sessionId);
    let a = false, b = false, detail = '找不到两块面板（跳过）';
    if (h.length >= 2) {
      const args = (panel) => [path.join(ROOT, '工具', '回执.mjs'), '--to', 'DSH·GUI', ...(panel ? ['--panel', panel] : []), '--结论', '已完成：x', '--证据', '1 条', '--落盘', 'x', '--还差', '无'];
      const r1 = spawnSync(NODE, args(null), { cwd: ROOT, encoding: 'utf8', timeout: 60000, env });
      a = r1.status !== 0 && /必须用 --panel/.test((r1.stdout || '') + (r1.stderr || ''));
      env.DSH_SESSION_ID = h[0].sessionId;
      const r2 = spawnSync(NODE, args(h[0].id), { cwd: ROOT, encoding: 'utf8', timeout: 60000, env });
      b = r2.status !== 0 && /就是\*\*你自己\*\*/.test((r2.stdout || '') + (r2.stderr || ''));
      detail = '无--panel exit=' + r1.status + ' · 投自己 exit=' + r2.status;
    }
    add(a && b, '反例⑭ 回执：多会话不给 --panel 拒 / 投给自己拒（与派单同源）', detail);
  }
  // ⑮ 回执必须署名：不给 --from 要能按会话 id 自动推断出场景名（不许静默「未注明」）
  {
    // 用一个真实绑定会话当"我"，跑 --dry 看正文首行
    const sj = JSON.parse(fs.readFileSync(path.join(ROOT, '外壳', 'scenarios', 'dsh-gui.json'), 'utf8').replace(/^\uFEFF/, ''));
    const h = (sj.panels || []).filter((p) => p.type === 'harness' && p.sessionId);
    let ok = false, detail = '找不到绑定面板（跳过）';
    if (h.length) {
      const env = { ...process.env, DSH_SESSION_ID: h[0].sessionId };
      const r = spawnSync(NODE, [path.join(ROOT, '工具', '回执.mjs'), '--to', '控制器', '--panel', 'controller-chat', '--结论', '已完成：x', '--证据', '1 条', '--落盘', 'x', '--还差', '无', '--dry'], { cwd: ROOT, encoding: 'utf8', timeout: 60000, env });
      const out = (r.stdout || '') + (r.stderr || '');
      ok = /来自「(?!（未注明）)[^」]+」/.test(out);
      detail = out.split(/\r?\n/).filter((l) => l.includes('来自')).join(' | ').slice(0, 100);
    }
    add(ok, '反例⑮ 回执不给 --from ⇒ 按会话 id 自动推断场景名署名（不许静默「未注明」）', detail);
  }
  // ⑯ 冲突通道：AI 不许自己裁决 + 没依据的裁决必须报
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '冲突.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例⑯ 冲突通道 8 个反例 = PASS 8/8（AI 不许裁决 / 缺依据报 / 超24h告警 / 归属机械推导）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ⑰ 文档台账 / 入口哨兵 / 日志看门：各自跑反例
  {
    const cases = [
      ['文档台账.mjs', null, '文档台账 7'],
      ['入口哨兵.mjs', null, '入口哨兵 10'],
      ['日志看门.mjs', null, '日志看门 9'],
    ];
    let ok = 0;
    const failed = [];
    for (const [file, want, label] of cases) {
      const r = spawnSync(NODE, [path.join(ROOT, '工具', file), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
      const out = (r.stdout || '') + (r.stderr || '');
      if (r.status === 0 && (want === null ? isAllPass(out) : out.includes(want))) ok++; else failed.push(label);
    }
    add(ok === cases.length, '反例⑰ 三套新的自测全过（' + ok + '/' + cases.length + '）', failed.length ? '失败：' + failed.join(',') : '');
  }
  // ⑱ 面板刷新：回执判据（旧回执不许当新回执照）
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '刷新面板.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例⑱ 刷新面板 5 个反例 = PASS 5/5（没回执/旧回执不许当成功）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ⑲ 催办判据：不许刷屏（间隔/上限/已销账/知悉 都不许催）
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '催办.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例⑲ 催办 9 个反例（已销账/知悉/未到期/刚催过/超上限 都不催）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ⑳ 清理请求：只发消息不删东西（行为证据 + 无 child_process）
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '清理请求.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例⑳ 清理请求 6 个反例（真跑 --dry 后目录还在 / 无 child_process / 必须真投递）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ㉑ 指针压缩：只动指针不动正文，且不许越压越大
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '指针压缩.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例㉑ 指针压缩 6 个反例（正文不动 / 文件名不丢 / 太少不压）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ㉒ 设计规范三件（技能索引 / 交接摘要 / 原始层）：各自跑反例
  {
    const cases = [
      ['技能索引.mjs', '技能索引 6'],
      ['交接.mjs', '交接 6'],
      ['原始层.mjs', '原始层 5'],
    ];
    let ok = 0;
    const failed = [];
    for (const [file, label] of cases) {
      const r = spawnSync(NODE, [path.join(ROOT, '工具', file), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      const out = (r.stdout || '') + (r.stderr || '');
      if (r.status === 0 && isAllPass(out)) ok++; else failed.push(label);
    }
    add(ok === cases.length, '反例㉒ 设计规范三件自测全过（' + ok + '/' + cases.length + '）', failed.length ? '失败：' + failed.join(',') : '');
  }
  // ㉓ M7 顶栏三按钮：按钮/handler/IPC/桥/隔离 全链路
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '顶栏体检.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例㉓ 顶栏体检 9 个反例（缺按钮/缺handler/缺IPC/假按钮/壳掺引擎）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ㉔ M9 工作流：格式/状态机/依赖 三重反例
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', '工作流.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例㉔ 工作流 11 个反例（缺output/断链/有环/依赖未满足拦截）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }
  // ⑦ MCP iconfont 补丁：4 个反例（原版无 Cookie / 只补一处 / 方法被改名）
  {
    const r = spawnSync(NODE, [path.join(ROOT, '工具', 'mcp-iconfont补丁.mjs'), '--selftest'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    add(r.status === 0 && isAllPass(out), '反例⑦ MCP iconfont 补丁 4 个反例 = PASS 4/4（无 Cookie / 只补一处 / 方法改名 / 正例）', out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  }

  for (const c of cases) console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.label + (c.ok ? '' : '  ← ' + c.detail));
  const pass = cases.filter((c) => c.ok).length;
  console.log('  selftest: ' + (pass === cases.length ? `PASS ${pass}/${cases.length}` : `FAIL ${pass}/${cases.length}`));
  return pass === cases.length ? 0 : 1;
}

/* ---------------- 入口 ---------------- */
if (has('--list')) {
  for (const it of ITEMS) console.log('  [' + it.key + '] ' + it.name + '\n      跑：node ' + it.cmd.join(' ') + '\n      出处：' + it.doc);
  process.exit(0);
}
if (has('--help') || has('-h')) {
  console.log('用法：node 工具\\机制体检.mjs [--quiet|--json|--list|--selftest|--no-待办]');
  process.exit(0);
}
if (has('--selftest')) process.exit(selftest());
process.exit(main());
