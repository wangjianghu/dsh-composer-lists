# dsh-composer-lists

DSH（DeepSeek Harness）聊天输入框的列表编排插件：自动续号与重排、标记感知的光标移动、层级升降，以及一个可撤销的 AI 提示词优化按钮。

Ordered/unordered list editing for the DeepSeek Harness message composer: automatic numbering and renumbering, marker-aware caret moves, level promotion, and an undoable AI prompt-polish button.

## 安装 / Install

```sh
dsh plugin add dsh-composer-lists
```

Requires dsh 0.2.1+. 刷新页面后生效 / takes effect after a page refresh.

## 行为 / Behavior

遵循 DSH 原生按键约定（Enter 发送、⌘Enter 加速发送均不改动）：

| 手势 | 行为 |
|---|---|
| **Shift+Enter** | 列表行内换行并自动续号（沿用当前行样式：`1.`→`2.`、`a.`→`b.`、`①`→`②`）；空列表项上按 = 退出列表并入上一行行尾（不留空行） |
| **Backspace** | 光标紧跟标记后：二级及更深 → 升一级（如 `b. `→`2. `，光标停在新标记右侧）；一级 → 整个标记一步删掉；空列表项 → 删整行并入上一行行尾 |
| **← / →** | 标记前缀（缩进+编号/符号+空格）作为一步跨过：标记右侧按 ← 一次到行首，行首按 → 一次到标记右侧 |
| **⌘← / Home** | 跳到行首；列表行落在标记右侧，再按一次到最左 |
| **Tab / Shift+Tab** | 仅列表行：降 / 升一级，所在块按新层级重排样式与编号；多行选中批量 |
| **⌘⇧8 / ⌘⇧7** | 当前行或选中行：加无序 / 有序标记；再按取消，可反复循环 |
| **⌘⇧B** | 选中文本加 `**粗体**`（⌘B 被 DSH 菜单占用，无法到达页面） |
| 输入/删除/粘贴 | 有序编号自动重排（多行块内顺序归一；手改编号不会被覆盖） |

## 层级样式（默认，⚙ 中可自定义）

| 层级 | 有序 | 无序 |
|---|---|---|
| 一级 | `1. 2. 3.` | `-` |
| 二级 | `a. b. c.` | `*` |
| 三级 | `① ② ③` | `+` |
| 四级 | `(1) (2) (3)` | `•` |
| 五级 | `α. β. γ.` | `○` |
| 六级 | `1. 2. 3.` | `▪` |

每层有序样式可选 `1.` / `a.` / `α.` / `(1)` / `①`，无序符号可选 `- * + • ○ ▪ –`，缩进宽度 2/4/8，另有自动重排与优化按钮开关。手写 `a.` `α.` `(3)` `①` 同样被识别并参与重排。设置存于浏览器 localStorage，即时生效。

## AI 提示词优化（✨ 按钮）

点击将当前草稿交由 Host 侧当前默认模型改写为「任务目标 + 有序步骤 + 无序约束」的结构化列表，完成后可一键 ↩ 撤销恢复原文；手动编辑过优化结果后撤销自动退场。请求 90 秒超时、优化中可按 Esc 中止，生成失败有明确提示。

## 实现说明

- 浏览器半挂载于 `conversation.input.left` 槽位，所有编辑经会话 `inputActions.insertText / setDraft`（一次手势 = 一步撤销）
- 含引用 chip / 命令 chip / 引用块时键盘编排自动停用；触发菜单（`/`、`@`）打开时不拦截按键；IME 组词期间不处理
- Host 半注册 `POST /composer-lists/optimize` 路由：跨域精确校验、请求体 256KB 上限、思考档自动取模型最轻档、断连与卡流超时保护

## 开发 / Development

```sh
node test-pure.cjs   # 纯函数回归 + 确定性混沌测试（7000+ 断言）
node test-host.cjs   # Host 路由集成测试（假 req/res 驱动）
node bench-pure.cjs  # 性能基准
```

改 `client.js` 后用插件管理停用→启用一次即同步页面；改 `index.js`（Host 半）需重启 dsh。

## License

[MIT](./LICENSE)
