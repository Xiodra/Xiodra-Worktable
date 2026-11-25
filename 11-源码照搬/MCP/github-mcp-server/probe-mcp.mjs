// 探针：对 github-mcp-server 做一次真实 MCP 握手（initialize + tools/list）
// 用法: node probe.mjs <exe路径> [env名=值 ...]
import { spawn } from 'node:child_process'

const exe = process.argv[2]
const envs = Object.fromEntries(
  process.argv.slice(3).map(s => {
    const i = s.indexOf('=')
    return [s.slice(0, i), s.slice(i + 1)]
  }),
)

const child = spawn(exe, ['stdio'], {
  env: { ...process.env, ...envs },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
let stderr = ''
const pending = new Map()
let id = 0

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', d => { stderr += d })

function send(method, params) {
  const mid = ++id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30000)
    pending.set(mid, m => { clearTimeout(timer); resolve(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n')
  })
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

try {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-probe', version: '1.0.0' },
  })
  if (init.error) {
    console.log('INIT_ERROR: ' + JSON.stringify(init.error))
    process.exitCode = 2
  } else {
    console.log('SERVER: ' + JSON.stringify(init.result.serverInfo))
    console.log('PROTOCOL: ' + init.result.protocolVersion)
    notify('notifications/initialized', {})

    const list = await send('tools/list', {})
    if (list.error) {
      console.log('LIST_ERROR: ' + JSON.stringify(list.error))
      process.exitCode = 3
    } else {
      const names = list.result.tools.map(t => t.name)
      console.log('TOOL_COUNT: ' + names.length)
      console.log('TOOLS: ' + names.join(', '))
    }
  }
} catch (e) {
  console.log('FAIL: ' + e.message)
  if (stderr) console.log('STDERR: ' + stderr.slice(0, 1500))
  process.exitCode = 1
} finally {
  child.stdin.end()
  setTimeout(() => { child.kill(); process.exitCode = process.exitCode ?? 0 }, 500)
}
