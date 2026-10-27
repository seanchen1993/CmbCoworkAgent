# autoBizDevOps Eval 设计方案

> 状态：v1.0（基于当前 `autobizdevops` 插件仓库重写）
> 目标：为 Biz / Dev / Ops 技能编排、checkpoint 状态机、过程产物契约与端到端贯通建立一套可离线回归、可定位失败原因、可持续扩展的数据化评估体系。
> 核心评估对象：**Skill 路由正确性 / Checkpoint 合法性 / 产物契约质量 / Agent 过程质量 / 端到端贯通率**。

---

## 1. 当前项目的真实评估对象

当前 `autobizdevops` 不是普通业务应用仓库，也不是单纯的代码生成服务。它是一个 Codex 插件式研发流程编排仓库，核心资产包括：

| 类型 | 代表文件 | 评估关注点 |
|------|----------|------------|
| 插件入口 | `plugin.json`、`skills/SKILL.md` | 插件元数据、入口技能、根路由约束是否正确 |
| Biz 技能 | `skills/autobiz/**/SKILL.md` | 需求澄清、PRD 生成、Biz 产物校验是否可靠 |
| Dev 技能 | `skills/autodev/**/SKILL.md` | Plan、Code、Reviewer、UTest、E2E、Verify 的输入输出契约是否闭合 |
| Ops 技能 | `skills/autoops/**/SKILL.md` | CI/CD 与 Archive 是否按 checkpoint 接续 |
| 状态机 | `hooks/state_checkpoint.py`、`hooks/update_checkpoint.py` | checkpoint 集合、允许转移、非法转移拦截、产物生命周期校验 |
| 产物校验 | `skills/autodev/**/hooks/artifact-check.yaml`、`artifact_check.py`、`biz_validate.py` | 各阶段 required inputs/outputs、Markdown 结构、verdict、任务状态等是否被正确验证 |
| 过程产物 | `.autobizdevops/features/{slug}/...` | PRD、design、PLAN、评审、测试、E2E、Verify、CI/CD、PR_BODY 等是否符合契约 |

因此，eval 的主轴不应是泛化的 “Biz Intake → Codegen → Deploy → Observe”，而应是：

```text
requirement-discuss
  -> prd-generate
  -> autodev-plan
  -> autodev-code
  -> autodev-reviewer
  -> autodev-utest
  -> autodev-e2e
  -> autodev-verify
  -> autoops-cicd
  -> autoops-archive
```

评估系统必须围绕这个真实链路设计。

---

## 2. Eval 设计原则

### 2.1 契约优先

本项目的稳定性来自显式契约，而不是单次 agent 输出质量。契约包括：

- checkpoint 合法转移
- skill 前置输入
- skill 后置输出
- 过程产物结构
- verdict / status 等机器可识别字段
- 允许写入与禁止写入边界

eval 应优先覆盖这些硬契约。只要硬契约破坏，即使 LLM judge 认为语义还不错，也应判定失败。

### 2.2 确定性校验先行，语义 judge 补充

确定性校验适合评估：

- checkpoint 是否属于已知集合
- 是否允许从 A 转移到 B
- 必需文件是否存在且非空
- Markdown 是否包含必要章节
- `PLAN.md` 任务状态是否可解析
- `REQUIREMENTS_EVAL.md` verdict 是否为收敛态
- `code_done` 前编译校验是否被触发

LLM-as-judge 只用于确定性规则无法覆盖的质量问题，例如：

- PRD 是否准确收敛了用户需求
- design 是否真实贴合代码库约束
- PLAN 是否按业务闭环拆任务，而不是机械按文件拆任务
- E2E 用例是否覆盖用户主路径
- Verify 报告是否把证据和验收标准正确映射

### 2.3 Eval runner 不模拟 agent，先评估边界

完整重放真实 agent 开发过程成本高、噪声大、难归因。冷启动阶段不应一开始就追求 “自动跑完整开发”。更稳的路线是：

1. 先用构造的 `.autobizdevops` workspace fixture 评估状态机和产物 hook。
2. 再用真实/脱敏历史产物评估 Markdown 质量。
3. 最后挑少量端到端 scenario 验证贯通率。

### 2.4 端到端贯通必须能归因

E2E 贯通率不能只看最终是否 `archived`。每条 scenario 必须记录：

- 最后到达的 checkpoint
- 首个失败阶段
- 失败类型：路由错误 / checkpoint 非法 / 缺失产物 / 产物结构错误 / 语义质量不足 / 执行环境阻断
- 建议回流阶段是否正确

---

## 3. 真实步骤与评估矩阵

| # | 步骤 | 入口/文件 | 节点类型 | 输入 | 输出 | 主指标 | 评估器 |
|---|------|-----------|----------|------|------|--------|--------|
| 1 | Requirement Discuss | `/autobiz-requirement-discuss` | LLM + 文档 | 用户原始需求 | `PRD_DISCUSS.md` | 需求澄清完整性 | rule + judge |
| 2 | PRD Generate | `/autobiz-prd-generate` | LLM + 文档 | `PRD_DISCUSS.md` | `PRD.md`、`discuss_done/prd_done` | PRD 契约完整性 | `biz_validate.py` + judge |
| 3 | Dev Plan | `/autodev-plan` | LLM + 代码阅读 | `PRD.md`、代码库 | `design.md`、`PLAN.md` | 设计契约合规率、任务拆分质量 | artifact hook + judge |
| 4 | Code | `/autodev-code` | 混合 | `PRD.md`、`design.md`、`PLAN.md` | 代码 diff、`PLAN.md` 状态、`code_done` | 编译通过率、任务完成率、写入边界遵守率 | executable + rule |
| 5 | Requirements Review | `/autodev-reviewer` | 独立 reviewer | proposal、真实 diff、PRD | `REQUIREMENTS_EVAL.md` | verdict 收敛率、审查独立性 | rule + judge |
| 6 | Unit Test | `/autodev-utest` | 混合 | 代码、评审报告 | `UNIT_TEST_REPORT.md`、`test-output.log` | 测试执行证据完整性 | rule + executable |
| 7 | E2E | `/autodev-e2e` | 混合 | 上游文档、代码、服务 | `E2E_TEST_CASES.yaml`、`E2E_REPORT.md`、`e2e-run.log` | 主链路覆盖率、失败归因准确率 | rule + judge |
| 8 | Verify | `/autodev-verify` | 证据汇总 | PRD、UTest、E2E | `VERIFY_REPORT.md`、`verify_done/needs_fix` | 验收标准映射准确率 | rule + judge |
| 9 | CI/CD | `/autoops-cicd` | 文档 + 外部流水线 | Dev 产物、pipeline_code | `CICD_CHECKLIST.md`、`PR_BODY.md` | 发布清单完整性、阻断记录准确率 | rule |
| 10 | Archive | `/autoops-archive` | 确定性 | `cicd_done`、feature 目录 | archive 目录、`archived` | 归档成功率、不覆盖率 | executable |
| E2E | Full Flow | 根入口 + checkpoint | 组合 | scenario | 最终 checkpoint + trace | 贯通率、首失败步骤分布 | runner aggregate |

---

## 4. 指标体系

### 4.1 硬契约指标

这些指标应作为 CI smoke 的第一层红线。

| 指标 | 定义 | 目标 |
|------|------|------|
| known checkpoint coverage | eval case 是否覆盖全部 `KNOWN_CHECKPOINTS` | 100% |
| legal transition pass rate | 合法 checkpoint 转移被允许的比例 | 100% |
| illegal transition block rate | 非法 checkpoint 转移被阻断的比例 | 100% |
| required input block rate | 缺少上游产物时是否阻断进入下游 | 100% |
| required output block rate | 缺少阶段输出时是否阻断完成阶段 | 100% |
| artifact schema pass rate | artifact-check yaml 和 validator 是否可加载、可执行 | 100% |
| state table parse accuracy | `STATE.md` 正常、重复、未知 checkpoint 等情况是否解析正确 | 100% |

### 4.2 过程产物质量指标

| 产物 | 硬规则 | 语义质量 |
|------|--------|----------|
| `PRD_DISCUSS.md` | 必要章节齐全 | 是否澄清核心问题、假设风险是否明确 |
| `PRD.md` | 目标、核心价值、具体要求、非目标、边界说明、验收标准、关键约束、风险与假设齐全 | 是否可执行、无开放式残留、验收标准可验证 |
| `design.md` | Proposal、Behavior Specs、API Decisions、Data Decisions、Technical Design、Risks/Open Questions 齐全；`x-auto-no-http-api`、`x-auto-no-sql` 存在 | 是否贴合现有架构，是否避免把未确认内容写成硬约束 |
| `PLAN.md` | 任务总览、任务详情、任务状态可解析 | 是否按业务闭环拆分，是否覆盖 PRD 与 design 决策 |
| `REQUIREMENTS_EVAL.md` | verdict 存在且为 `PASS` / `PASS_WITH_WARNINGS` 才能收敛 | 是否真实核验 diff、PRD、proposal，而非自证完成 |
| `UNIT_TEST_REPORT.md` | 报告和原始日志存在 | 是否记录可执行命令、覆盖范围、失败原因 |
| `E2E_TEST_CASES.yaml` | 用例字段完整，`execution_mode`、`ui_required` 合法 | 是否覆盖 P0 用户主链路和设计契约 |
| `E2E_REPORT.md` | 执行范围、启动证据、鉴权证据、结果、归因齐全 | 失败归因是否可信，是否避免伪造通过 |
| `VERIFY_REPORT.md` | 验收标准映射、证据来源、结论齐全 | 是否只做汇总，不引入新证据或自跑命令 |
| `CICD_CHECKLIST.md` / `PR_BODY.md` | 文件存在，阻断记录结构化 | 是否足够支持发布前人工复核 |

### 4.3 端到端指标

| 指标 | 定义 |
|------|------|
| flow completion rate | scenario 最终到达目标 checkpoint 的比例 |
| archived rate | 完整 Biz -> Dev -> Ops 最终到达 `archived` 的比例 |
| first failure distribution | 首个失败步骤分布 |
| needs_fix attribution accuracy | `needs_fix` 时建议回流阶段是否正确 |
| upstream pollution gap | 单步 fixture 通过率与端到端中该步通过率的差值 |
| recovery success rate | 从 `needs_fix` 回流到指定阶段后再次推进成功的比例 |

---

## 5. 数据集设计

### 5.1 数据目录

建议在仓库根目录新增：

```text
eval/
  datasets/
    checkpoint/
      transitions.jsonl
      malformed_state.jsonl
    artifacts/
      valid_feature_workspaces/
      invalid_feature_workspaces/
    semantic/
      prd_cases.jsonl
      design_cases.jsonl
      plan_cases.jsonl
      e2e_report_cases.jsonl
      verify_report_cases.jsonl
    e2e/
      scenarios.jsonl
  rubrics/
    prd.md
    design.md
    plan.md
    requirements_eval.md
    e2e_report.md
    verify_report.md
  runners/
    run_checkpoint_eval.py
    run_artifact_eval.py
    run_semantic_eval.py
    run_e2e_eval.py
    aggregate_report.py
  reports/
    latest/
    baselines/
```

### 5.2 Checkpoint case schema

```json
{
  "id": "transition_plan_done_to_code_in_progress",
  "type": "legal_transition",
  "old_checkpoint": "plan_done",
  "new_checkpoint": "code_in_progress",
  "feature": "feat-export-orders",
  "expected_ok": true,
  "tags": ["dev", "checkpoint", "happy_path"]
}
```

### 5.3 Artifact fixture schema

```json
{
  "id": "missing_design_blocks_code",
  "workspace_fixture": "artifacts/invalid_feature_workspaces/missing_design",
  "skill": "autodev-code",
  "check": "precheck",
  "feature": "feat-demo",
  "expected_ok": false,
  "expected_reason_contains": "missing_required_artifacts",
  "tags": ["autodev-code", "precheck"]
}
```

### 5.4 Semantic case schema

```json
{
  "id": "plan_business_task_split_001",
  "artifact_path": "semantic/cases/PLAN.business-good.md",
  "artifact_type": "PLAN.md",
  "rubric": "plan.md",
  "expected": {
    "min_score": 0.8,
    "must_pass": [
      "business_closed_loop_tasks",
      "acceptance_coverage",
      "design_decision_coverage"
    ]
  },
  "tags": ["plan", "judge", "task_split"]
}
```

### 5.5 E2E scenario schema

```json
{
  "id": "full_flow_happy_path_minimal_feature",
  "feature": "feat-demo",
  "start_checkpoint": "discuss_in_progress",
  "target_checkpoint": "archived",
  "fixture": "e2e/fixtures/full_flow_happy_path",
  "expected": {
    "final_checkpoint": "archived",
    "must_generate": [
      "PRD.md",
      "design.md",
      "PLAN.md",
      "REQUIREMENTS_EVAL.md",
      "UNIT_TEST_REPORT.md",
      "E2E_REPORT.md",
      "VERIFY_REPORT.md",
      "CICD_CHECKLIST.md",
      "PR_BODY.md"
    ],
    "first_failure_step": null
  },
  "tags": ["e2e", "happy_path"]
}
```

---

## 6. Runner 设计

### 6.1 `run_checkpoint_eval.py`

职责：

- 读取 `checkpoint/transitions.jsonl`
- 构造临时 `.autobizdevops/STATE.md`
- 调用 `hooks/update_checkpoint.py --dry-run --json`
- 断言合法转移通过、非法转移失败
- 输出每条 case 的 actual / expected / error

这个 runner 应覆盖：

- 所有 `ALLOWED_NEXT`
- 每个 checkpoint 的至少一个非法目标
- 新增 feature 只允许从 `INITIAL_CHECKPOINTS` 开始
- 重复 feature 行
- 未知 checkpoint
- 删除 feature 行

### 6.2 `run_artifact_eval.py`

职责：

- 对每个 fixture workspace 调用 `artifact_check.py precheck/postcheck/schema`
- 调用 `biz_validate.py discuss/prd`
- 验证缺失输入、缺失输出、错误章节、错误 verdict、错误任务状态能被拦截

优先覆盖：

- `autodev-plan`：缺 `PRD.md`、缺 `design.md`、缺 `PLAN.md`
- `autodev-code`：缺 design/PLAN、PLAN 仍有待做任务
- `autodev-reviewer`：缺 `REQUIREMENTS_EVAL.md`、verdict 非收敛态
- `autodev-e2e`：缺 E2E 三件套
- `autodev-verify`：缺上游报告
- Biz：PRD 缺必要章节、PRD 残留开放式内容

### 6.3 `run_semantic_eval.py`

职责：

- 读取 semantic cases
- 对指定 Markdown 产物运行 rubric judge
- judge 输出结构化 JSON：

```json
{
  "pass": true,
  "score": 0.86,
  "dimensions": {
    "contract_completeness": "pass",
    "grounded_in_existing_code": "pass",
    "no_unconfirmed_hard_constraints": "warn",
    "testability": "pass"
  },
  "reason": "..."
}
```

要求：

- 每个 rubric 控制在 4-6 个维度
- 每个维度使用 `pass / warn / fail`
- 关键维度 fail 时整条 case fail
- 抽样人工复核，judge 与人工一致率低于 80% 时重写 rubric

### 6.4 `run_e2e_eval.py`

职责：

- 在临时 workspace 中加载完整 `.autobizdevops` fixture
- 按 scenario 目标模拟阶段推进
- 不强行调用真实 LLM agent
- 重点验证路由、checkpoint、产物校验、报告聚合、失败归因

冷启动阶段，E2E runner 可以先采用 “fixture replay”：

- fixture 中预置每阶段产物
- runner 尝试推进 checkpoint
- hook 决定能否进入下一阶段
- 对失败 case 记录首个失败点

后续再扩展为 “agent execution mode”，真实触发技能执行。

### 6.5 `aggregate_report.py`

统一输出：

```text
eval/reports/latest/
  summary.md
  summary.json
  checkpoint.json
  artifact.json
  semantic.json
  e2e.json
```

`summary.md` 顶部必须包含：

- 总通过率
- 硬契约通过率
- 语义质量均分
- E2E 贯通率
- 首失败步骤分布
- 新增 regression 列表

---

## 7. Rubric 设计

### 7.1 PRD rubric

建议维度：

| 维度 | 判定问题 |
|------|----------|
| goal_clarity | 是否明确目标、用户、业务价值 |
| scope_boundary | 是否明确范围、非目标、边界 |
| acceptance_testability | 验收标准是否可验证 |
| constraint_completeness | 权限、安全、性能、兼容、数据等关键约束是否记录 |
| open_issue_handling | 是否没有把待确认事项伪装成已确认 |

### 7.2 Design rubric

建议维度：

| 维度 | 判定问题 |
|------|----------|
| behavior_specs | 是否有外部可观察行为和场景 |
| api_data_decisions | API/Data 决策是否清晰，`x-auto-no-*` 是否合理 |
| grounded_in_codebase | 是否引用真实模块、路径、现有约束 |
| risk_handling | 风险和待确认项是否明确 |
| downstream_actionability | 是否足够支撑 PLAN 和 Code |

### 7.3 PLAN rubric

建议维度：

| 维度 | 判定问题 |
|------|----------|
| business_task_split | 是否按业务闭环拆任务，而不是按文件机械拆分 |
| dependency_order | 任务依赖是否合理 |
| acceptance_coverage | PRD 验收标准是否被任务覆盖 |
| design_coverage | design 决策是否被任务和验证方法覆盖 |
| verification_quality | 验证方法是否可执行、可定位 |

### 7.4 E2E report rubric

建议维度：

| 维度 | 判定问题 |
|------|----------|
| main_flow_coverage | 是否覆盖 P0 用户主链路 |
| execution_evidence | 服务、鉴权、浏览器/API 执行证据是否可信 |
| failure_triage | 失败分类是否合理 |
| no_fake_pass | 是否没有用接口响应或文件存在替代 UI 主链路 |
| recovery_record | 修复闭环和重跑证据是否记录 |

### 7.5 Verify report rubric

建议维度：

| 维度 | 判定问题 |
|------|----------|
| acceptance_mapping | 是否逐项映射 PRD 验收标准 |
| evidence_traceability | 每项裁定是否能追溯到上游报告或日志 |
| read_only_summary | 是否未引入本阶段新执行证据 |
| branch_decision | `verify_done` / `needs_fix` 决策是否与证据一致 |
| fixback_guidance | 失败时建议回流阶段是否合理 |

---

## 8. promptfoo 的定位

promptfoo 可以保留，但不要作为主 eval runner。

适合 promptfoo 的场景：

- PRD / design / PLAN 的 rubric judge
- 同一 prompt 或同一产物生成策略的多模型对比
- 小样本稳定性测试

不适合 promptfoo 的场景：

- checkpoint 状态机校验
- 需要文件系统 fixture 的产物 precheck/postcheck
- 需要调用 `update_checkpoint.py`、`artifact_check.py`、`biz_validate.py` 的确定性校验
- 需要真实 workspace、git diff、测试执行、归档移动的流程

因此推荐分工：

| 类型 | 主工具 |
|------|--------|
| checkpoint / artifact / e2e replay | Python runner |
| Markdown 语义质量 | Python runner 调 judge 或 promptfoo |
| 报告聚合 | Python runner |
| CI smoke | Python runner |

---

## 9. 分阶段落地路线图

### 阶段 1：硬契约 eval（2-3 天）

目标：先把最容易回归、最该红线保护的部分跑起来。

交付：

- `eval/datasets/checkpoint/transitions.jsonl`
- `eval/runners/run_checkpoint_eval.py`
- 覆盖全部 `KNOWN_CHECKPOINTS` 与 `ALLOWED_NEXT`
- `summary.md` 输出合法/非法转移通过率

通过标准：

- 合法转移通过率 100%
- 非法转移拦截率 100%
- 未知 checkpoint、重复 feature、非法新增行均可被识别

### 阶段 2：Artifact fixture eval（3-5 天）

目标：把现有 hook 纳入回归测试。

交付：

- valid / invalid `.autobizdevops` fixture
- `run_artifact_eval.py`
- 覆盖 Biz validate、Autodev artifact precheck/postcheck/schema

通过标准：

- 缺失必需输入必须阻断
- 缺失必需输出必须阻断
- 错误 verdict 必须阻断
- PLAN 未完成任务必须阻断 `code_done`

### 阶段 3：语义质量 eval（1-2 周）

目标：用 rubric judge 覆盖确定性规则无法判断的质量。

交付：

- `rubrics/prd.md`
- `rubrics/design.md`
- `rubrics/plan.md`
- `rubrics/e2e_report.md`
- `rubrics/verify_report.md`
- `run_semantic_eval.py`
- 30 条人工标注校准样本

通过标准：

- judge 与人工一致率 >= 80%
- 关键维度 fail 能正确导致 case fail
- 输出可解释 reason，便于改 skill prompt

### 阶段 4：端到端 fixture replay（1-2 周）

目标：验证流程贯通和失败归因。

交付：

- `eval/datasets/e2e/scenarios.jsonl`
- `run_e2e_eval.py`
- 首失败步骤分布
- `needs_fix` 回流建议准确率

通过标准：

- happy path 能到达目标 checkpoint
- 故意缺失产物能在正确阶段失败
- `needs_fix` case 能正确归因到 Biz / Plan / Code / Ops

### 阶段 5：CI 与 baseline（持续）

目标：形成稳定回归机制。

交付：

- CI smoke：checkpoint + artifact 快速集
- nightly：semantic + e2e replay 全量集
- baseline diff：新失败 / 新通过 / 分数变化

推荐策略：

- PR 级只跑硬契约和小样本 artifact eval
- nightly 跑语义 judge 和 E2E replay
- 每次修改 `SKILL.md`、`hooks/*.py`、`artifact-check.yaml` 必须跑相关 eval 子集

---

## 10. 报告格式

`summary.md` 建议结构：

```markdown
# autoBizDevOps Eval Report

- Run ID:
- Commit:
- Time:
- Dataset version:

## Overview

| Area | Pass | Total | Rate |
|------|------|-------|------|
| Checkpoint | 120 | 120 | 100% |
| Artifact | 86 | 88 | 97.7% |
| Semantic | 41 | 50 | 82.0% |
| E2E Replay | 12 | 15 | 80.0% |

## Hard Contract Regressions

| Case | Expected | Actual | Error |
|------|----------|--------|-------|

## Semantic Quality Warnings

| Artifact | Score | Failed Dimension | Reason |
|----------|-------|------------------|--------|

## E2E First Failure Distribution

| Step | Count |
|------|-------|

## Recommended Fixes

1. ...
```

---

## 11. 需要特别注意的风险

### 11.1 不要只评估文档长得像不像

本项目最容易出现 “Markdown 章节齐全，但实际不可执行” 的问题。确定性规则只能做闸门，语义 judge 必须检查：

- 是否扎根真实代码路径
- 是否覆盖 PRD 验收标准
- 是否避免未确认硬约束
- 是否有可执行验证方法

### 11.2 不要让 judge 替代 hook

checkpoint、必需文件、verdict、任务状态这些都是机器可判定问题。必须先用 hook 判，judge 只处理语义质量。

### 11.3 不要一开始追求真实 agent 全流程重放

真实 agent 执行有模型波动、工具环境、用户交互、代码仓库状态等变量。冷启动阶段先做 fixture replay，才能把状态机和产物契约打牢。

### 11.4 不要忽略 `needs_fix`

`needs_fix` 是流程质量的关键出口，不是失败垃圾桶。eval 必须覆盖：

- 什么时候应该进入 `needs_fix`
- 报告中是否写明问题来源
- 建议回流阶段是否正确
- 从 `needs_fix` 回流是否合法

---

## 12. 最小可行版本（MVP）

如果只做一版最小可行 eval，建议范围如下：

1. `run_checkpoint_eval.py`
   - 覆盖所有合法转移
   - 每个 checkpoint 至少一个非法转移
   - 新增 feature 初始状态校验

2. `run_artifact_eval.py`
   - 覆盖 `autodev-plan`、`autodev-code`、`autodev-reviewer`
   - 覆盖 Biz `discuss` / `prd`
   - 覆盖 PLAN 状态和 verdict

3. `run_semantic_eval.py`
   - 只先评估 `design.md` 和 `PLAN.md`
   - 各 10 条样本

4. `aggregate_report.py`
   - 输出 summary json 和 markdown

这版 MVP 就能保护当前项目最关键的质量线：**状态不能乱跳，产物不能缺，设计和计划不能空转，评审不能自证完成。**
