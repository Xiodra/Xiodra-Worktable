# @dawipong/mcp-iconfont

[![npm](https://img.shields.io/npm/v/@dawipong/mcp-iconfont.svg)](https://www.npmjs.com/package/@dawipong/mcp-iconfont)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![English](https://img.shields.io/badge/lang-English-orange)](README.en.md)

> 把 [iconfont.cn](https://www.iconfont.cn/)(阿里矢量图标库)的公开搜索接进任何 MCP 客户端 — 让 AI 直接搜免费的图标和插画。**不需登录,不需要 API key**。

## ✨ 工具一览

| 工具           | 说明                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| `search_icons` | 按关键词搜索图标或插画,图标与插画都返回内联 SVG 字符串。中文查询效果最佳(图标名多是中文) |

## 🚀 快速开始

### 1. 安装

```bash
# 全局安装(推荐,会注册 mcp-iconfont 命令到 PATH)
npm install -g @dawipong/mcp-iconfont
# 或
pnpm add -g @dawipong/mcp-iconfont

# 不装也行,直接 npx 跑(下面 AI 工具配置默认走 npx)
npx -y @dawipong/mcp-iconfont --help
```

> 下面所有 AI 工具配置示例都用 `npx -y @dawipong/mcp-iconfont` — **不用先全局安装**。如果你已经全局装,把 `npx -y @dawipong/mcp-iconfont` 换成 `mcp-iconfont`。

### 2. 接入 AI 工具

任选你常用的客户端,把对应片段加进配置文件,**不用填任何 key / token**,然后**重启客户端**让 MCP server 重新加载。

#### Claude Desktop

配置文件:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "iconfont": {
      "command": "npx",
      "args": ["-y", "@dawipong/mcp-iconfont"]
    }
  }
}
```

#### Cursor

**Settings → Features → Model Context Protocol → Add new global MCP server**,或编辑 `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "iconfont": {
      "command": "npx",
      "args": ["-y", "@dawipong/mcp-iconfont"]
    }
  }
}
```

#### Claude Code (CLI)

```bash
claude mcp add iconfont -- npx -y @dawipong/mcp-iconfont
```

> 想删:`claude mcp remove iconfont`

#### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "iconfont": {
      "command": "npx",
      "args": ["-y", "@dawipong/mcp-iconfont"]
    }
  }
}
```

#### OpenCode

配置文件:

- 项目级: `<project>/opencode.json`
- 全局: `~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "iconfont": {
      "type": "local",
      "command": ["npx", "-y", "@dawipong/mcp-iconfont"]
    }
  }
}
```

#### Codex CLI (OpenAI)

配置文件: `~/.codex/config.toml`(TOML 不是 JSON):

```toml
[mcp_servers.iconfont]
command = "npx"
args = ["-y", "@dawipong/mcp-iconfont"]
```

或一行命令:

```bash
codex mcp add iconfont -- npx -y @dawipong/mcp-iconfont
```

### 3. 用起来

> "帮我找个房子的图标,放在我的 React 项目 header 里。"

AI 会调 `search_icons(q="房子", type="icon")`,从结果里挑一个,直接返回 inline SVG,你拿 `<svg>` 贴到代码里就行。

> "再找几张房子主题的插画,做 404 页用。"

AI 调 `search_icons(q="房子", type="illustration")`,每条结果直接带内联的 `svg` 字符串(工具已在服务端带 `Referer` 抓好),和图标一样,拿 `<svg>` 贴进代码即用。`illustration_3d` 或抓取失败的条目 `svg` 为 `null`。

## ⚠️ iconfont 服务条款要点

| 规则                  | 说明                                                         |
| --------------------- | ------------------------------------------------------------ |
| **不需登录/不需 key** | 公开搜索 API 任何人都能用                                    |
| **请求带 UA**         | 本服务固定 `User-Agent: mcp-iconfont/<version>`,标识请求来源 |
| **结果有缓存**        | 24 小时内存缓存(同请求不重发),减轻 iconfont 服务器负担       |
| **偶尔 5xx**          | iconfont 不是正式公开 API,可能临时挂;遇到就稍后重试          |
| **图标版权**          | iconfont 上的图标由用户上传,商用前请确认原作者授权           |

## ⚙️ 环境变量

| 变量 | 必填 | 说明                                |
| ---- | ---- | ----------------------------------- |
| (无) | —    | 公开 API,**不需要任何 key / token** |

## 📋 参数参考

### `search_icons`

| 参数                                                     | 类型   | 备注                                  |
| -------------------------------------------------------- | ------ | ------------------------------------- |
| `q`                                                      | string | 搜索词,**必填**,1-100 字              |
| `type`                                                   | enum   | `"icon"` 或 `"illustration"`,**必填** |
| `limit`                                                  | int    | 1-60,默认 20                          |
| `sortType`                                               | enum   | `"updated_at"`(默认) / `"popular"`    |
| `fills`                                                  | enum   | `""`(全部) / `"0"` / `"1"`            |
| `line` / `fill` / `flat` / `hand` / `simple` / `complex` | enum   | `"1"` 启用该风格过滤,`""`(默认)不限   |

返回字段(以 icon 为例):

```json
{
  "type": "icon",
  "total": 240,
  "hits": [
    {
      "type": "icon",
      "id": 4055804,
      "name": "房子",
      "font_class": "fangzi",
      "unicode": "59647",
      "fills": 1,
      "width": 1024,
      "height": 1024,
      "svg": "<svg viewBox=\"0 0 1024 1024\">...</svg>",
      "preview_image": "..."
    }
  ]
}
```

插画结果每条含 `svg`(内联 SVG 字符串,和图标一致)、`preview_image`、`width`/`height` 等字段;`illustration_3d` 及抓取失败的条目 `svg` 为 `null`。

## 🧪 开发 & 调试

```bash
# 仓库根目录装依赖
pnpm install

# 包目录里
cd packages/iconfont
pnpm dev              # tsx watch
pnpm test             # node --test
pnpm build            # tsc

# 用 MCP Inspector 调试(无需 key)
pnpm inspect
```

## 📄 License

[MIT](../../LICENSE) © nvrenshiren
