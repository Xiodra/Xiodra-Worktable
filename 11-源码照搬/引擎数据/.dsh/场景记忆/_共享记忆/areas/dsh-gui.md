# DSH·GUI

- 场景 id：dsh-gui
- 负责：外壳本体（顶栏/场景体系/面板渲染器/主题/壁纸）的改造与排错，**以及工作台的"规矩层"**（`工具\*.mjs` 里的体检/派单/回执/归属/索引这几件）。两条常驻会话：GUI改造（主）、DSH改造（副）。
- 不碰什么：⛔ 不碰引擎源码（`引擎\` 是上游）；⛔ 不碰别的场景的记忆；⛔ 两条会话绝不共用分区或同名；⛔ 不改 `console.css`（原值移植件）。
- 记忆：`场景记忆\DSH·GUI\场景私有记忆.md`
- 定位卡：`外壳\scenarios\dsh-gui-context.md`
- 主面板：`dsh-gui-p3`（DSH改造）
- 两条面板：`dsh-gui-chat`（GUI改造，主）｜ `dsh-gui-p3`（DSH改造，副）
- 工具地盘（C 档，见 `工具\归属.mjs`）：`工具\*.mjs`、`外壳\main.js|preload.js|renderer\`、`config.json`
