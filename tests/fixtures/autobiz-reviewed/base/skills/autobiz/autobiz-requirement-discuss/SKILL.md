---
name: autobiz-requirement-discuss
description: Biz 阶段需求澄清与正式 PRD 生成技能。
version: v1.4.0917
---

# /autobiz-requirement-discuss — Biz 阶段需求澄清与 PRD 生成

## 产物协议

- 产物：`${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/PRD.md`；存在外部资料时同时生成 `sources/SRC-NNN/` 与 `source-context.json`

## 准备工作

### 获取feature状态
```bash
python -X utf8 "${pluginPath}/read_state_json.py" --feature "${feature}"
```

每次需要当前 checkpoint 时，运行上面的脚本读取，不得从 `hooks.ndjson` 等其他文件推断。

###  更新状态

开始需求澄清时必须用脚本写入开始态：

```bash
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint prd_in_progress
```
### 缓存检测与清理

用户明确要求"重新 DISCUSS""重新讨论""重新分析""重新梳理需求"，且 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/PRD.md` 已存在时，先删除该文件再走完整流程。

### 实现范围与分析维度

开始需求分析前，先读取当前对话中的范围结论，并运行以下命令查看本 Feature 已记录的范围：

```bash
python -X utf8 "${pluginPath}/hooks/implementation_scope.py" show --feature "${feature}"
```

- 当前对话已经明确本轮实现端，或命令返回 `ok=true` 且 `source=user_confirmed` 时，直接复用；用户主动调整范围时采用其最新明确结论。继续或重新 Discuss 不重新询问已确认的范围。
- 缺少明确结论时，按共享 `ask-user-question.md` 协议用 `request_user_input` 只提一个问题：“本轮要实现哪些端？需求分析将按同一范围检查。”`id` 使用 `implementation_scope`，选项为“仅前端”“仅后端”“全栈（前后端）”，按需求匹配程度排序并标记推荐项。
- `source=legacy_default` 或其他未确认来源不代表用户已选择全栈，仍需上述一次确认。此前只确认过分析角色、未明确本轮实现端时，仅补问实现范围。

同一次选择同时确定实现范围与默认分析维度：

| 用户选择 | `implementationScope` | 默认分析维度 |
|----------|-----------------------|--------------|
| 仅前端 | `frontend_only` | 通用、业务、前端；后端接口作为外部依赖 |
| 仅后端 | `backend_only` | 通用、业务、后端；页面和交互不纳入本轮实现 |
| 全栈（前后端） | `full_stack` | 通用、业务、前端、后端及跨端一致性 |

不再单独询问“需求分析角色”。分析维度用于发现问题，实现范围约束实际交付；用户主动指定不同分析视角时可补充检查维度，不得据此修改已确认范围或再次弹出范围选择。

用户明确范围后立即写入（已存在相同的有效用户确认记录时直接复用）：

```bash
python -X utf8 "${pluginPath}/hooks/implementation_scope.py" set \
  --feature "${feature}" \
  --scope "${implementationScope}" \
  --source user_confirmed
```

同时在 `PRD.md` 写入 `## 当前实现范围`，在“当前已确认结论”记录该范围对应的分析维度；`${implementationScope}` 使用上表的机器值。

当用户已明确选择 `backend_only` 时，该选择同时确认了“本 Feature 不需要 UI 实现”，不得再单独询问 UI 范围。立即使用 `ui_context_writer.py set-ui-required false` 写入具体的 `--reason` 与 `--decision-source user_confirmed`，再使用 `confirm --decision-source user_confirmed` 将该 UI 决策收口为 `confirmed`。

## 需求澄清
### 流程管控

> 执行开始时用 `write_todos` 建立 todo 列表，每完成一步立即标记完成。以下环节不得跳过，可按实际情况增补条目：
> - 建立需求上下文
> - 加载领域知识文档
> - 保存原始材料快照
> - 需求内容格式改造
> - 需求分析
> - 问题清单展示与逐项裁定
> - 对话式引导与需求内容调整
> - 迭代回检直到收敛
> - 待确认裁定与正式稿收敛
> - 更新状态与校验


### 建立需求上下文

- 读取需求材料：优先 Word 文档（`.docx` / `.doc`）；Markdown、需求说明、会议纪要、飞书导出内容也可作为输入
- 按原始文档的实际目录结构逐章逐节提取，不预设固定的信息类别；记录完整章节树与术语、文风特点，每节内容提取完整

### 加载领域知识文档（必读）

根据 `<UNIT>` 阅读规则，需求澄清阶段按照 `deployUnit` 必须读取相应领域知识文档，并将其作为需求分析的背景知识；未读取到时不影响需求澄清流程。

### 保存原始材料快照
将原始需求文档复制到 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/prd_original/`（目录不存在则创建）保留快照

用户提供的外部接口、补充接口说明按  `SRC-NNN` 保存到 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/sources/SRC-NNN/`。

### 需求内容格式改造

- 必须先完整读取 `${pluginPath}/skills/autobiz/autobiz-requirement-discuss/references/prd-formatter.md` 。
- 按 `${pluginPath}/skills/autobiz/autobiz-requirement-discuss/references/prd_module.md` 的模板格式重写需求文档。
- **关键** ：根据 `prd-formatter.md`进行格式化。
- 写入`${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/PRD.md`。
- **关键** ：以原需求文档为基准，核对生成的 `PRD.md` 是否遗漏功能说明；逐项检查功能清单、功能详情、字段/表格行、规则、链接、文案、状态、外部协作规则和验收项。发现遗漏、弱化或错位时，先更新 `PRD.md`，再重新核对。
- 从原需求、初始上传与讨论补充资料中提取会约束实现或验收的外部接口文档、sql脚本等，在 `## 外部资料与实现约束` 建立索引。每项分配稳定 `SRC-NNN`，后续增量只追加，禁止重编号或复用已删除 ID；没有此类资料时正文写“无”。
- 接口方法、路径、请求/响应结构、错误与超时等已知约束仍须写入对应 FR 或验收标准。
- 存在来源项时完整读取 `${pluginPath}/skills/autobiz/autobiz-requirement-discuss/references/source-context.md`，按其中的脚本生成 `source-context.json`。
### 需求分析

- 严格按 `${pluginPath}/skills/autobiz/autobiz-requirement-discuss/references/analysis-guide.md` 的评估规则检查，生成问题清单；复用已确认范围及其分析维度，不再发起角色选择。
- 仅输出有问题、有遗漏、不明确的事项；无问题则不制造问题。

### UI 范围收口

- 需求澄清阶段必须读取 `${pluginPath}/skills/autobiz/references/ui-context.md`，并使用 `hooks/ui_context_writer.py` 创建或更新 Feature 的 `UI_CONTEXT.json`；不能只把页面范围写在 PRD Markdown 中。
- 初次生成时 `decisionStatus` 使用 `defaulted`，并记录页面、核心交互、加载/空/错误/成功状态及视觉来源类型。除已确认 `backend_only` 的情况外，展示问题清单时必须让用户确认 UI 范围；用户确认后使用 writer 的 `confirm` 命令写入 `decisionStatus=confirmed`。PRD 阶段不要凭空写入尚未定义的 capability/specRefs。
- 只要需求涉及页面、交互、设计稿、HTML 或前端路由，必须设置 `uiRequired=true`，并把页面与交互写入 JSON；纯后端需求设置 `uiRequired=false` 并填写 `notApplicableReason`。
- 用户提供高保真 HTML 时，使用 `ui_context_writer.py add-visual-source --source-file ...` 归档到 `feature/frontend-html/VIS`；需要高保真但暂时没有文件时登记缺失视觉来源，不能伪造文件路径。
- 需求阶段只收口 UI 范围和视觉来源，不创建 capability 的规格引用；规格阶段负责锁定 `UI_CONTEXT.json`，后续 Plan/Code 只能消费该 JSON。

### 问题清单展示与逐项裁定

####  优先级分级

| 优先级 | 分类 | 说明 |
|--------|------|------|
| P0 | 阻断性问题 | 需求无法理解或无法开发，必须立即解决 |
| P1 | 重要问题 | 功能实现可能受影响，需要 PM 确认 |
| P2 | 优化建议 | 文档完整性或规范性问题，建议改进 |

####  问题清单输出格式

```markdown
## 问题清单

| 序号 | 重要性 | 检查项 | 问题描述 | 功能定位 | 领域依据 | 优化建议 |
|------|--------|--------|----------|----------|----------|----------|
| 1 | P0 - 阻断性问题 | [检查项] | [问题描述] | [功能定位] | [文件名 — 原文约束] | [优化建议] |
| 2 | P1 - 重要问题 | [检查项] | [问题描述]| [功能定位] | 通用 | [优化建议] |
```

#### 领域依据
- 「领域依据」填该条问题所依据的系统提示词 `<SYSTEM>`、`<UNIT>` 段落点名文档的文件名与原文约束（如 `core-entities.md — 用户关联实体: 角色/部门/岗位`），与既有实体、流程、约束无关的纯规范类问题填「通用」。
- 整张表的「领域依据」全为「通用」时，说明未结合本系统既有实体、流程与约束检查，重做需求分析。

#### 处理问题清单

- 存在实质问题时，先完整展示问题清单，再直接按 P0 → P1 → P2 对第一批最多 3 项发起裁定。不先追问“是否开始讨论”。
- 用户在逐项裁定的 Other /「其他」中补充新问题时，直接记录并合并到问题清单，不得再次询问“请补充说明”。
- 无实质问题时，告知用户“需求检查完毕，未发现问题”，然后直接进入正式稿收敛，不询问是否进入下一阶段。


### 对话式引导并调整 `PRD.md`

对已确认的问题清单（含用户补充项）按 P0→P1→P2 逐项单独对话，结合原始需求文档和用户回复把调整结果沉淀到 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/PRD.md`。

**对话流程（每个问题单独执行）：**

1. **展示当前问题**：展示问题的检查项、问题描述和优化建议
2. **智能生成选项**：根据问题类型生成 2-3 个互斥选项；推荐项在前并标记 `(Recommended)`，不要手工添加“其他”
    - P0 问题示例选项：「已明确」「记录风险项」
    - P1 问题示例选项：「确认按建议处理」「记录风险项」
    - P2 问题示例选项：「确认按建议处理」「本期不做」
    - 若问题要求用户实际填写链接、路径、联系人、文件位置、配置值或补充说明，不得生成「现在提供」「提供路径」「补充说明」等空动作选项；必须在 `question` 中提示用户直接通过客户端 Other /「其他」填写具体内容
    - 自由文本补充类问题仍必须提供至少 2 个预设选项，通常为「后续补充并继续 (Recommended)」和「缺少该信息前暂停」；仅当业务上确实成立时，第二项可改为「不适用」
3. **按共享 `ask-user-question.md` 协议使用 request_user_input 询问**：
    - 问题：描述当前问题，询问 PM 的处理意向
    - 选项：智能生成的选项
4. **处理用户回复**：
    - 若选择预设选项 → 按选项语义继续、暂停或标记为不适用，不得把预设选项当成再次索取自由文本的过渡步骤
    - 若用户通过客户端自动提供的 Other 自由输入补充说明 → 记录补充内容，继续下一问题
    - 若选择「后续补充并继续」→ 标记为待确认并继续其他问题，同一轮不得再次追问该内容
5. **记录完整对话**：将每个问题的对话内容（问题、选项、用户选择、补充内容）记录到 PRD.md
6. **处理新增文件**：若用户在回答中提供文件，按“讨论过程中新增资料的处理”执行；其中，分析维度包含前端时用户提供的每个 HTML 文件位置，均视为讨论补充资料，必须登记文件名称、原始文档绝对路径和“前端页面/交互分析”的用途。

**示例对话流程：**

```
问题 1：P0 - 字段定义缺失
- 检查项：字段定义完整性
- 问题描述：用户ID字段未定义类型和长度
- 优化建议：补充 userId 字段的类型为 VARCHAR(32)

【询问】
问题：用户ID字段未明确定义，请问如何处理？
选项：
1. 补充字段定义为 VARCHAR(32) (Recommended)
2. 记录风险项

【用户选择后记录】
- 用户选择：补充字段定义为 VARCHAR(32)
- 补充说明：[如有]
- 确认结论：[记录最终决策]
```

#### 调整需求摘要
- 根据用户回答调整需求摘要，确保需求摘要内容的准确性
- 不做的任务在任务标题上明确标注"（二期）"或"本期不做"
- 对于需求摘要内容中描述不明确的内容，应在对应位置标注"【待确认】"并在"待确认事项"中记录


#### 讨论沉淀生成

`PRD.md` 是固定文件名，每轮增量更新。必须包含：

1. **需求摘要【核心】**：完整需求内容
2. **当前已确认结论**
3. **问题清单与处理状态**：含「领域依据」列
4. **待确认事项**
5. **假设与风险**
6. **历次讨论记录**：按时间记录
7. **讨论补充资料**：讨论过程中新增文件的名称、绝对路径和用途；分析维度包含前端时，用户提供的 HTML 文件逐项登记，用途填“前端页面/交互分析”。初始上传的原始需求文档不入本清单（快照在 `prd_original`）；无新增文件时保留空清单说明
8. **外部资料与实现约束**：只登记会约束实现或验收的资料，以稳定 `SRC-NNN` 建立跨阶段引用；它与“讨论补充资料”的过程记录用途不同

#### 写作要求

- 收敛过程中可以保留"待确认""候选方案""暂定结论"这类中间状态，但每次新增或修改都要标明哪些已确认、哪些仍待确认

### 迭代直到收敛

将 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/PRD.md` 与 `analysis-guide.md` 反复对照检查原问题是否已解决、是否引入新问题或新歧义；仍存在 P0 / P1 时回到『需求分析』重来一轮。每轮都要向用户展示检查结果，由用户判断是否可以终止循环。

#### 迭代终止条件

满足以下任一条件可视为需求已收敛：

- 用户明确表示"无问题""可以了""通过""开始整理正式 PRD"
- 用户表示"不需要""不考虑"等问题暂存的相似语句
- 所有 P0 / P1 已处理完毕，只剩可接受的 P2 建议
- 连续两次检查没有新增实质问题
- 范围：`PRD.md` 的 `待确认事项` / `待确认项` 章节中每个实质条目，以及每一处 `【待确认】`；同一决策去重后逐条询问用户。章节正文仅为「无」时直接移除该空章节。
- 展示：向用户确认前展示 `待确认内容 / 所在上下文 / 当前建议 / 备选 / 影响`。
- 协议：先读取 `${pluginPath}/skills/references/ask-user-question.md`，再用 `request_user_input` 逐项提问，每轮最多 3 项；`id` 用条目内容的简短 snake_case 概括。不设置 `autoResolutionMs`。
- 信息缺口型条目在 `question` 中提示用户通过「其他」粘贴具体内容。
- 回写：立即将具体结论写入对应需求正文；无对应位置时写入「当前已确认结论」。用户裁定本期不做时，在对应需求标注「本期不做」或「二期」。声称拥有 ≠ 提供；仅声称稍后提供时追问一次，仍未提供则重新裁定为移除依赖或暂停。
- 消解：具体结论已落盘，原待确认条目和标记已移除，才算完成。禁止自行消解。
- 自由回复：用户直接提供实质结论时，吸收并更新当前条目，不重复弹出相同选择。
- 消解自查：不得残留待确认章节、`【待确认】`、TBD、待补充、待提供、后续确认或「以实际接口为准」「开发阶段补充」等延后占位。
- 来源自查：逐项确认 `SRC-NNN` 的名称、地址/路径、约束范围与状态完整；外部接口资料无法访问或契约仍不明确时，按信息缺口处理。

全部条目裁定并回写前，禁止更新 `prd_done` 或运行完成校验。


### 更新状态

```bash
python -X utf8 "${pluginPath}/hooks/update_checkpoint.py" --checkpoint prd_done
```


## 输出清单

Skill 完成后，必须运行脚本校验：

```bash
python -X utf8 "${pluginPath}/skills/autobiz/hooks/biz_validate.py" prd --feature "${feature}"
```

脚本通过即视为以下清单已完成：

- `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/PRD.md` — 已存在并满足正式稿结构
- PRD 存在 `SRC-NNN` 时，对应快照与 `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/source-context.json` 已通过校验
- Feature checkpoint 为 `prd_done`
- 所有 P0 / P1 与待确认项已完成裁定并回写
- 所有实现外部依赖材料均已进入 `外部资料与实现约束`

技能完成后，读取并遵循 `${pluginPath}/skills/references/ui-continuation-guide.md`。
