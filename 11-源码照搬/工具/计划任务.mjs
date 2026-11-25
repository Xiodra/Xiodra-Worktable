#!/usr/bin/env node
/**
 * 计划任务.mjs —— 把体检挂到节奏上（照搬《08/把规矩变成机制》第 5 步「挂到节奏上」）
 *
 * 参照的原话：「**手动跑的检查等于没跑** ⇒ 落地：计划任务（每周/每天）」。
 *
 * ⚠ 这条曾经被 Xiodra 否掉（2026-11-18：「不要」），**2026-11-19 改口允许**。
 *   ⇒ 规矩也跟着改了：`协作规矩.md` §11 从「不挂计划任务」改成「已挂 + 清单见下」。
 *
 * 挂什么（都是"只读或只报"，不修东西）：
 * | 任务 | 频率 | 跑什么 |
 * |---|---|---|
 * | `Xiodra-审计`      | 每天 12:30 | `审计.mjs --quiet`（全量只读巡检 → 写报告） |
 * | `Xiodra-临时哨兵`  | 每周日 12:35 | `临时哨兵.mjs --quiet`（临时区违规） |
 * | `Xiodra-验证闸`    | 每周日 12:40 | `验证闸.mjs`（与基线比，退化就 ⛔） |
 *
 * ⛔ 不挂的（避免"自动化反而拖慢机器"）：
 *   · `机制体检.mjs`（它已含在审计里，重复跑没意义）
 *   · `自动归档.mjs --go`（**会改记忆文件**，必须人看着跑）
 *   · 任何会写盘/改配置的任务
 *
 * 用法：
 *   node 工具\计划任务.mjs --list        # 看已经挂了什么 + 下次跑的时间
 *   node 工具\计划任务.mjs --install     # 注册三个任务（幂等：已存在就覆盖）
 *   node 工具\计划任务.mjs --remove      # 全部撤掉
 *   node 工具\计划任务.mjs --run 审计     # 立刻手动触发一次（验证任务真的能跑）
 *   node 工具\计划任务.mjs --selftest    # 反例：注册→查得到→撤掉→查不到
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(SELF), '..');
const NODE = process.execPath;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

/** 任务定义（唯一出处）。cmd 用相对 ROOT 的脚本名 + 参数 */
export const TASKS = [
  {
    name: 'Xiodra-审计',
    script: '工具/审计.mjs',
    args: ['--quiet'],
    schedule: 'DAILY', time: '12:30',
    why: '全量只读巡检（结构/记忆/索引/共享/技能/宪法/会话/闸门/MCP/发布），写 _体检-latest.json + 体检报告.md',
  },
  {
    name: 'Xiodra-催办',
    script: '工具/催办.mjs',
    args: [],
    schedule: 'HOURLY', time: '00:05', mo: 2,
    why: '欠账没回就催一次（逾期≥20min / ≤2次 / 间隔≥30min；⛔ 有上限，不会刷屏）',
  },
  {
    name: 'Xiodra-临时哨兵',
    script: '工具/临时哨兵.mjs',
    args: ['--quiet'],
    schedule: 'WEEKLY', day: 'SUN', time: '12:35',
    why: '扫临时件违规 + 允许区外的裸放 _临时',
  },
  {
    name: 'Xiodra-验证闸',
    script: '工具/验证闸.mjs',
    args: [],
    schedule: 'WEEKLY', day: 'SUN', time: '12:40',
    why: '与基线比，列出「从通过变成不通过」的项（退化就 ⛔）',
  },
];

const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';

/**
 * ⚠ schtasks 的输出是 **GBK(936)**，用 UTF-8 读会整片乱码 ⇒ 标签永远匹配不上
 *   （实测：`下次运行时间` 会变成 `�´�����ʱ��`）。
 *   所以用 buffer 取回再按 GBK 解码。
 */
function gbk(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}

function schtasks(args, opts = {}) {
  const r = spawnSync('schtasks', args, { windowsHide: true, ...opts });
  const out = gbk(Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)])).trim();
  return { code: r.status, out };
}

function exists(name) {
  const r = schtasks(['/query', '/tn', name]);
  return r.code === 0 && !/cannot find/i.test(r.out);
}

/** 生成一条 schtasks /create 的参数 */
export function createArgs(t) {
  const script = path.join(ROOT, t.script);
  const tr = q(NODE) + ' ' + q(script) + (t.args.length ? ' ' + t.args.join(' ') : '');
  const base = ['/create', '/tn', t.name, '/tr', tr, '/sc', t.schedule, '/st', t.time, '/f'];
  if (t.schedule === 'WEEKLY' && t.day) base.push('/d', t.day);
  // 间隔（HOURLY / MINUTE 类）：`/mo N` = 每 N 个周期一次
  // ⚠ 实测 schtasks 支持 /sc HOURLY；`/mo` 不传就是每 1 小时
  if (t.mo) base.push('/mo', String(t.mo));
  return base;
}

function install() {
  let n = 0;
  for (const t of TASKS) {
    if (!fs.existsSync(path.join(ROOT, t.script))) { console.log('  ! 跳过（脚本不存在）：' + t.script); continue; }
    // /RL LIMITED：不需要管理员权限即可运行；/F：已存在就覆盖（幂等）
    const r = schtasks([...createArgs(t), '/rl', 'LIMITED']);
    if (r.code === 0) { console.log('  ✓ ' + t.name + '　' + t.schedule + (t.day ? ' ' + t.day : '') + ' ' + t.time); n++; }
    else console.log('  ✗ ' + t.name + '：' + r.out.split('\n')[0]);
  }
  console.log('\n共注册 ' + n + '/' + TASKS.length + ' 个任务');
  if (n) console.log('  看下次时间：node 工具\\计划任务.mjs --list');
}

function remove() {
  let n = 0;
  for (const t of TASKS) {
    if (!exists(t.name)) { console.log('  · ' + t.name + '（本来就没有）'); continue; }
    const r = schtasks(['/delete', '/tn', t.name, '/f']);
    if (r.code === 0) { console.log('  ✓ 已删 ' + t.name); n++; }
    else console.log('  ✗ ' + t.name + '：' + r.out.split('\n')[0]);
  }
  console.log('\n共撤掉 ' + n + ' 个');
}

function list() {
  console.log('计划任务清单（唯一出处：工具\\计划任务.mjs 的 TASKS）\n');
  for (const t of TASKS) {
    // ⚠ 加 /v：不带的 /fo LIST 里没有 Next Run Time / Status
    // ⚠ 中英双语：本机 schtasks 输出可能是中文标签，别只匹配英文
    const r = schtasks(['/query', '/tn', t.name, '/fo', 'LIST', '/v']);
    const ok = r.code === 0 && !/cannot find|找不到/i.test(r.out);
    const grab = (re) => (r.out.match(re) || [])[1] || '';
    const next = grab(/Next Run Time:\s*(.+)/i) || grab(/下次运行时间[:：]\s*(.+)/);
    const status = grab(/Status:\s*(.+)/i) || grab(/状态[:：]\s*(.+)/);
    // 人读的频率文字（⛔ 别把 HOURLY 拼成"每2hourly"）
    const UNIT = { HOURLY: '小时', MINUTE: '分钟', DAILY: '天', WEEKLY: '周' };
    let freq;
    const DAYCN = { SUN: '日', MON: '一', TUE: '二', WED: '三', THU: '四', FRI: '五', SAT: '六' };
    if (t.schedule === 'WEEKLY') freq = '每周' + (DAYCN[t.day] || t.day || '') + ' ' + t.time;
    else if (t.mo) freq = '每 ' + t.mo + ' ' + (UNIT[t.schedule] || t.schedule) + '（' + t.time + ' 起）';
    else freq = t.schedule + ' ' + t.time;
    console.log((ok ? '  ✓ ' : '  · ') + t.name.padEnd(18) + freq);
    if (ok) console.log('        下次：' + (next.trim() || '(未排期？)') + (status ? '　状态：' + status.trim() : ''));
    else console.log('        （未注册）');
    console.log('        ' + t.why);
  }
}

function runNow(which) {
  const t = TASKS.find((x) => x.name.includes(which) || x.name === which);
  if (!t) { console.error('✗ 没有任务匹配「' + which + '」（可选：' + TASKS.map((x) => x.name).join(' / ') + '）'); process.exit(2); }
  if (!exists(t.name)) { console.error('✗ 任务还没注册，先 --install'); process.exit(2); }
  const r = schtasks(['/run', '/tn', t.name]);
  console.log(r.code === 0 ? '✓ 已触发：' + t.name + '（结果看报告文件，不在这里打印）' : '✗ 触发失败：' + r.out);
  process.exit(r.code === 0 ? 0 : 1);
}

/* ---------------- 自测 ---------------- */
function selftest() {
  const cases = [];
  const add = (ok, label, detail = '') => cases.push({ ok, label, detail });
  const probe = 'Xiodra-selftest-临时';

  // ① 参数拼装对不对（不落盘，纯函数）
  {
    const a = createArgs(TASKS.find((x) => x.schedule === 'DAILY'));
    const s = a.join(' ');
    add(s.includes('/sc DAILY') && s.includes('/st 12:30') && s.includes('/f') && s.includes('--quiet'),
      '反例① DAILY 任务参数含 /sc /st /f 与脚本参数', s.slice(0, 120));
    const b = createArgs(TASKS.find((x) => x.schedule === 'WEEKLY')).join(' ');
    add(b.includes('/d SUN') && b.includes('/sc WEEKLY'), '反例② WEEKLY 任务带 /d SUN', b.slice(0, 120));
  }

  // ② 真注册 → 查得到 → 撤掉 → 查不到（这条最实）
  {
    const tr = q(NODE) + ' -e "process.exit(0)"';
    const r1 = schtasks(['/create', '/tn', probe, '/tr', tr, '/sc', 'ONCE', '/st', '23:59', '/f', '/rl', 'LIMITED']);
    const e1 = exists(probe);
    const r2 = schtasks(['/delete', '/tn', probe, '/f']);
    const e2 = exists(probe);
    add(r1.code === 0 && e1, '正例 能注册（schtasks /create 成功且 /query 查得到）', r1.out.split('\n')[0]);
    add(r2.code === 0 && !e2, '反例③ 撤掉后必须查不到（否则 --remove 是假的）', 'existsAfter=' + e2);
  }

  // ③ 不挂危险任务：TASKS 里不许出现 --go / 写盘类
  {
    const risky = TASKS.filter((t) => t.args.some((a) => /--go|--bump|--record|--ack/.test(a)));
    add(risky.length === 0, '反例④ 清单里不许有会写盘的任务（--go/--bump/--ack）', risky.map((t) => t.name).join(','));
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
  if (has('--help') || has('-h') || (!argv.length)) {
    console.log([
      '计划任务.mjs —— 把体检挂到节奏上',
      '  node 工具\\计划任务.mjs --list',
      '  node 工具\\计划任务.mjs --install',
      '  node 工具\\计划任务.mjs --remove',
      '  node 工具\\计划任务.mjs --run 审计',
      '  node 工具\\计划任务.mjs --selftest',
      '⛔ 只挂"只读或只报"的任务；会写盘的（--go/--bump/--ack）一律不挂。',
    ].join('\n'));
    process.exit(0);
  }
  if (has('--install')) { install(); process.exit(0); }
  if (has('--remove')) { remove(); process.exit(0); }
  if (has('--run')) { runNow(val('--run')); }
  list();
}
