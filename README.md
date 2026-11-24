# dsh-composer-lists

**English** · Ordered/unordered list editing for the DeepSeek Harness (DSH) message composer: automatic numbering and renumbering across six marker styles, marker-aware caret moves, level promotion/demotion, a natural blank-line flow (exit a list, then keep pressing Shift+Enter to add blank lines one by one), and a one-click AI prompt-polish button that rewrites your draft into structured lists via the host's model — fully undoable. The caret stays on your line while lists renumber, and renumbering never fights undo.

**中文** · DSH 聊天输入框的列表编排插件。输入框工具行保留 ✨（AI 优化提示词，可在设置中隐藏）和 ⚙（设置）两个小图标，其余全部走快捷键。

## What it does (English summary)

| Gesture | Behaviour |
|---|---|
| **Shift+Enter** | New line inside a list with the next marker (`1.`→`2.`, `a.`→`b.`, `①`→`②`); on an empty item it exits the list, leaving one blank line with the caret on the line below; keep pressing to add one blank line per press |
| **Backspace** right after a marker | Level 2+ → promote one level; level 1 → delete the marker; empty item → remove the line |
| **Tab / Shift+Tab** | Demote / promote one level; the whole block restyles and renumbers, and the caret stays on its line |
| **⌘⇧8 / ⌘⇧7** | Toggle a bullet / ordered list on the current line or selection; press again to remove |
| **← / →** | Hop over the marker prefix in one step |
| **⌘/Ctrl+Z** | Auto-renumbering never fights undo: deleting a middle item renumbers at once and keeps the caret, and undo restores what you had |
| ✨ button | AI prompt polish: the host's default model rewrites the draft into structured lists (goal + ordered steps + constraints); undoable, 90 s hard timeout, Esc cancels |

It only ever drives its own DSH composer — never another editor on the page. The sections below are in Chinese.

## 行为（遵循 DSH 原生按键）

| 手势 | 行为 |
|---|---|
| Enter | 发送（原生，不改动） |
| ⌘/Ctrl+Enter | 加速发送（原生，不改动） |
| **Shift+Enter** | 列表行内换行并自动续号（沿用当前行样式：`1.`→`2.`、`a.`→`b.`、`①`→`②`），光标落在新行标记右侧；列表中段续号时，后面各行随之顺延的编号在同一次按键里完成，光标不会跳走。空列表项上按 = 退出列表并空出 1 行，光标落在空行的下一行；之后继续按每按多空一行（光标逐行下移）；仅当全稿只有这一个空列表项时清空整稿。光标被用户主动移回列表行行尾（点击/方向键）再按则恢复续号 |
| **Backspace** | 光标紧跟标记后：**二级及更深 → 升一级**（当前行去掉一级缩进、标记换上级样式并接续编号，光标定位到新标记右侧，如 `b. `→`2. `）；一级 → 整个标记一步删掉；空列表项 → 删整行并入上一行行尾 |
| **Tab / Shift+Tab** | 仅列表行：降 / 升一级层级，所在块自动按新层级重排样式与编号（`1.`→Tab→`a.`→Tab→`①`；无序符号同样随层级切换），**光标始终留在当前行**；多行选中批量 |
| **⌘⇧8 / ⌘⇧7** | 当前行或选中行：加无序 / 有序标记；再按取消；可反复循环；折叠光标保持在原字符位置（有序编号延续上下文并连后续行一起重排，并入同一次编辑，不触发二次重排挪动光标） |
| **← / →** | 标记前缀（缩进+编号/符号+空格）作为一步跨过：标记右侧按 ← 一次到行首，行首按 → 一次到标记右侧 |
| **⌘/Ctrl+Z 撤销** | 自动重排不跟撤销作对：删除列表中间某项后编号立即顺延、光标停在原行；按撤销回到的是你删之前的样子，重做则重新顺延 |

只在 DSH 输入框内生效：页面上其它可编辑区域（别的编辑器、行内输入框）里的按键不会被接管，也不会改动输入框草稿。

## AI 优化提示词（✨ 按钮，可隐藏）

一个按钮三种状态：**✨ 闪烁星图标**（点击优化，当前草稿发送给 Host 侧的 `POST /composer-lists/optimize`，由当前默认模型改写为「任务目标 + 有序步骤 + 无序约束」的结构化列表并替换输入框内容）→ **优化中**（图标脉动、按钮禁用）→ **↩ 撤销图标**（点击一键恢复优化前原文；手动编辑过优化结果后撤销自动退场，不会吞掉你的修改）。草稿为空、发送锁定或含引用 chip 时按钮禁用/跳过。⚙ 设置里可关闭「显示提示词优化按钮」。

稳定性保障：优化请求 **90 秒硬超时**，超时自动取消并解锁输入框；优化进行中按 **Esc 可立即中止**（焦点已落到页面上时同样有效）；连点只发一个请求；切换会话或停用插件会立即中止进行中的优化并解锁输入框，飞行途中草稿若被外部改动，改写结果会被丢弃而不是覆盖。Host 侧检测到浏览器断连或模型卡流（120 秒无输出）时，取消的是 **provider 请求本身**，不会留下僵尸请求；模型输出被截断或异常结束时按失败处理，不会拿半截结果替换整稿。

已知取舍：一次手势若包含「后面各行顺延」的两处编辑，就是两步撤销（宿主按每次编辑记一步），撤销时会先回到一个中间状态；最终都能回到操作前。

## 层级样式（默认，⚙ 中可自定义）

| 层级 | 有序 | 无序 |
|---|---|---|
| 一级 | `1. 2. 3.` | `-` |
| 二级 | `a. b. c.` | `*` |
| 三级 | `① ② ③` | `+` |
| 四级 | `(1) (2) (3)` | `•` |
| 五级 | `α. β. γ.` | `○` |
| 六级 | `1. 2. 3.` | `▪` |

每层有序样式可选：阿拉伯 `1.`、字母 `a.`、希腊 `α.`、括号 `(1)`、圆圈 `①`；无序符号可选 `- * + • ○ ▪ –`；缩进宽度 2/4/8 空格；另有「有序编号自动重排」和「显示提示词优化按钮」开关。设置存浏览器 localStorage（键 `dsh.composerLists.settings`），即时生效。

手写 `a.` `α.` `(3)` `①` 同样被识别为有序列表并参与自动重排（重排归一为层级样式；续号沿用当前行样式）。手改编号（如把 `2.` 改成 `7.`）不会被打断；之后任何内容编辑、粘贴整行列表项或删除整行都会即时重排。

## 实现说明

- 客户端所有编辑经会话槽位 props 的 `inputActions.insertText / setDraft`。
- 编辑前从编辑器 DOM 重建 detect 投影（文本 span 递归取文本、`contenteditable="false"` 的原子 chip 计 1 个 U+FFFC、空段落的占位 `<br>` 计空串）并与 `InputState.draft` 比对；含引用 chip / 命令 chip / 引用块时键盘编排自动停用。
- 光标与撤销：宿主的 `insertText` 总把光标放到插入文本末尾，且每次调用是独立的一步撤销。因此每个手势都按「先改光标右侧的行、最后落光标所在的那次编辑」的顺序应用，自动重排也折进同一组编辑；自动重排不响应撤销（Cmd/Ctrl+Z、编辑菜单「撤销」），重做时才重新收敛。
- 作用域：按键监听挂在 document 捕获阶段，只认领自己所在 composer（宿主 InputBar 卡片）内的可编辑区；同一输入框即使被重复注册也只有一个实例生效。
- Host 半（index.js）：`inject: ['llm']`，软注入 `webServer` 注册优化路由，模型取 `agentDefaultModel.currentSelection()`（缺省回退第一个 provider），`ctx.llm.stream` 流式拼接文本并传入取消信号；输入限 64KB，请求体限 256KB，跨域 Origin 按完整 host 精确比对拒绝。这些调用不声明任何工具；`toolChoice: 'none'` 仅作为向前兼容的提示传入（当前 DSH 的适配器未声明该选项，实际生效的是「不声明工具 + 模型仍调用工具时带禁工具提示重试一次」）。
- 触发菜单（`/`、`@` 补全）打开时，可被接管的键（Enter/Backspace/Tab/方向键/Home 及 ⌘⇧组合）不拦截；IME 组词期间不处理按键；普通字符键不做任何 DOM 遍历。
- 测试：`node test-pure.cjs`（纯函数回归 + 两套确定性混沌：计划边界、重排幂等、字符守恒、编辑集合收敛）；`node test-runtime.cjs`（真实 Runtime 组件的按键序列：草稿 / 光标 / 每键编辑次数、撤销与重做、作用域、优化流程的中止与解锁）；`node test-host.cjs`（Host 路由：信任栏、重试、取消信号、截断输出）。
- 性能：`node bench-pure.cjs`。纯层实测（同机对照）重排 0.016ms@50 行 / 0.15ms@500 行 / 0.6ms@2000 行，Tab 整个手势 0.03ms@50 行；普通打字键不再遍历 DOM。

## 安装

```bash
# npm 安装（推荐）
npm install -g dsh-composer-lists
# 或在 DSH 工作区内经 plugin_manager install_bundle 安装本仓库目录
```

升级后（包括从 1.3.x 或 1.4.0 升到 1.4.1）需要完全退出并重启 DSH：Host 半的改动只在重启后生效。

本地开发：克隆后改代码，用 `set_plugin` 停用→启用一次即同步到页面（Host 半改动需重启 DSH）；`node --check client.js index.js && node test-pure.cjs && node test-runtime.cjs && node test-host.cjs` 全绿再提交。
