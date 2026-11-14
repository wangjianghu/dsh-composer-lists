# dsh-composer-lists

[![CI](https://github.com/wangjianghu/dsh-composer-lists/actions/workflows/ci.yml/badge.svg)](https://github.com/wangjianghu/dsh-composer-lists/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-composer-lists)](https://www.npmjs.com/package/dsh-composer-lists)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**一键把粗糙的想法改写成结构化的 Agent 提示词**，再把输入框变成顺手的多级列表编辑器。Turn a rough idea into a structured agent prompt in one click — plus ordered/unordered list editing in the DSH composer.

## ✨ AI 提示词结构化改写（核心功能）

写 Agent 提示词最耗时的不是措辞，是结构：目标、步骤、约束混成一团，模型只能猜。点一下输入框旁的 ✨，当前草稿会被改写为「**一句话任务目标 + 有序步骤列表（含子层级）+ 无序约束与验收标准**」的结构化提示词——正是 Agent 最容易准确执行的形态。

改写效果示例 / What the rewrite looks like:

```text
✨ 改写前                                          改写后 ↩
帮我做个周报，要包含这周做了什么，              1. 生成本周工作周报，按项目分组。
下周的计划，还有些数据要整理一下，                 1. 汇总本周各项目进展与关键结果；
老板喜欢看图表，别太长                            2. 整理下周计划，标注优先级。
                                              - 输出包含进度图表，正文控制在 500 字内；
                                              - 只使用草稿中提到的事实，不补充假设。
```

工程上为「点一下就完事」做了完整闭环：

- **一键撤销**：改写完成后 ✨ 变 ↩，一键恢复原文；手动编辑过结果后撤销自动退场，绝不吞你的修改
- **跨模型自适应**：自动选用当前默认模型自己声明的**最轻思考档**（改写不需要推理，速度从十几秒降到 2–5 秒；模型未声明档位则自动跳过）
- **自愈与防护**：思考耗尽生成预算时自动加倍重试；请求 90 秒硬超时，优化中按 Esc 立即中止；草稿含引用/命令 chip 时自动禁用；无意义输入（过短、纯符号、复读）直接拦截
- **透明失败**：出错时明确提示原因（超时/模型拒绝/无可用模型），输入框永不锁死

## 列表编排（第二能力）

结构化提示词里全是列表——所以输入框本身也需要顺手的列表编辑。遵循 DSH 原生按键（Enter 发送、⌘Enter 加速发送不改动）：

| 手势 | 行为 |
|---|---|
| **Shift+Enter** | 列表行内换行并自动续号（沿用当前行样式）；空项上按 = 退出列表 |
| **Backspace** | 光标紧跟标记后：二级及更深 → 升一级（`b. `→`2. `，光标停在当前行）；一级 → 整个标记一步删掉；空项 → 退出 |
| **← / →** | 标记前缀作为一步跨过（标记右侧 ← 一次到行首，行首 → 一次到标记右侧） |
| **⌘← / Home** | 跳到行首；列表行落在标记右侧，再按到最左 |
| **Tab / Shift+Tab** | 降 / 升一级，所在块按新层级重排样式与编号；层级改变时光标保持原字符位置 |
| **⌘⇧8 / ⌘⇧7** | 当前行或选中行：加无序 / 有序标记；再按取消 |
| **⌘⇧B** | 选中文本加 `**粗体**`（⌘B 被 DSH 菜单占用） |
| 输入/删除/粘贴 | 有序编号自动重排；手改编号不会被覆盖 |

默认六级样式：有序 `1.` → `a.` → `①` → `(1)` → `α.` → `1.`，无序 `- * + • ○ ▪`；每层可在 ⚙ 设置中自定义，缩进宽度 2/4/8 可选。手写 `a.` `α.` `(3)` `①` 同样被识别并参与重排。

## 安装 / Install

```sh
dsh plugin add dsh-composer-lists
```

Requires dsh 0.2.1+. 已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 市场目录 / listed in the plugin catalog. 刷新页面生效。

AI 改写使用你当前配置的默认模型，经 Host 本地路由（`POST /composer-lists/optimize`）完成，不引入额外密钥或第三方服务。

## 开发 / Development

```sh
node test-pure.cjs   # 8000+ 断言：纯函数回归 + 确定性混沌测试
node test-host.cjs   # Host 路由集成测试（假 req/res 驱动）
node bench-pure.cjs  # 性能基准（每按键路径 <1ms）
```

改 `client.js` 后停用→启用插件即同步页面；改 `index.js`（Host 半）需重启 dsh。

## License

[MIT](./LICENSE)
