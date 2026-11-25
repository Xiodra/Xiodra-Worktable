# Xiodra-Worktable · 项目记忆

> 项目 id：`xiodra-worktable`　｜　归属场景：代码仓库（`git-scene`）　｜　建立：2026-11-23
> ⛔ 这是**项目级**记忆（比会话活得久）。进度/下一步写 §〇，决策与新坑追加 §五。

## §〇 当前状态

- 状态：**首推成功，仓库已活**
- 到哪一步：`4242376`（"chore: 删除 64 个方法论文档"）已推到 `origin/main`。
  远端现在**只剩 2 个文件**：`.gitignore` + `88-自我复盘/README.md`。
  本地 HEAD 与远端 sha 一致（`424237619789bddc9e8d8354d81f9a5fea03a2c2`）。
- 下一步：`11-源码照搬`(238) / `12-版本`(334) / `99-工作区`(58) 三块仍未提交，等 Xiodra 定。
- 卡点：无技术卡点。SSH 推送已实测通过。

### 提交历史

| sha | 说明 | 文件 | 行 |
|---|---|---|---|
| `e3f9284` | 项目初始化（远端原有） | — | — |
| `77db934` | 补方法论正文与照搬状态记录 | 7 | +932 / -3 |
| `e2be0e7` | 更新清单.md 移出版本控制 | 2 | +4 / -176 |
| `4242376` | 删除 64 个方法论文档 | 64 | -14710 |

## §一 仓库事实（2026-11-23 实测）

| 项 | 值 |
|---|---|
| 本地根 | `D:\Xiodra Worktable` |
| remote origin | `git@github.com:Xiodra/Xiodra-Worktable.git` |
| 分支 / 上游 | `main` → `origin/main` |
| 本地 HEAD | `e3f9284` 项目初始化 |
| 远端 main | `e3f9284`（`git ls-remote origin` exit=0，2 行：HEAD + refs/heads/main） |
| 可见性 | public（GitHub API 查到 `"private":false`，`default_branch: main`） |
| 本机另一个仓库 | `11-源码照搬\引擎` → `deepseek-ai/deepseek-harness`（**上游，只读**） |

## §二 通道（实测，别再凭记忆判）

| 通道 | 状态 | 证据 |
|---|---|---|
| **SSH** | ✅ **可用** | `git ls-remote origin` exit=0；`ssh -p 443 git@ssh.github.com` 回 `Hi Xiodra! You've successfully authenticated` |
| SSH 走的代理 | `~/.ssh/config` 的 `ProxyCommand connect -S 127.0.0.1:10808` | `ssh -v` 打出 `Executing proxy command: exec connect -S 127.0.0.1:10808 ssh.github.com 443` |
| `connect.exe` 位置 | `C:\Program Files\Git\ucrt64\bin\connect.exe`（87,617 B） | 不在 PATH 上，但 ssh 能找到 |
| https://github.com | ⚠ 被全局 `url.https://kgithub.com/.insteadof` 改写到 kgithub，镜像已连不上 | `ls-remote https://…` 报 21 秒超时 |
| `https://github.com:443` | ✅ 可读 | 绕开改写后拿到 sha |

**结论：推送走 SSH 即可，不需要 PAT。**（2026-11-23 更正，原判断"SSH 不可用"是错的）

## §三 提交纪律

1. ⛔ **不用 `git add -A`**：空跑实测会扫进 **637** 条真实条目
   （`12-版本` 334 / `11-源码照搬` 238 / `99-工作区` 58 / 其余 7）。
2. ✅ 逐条 `git add <路径>`，然后 `git diff --cached --stat` 复核。
3. 提交前必须确认暂存区**不含**：`.credentials.yaml`、`sessions/`、`引擎数据/.dsh/场景记忆/<别的场景>/`、`12-版本` 整包。
4. `.gitignore` 已挡住凭据与会话（`11-源码照搬/.gitignore:17` 挡 `.credentials.yaml`，`:10` 挡 `sessions/`），
   但**没挡场景记忆**（`git check-ignore` 对 `场景私有记忆.md` 返回 exit=1）⇒ 记忆文件靠人工把关。
5. ⛔ 不擅自 `push --force`；⛔ 不擅自 `--abort` 丢别人的改动。
6. **⛔ `更新清单.md` 不上传服务器**（Xiodra 2026-11-23 指定）。已在 `.gitignore` 加 `/更新清单.md`，
   并用 `git rm --cached` 移出索引；**本地文件保留**（12808 B，在根目录）。
   理由：那是本机照搬台账（记我们这台机器的改动流水），不是公开方法论正文。
   ⚠ 注意：它曾随 `77db934` 上过远端，`e2be0e7` 已删除；**远端历史里仍能翻到**（未改写历史）。

## §五 决策与坑（只追加）

- **2026-11-23**：本仓是「公开方法 + 纯壳模板」，**不是 DSH 安装包**（`.gitignore` 开头的原话）。
  ⇒ 提交时把运行数据、会话、凭据挡在外面是设计意图，不是可以通融的。
- **2026-11-23**：`11-源码照搬\引擎` 在根仓里以 **gitlink**（嵌套仓库）形式加入，
  `git add` 只记一条 `11-源码照搬/引擎/`，**不会**把那 2.5 GB 塞进根仓。但 git 会打
  `warning: adding embedded git repository`，克隆方拿不到内容（需 `git submodule` 或另行 clone）。
