# dsh-composer-lists

**English** · Ordered/unordered list editing for the DeepSeek Harness (DSH) message composer: automatic numbering and renumbering across six marker styles, marker-aware caret moves, level promotion/demotion, a natural blank-line flow (exit a list, then keep pressing Shift+Enter to add blank lines one by one), and a one-click AI prompt-polish button that rewrites your draft into structured lists via the host's model — fully undoable.

**中文** · DSH 聊天输入框的列表编排插件。输入框工具行保留 ✨（AI 优化提示词，可在设置中隐藏）和 ⚙（设置）两个小图标，其余全部走快捷键。

## 行为（遵循 DSH 原生按键）

| 手势 | 行为 |
|---|---|
| Enter | 发送（原生，不改动） |
| ⌘/Ctrl+Enter | 加速发送（原生，不改动） |
| **Shift+Enter** | 列表行内换行并自动续号（沿用当前行样式：`1.`→`2.`、`a.`→`b.`、`①`→`②`）；空列表项上按 = 退出列表并空出 1 行，光标落在空行的下一行；之后继续按每按多空一行（光标逐行下移）；仅当全稿只有这一个空列表项时清空整稿。光标被用户主动移回列表行行尾（点击/方向键）再按则恢复续号 |
| **Backspace** | 光标紧跟标记后：**二级及更深 → 升一级**（当前行去掉一级缩进、标记换上级样式并接续编号，光标定位到新标记右侧，如 `b. `→`2. `）；一级 → 整个标记一步删掉；空列表项 → 删整行并入上一行行尾 |
| **Tab / Shift+Tab** | 仅列表行：降 / 升一级层级，所在块自动按新层级重排样式与编号（`1.`→Tab→`a.`→Tab→`①`；无序符号同样随层级切换）；多行选中批量 |
| **⌘⇧8 / ⌘⇧7** | 当前行或选中行：加无序 / 有序标记；再按取消；可反复循环；折叠光标保持在原字符位置（有序编号延续上下文并连后续行一起重排，并入同一次编辑，不触发二次重排挪动光标） |
| **← / →** | 标记前缀（缩进+编号/符号+空格）作为一步跨过：标记右侧按 ← 一次到行首，行首按 → 一次到标记右侧 |

## AI 优化提示词（✨ 按钮，可隐藏）

一个按钮三种状态：**✨ 闪烁星图标**（点击优化，当前草稿发送给 Host 侧的 `POST /composer-lists/optimize`，由当前默认模型改写为「任务目标 + 有序步骤 + 无序约束」的结构化列表并替换输入框内容）→ **优化中**（图标脉动、按钮禁用）→ **↩ 撤销图标**（点击一键恢复优化前原文；手动编辑过优化结果后撤销自动退场，不会吞掉你的修改）。草稿为空、发送锁定或含引用 chip 时按钮禁用/跳过。⚙ 设置里可关闭「显示提示词优化按钮」。

稳定性保障：优化请求 **90 秒硬超时**，超时自动取消并解锁输入框；优化进行中按 **Esc 可立即中止**；飞行途中切换会话导致草稿变化时，改写结果会被丢弃而不是写入新会话。Host 侧检测客户端断连即停止模型流，provider 卡流 120 秒强制超时，不会悬挂 handler。

## 层级样式（默认，⚙ 中可自定义）

| 层级 | 有序 | 无序 |
|---|---|---|
| 一级 | `1. 2. 3.` | `-` |
| 二级 | `a. b. c.` | `*` |
| 三级 | `① ② ③` | `+` |
| 四级 | `(1) (2) (3)` | `•` |
| 五级 | `α. β. γ.` | `○` |
| 六级 | `1. 2. 3.` | `▪` |

每层有序样式可选：阿拉伯 `1.`、字母 `a.`、希腊 `α.`、括号 `(1)`、圆圈 `①`；无序符号可选 `- * + • ○ ▪ –`；缩进宽度 2/4/8 空格；另有「有序编号自动重排」和「显示提示词优化按钮」开关。设置存浏览器 localStorage（键 `dsh.composerLists`），即时生效。

手写 `a.` `α.` `(3)` `①` 同样被识别为有序列表并参与自动重排（重排归一为层级样式；续号沿用当前行样式）。

## 实现说明

- 客户端所有编辑经会话槽位 props 的 `inputActions.insertText / setDraft`（一次手势 = 一步撤销）。
- 编辑前从编辑器 DOM 重建 detect 投影（文本 span 递归取文本、`contenteditable="false"` 的原子 chip 计 1 个 U+FFFC、空段落的占位 `<br>` 计空串）并与 `InputState.draft` 比对；含引用 chip / 命令 chip / 引用块时键盘编排自动停用。
- Host 半（index.js）：`inject: ['llm']`，软注入 `webServer` 注册优化路由，模型取 `agentDefaultModel.currentSelection()`（缺省回退第一个 provider），`ctx.llm.stream` 流式拼接文本；输入限 64KB，请求体限 256KB，跨域 Origin 按完整 host 精确比对拒绝。
- 触发菜单（`/`、`@` 补全）打开时不拦截任何键；IME 组词期间不处理按键。
- 测试：`node test-pure.cjs`（纯函数回归 + 400 轮确定性混沌：计划边界、重排幂等、不抛异常）；`node bench-pure.cjs`（纯层性能基准，实测每按键路径 ≤0.03ms@50 行 / 0.73ms@2000 行压力档）。

## 安装

```bash
# npm 安装（推荐）
npm install -g dsh-composer-lists
# 或在 DSH 工作区内经 plugin_manager install_bundle 安装本仓库目录
```

本地开发：克隆后改代码，用 `set_plugin` 停用→启用一次即可同步到页面（或刷新页面）；`node test-pure.cjs && node test-host.cjs` 全绿再提交。
