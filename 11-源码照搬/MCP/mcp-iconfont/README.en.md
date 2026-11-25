# @dawipong/mcp-iconfont

[![npm](https://img.shields.io/npm/v/@dawipong/mcp-iconfont.svg)](https://www.npmjs.com/package/@dawipong/mcp-iconfont)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![中文](https://img.shields.io/badge/lang-中文-red)](README.md)

> Bring [iconfont.cn](https://www.iconfont.cn/) (Alibaba's open icon library) into any MCP client — let your AI search free vector icons and illustrations. **No login, no API key.**

## ✨ Tools

| Tool           | Description                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `search_icons` | Search icons or illustrations by keyword; both come back as inline SVG. Chinese queries work best. |

## 🚀 Quick start

### 1. Install

```bash
npm install -g @dawipong/mcp-iconfont
# or
pnpm add -g @dawipong/mcp-iconfont

# or skip the install and run via npx (used in the configs below)
npx -y @dawipong/mcp-iconfont --help
```

> Every config snippet below uses `npx -y @dawipong/mcp-iconfont`, so you don't need a global install. If you did install globally, swap `npx -y @dawipong/mcp-iconfont` for `mcp-iconfont`.

### 2. Wire it into your AI client

Pick your client, paste the matching snippet into its config file (**no key needed**), then **restart the client** so the MCP server reloads.

#### Claude Desktop

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

**Settings → Features → Model Context Protocol → Add new global MCP server**, or edit `~/.cursor/mcp.json`:

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

> To remove: `claude mcp remove iconfont`

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

- project: `<project>/opencode.json`
- global: `~/.config/opencode/opencode.json`

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

`~/.codex/config.toml` (TOML, not JSON):

```toml
[mcp_servers.iconfont]
command = "npx"
args = ["-y", "@dawipong/mcp-iconfont"]
```

Or one-liner:

```bash
codex mcp add iconfont -- npx -y @dawipong/mcp-iconfont
```

### 3. Use it

> "Find me a house icon for my React header."

The AI calls `search_icons(q="房子", type="icon")`, picks one from the results, and returns the inline SVG.

> "Also grab some house-themed illustrations for a 404 page."

The AI calls `search_icons(q="房子", type="illustration")`; each result comes back with an inline `svg` string (the tool already fetched it server-side with the required `Referer`), just like icons — paste the `<svg>` straight into your code. `illustration_3d` items, or items whose fetch failed, have `svg: null`.

## ⚠️ iconfont ToS notes

| Rule                    | Detail                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------ |
| **No login, no key**    | The public search API is open to anyone.                                             |
| **Identify yourself**   | This server sets `User-Agent: mcp-iconfont/<version>` on every request.              |
| **24h in-memory cache** | Identical queries don't hit iconfont repeatedly.                                     |
| **Occasional 5xx**      | iconfont's search API is unofficial and can hiccup — retry after a few seconds.      |
| **Icon licensing**      | Icons are user-uploaded; verify the original author's license before commercial use. |

## ⚙️ Environment

| Variable | Required | Description                    |
| -------- | -------- | ------------------------------ |
| (none)   | —        | Public API — no key, no token. |

## 📋 Parameter reference

### `search_icons`

| Param                                                    | Type   | Notes                                               |
| -------------------------------------------------------- | ------ | --------------------------------------------------- |
| `q`                                                      | string | **Required**, 1-100 chars. Chinese recommended.     |
| `type`                                                   | enum   | `"icon"` or `"illustration"`, **required**          |
| `limit`                                                  | int    | 1-60, default 20                                    |
| `sortType`                                               | enum   | `"updated_at"` (default) / `"popular"`              |
| `fills`                                                  | enum   | `""` (any) / `"0"` / `"1"`                          |
| `line` / `fill` / `flat` / `hand` / `simple` / `complex` | enum   | `"1"` to require that style, `""` (default) for any |

Icon result shape:

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

Each illustration result carries an inline `svg` string (same shape as icons), plus `preview_image`, `width`/`height`, etc. `illustration_3d` items, or items whose fetch failed, have `svg: null`.

## 🧪 Development

```bash
pnpm install
cd packages/iconfont
pnpm dev              # tsx watch
pnpm test             # node --test
pnpm build            # tsc
pnpm inspect          # MCP Inspector (no key needed)
```

## 📄 License

[MIT](../../LICENSE) © nvrenshiren
