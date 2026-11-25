# MCP 服务端（我们自己的）

> 这里放**本工作台自己维护**的 MCP 服务器与它们的接入 bundle。
> ⛔ 不放上游引擎的东西（`引擎\` 是上游，改了下次同步会丢）。

## 目录

| 目录 | 是什么 | 谁维护 |
|---|---|---|
| `mcp-iconfont\` | `@dawipong/mcp-iconfont@0.3.1` 的 vendor 副本（含 `node_modules` 与打补丁后的 `dist`） | DSH·GUI |
| `bundle-iconfont\` | 配置型 DSH bundle：把上面那个接成工具 `mcp__iconfont__search_icons` | DSH·GUI |
| `github-mcp-server\` | 官方 `github/github-mcp-server` v2.2.0 的 Windows x86_64 发布件（Go 二进制）+ `launch.mjs` 启动器 | 控制器 |
| `bundle-github\` | 配置型 DSH bundle：把上面那个接成工具 `mcp__github__*`（46 个） | 控制器 |

## 一条判据

```powershell
node 工具\mcp-iconfont补丁.mjs --check   # 补丁在位 ⇒ exit 0
node 工具\机制体检.mjs                    # 12 项全跑（含本项）
```

## 加第二个 MCP 的步骤（照抄这一套）

1. 在 `MCP\<服务名>\` 放服务端本体（含依赖）；
2. 在 `MCP\bundle-<服务名>\` 照 `bundle-iconfont\` 复制：`package.json` / `cordis.patch.yml` / `locale\{en,zh}.json` / `icon.svg` / `docs\DETAIL.md`；
3. `cordis.patch.yml` 里改 `serverName`（工具前缀 `mcp__<serverName>__*`）与 `args` 的入口路径；
4. `plugin_manager install_bundle`（或 GUI **插件 → 添加插件** 选目录）；
5. ⛔ **验证只认真调用**：直接调一次 `mcp__<serverName>__<tool>`，别拿"安装成功"当证据。

## 踩过的坑

- **stdio 的 `command`/`args`/`cwd` 不能写相对路径**：MCP 子进程 cwd 不由我们控制。
- **子进程环境被清洗**：所有 `DSH_*` 变量会被删掉，所以路径必须在父进程算好传进去。
  ⛔ **连自定义变量也别用 `DSH_` 前缀** —— 第一次接 GitHub 就是栽在这：
  `launch.mjs` 里读 `process.env.DSH_HOME` 永远拿到 `undefined`，
  报「GITHUB_PERSONAL_ACCESS_TOKEN is not configured」。
  改用 `GITHUB_MCP_CREDENTIALS_FILE`（非 `DSH_` 前缀）由父进程传绝对路径才通。
- **`${credential:...}` 模板在 bundle 层不可用**：`mcp-client` 的凭据模板要求
  **加载阶段**就能 `ctx.get('credentials')`，而 bundle 层拿不到凭据服务，直接报
  `MCP credential templates require a credentials provider`，整个条目不激活
  （表现为 `dsh: warning: 1 entry did not activate`）。
  ⇒ 令牌改由启动器脚本在运行时读 `$DSH_HOME/.credentials.yaml` 再喂子进程。
- **`!!js` 是 ESM 上下文**：⛔ 不能用 `require`（报 `ReferenceError: require is not defined`），只能用 `process` 与字符串方法。
- **`!!js` 里别写中文正则**：文件编码经手几次就可能变味。用
  `/[\\/][^\\/]+[\\/]\.dsh[\\/]?$/` 这种纯 ASCII 写法同样能剥掉「引擎数据\.dsh」。
- **第三方 MCP 的上游接口会变**：`mcp-iconfont` 就是例子（缺 Cookie 全站 403）。每个 vendor 的包都该配一个 `--check` 判据 + 反例自测。
- **Go 二进制的 `generate-docs` 需要 README**：在空目录里跑会报错，别拿它当探针；
  用真实 MCP 握手（`initialize` + `tools/list`）才是权威。
