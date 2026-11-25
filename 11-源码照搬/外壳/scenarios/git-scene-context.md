# 代码仓库 · 定位卡

> 开场读一次就够，一屏以内。只做**导航与进度**：细则进技能、决策进场景记忆。

## 一、身份与职责

| 项 | 值 |
|---|---|
| 场景 id | `git-scene` |
| 面板 id / 标题 | `git-scene-chat` · `AI 对话`（另有文件管理 / 预览 / 占位共 4 块，见 §二） |
| 会话名（pinTarget 首项） | `GitHub 仓库拉取与提交职责` |
| 会话 id | 见 `外壳\scenarios\_场景身份索引.md` 的 `git-scene` 行（⛔ 本卡不写明文 id：发布前红线会判 `发布前检查` 命中 session id） |
| 主技能 | （暂无 —— 需要时在场景 json 里挂 `skill` 字段） |
| 场景记忆 | `引擎数据\.dsh\场景记忆\代码仓库\场景私有记忆.md` |

**我负责**：这台机器上的**代码仓库日常操作** —— 拉取 / 提交 / 分支 / 冲突处理，
以及「代码仓库」这个场景的面板布局（文件管理 + 预览 + AI 会话）。

**我不负责**：外壳渲染器 / 主进程 / 样式（`归属.mjs` 判 **C 档**，归 `DSH·GUI` 的 GUI改造，我只派单）；
引擎源码（上游，⛔ 一个字不改）；别的场景的活。

## 二、资产地图

| 资产 | 位置 | 性质 |
|---|---|---|
| 场景配置 | `外壳\scenarios\git-scene.json` | 可改（D 档，含面板三字段） |
| 本定位卡 | `外壳\scenarios\git-scene-context.md` | 可改（D 档） |
| 场景记忆 | `引擎数据\.dsh\场景记忆\代码仓库\` | 可改（D 档，只写自己这份） |
| 面板渲染器 | `外壳\renderer\renderers.js` → `renderFile` / `renderView`（file / view 两类） | ⛔ **C 档**，只提需求 |
| 面板样式 | `外壳\renderer\console-panel.css` | ⛔ **C 档**，只提需求 |
| 主进程只读通道 | `外壳\main.js` → `fs:roots` / `fs:list` / `fs:readText` / `fs:stat` | ⛔ **C 档**，只提需求 |

**当前面板布局**（2026-11-23 按用户草图重排，3 列）：

| # | 面板 | 类型 | 位置 | 说明 |
|---|---|---|---|---|
| 01 | 文件管理 | `file` | col1 row1 w1 h6 | 满高；`cwd` = `D:\Xiodra Worktable`（⛔ 还没定到具体仓库目录，用户暂未指定） |
| 02 | 预览 | `view` | col2 row1 w1 h6 | 满高；`homeFolders` 同上 |
| 03 | 窗口1 | `placeholder` | col3 row1 w1 h4 | **占位格**，用户自己再配类型 |
| 04 | AI 对话 | `harness` | col3 row5 w1 h2 | 右下角会话窗；已绑定 `GitHub 仓库拉取与提交职责` |

## 三、触发词 → 去哪

| 用户说什么 | 我去哪 |
|---|---|
| 「拉一下 / 更新代码 / pull」 | 本场景 AI 面板；仓库目录见 §二 的 `cwd`（⚠ 还没定到具体仓库，先问清是哪个） |
| 「提交 / commit / push」 | 同上；**先看 `git status` 再动手**，⛔ 不擅自 `push --force` |
| 「有冲突 / merge 报错」 | 同上；先列冲突文件再决定，⛔ 不擅自 `--abort` 丢别人的改动 |
| 「文件管理 / 预览看不到东西」 | 先确认 `cwd` / `homeFolders` 指对了没；面板本身是 C 档，坏了就派单 |
| 「换布局 / 面板类型不对」 | 场景 json 是 D 档可改（`外壳\scenarios\git-scene.json`）；渲染器坏了 → 派单 |
| 「面板不好用 / 想加个功能」 | 先 `node 工具\归属.mjs <路径> --我已经是 代码仓库`；C 档 ⇒ `node 工具\派单.mjs --to dsh-gui --panel dsh-gui-chat` |

## 四、标准流程（要改外壳 → 派单给 GUI改造）

1. 先判归属：`node 工具\归属.mjs <文件路径> --我已经是 代码仓库`（五档；C 档不许改）。
2. 写**四件套**派单：现象（可观察）/ 照哪做（文件+行号）/ 怎么验（命令+画面判据）/ 回一句。
3. **必须真投递**：`node 工具\派单.mjs --to dsh-gui --panel dsh-gui-chat --from 代码仓库 "…"`。
4. 对方改完 ⇒ **我自己验画面**（`node 工具\自检-截图.mjs <out.png> 9222` + CDP 读 DOM），
   不拿"他说改好了"当结论。

## 五、已知坑

- **工作台根目录本身就是一个 git 仓库**（2026-11-23 实测更正）：
  `D:\Xiodra Worktable` → `git@github.com:Xiodra/Xiodra-Worktable.git`，分支 `main`，HEAD `e3f9284`。
  本机共**两个**仓库：本根（我们自己的公开仓）+ `11-源码照搬\引擎`（上游 dsh，只读不改）。
- **⛔ `git add -A` 是雷**：空跑扫进 **639** 条真实条目
  （`12-版本` 334 / `11-源码照搬` 241 / `99-工作区` 57 / 其余 7），含 `12-版本` 的 rc1/rc2 整份拷贝、
  以及**全部场景私有记忆**（别人的 E 档）。凭据与会话已被 `.gitignore` 挡住，但记忆与版本包没有
  （`git check-ignore` 对 `场景私有记忆.md` 返回 exit=1）。
  ⇒ 提交前逐条 `git add <路径>`，⛔ 不用 `-A`。
- **远端通道：走 SSH，已验通**（2026-11-23 更正，**原卡写「SSH 不可用」是错的**）：
  `git ls-remote origin` exit=0；`ssh -p 443 git@ssh.github.com` 回 `Hi Xiodra! You've successfully authenticated`。
  代理是 `~/.ssh/config` 的 `ProxyCommand connect -S 127.0.0.1:10808`，
  `connect.exe` 在 `C:\Program Files\Git\ucrt64\bin\`（不在 PATH 上但 ssh 找得到）。
  ⛔ 先前那句 `couldn't create signal pipe` 是**沙箱受限模式的症状**，不是机器限制 ——
  **别把环境症状写成机器事实**，那会让下一任永远绕开一条能走的路。
  仍为真：全局 `url.https://kgithub.com/.insteadof` 把 https 改写到连不上的镜像，走 https 要加 `:443` 绕开。
- **占位格 `窗口1`** 是用户留着自己配的，⛔ 别替他选类型。
- **仓库已定**：工作台根 `D:\Xiodra Worktable` 本身就是本场景要操作的仓
  （origin `git@github.com:Xiodra/Xiodra-Worktable.git`，分支 `main`，HEAD `e3f9284` = 远端）。
  文件管理面板 `cwd` 已指向它。⛔ 另注：`11-源码照搬\引擎` 是**另一个**仓库（上游 dsh，只读）。
