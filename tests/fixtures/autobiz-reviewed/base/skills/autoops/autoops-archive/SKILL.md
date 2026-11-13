---
name: autoops-archive
description: Ops 归档阶段技能。
version: v1.2.08311
author: zhangQiuFeng
---

## 缺失产物处理
```bash
python -X utf8 "${pluginPath}/hooks/inspect_skill_contract.py" autoops-archive --feature "${feature}" --plain
```

# /autoops-archive — Feature 过程归档

## 目标

在 CI/CD 已由用户确认完成后，将当前 Feature 的过程产物从 active features 目录移动到 archive 目录，并把状态推进到终态。

## 恢复入口
若 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/` 已不存在、`.autobizdevops/archive/{slug}-iter*` 已存在且 `state.json` 为 `archived`，直接提示已归档并退出

调用脚本读取当前 Feature 快照：

```bash
python -X utf8 "${pluginPath}/read_state_json.py" --feature "${feature}"
```

每次需要当前 checkpoint 时，运行上面脚本读取，不得从 `hooks.ndjson` 等其他文件推断。

## 路径约定

| 项目 | 路径 |
|------|------|
| 活跃 Feature 目录 | `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/` |
| 归档根目录 | `${pluginWorkspace}/${projectDir}/.autobizdevops/archive/` |
| 归档目标目录 | `${pluginWorkspace}/${projectDir}/.autobizdevops/archive/{slug}-iter{N}/` |
| 全局状态 | `${pluginWorkspace}/${projectDir}/.autobizdevops/state.json` |

`iter{N}` 的确定规则：

1. 先调用 `python -X utf8 "${pluginPath}/read_state_json.py"` 读取全量 JSON，优先取 `STATE.records[${feature}].iteration`；若为有效数字则作为起始候选。
2. 若迭代列为空或不是数字，则从 `1` 开始。
3. 若 `.autobizdevops/archive/{slug}-iter{N}/` 已存在，递增 N，直到找到不存在的目录。
4. 禁止覆盖、合并或删除已有归档目录。

## 执行步骤

### 前置检查

- 确认 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/` 存在。
- 确认 `.autobizdevops/archive/` 存在；若缺失，无法归档。

### 选择归档目标

1. 按 `iter{N}` 规则计算目标目录。
2. 输出即将归档的源目录和目标目录。
3. 若目标目录已存在，不得覆盖，必须递增 N 后重新选择。

### 更新状态

先更新状态、再移动目录：归档事件的 hook 日志会写入活跃 `features/{slug}/`，先更新可让该日志随目录一并归档，不会在 `features/` 留下空壳目录。

使用统一脚本将当前 Feature 的 checkpoint 推进为 `archived`，并写入归档迭代号：

```bash
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint archived --iteration "{N}"
```

只允许更新当前 `{slug}` 对应的 Feature 行，不得删除该行，不得改写其他 Feature 状态。

### 移动过程目录

确认 `CHECKPOINT` 已为 `archived` 后，将当前 Feature 过程目录整体移动：

```text
${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/
→ .autobizdevops/archive/{slug}-iter{N}/
```

移动后必须确认：

- 源目录 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/` 不再存在
- 目标目录 `.autobizdevops/archive/{slug}-iter{N}/` 存在
- 目标目录中保留本工作流实际产生的过程产物（如 `proposal.md`、`specs/`、各阶段报告与日志；具体以本 Feature 工作流产物为准）

### 输出结果

归档完成后输出：

```text
## ✓ Ops 归档完成

Feature: {slug}
归档位置: .autobizdevops/archive/{slug}-iter{N}/
checkpoint=archived

保留的过程产物:
- [列出归档目录中的主要文件]
```

## 失败处理

- checkpoint 不是合法上游 done checkpoint：停止，提示应先完成当前工作流的上游阶段。
- 状态已更新为 `archived` 但源目录仍在（移动失败或中断）：直接重试移动到 `.autobizdevops/archive/{slug}-iterN/`（该步幂等），不要重复更新状态。
- 目标目录冲突：不得覆盖，递增 `iterN` 后重试。
- 状态更新失败：停止并提示人工检查 `.autobizdevops/state.json`，不得删除已归档目录。

## 输出清单

Skill 完成前必须满足：

- [ ] `.autobizdevops/archive/{slug}-iter{N}/` 已存在
- [ ] `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/` 已不存在
- [ ] 已向用户输出归档路径与保留的过程产物清单

技能完成后，读取并遵循 `${pluginPath}/skills/references/ui-continuation-guide.md`。
