---
name: autodev-e2e
description: 固定 Code Workflow 的 B-E2E 内部执行协议。以 Playwright Test、质量扫描和 Evidence 支持 V-E2E 子阶段；不创建独立 E2E checkpoint。
version: v1.3.0917
---

# /autodev-e2e - 端到端测试

以脚本派生的质量门禁、Playwright JSON report、Evidence、`E2E_RESULT.json` 与 JSONL 运行日志为完成标准。探索、截图或静态代码存在不能裁定 PASS。

## 运行契约

写入：

- `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/E2E_TEST_CASES.yaml`
- `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/E2E_QUALITY_SCAN.json`
- `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/E2E_RESULT.json`
- `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/e2e-run.log`
- `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/evidence/EVIDENCE.jsonl`
- `${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}/e2e-diagnostics/round-<index>/*`
- 可选 `E2E_REPORT.md`；失败回流时可选 `FIX_REQUEST.json`

`E2E_TEST_CASES.yaml` 是唯一用例计划。Markdown 报告只提供人类视图。

## 建立上下文与恢复

```bash
python -X utf8 "${pluginPath}/hooks/inspect_skill_contract.py" autodev-e2e --feature "${feature}" --plain
python -X utf8 "${pluginPath}/read_state_json.py" --feature "${feature}"
```

只能在固定 Code Workflow 已创建并启动 V-E2E 的 `e2e_test` 子阶段后执行。全局 checkpoint 保持 `code_in_progress`；不得写入 `e2e_in_progress` 或 `e2e_done`。

读取 `PRD.md`、`source-context.json`、`sources/` 快照、`specs/**/*.md`、`design.md`、`plan.json`、batch plan、`REQUIREMENTS_EVAL.md`、单测结果和项目 Playwright 配置。逐项读取其中登记的资料及对应快照；同时读取 reviewer 的 `External Interface Coverage` 与 `E2E Focus`。`deferredValidationIssues[]` 映射到具体用例或明确的 manual/missing 结论。

PRD 中类型为外部接口的每个 `SRC-NNN` 必须在 `E2E_TEST_CASES.yaml` 的 `source.external_sources` 中至少出现一次，并有对应的机械断言。只允许在测试/沙箱环境执行有副作用调用；生产环境只做用户明确授权的只读验证。没有安全环境或凭据时保留用例并形成 BLOCKED/missing 证据；来源为 `snapshot_only` 时直接读取快照，不向用户索要原件。

恢复时读取全部 E2E 机器产物和 `e2e-diagnostics/**/**/*.pending.json`。旧格式 `E2E_RESULT.json` 或纯文本 `e2e-run.log` 只读保留，列出需重新执行的用例；旧产物不能形成新 PASS。存在 pending 时执行：

```bash
python -X utf8 "${pluginPath}/hooks/run_e2e_command.py" resume \
  --workspace "${pluginWorkspace}/${projectDir}" \
  --feature "${feature}" \
  --run-id "<runId>"
```

## 生成用例并开轮

读取 [`${pluginPath}/skills/autodev/autodev-e2e/reference/testcase-generation.md`](reference/testcase-generation.md)，生成或更新 `E2E_TEST_CASES.yaml`。每条持久化 Playwright 测试以完整 tag 或标题标记 `[<caseId>]` 精确绑定 case。

首次执行：

```bash
python -X utf8 "${pluginPath}/hooks/e2e_result_writer.py" init \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}"
python -X utf8 "${pluginPath}/hooks/e2e_result_writer.py" add-case \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}" \
  --task-id "<taskId>" --spec-ref "<spec#REQ-NNN>" --spec-ref "<spec#SCN-NNN>" \
  --priority P0 --ui-required true --execution-mode mixed \
  --step-json '{"action":"<action>","expected":"<visible result>","verification":{"type":"ui","details":"<mechanical assertion>"}}'
python -X utf8 "${pluginPath}/hooks/e2e_result_writer.py" begin-round \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}" --kind initial
```

任何测试资产或源码修复前开 repair 轮；最多三轮：

```bash
python -X utf8 "${pluginPath}/hooks/e2e_result_writer.py" begin-round \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}" --kind repair
```

## 有头探索与持久化资产

`ui_required: true` 的 P0/P1 优先使用 DevClaw 内置的有头 Chrome Playwright CLI 探索真实页面。确认入口 URL、可访问名称、稳定 locator、鉴权、测试数据、console 与 network；探索不写 verdict Evidence。

读取 [`${pluginPath}/skills/autodev/autodev-e2e/reference/test-playwright-script.md`](reference/test-playwright-script.md)。复用项目配置、fixture、helper 与 Page Object；缺失时只补当前 feature 的最小资产。持久化 spec 不使用探索 snapshot 的临时元素引用，认证通过项目 setup 或明确 `storageState` 建立。

探索、服务与鉴权事实写 JSONL note：

```bash
python -X utf8 "${pluginPath}/hooks/run_e2e_command.py" note \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}" \
  --phase discovery --text "<URL、auth、service、locator 或诊断摘要>"
```

## 质量门禁

读取 [`${pluginPath}/skills/autodev/autodev-e2e/reference/e2e-quality-gate.md`](reference/e2e-quality-gate.md)。先扫描持久化 spec 及其依赖：

```bash
python -X utf8 "${pluginPath}/hooks/e2e_quality_check.py" scan \
  --workspace "${pluginWorkspace}/${projectDir}" \
  --feature "${feature}" \
  --code-workspace "<assignment workspaceRef 的绝对仓库路径>" \
  --spec-path "<relative Playwright spec>" \
  --input "<语义审查实际读取的源文件>"
```

无法解析的 alias、barrel、动态 import 或自定义 fixture 注入用保守目录哈希补齐后重扫：

```bash
python -X utf8 "${pluginPath}/hooks/e2e_quality_check.py" scan \
  --workspace "${pluginWorkspace}/${projectDir}" \
  --feature "${feature}" \
  --code-workspace "<assignment workspaceRef 的绝对仓库路径>" \
  --spec-path "<relative Playwright spec>" \
  --input-dir "<relative conservative directory>"
```

逐条裁定 candidate；误报使用 `dismissed` 并填写理由，真实问题使用 `confirmed` 后修复和重扫。语义审查新问题以 `semantic:<name>` 登记。

```bash
python -X utf8 "${pluginPath}/hooks/e2e_quality_check.py" resolve \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}" \
  --finding-id "<findingId>" --status dismissed \
  --reviewer autodev-e2e --rationale "<why false positive>" \
  --input "<reviewed source>"
python -X utf8 "${pluginPath}/hooks/e2e_result_writer.py" sync-quality-gate \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}"
```

任一未裁定或确认的 blocker、未解析 import、登记输入哈希变化都阻断 verdict。语义审查还必须逐项核对用例声明的来源、对应快照、测试请求与机械断言；缺少来源覆盖、实际调用证据或安全可执行环境均阻断 PASS。

## 干净上下文裁定

每个 case 单独用 `--grep <caseId>` 重放；浏览器跟随项目配置。只接受直接 Playwright Test 命令，不使用探索 CLI 或 `npm/pnpm/yarn run` 包脚本。

```bash
python -X utf8 "${pluginPath}/hooks/run_e2e_command.py" run \
  --workspace "${pluginWorkspace}/${projectDir}" \
  --feature "${feature}" \
  --code-workspace "<assignment workspaceRef 的绝对仓库路径>" \
  --case-id "<caseId>" --task-id "<taskId>" \
  --spec-ref "<spec#REQ-NNN>" --spec-ref "<spec#SCN-NNN>" \
  --spec-path "<relative Playwright spec>" \
  --entry-url "<URL>" --auth-status "<bypassed|pre_authenticated|not_required>" \
  -- npx --yes --package @playwright/test playwright test \
  "<relative Playwright spec>" --grep "<caseId>"
```

执行器注入 JSON reporter，记录实际 Playwright version、project、配置与报告哈希，派生 PASS/FAIL/FLAKY/BLOCKED，并按同一 `runId` 提交 Evidence、`verdict_run` 日志和 execution。中断后使用 pending 的 `runId` 恢复，不重跑命令。

## 失败分类与修复

固定诊断顺序：复现 → trace/report → console/network → 分类 → 最小修复或回流。

| 分类 | 处置 | FIX_REQUEST 映射 |
|---|---|---|
| `test_bug` | 只修 spec、fixture、Page Object、mock、测试辅助、测试数据或 E2E 配置 | 不生成 |
| `source_bug` | 当前 feature 最小源码修复；越界停止 | `implementation_bug` → `code_in_progress` |
| `contract_gap` | 不猜测预期，回流规格或设计 | `spec_gap` / `requirement_ambiguous` → `specs_in_progress`；`design_conflict` → `design_in_progress` |
| `environment` | 记录服务、依赖、浏览器、命令证据 | `environment_issue` → `cicd_in_progress` |
| `auth` | 记录身份、方法、缺失权限，不记录敏感值 | `permission_issue` → `cicd_in_progress`，`humanActionRequired: true` |
| `data` | 记录缺失数据与最小准备条件 | `dependency_issue` → `cicd_in_progress` |
| `flaky` | 用重复结果与诊断定位；不增加 retry、timeout 或固定 sleep 洗绿 | 不生成；预算内未定位按 unknown |
| `unknown` | 停止猜测性修复，记录已排除项 | `unknown` → `code_in_progress`，`humanActionRequired: true` |

每次 repair 轮重跑质量扫描与全部用例。修复预算耗尽、根因不清或超出 feature 时停止。

## 派生 coverage 与最终 verdict

```bash
python -X utf8 "${pluginPath}/hooks/e2e_result_writer.py" derive-scenario-coverage \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}"
python -X utf8 "${pluginPath}/hooks/e2e_result_writer.py" finalize \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}"
python -X utf8 "${pluginPath}/hooks/e2e_result_writer.py" validate \
  --workspace "${pluginWorkspace}/${projectDir}" --feature "${feature}" --gate
```

`finalize` 只在质量门禁、本轮 execution、新鲜 Evidence、coverage、三方字段与哈希链全部成立时派生 case/root PASS。不存在写 PASS 的人工参数。

PASS 时由固定 Workflow 完成 V-E2E 的 `e2e_test` 子阶段并聚合证据。FAIL/BLOCKED 时保留分类、诊断和失败元数据，由固定 Workflow 创建受控修复入口；不得在本技能中更新全局 checkpoint。

## 完成交接

`FEATURE_API_DETAIL.md` 生成与产物上传由独立的 [`/autobizdevops-artifact-sync`](../../autobizdevops-artifact-sync/SKILL.md) 负责。用户请求同步时进入该技能，不作为 E2E verdict 或完成门禁。

技能完成后，读取并遵循 `${pluginPath}/skills/references/ui-continuation-guide.md`。
