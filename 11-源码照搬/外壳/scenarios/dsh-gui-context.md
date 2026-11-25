# DSH·GUI · 定位卡

> 开场读一次就够，一屏以内。只做**导航与进度**：细则进技能、决策进场景记忆。

## 一、身份与职责

| 项 | 值 |
|---|---|
| 场景 id | `dsh-gui` |
| 面板 id / 标题 | `dsh-gui-chat` · `GUI改造`（主）｜`dsh-gui-p3` · `DSH改造`（副） |
| 会话名（pinTarget 首项） | GUI改造 ｜ DSH改造 |
| 会话 id | 见 `外壳\scenarios\_场景身份索引.md` 的 `dsh-gui` 两行（`dsh-gui-chat` / `dsh-gui-p3`）。⛔ 本卡不写明文 id：发布前红线会判「不该出现会话 id 的地方」命中 |
| 主技能 | —（暂无专属技能） |
| 场景记忆 | `引擎数据\.dsh\场景记忆\DSH·GUI\场景私有记忆.md` |

**我负责**：这个工作台外壳本身（`外壳\`：主进程启动链路、场景体系、面板渲染器、主题、网页版 AI 图标条）的改造与排障。
**我不负责**：引擎本体（`引擎\` 下 deepseek harness 源码）的改动 —— 那是上游，改了会在下次同步时丢。

## 二、资产地图

| 资产 | 位置 | 性质 |
|---|---|---|
| 外壳主进程 | `外壳\main.js` | 可改（改完**必须重启** Electron） |
| 预加载桥 | `外壳\preload.js` | 可改（同上） |
| 渲染层 | `外壳\renderer\{index.html,renderer.js,renderers.js,theme.js,webai.js,styles.css}` | 可改（改完 `location.reload()` 即可） |
| 场景配置 | `外壳\scenarios\*.json` | 可改 |
| 启动配置 | `config.json`（工作台根） | 可改（端口/数据目录改动后必须重启） |
| 工具脚本 | `工具\*.mjs` | 可改（C 档，归属本场景） |
| **MCP 服务端** | `MCP\mcp-iconfont\`（vendor）· `MCP\bundle-iconfont\`（接入 bundle） | 可改（**第三方包，升级后要重跑补丁**） |
| 引擎数据 | `引擎数据\.dsh\` | 只读为主（`storages\` 只读投影） |
| 引擎源码 | `引擎\` | **不改**（上游） |

## 三、触发词 → 去哪

| 用户说什么 | 我去哪 |
|---|---|
| 「打不开 / 双击没反应 / 白屏」 | 先看 `外壳\server.log`，再查 `启动.vbs` 与 `config.json` |
| 「引擎起不来 / 401 / authentication required」 | 查 `primeAuthCookie` 与 webview 分区是否一致 |
| 「面板串台 / 会话跟着跑」 | 查该面板的三字段 + 分区名，见本卡 §五 |
| 「新加一种面板类型」 | `main.js` 的 `PANEL_TYPES`（`impl` 只给真写了渲染器的）+ `renderers.js` 注册表 |
| 「壁纸 / 外观 / 主题」 | `renderer\theme.js` + `styles.css` 主题段；引擎页透壁纸靠 `ENGINE_WP_CSS` |
| 「这条规矩在我们这儿算不算数 / 该谁做」 | `node 工具\归属.mjs <路径> --我已经是 DSH·GUI`（五档）+ `05-协作与规矩\00-照搬状态.md` |
| 「要不要找图标 / 找配图」 | 调 `mcp__iconfont__search_icons`（`q` 用中文效果最好） |
| 「embed 面板白屏 / 闪空 / 透壁纸 / DeepSeek 面板空白」 | **技能 `embed-panel-debug`**（`引擎数据\.dsh\skills\embed-panel-debug\SKILL.md`）—— **本场景第二技能，不占 json 的 `skill` 字段**（Xiodra 2026-11-21 拍板：dsh-gui 有两个分工不同的会话，场景只能挂一个主技能，故只在定位卡里引用）。⛔ 第一判据是 **guest 截图字节数**（2KB=空图 / 24KB=有内容），不是元素 computed background |
| 「某个面板看着不对 / 想确认它到底画出来没」 | `node 工具\面板探针.mjs --panel <面板id>`（一条命令出：标题小字 / webview 尺寸 / guest 截图字节 / guest 文本）。同名 guest 会自动按尺寸认 |
| 「MCP 工具挂了 / 403」 | `node 工具\mcp-iconfont补丁.mjs --check`，再查 `MCP\README.md` 的坑 |
| 「改完怎么验」 | `node 工具\机制体检.mjs`（**35 项**一条命令；`--selftest` 是 27 条反例门禁） |

## 四、标准流程（改一次外壳）

1. 改 `renderer\*` → CDP `location.reload()` 就能看到；
2. 改 `main.js` / `preload.js` → **必须重启整个 Electron**（重启前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`、删 `data\electron-profile`）；
3. 每次改完跑 `node --check` 逐个文件过一遍；
4. 验证只认画面：`node 工具\自检-截图.mjs <out.png> 9222`（Electron 必须带 `--remote-debugging-port=9222`）。

## 五、铁律（每条都是踩过的）

- ⛔ **不许拿"我写进 json / 写进 localStorage 的值"当成功证据** —— 判据只能是画面。
- ⛔ **一块 AI 面板一个分区**；解绑要清 `dsh.sessions.current`，否则自动回上一条（串台事故）。
- ⛔ **改 `main.js` 不重启就以为没生效** —— 曾经为此误判过一整轮。
- ⛔ **读 UTF-8 中文文件必须用 `node` + `fs.readFileSync(f,'utf8')`**，PowerShell 的 `Get-Content` 会按 GBK 解成乱码。
- ⛔ **写 json 必须 UTF-8 无 BOM** —— BOM 会让 `JSON.parse` 抛 `Unexpected token '﻿'`，界面上只显示「场景读不出来」。
- ⛔ **不许改 `console.css`**（dsh-worktable 原值移植件）。
- ⚠ `webview` 的 `partition` **必须在插入 DOM 之前** `setAttribute`，插进去之后设不生效、会静默退化成 default session。
- ⚠ emoji 是否真有字形**必须用真实渲染测宽**（`canvas.measureText` 看不出缺失）；本机 🎛 🎚 🗑 ⚙ 🗂 🖥 🛠 ⌨ 等缺字形。

## 六、多会话

本场景有**两条**常驻会话，靠面板 id 与 `sessionId` 分辨：

| 面板 id | 面板标题 | 会话名 | 干什么 |
|---|---|---|---|
| `dsh-gui-chat` | GUI改造 | GUI改造 | 外壳（`外壳\`）的改造与排障 |
| `dsh-gui-p3` | DSH改造 | DSH改造 | 引擎侧接线 / 协议核对 |

两条会话**绝不能同名**（`pinTarget` 首项不同），分区各自独立。改绑定后两个面板都要重建。

## 七、上次进度（一行，随时更新）

- 2026-11-18（DSH改造）：① 机制层照搬（`08-`）② 规矩层照搬（`05-`）③ 接入 MCP iconfont（`mcp__iconfont__search_icons`，vendor + 补丁 + bundle）。
  验收：`机制体检.mjs` 12/12；对照表 `05-协作与规矩\00-照搬状态.md`、`08-升级与改造清单\00-照搬状态.md`。

---

> 冲突时以**场景记忆与技能**为准，本卡只做导航；发现不一致就顺手把本卡改对。
