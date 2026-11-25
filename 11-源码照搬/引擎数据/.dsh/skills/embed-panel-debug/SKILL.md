---
name: embed-panel-debug
description: 【排障技能】内嵌网页/embed 面板白屏、闪空、透壁纸、内容不显示时的排查套路。核心判据是 guest 截图字节数，⛔ 不看元素 computed background。触发词：「embed 白屏」「webview 闪空」「内嵌网页透壁纸」「DeepSeek 面板空白」「guest 截图」。
---

# embed 面板排障（内嵌第三方站点）

> 这套判据是 2026-11-19~21 追同一个 embed 面板故障**修了三轮**后沉淀的。
> 三轮里我误判过一次（把"元素底色变了"当成"内容画出来了"），所以第一条判据特意写成反面。

## 一、⛔ 第一判据：看 guest 截图字节数，不看元素属性

```powershell
node 工具\面板探针.mjs --panel <面板id> --shot 外壳\captures\probe.png
```

输出里的 **④ guest 截图：约 X KB** 才是"内容画出来没有"的证据：

| 截图字节数 | 含义 |
|---|---|
| 约 2 KB（实测 2103） | **纯灰空图 ⇒ 内容没画出来** |
| 约 24 KB（实测 24409） | 有内容 |
| 0 KB | target 没起来 / 截不到 |

⛔ **不许用 `getComputedStyle(wv).background` 当判据。**
   元素底色改成不透明只说明**壳**对了，不说明 **guest 页**画出来了。这两件事会同时"看起来对"但结果相反。

## 二、30 秒定性实验

把 webview 元素底色临时改成纯红：

```js
const wv = document.querySelector('webview');
wv.style.background = '#ff0000';
```

- **整片变红** ⇒ 你看到的是**元素底色**，guest 内容没画（去查 §三 的根因）
- **只有边变红、中间还是原样** ⇒ guest 在画，问题在别处（尺寸/滚动/遮挡）

## 三、两个已知根因位置（都验证过）

| # | 文件 | 具体位置 | 症状 |
|---|---|---|---|
| 1 | `外壳\renderer\styles.css` | `body.has-wallpaper .harness-webview, .ai-webview, .webai-webview { background: transparent; }` | **`.web-view`（embed 面板）不该在这条里**。它在里面 ⇒ 合成层重绘（打开/reload/展开/切场景）时透明区透出壁纸，内容"闪掉" |
| 2 | `外壳\renderer\theme.js` | `ENGINE_WP_CSS`（注入引擎页的透明样式） | 如果这段被注入到**第三方站点**（DeepSeek 等）⇒ 站点自己的底色被抹掉，跟着壁纸透出来 |

**修法**：embed/web 类面板必须保留不透明底色
（`body.has-wallpaper .web-view { background: var(--bg) !important; }`），
因为内嵌第三方站点本来就该有自己的底色，透壁纸没有意义。

## 四、踩过的坑（别重犯）

1. **同场景可能有 2 个同名 guest target**（比如自己 + 别人同 URL）。
   必须按 `innerWidth × innerHeight` 认，不是按标题认。
   `面板探针` 已内置这一步（按尺寸差排序）。
2. **"索引只显示了 8 个词" ≠ "只存了 8 个"** —— 别看到展示层就下结论。
3. 改 `renderers.js` / `styles.css` 可热更新（`node 工具\刷新面板.mjs all`）；
   改 `main.js` / `preload.js` **必须重启 Electron**。

## 五、验收

- `node 工具\面板探针.mjs --panel <id>`：④ 字节数 > 20 KB 才算有内容
- **判据只认画面**：`外壳\captures\*.png` 截图 + 面板标题行小字
- 四条动作全过才算修好：打开 30 秒不空 / 展开收起不消失 / ⟳ 重载正常 / 切场景回来正常
