# GitHub MCP 接入记录

> 2026-11-23 · 控制器场景 · 一次性文档，勿追加

## 装了什么

官方 `github/github-mcp-server` v2.2.0（Go 编译的 Windows x86_64 二进制，**不是 npm 包、不是 DSH 插件**）。

| 项目 | 位置 |
|---|---|
| 服务器本体 | `MCP\github-mcp-server\github-mcp-server.exe` |
| 启动器 | `MCP\github-mcp-server\launch.mjs` |
| 握手探针 | `MCP\github-mcp-server\probe-mcp.mjs` |
| 接入 bundle | `MCP\bundle-github\` |
| 令牌 | `引擎数据\.dsh\.credentials.yaml` → `refs.GITHUB_PERSONAL_ACCESS_TOKEN` |
| 回滚备份 | `MCP\备份\20261123-131358\` |

工具前缀 `mcp__github__*`，默认工具集 **46 个**。

## 来源可信性

- 从 GitHub Releases 官方页下载 v2.2.0；
- **SHA256 比对通过**：`6ecda644…3a850` = 官方 `checksums.txt` 里 `github-mcp-server_Windows_x86_64.zip` 那一行；
- 二进制自报 `Version: 2.2.0 / Commit: 67d4dc4897…`，与发布页一致。

## 两个必须记住的坑

### ① `${credential:...}` 模板在 bundle 层不可用

`mcp-client` 要求**加载阶段**就能 `ctx.get('credentials')`，bundle 层拿不到凭据服务：

```
mcp-github (@deepseek-ai/dsh-mcp-client): Error: MCP credential templates require a credentials provider
dsh: warning: 1 entry did not activate
```

⇒ 令牌改由 `launch.mjs` 运行时读凭据库再喂子进程。**令牌不进任何配置文件。**

### ② 子进程里所有 `DSH_*` 变量会被删掉

`launch.mjs` 里读 `process.env.DSH_HOME` 永远是 `undefined`，报
`GITHUB_PERSONAL_ACCESS_TOKEN is not configured`。

⇒ 由父进程用 `!!js` 算好绝对路径，经**非 `DSH_` 前缀**的
`GITHUB_MCP_CREDENTIALS_FILE` 传进去。

## 判据

```powershell
$env:DSH_HOME='D:\Xiodra Worktable\11-源码照搬\引擎数据\.dsh'
node 引擎\apps\cli\lib\bin.js --profile web --dump-config | Select-String 'mcp-github'
# 启动后日志必须【没有】"did not activate"，且看到 "GitHub MCP Server running on stdio"
Get-CimInstance Win32_Process -Filter "Name='github-mcp-server.exe'"
```

唯一硬判据：**真实调用一次 `mcp__github__get_me`**。

## 实测记录

| 测试 | 结果 |
|---|---|
| 裸 MCP 握手 | `SERVER: github-mcp-server v2.2.0`，`TOOL_COUNT: 46` |
| 经 launch.mjs | 同样 46 个工具 |
| 临时引擎实例加载（33098/33099） | 无 `did not activate`，exe 进程在，会话已连 |
| 反例：凭据路径错 | exit=2 + 明确报错（非静默） |
| 反例：无路径无 DSH_HOME | exit=2 + 明确报错 |
| 令牌泄漏扫描 | 6 个配置文件全部 clean |

## 卸载

```powershell
# ① 编辑 引擎数据\.dsh\profiles\web\package.json
#    删掉 "@local/mcp-github-bundle" 依赖行 + bundles 数组里那一项
# ② 可选：删凭据 引擎数据\.dsh\.credentials.yaml 的 refs.GITHUB_PERSONAL_ACCESS_TOKEN
# ③ 可选：删目录
Remove-Item -Recurse -Force 'MCP\bundle-github','MCP\github-mcp-server'
# ④ 重启引擎
```

## 注意

- 本机**无 Docker**，只能走原生 exe。
- 令牌是 fine-grained PAT（`github_pat_` 前缀）。写类工具（`create_or_update_file` / `push_files` / `merge_pull_request`）会**真的改仓库**。只想读就在 `args` 加 `--read-only`。
- 要精简工具数用 `--toolsets=default,issues` 收窄。
