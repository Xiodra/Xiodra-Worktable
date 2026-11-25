# GitHub MCP 接入详情

## 是什么

[github/github-mcp-server](https://github.com/github/github-mcp-server) v2.2.0 —— GitHub 官方的
MCP 服务器。**Go 编译的原生可执行文件**（不是 npm 包、不是 DSH 插件），
本工作台以 vendor 副本形式放在 `MCP\github-mcp-server\`。

## 装在哪

| 项目 | 位置 |
|---|---|
| 服务器本体 | `MCP\github-mcp-server\github-mcp-server.exe`（30.7 MB） |
| 启动器 | `MCP\github-mcp-server\launch.mjs`（读凭据库 → 起 exe） |
| 接入 bundle | `MCP\bundle-github\` |
| profile 依赖 | `引擎数据\.dsh\profiles\web\package.json` → `"@local/mcp-github-bundle": "link:…"` |
| 令牌 | `引擎数据\.dsh\.credentials.yaml` → `refs.GITHUB_PERSONAL_ACCESS_TOKEN` |

工具前缀：`mcp__github__*`（默认工具集 46 个）。

## 为什么多了一个 launch.mjs

两处坑，都实测撞过：

1. **`${credential:...}` 模板在 bundle 层用不了**
   `mcp-client` 要求加载阶段就能 `ctx.get('credentials')`，bundle 层拿不到凭据服务，
   报 `MCP credential templates require a credentials provider`，整个条目不激活。
2. **子进程里所有 `DSH_*` 变量会被删掉**
   所以启动器不能靠 `$DSH_HOME` 找凭据文件；由父进程用 `!!js` 算好绝对路径，
   经 **非 `DSH_` 前缀** 的 `GITHUB_MCP_CREDENTIALS_FILE` 传进去。

⇒ 令牌由 `launch.mjs` 在运行时读凭据库，再以 env 交给 exe。
**令牌不出现在任何配置文件里，也不进 git。**

## 来源可信性

- 下载自 GitHub Releases 官方发布页 v2.2.0；
- **SHA256 已比对**：`6ecda644e8ea54b26acbc76e80379f4afb6ac1a4c2521366584f2a7f23e3a850`
  与官方 `github-mcp-server_2.2.0_checksums.txt` 完全一致；
- 二进制自报 `Version: 2.2.0 / Commit: 67d4dc4897…`，与发布页一致。

## 判据（怎么确认生效）

```powershell
# ① 组合树里能看到 mcp-github 且没有 disabled
$env:DSH_HOME='<工作台根>\引擎数据\.dsh'
node 引擎\apps\cli\lib\bin.js --profile web --dump-config | Select-String 'mcp-github'

# ② 启动引擎，日志里必须【没有】这行
#    dsh: warning: 1 entry did not activate
#    且能看到 GitHub 自己的启动输出：
#    GitHub MCP Server running on stdio
#    msg="server session connected"

# ③ 进程在
Get-CimInstance Win32_Process -Filter "Name='github-mcp-server.exe'"

# ④ 唯一硬判据：在对话里让模型真实调用一次 mcp__github__get_me
```

⛔ 不许拿"安装成功"当证据，只认真实工具调用返回。

**已验证的实测记录（2026-11-23）**：
- 裸 `initialize`+`tools/list` 握手 → `SERVER: github-mcp-server v2.2.0`，`TOOL_COUNT: 46`
- 经 launch.mjs 启动 → 同样 46 个工具
- 临时引擎实例（端口 33099）加载 → 日志无 `entry did not activate`，`github-mcp-server.exe` 进程在，会话已连

## 卸载

```powershell
# ① 从 profile 依赖里去掉
#    编辑 引擎数据\.dsh\profiles\web\package.json，删掉 "@local/mcp-github-bundle" 那一行，
#    并从 dsh.profile.bundles 数组里删掉 "@local/mcp-github-bundle"
# ② 清掉凭据（可选）
#    编辑 引擎数据\.dsh\.credentials.yaml，删掉 refs.GITHUB_PERSONAL_ACCESS_TOKEN
# ③ 删目录（可选，不删也不影响）
Remove-Item -Recurse -Force 'MCP\bundle-github'
Remove-Item -Recurse -Force 'MCP\github-mcp-server'
# ④ 重启引擎生效
```

回滚备份：`MCP\_备份-20261123-131358\`（含 `package.json` / `cordis.patch.yml` / `.credentials.yaml`）。

## 已知限制

- 本机**没有 Docker**，所以不能用官方 docker 镜像方式，只能走原生 exe。
- 令牌是 `gho_` 前缀（OAuth 令牌），权限 `gist, repo, workflow`。
  写类工具（`create_or_update_file` / `push_files` / `merge_pull_request` 等）会**真的改动仓库**。
  只想读的话，把 `args` 加上 `--read-only`。
- 默认工具集 46 个工具。要精简用 `--toolsets=default,issues` 之类收窄。
