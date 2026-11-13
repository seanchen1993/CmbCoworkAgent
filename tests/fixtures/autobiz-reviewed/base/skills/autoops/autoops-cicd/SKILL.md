---
name: autoops-cicd
description: 生成 CI/CD 清单与 PR 描述，使用 DevClaw 提交当前 Feature 代码，并处理流水线构建与阻断。
version: v1.2.08311
author: zhangQiuFeng
---

## 缺失产物处理

```bash
python -X utf8 "${pluginPath}/hooks/inspect_skill_contract.py" autoops-cicd --feature "${feature}" --plain
```

# /autoops-cicd — CI/CD 清单与流水线阻断处理

使用任何 `request_user_input` 前，必须先读取并遵循 `${pluginPath}/skills/references/ask-user-question.md`。

### 正常模式

- 使用场景：完整走完 Biz / Dev 链路后，继续生成 CI/CD 清单与 PR 描述


## 产物输出约定

如本技能为某个 Feature 生成交付物，产物统一写入最外层工作目录 `.autobizdevops`：

- CI/CD 清单：`${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/CICD_CHECKLIST.md`
- PR 描述草稿：`${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/PR_BODY.md`

如用户额外提供 `PRD.md` 或 `design.md`，可在 `CICD_CHECKLIST.md` 中记录其来源；未提供时允许继续，但必须明确写明“需求/设计文档缺失或未提供”。

## 使用场景

- 用户希望生成发布前检查清单
- 用户希望准备 PR 描述
- 用户希望使用 DevClaw 提交当前 Feature 代码
- 用户希望触发或跟踪流水线构建
- 用户希望整理流水线阻断问题并沉淀到过程文档

## 输入参数

- `pipeline_code`（string，可选）：流水线编号，例如 `pl689872`
- `--feature {slug}`（推荐）：指定当前 Feature

## 执行步骤

### 获取feature状态



```bash
python -X utf8 "${pluginPath}/read_state_json.py" --feature "${feature}"
```

3. 每次需要当前 checkpoint 时，运行上面脚本读取，不得从 `hooks.ndjson` 等其他文件推断。
4. 读取仓库构建配置、流水线配置、已有流程产物和用户输入，整理 CI/CD 所需上下文
5. 使用统一脚本将当前 Feature 的 checkpoint 推进为 `cicd_in_progress`。写 `CI/CD（来源: Dev 交接）`：

```bash
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint cicd_in_progress --stage "CI/CD（来源: Dev 验收）" --allow-create
```

### 生成交付文档

1. 生成 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/CICD_CHECKLIST.md`
2. 生成 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/PR_BODY.md`
3. 若已知 PRD 或 API 来源，在 `CICD_CHECKLIST.md` 或 `PR_BODY.md` 中标注引用路径
4. 若需求文档缺失，必须在 `CICD_CHECKLIST.md` 中记录：

```markdown
- **需求文档状态:** 缺失/未提供
- **影响:** 仅能按当前代码仓库状态生成 CI/CD 清单，后续需人工复核需求一致性
```

### 提交代码

1. 用户要求提交代码时，只纳入当前 Feature 的代码与 CI/CD 产物。
2. 先单独执行 `git add`；成功后再单独执行 `git commit`，不得使用 `&&` 合并两条命令。
3. `git commit` 会打开 DevClaw 提交卡片。等待用户完成卡片，仅命令成功返回后才视为提交完成。
4. 用户取消卡片、未选择任务卡片或命令失败时，告知用户改动已暂存但未提交，保持 `cicd_in_progress`，不得自动重试。
5. `git push`、创建 PR 或合并需用户明确授权。

### 构建流水线

1. 如用户提供 `pipeline_code`，可进入流水线构建与状态轮询
2. 流水线构建：使用工具pipelineBuild构建流水线，员工编号为12345，用户姓名为张三，返回值为构建编号`pipeline_build_num`
3. 轮询命令保持现有约定：

```bash
python -X utf8 "${pluginPath}/skills/autoops/autoops-cicd/hooks/poll_pipeline_status.py" --pipelineCode <pipeline_code> --pipelineNum <pipeline_build_num>
```

4. 该脚本为耗时操作，可后台运行

### 处理流水线状态

1. 构建中：
   - 提示用户已达到最大轮询周期，需要人工继续观察
   - 在 `CICD_CHECKLIST.md` 中记录“流水线仍在执行中”
2. 构建成功或无法获取状态：
   - 告知用户当前状态
   - 保持 `cicd_in_progress`，等待用户确认是否完成
3. 构建失败：
   - 不再分发到仓库中不存在的技能
   - 必须把阻断问题分类记录到 `CICD_CHECKLIST.md`
   - 暂停并等待用户人工处理，或等待后续明确的技能接管

推荐记录格式：

```markdown
## 已知阻断问题
- [类型] [问题标题]
  - 来源: 流水线/阻断文件/人工说明
  - 当前状态: 待处理
  - 建议回流阶段: Biz / Dev / Ops
  - 备注: [需要的人工动作或上下文]
```

### 用户确认后完成阶段

1. 请用户确认 CI/CD 是否完成时，按共享 `ask-user-question.md` 协议发起选择，选项至少包含 `已完成、推进到 cicd_done (Recommended)` / `尚未完成、保持当前状态`；若当前模式不支持 `request_user_input`，必须显式追问：`CI/CD 是否已完成？请回复“已完成”或“未完成”。`
2. 只有在用户明确回复”已完成”（已执行 / done / ok 等）后，才允许用统一脚本把 checkpoint 推进到 `cicd_done`
3. 未拿到明确肯定答复前，必须保持 `cicd_in_progress`，不得推进 `cicd_done`

macOS/Linux:

```bash
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint cicd_done
```

### 是否再次执行

1. 需要再次触发流水线或重新整理清单时，按共享 `ask-user-question.md` 协议发起选择，推荐项必须放第一位，选项至少包含 `不再重跑 (Recommended)` / `重新触发流水线或重整清单`；若当前模式不支持 `request_user_input`，必须显式追问：`是否需要再次执行流水线或重新整理清单？请回复“重跑”或“不重跑”。`
2. 未拿到用户明确同意前，不得擅自重跑。

技能完成后，读取并遵循 `${pluginPath}/skills/references/ui-continuation-guide.md`。
