#!/usr/bin/env node
/**
 * gpu.mjs —— 「这个活要不要上 GPU」的**唯一判据**
 *
 * 照搬《00-核心机制/五-GPU优先.md》。核心两条：
 *   ① 判据只写一处：所有脚本都调 `shouldUseGpu(task)`，不许各判各的
 *      （同一个判断写在两处 ⇒ 这个说该上、那个说不该，还没人能复现）
 *   ② 判据拿不到就**照 CPU 跑并记 why** —— **降级不是失败**
 *
 * 只有三类活真的能用 GPU（其余全是调远端 API，本地 GPU 完全不参与）：
 *   OCR / 视频编码 / 三维渲染
 * ⛔ 大模型推理、对话、云端生图 —— 数据在别人机器上算，别动 GPU 的心思。
 *
 * 用法（命令行）：
 *   node 工具\gpu.mjs ocr
 *   node 工具\gpu.mjs video --out h264
 *   node 工具\gpu.mjs llm          # → false（远端 API）
 *   node 工具\gpu.mjs --json ocr   # 给别的脚本读
 *
 * 用法（代码）：
 *   const g = await decide('ocr')
 *   g.use ? runGpu() : runCpu({ threads: g.threads, priority: g.priority })
 */
import fs from 'node:fs';
import os from 'node:os';

/** 能用 GPU 的三类活。key → 说明 */
export const GPU_TASKS = {
  ocr: '文字识别（纯本地视觉推理，批量大）',
  video: '视频编码（硬件编码器是独立单元）',
  render3d: '三维渲染（天生就是 GPU 活）'
};

/**
 * 退 CPU 时的三条硬参数（照抄 §3 —— 曾经 6 路并行 OCR 把 8 核机器打到假死）：
 *   单进程 / 线程 ≤2 / BelowNormal
 */
export const CPU_SAFE = { procs: 1, threads: 2, priority: 'belowNormal' };

/** 负载闸（§5）：任一资源 ≥90% ⇒ 不派子代理、不唤醒别的会话；≥95% ⇒ 连体检都别跑 */
export const LOAD_GATE = { softMax: 0.90, hardMax: 0.95, heavyParallel: 3 };

/**
 * 判据（唯一一处）。
 * @param {string} task ocr | video | render3d | 其它任何字符串
 * @returns {Promise<{use:boolean, why:string, provider?:string, threads?:number, priority?:string}>}
 */
export async function decide(task) {
  const t = String(task || '').toLowerCase();
  const known = Object.keys(GPU_TASKS).find((k) => t === k || t.includes(k));
  if (!known) {
    return {
      use: false, why: '不在这三类里（' + (t || '空') + '）—— 数据不在本机算，别动 GPU 的心思',
      threads: CPU_SAFE.threads, priority: CPU_SAFE.priority
    };
  }
  // 探 GPU 是否真的可用；探不到就退 CPU 并记 why（降级不是失败）
  const info = probeGpu();
  if (!info.ok) {
    return {
      use: false, why: 'GPU 探测失败：' + info.why + ' ⇒ 照 CPU 跑（降级不是失败）',
      threads: CPU_SAFE.threads, priority: CPU_SAFE.priority
    };
  }
  const load = currentLoad();
  if (load.max >= LOAD_GATE.hardMax) {
    return { use: false, why: '负载闸：' + load.which + ' 已 ' + Math.round(load.max * 100) + '%（≥95%）—— 连重活都别派', threads: CPU_SAFE.threads, priority: CPU_SAFE.priority };
  }
  if (load.max >= LOAD_GATE.softMax) {
    return { use: false, why: '负载闸：' + load.which + ' 已 ' + Math.round(load.max * 100) + '%（≥90%）—— 不派子代理、不唤醒别的会话', threads: CPU_SAFE.threads, priority: CPU_SAFE.priority };
  }
  return { use: true, why: GPU_TASKS[known] + ' ⇒ 走 GPU 路径', provider: info.provider };
}

/** 探 GPU：本机有没有可用的 CUDA 设备。探测手段按可用性降级，全试不通就 ok:false。 */
export function probeGpu() {
  // ① nvidia-smi（最可靠：能拿到型号与显存）
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) return { ok: true, provider: 'cuda', device: out.split('\n')[0] };
  } catch (e) { /* 没装/没卡 */ }
  // ② 环境变量（有些机器工具链已配好但 nvidia-smi 不在 PATH）
  if (process.env.CUDA_VISIBLE_DEVICES && process.env.CUDA_VISIBLE_DEVICES !== '-1') {
    return { ok: true, provider: 'cuda', device: 'CUDA_VISIBLE_DEVICES=' + process.env.CUDA_VISIBLE_DEVICES };
  }
  return { ok: false, why: 'nvidia-smi 不可用且没有 CUDA_VISIBLE_DEVICES' };
}

/** 当前负载：CPU 用 os.loadavg 的 1 分钟值 / 核数；内存用 1 - free/total。取最大值。 */
export function currentLoad() {
  const cores = Math.max(1, os.cpus().length);
  const cpu = os.loadavg()[0] / cores;
  const mem = 1 - os.freemem() / os.totalmem();
  return cpu >= mem ? { max: cpu, which: 'CPU' } : { max: mem, which: '内存' };
}

/**
 * 验收三条（§4）—— ⛔「能跑通」不算证据，三条必须同时具备：
 *   ① providers 里出现 CUDA（不是 CPUExecutionProvider 兜底）
 *   ② 有量化指标：秒/页 or fps or 采样速度
 *   ③ 显存占用有数字
 * 「available」≠「in use」。
 */
export const VERIFY_3 = [
  'providers 列表里出现 CUDA（不是 CPUExecutionProvider 兜底）',
  '有量化指标：秒/页（OCR）或 fps / 编码速度（视频）或采样速度（渲染）',
  '显存占用有数字（进程确实占用了显存）'
];

/* ---------------- CLI ---------------- */
import { fileURLToPath } from 'node:url';
const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const task = args.find((a) => !a.startsWith('--')) || '';
  if (!task) {
    console.log('用法：node 工具\\gpu.mjs <ocr|video|render3d|llm|任意任务名> [--json]');
    console.log('能上 GPU 的只有：' + Object.values(GPU_TASKS).join(' / '));
    process.exit(2);
  }
  decide(task).then((g) => {
    if (json) { console.log(JSON.stringify(g, null, 2)); process.exit(0); }
    console.log((g.use ? '✓ 走 GPU' : '· 走 CPU') + '：' + task);
    console.log('  原因：' + g.why);
    if (g.use) {
      console.log('  设备：' + (g.provider || '?'));
      console.log('  验收三条（缺一不算用上 GPU）：');
      VERIFY_3.forEach((s, i) => console.log('    ' + (i + 1) + ') ' + s));
    } else {
      console.log('  CPU 安全参数：单进程 / 线程 ' + g.threads + ' / 优先级 ' + g.priority);
    }
    process.exit(0);
  });
}
