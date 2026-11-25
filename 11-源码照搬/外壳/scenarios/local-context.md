# 本地电脑 · 定位卡

> 开场读一次就够，一屏以内。只做**导航与进度**：细则进技能、决策进场景记忆。

## 一、身份与职责

| 项 | 值 |
|---|---|
| 场景 id | `local` |
| 面板 id / 标题 | `local-chat` · `AI 本地电脑`（另有四块数据面板，见 §二） |
| 会话名（pinTarget 首项） | 本地电脑 |
| 会话 id | 见 `外壳\scenarios\_场景身份索引.md` 的 `local` 行（⛔ 本卡不写明文 id：发布前红线会判 `发布前检查` 命中 session id） |
| 主技能 | `pc-cleanup`（`引擎数据\.dsh\skills\pc-cleanup\SKILL.md`） |
| 场景记忆 | `引擎数据\.dsh\场景记忆\本地电脑\场景私有记忆.md` |

**我负责**：这台 Windows 机器的**日常清理与磁盘体检** —— 分区容量、大户排行、可清理项、清理台账四块面板"说得对、数得准"，以及决定"删什么、先删谁"。
**我不负责**：外壳渲染器 / 主进程 / 样式的改动（`归属.mjs` 判 **C 档**，归 `DSH·GUI` 的 GUI改造，我只派单）；引擎源码（上游）；别的场景的活。

## 二、资产地图

| 资产 | 位置 | 性质 |
|---|---|---|
| 场景配置 | `外壳\scenarios\local.json` | 可改（D 档，含面板三字段） |
| 本定位卡 | `外壳\scenarios\local-context.md` | 可改（D 档） |
| 场景记忆 | `引擎数据\.dsh\场景记忆\本地电脑\` | 可改（D 档，只写自己这份） |
| 主技能 | `引擎数据\.dsh\skills\pc-cleanup\SKILL.md` | 可改（D 档） |
| 面板渲染器 | `外壳\renderer\renderers.js` → `renderPcDrives` / `renderPcTopLarge` / `renderPcJunk` / `renderPcLedger` | ⛔ **C 档**，只提需求 |
| 面板样式 | `外壳\renderer\console-panel.css` §6 | ⛔ **C 档**，只提需求 |
| 主进程数据源 | `外壳\main.js` → `sys:disks` / `fs:scan-*` / `pc:junk-scan` / `pc:ledger` | ⛔ **C 档**，只提需求 |
| 垃圾判据（唯一出处） | `工具\垃圾判据.mjs` | ⛔ C 档，只读不改 |

## 三、触发词 → 去哪

| 用户说什么 | 我去哪 |
|---|---|
| 「磁盘满了 / 哪个盘最紧」 | `local-drives` 面板（`sys:disks`）；数字以画面那一行为准 |
| 「哪个目录最占地方」 | `local-toplarge` 面板；先确认它跟随的是哪块盘（标题小字） |
| 「点 C 盘让排行只看 C 盘 / 取消跟随」 | 跨面板联动：真源 `localStorage['xiodra.drive-follow:<场景id>']` + 事件 `xiodra:drive-select` |
| 「哪些能删 / 能不能删」 | `local-junk` 面板；判据唯一出处 `工具\垃圾判据.mjs`，⛔ 不自己立一套 |
| 「删掉了记一下」 | `local-ledger` 面板（`pc:ledger`，只追加不改写） |
| 「面板不好用 / 想加个功能」 | 先 `node 工具\归属.mjs <路径> --我已经是 本地电脑`；C 档 ⇒ `node 工具\派单.mjs --to dsh-gui --panel dsh-gui-chat` |

## 四、标准流程（要改外壳 → 派单给 GUI改造）

1. 先判归属：`node 工具\归属.mjs <文件路径> --我已经是 本地电脑`（五档；C 档不许改）。
2. 写**四件套**派单：现象（可观察）/ 照哪做（文件+行号）/ 怎么验（命令+画面判据）/ 回一句。
3. **必须真投递**：`node 工具\派单.mjs --to dsh-gui --panel dsh-gui-chat --from 本地电脑 "…"`（多会话场景缺 `--panel` 会被拒）。
4. 对方改完 ⇒ **我自己验画面**（`node 工具\自检-截图.mjs <out.png> 9222` + CDP 读 DOM），不拿"他说改好了"当结论。

## 五、铁律（每条都是踩过的）

- ⛔ **报数超过磁盘总容量 = 一定是 bug**，不用看代码（曾出现合计 422 GB 而 C 盘只有 238 GB）。
- ⛔ **`maxDepth: 0` 别经过 `||` 兜底** —— `Number(0) || 2` 会把它变成 2 层，而且不报错。
- ⛔ **判据只能是画面**：面板标题行小字 + 截图；⛔ 不拿"我写进 json / localStorage 的值"当证据。
- ⛔ **限深扫盘的数是假的**（C:\ 一层得 1.73 GB，Users 真实 88.62 GB）⇒ 要真数字只能全量扫。
- ⛔ **C 档文件一个字都不许写**（`renderers.js` / `console-panel.css` / `main.js`），只能派单。
- ⚠ 清理纪律：**先列清单等 Xiodra 点头 → 直接删（无暂存）**。

## 六、多会话

本场景只有一条常驻会话（`local-chat`）。若将来加第二条 AI 面板：
**两条会话必须不同名**（`pinTarget` 首项不能相同），并各自用独立分区 `persist:ai-panel-<面板id>` —— 否则必串台。

### 表外文件登记（`归属.mjs` 判「表外」的，动之前先在这里留一行）

| 路径 | 为什么要碰 | 判据 | 登记日 |
|---|---|---|---|
| `引擎数据\.dsh\cache\attachments\request-images\` | 清理缓存（S4） | 引擎 README：清掉后持久附件不受影响，下次请求会重新生成 | 2026-11-21 |
| `外壳\data\electron-profile\sessions\Cache\` | 清理 Electron HTTP 缓存（S4） | Chromium 缓存，可再生；运行中部分文件被锁 | 2026-11-21 |

> 这两条是**缓存区**（`cache\` / `electron-profile\`），五档表没覆盖 ⇒ 判「表外」。按规矩先登记再动手。
> ⛔ 不动 `引擎数据\.dsh\attachments\`（持久附件 = never）与 `外壳\captures\`（证据 = never）。

## 七、上次进度（一行，随时更新）

- 2026-11-20：跨面板联动已上线并实测通过 —— 点 C 卡 ⇒ 排行只扫 C:\（全量 843,271 文件 / 142.57 GB，Users 88.62 GB 居首）；点 D 卡直接切 D；再点已选中的卡取消；切场景/重启后记住。派单 `7a5f58c15b` / `68dfc63517`（接收方 `dsh-gui · GUI改造`，已销账）。

---

> 冲突时以**场景记忆与技能**为准，本卡只做导航；发现不一致就顺手把本卡改对。
