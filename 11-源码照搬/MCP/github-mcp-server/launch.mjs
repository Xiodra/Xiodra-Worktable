// github-mcp-server 启动器
//
// 为什么不直接在 cordis.patch.yml 里用 ${credential:...}：
//   mcp-client 的凭据模板要求加载阶段就能 ctx.get('credentials')，
//   而 bundle 层拿不到凭据服务（实测报 "MCP credential templates require
//   a credentials provider"）。所以令牌在这里读，再以 env 传给子进程。
//
// 令牌来源（按优先级）：
//   ① $DSH_HOME/.credentials.yaml 的 refs.GITHUB_PERSONAL_ACCESS_TOKEN
//   ② 进程环境变量 GITHUB_PERSONAL_ACCESS_TOKEN
//
// ⛔ 本文件不含任何令牌，令牌只存在凭据库里。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXE = join(HERE, 'github-mcp-server.exe')
const REF = 'GITHUB_PERSONAL_ACCESS_TOKEN'

/**
 * 凭据文件路径。
 * ⚠ mcp-client 会把子进程环境里所有 `DSH_*` 变量删掉，所以这里**不能**依赖
 *   $DSH_HOME；由父进程用 !!js 算好绝对路径，经非 DSH_ 前缀的
 *   GITHUB_MCP_CREDENTIALS_FILE 传进来。DSH_HOME 只作为手动运行时的兜底。
 */
function credentialsFile() {
  const explicit = process.env.GITHUB_MCP_CREDENTIALS_FILE
  if (explicit && explicit.length > 0) return explicit
  const home = process.env.DSH_HOME
  return home ? join(home, '.credentials.yaml') : undefined
}

/** 从 .credentials.yaml 的 refs 段里取一个标量值；取不到返回 undefined。 */
function readRefFromStore(ref) {
  const file = credentialsFile()
  if (!file) return undefined
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let inRefs = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      // 顶层键（version: / records: / refs:）
      inRefs = /^refs:\s*$/.test(raw)
      continue
    }
    if (!inRefs) continue
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(raw)
    if (!m) continue
    if (m[1] !== ref) continue
    let v = m[2]
    // 去掉成对引号
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1)
    }
    return v.length > 0 ? v : undefined
  }
  return undefined
}

const token = readRefFromStore(REF) ?? (process.env[REF] || undefined)

if (token === undefined) {
  process.stderr.write(
    `github-mcp-server launcher: ${REF} is not configured — expected it under refs: in `
    + `${credentialsFile() ?? '<GITHUB_MCP_CREDENTIALS_FILE not set>'}, or exported in the environment.\n`,
  )
  process.exit(2)
}

// 子进程环境：只补令牌，其余继承（mcp-client 已做过一次清洗）
const child = spawn(EXE, process.argv.slice(2), {
  cwd: HERE,
  env: { ...process.env, [REF]: token },
  stdio: 'inherit',
  windowsHide: true,
})

child.on('error', (err) => {
  process.stderr.write(`github-mcp-server launcher: failed to start: ${err.message}\n`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})

// 父进程被关闭时带走子进程
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { child.kill() })
}
