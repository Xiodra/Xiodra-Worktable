#!/usr/bin/env node
/**
 * 发布前检查.mjs —— 出包/推仓库前扫一遍红线
 *
 * 用法：
 *   node 工具\发布前检查.mjs          扫「会装进包里」的东西（默认，快）
 *   node 工具\发布前检查.mjs --all    连 引擎\ 与 引擎数据\ 一起扫（慢，噪音大）
 *
 * 两类结果，别混为一谈：
 *   ✗ 红线   本机绝对路径 / 用户目录 / 密钥 / 服务器 IP，以及**不该出现会话 id 的地方**
 *            出现了会话 id。这些必须处理掉才能出包。
 *   ○ 待清   会话 id 出现在「打包时会被自动清掉」的文件里（场景 json、
 *            `_场景身份索引.md`）—— 封装.mjs 会把 sessionId 就地改写成 `__待填__`。
 *            这些**不算红线**，只是提示你别忘了打包走 封装.mjs，别手工 zip。
 *
 * 默认不扫的两个目录（加 --all 才扫）：
 *   引擎\       指向 DSH 引擎源码的 junction，不随包发布；它自己的测试夹具里
 *               本来就有 `session-xxxxxxxx`、`sk-fixture…` 之类的假值，
 *               扫它只会得到几十条噪音，把真问题埋掉。
 *   引擎数据\   本机会话 / 记忆 / 凭据，**永远不发布**（已在 .gitignore）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..')
const ALL = process.argv.includes('--all')

// 硬红线：命中就出不了包
const HARD = [
  ['本机绝对路径 <工作台>', /<盘根>:\\\\DSH/i],
  ['本机用户目录 <用户目录>', /<盘根>:\\\\Users/i],
  ['密钥', /sk-[A-Za-z0-9]{16,}/],
  ['服务器 IP', /47\.108\.201\.6/],
]
const SESSION_RE = /session-[0-9a-f]{8}/i

// 「打包时会被自动清掉」的文件（封装.mjs 会把它们的 sessionId 改成 __待填__）
const SCRUBBED = [
  /^外壳[\\/]scenarios[\\/][^\\/]+\.json$/i,
  /^外壳[\\/]scenarios[\\/]_场景身份索引\.md$/i,
]

// 任何情况下都不扫（依赖 / 版本库 / 产物 / 运行时状态）
const SKIP_DIR = new Set([
  'node_modules', '.git', '发布', 'dist',
  'captures', '_归档-无场景模板',
  'electron-profile',            // 外壳\data\electron-profile：每次启动重建
  // ⚠ 2026-11-18 补：`_临时` 已在 .gitignore（`git check-ignore` 实测命中）⇒ 永远不进包。
  //   以前没跳过它，导致"删会话前备份"这类**本来就该含会话 id** 的临时件被报成红线（假警报）。
  //   ⛔ 别用「删掉备份」来消警报 —— 那会把回滚能力一起删掉；该修的是扫描范围。
  '_临时',
])

// 只有 --all 才扫（不随包发布）
const SKIP_UNLESS_ALL = new Set(['引擎', '引擎数据'])

const SKIP_EXT = /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.ico|\.woff2?|\.ttf|\.mp4|\.zip|\.7z|\.exe|\.dll|\.log|\.ldb)$/i

let hard = 0
const scrub = []

function isScrubbed(rel) {
  const r = rel.split(path.sep).join('/')
  return SCRUBBED.some((re) => re.test(r))
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue
    if (!ALL && SKIP_UNLESS_ALL.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (SKIP_EXT.test(e.name)) continue
    let t
    try { t = fs.readFileSync(p, 'utf8') } catch { continue }
    const rel = path.relative(ROOT, p)

    for (const [name, re] of HARD) {
      const m = t.match(re)
      if (m) { console.log('✗ ' + rel + ' ← ' + name + '：' + m[0].slice(0, 30)); hard++ }
    }

    const ms = t.match(SESSION_RE)
    if (ms) {
      if (isScrubbed(rel)) scrub.push(rel)
      else { console.log('✗ ' + rel + ' ← 会话 id：' + ms[0].slice(0, 30) + '（这里不该有会话 id）'); hard++ }
    }
  }
}

walk(ROOT)
console.log('')
if (scrub.length) {
  console.log('○ 打包时会自动清掉会话 id 的文件（不算红线，但别手工 zip）：')
  for (const r of scrub) console.log('    ' + r)
  console.log('')
}
if (hard) { console.log('命中 ' + hard + ' 处红线 ⇒ 不出包'); process.exit(1) }
console.log('✓ 红线检查通过（0 命中）' + (ALL ? '［--all：含 引擎\\ 与 引擎数据\\］' : ''))
