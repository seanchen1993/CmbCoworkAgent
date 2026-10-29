import { describe, expect, it } from "vitest"
import { projectRuntimeRecoveryMessage } from "./project-runtime-message"

describe("native task recovery guidance", () => {
  it.each([
    ["PROJECT_TEMPLATE_PLUGIN_LIMIT", "移除不再使用的插件"],
    ["PROJECT_TEMPLATE_RESPONSE_LIMIT", "读取上限"],
    ["HOST_PROJECT_NAVIGATION_CHANGED", "重新打开阶段会话"],
    ["PROJECT_SEARCH_QUERY_INVALID", "缩短搜索条件"],
    ["project_check_input_limit", "检查尚未启动"],
    ["project_phase_preparation_unconfirmed", "核对前不会自动重跑或推进"],
    ["PROJECT_STAGE_DEBUG_ORIGINAL_BASELINE_REQUIRED", "回到原任务的阶段基线"],
    ["PROJECT_HOST_IMPORT_STAGE_REEXECUTION_REQUIRED", "重新执行技能"],
    ["PROJECT_HOST_IMPORT_SOURCE_MATERIAL_CHANGED", "不会自动恢复写入"],
    ["WORKTREE_DEADLINE_EXPIRED", "不会重置时限"],
    ["WORKTREE_DEADLINE_COMMAND_UNKNOWN", "不会自动重跑"],
    ["PROJECT_HOST_IMPORT_REVALIDATION_PENDING", "不能通过改步骤名称跳过验收"],
    ["PROJECT_HOST_IMPORT_PREFIX_BRANCH_UNSUPPORTED", "不能沿用旧批准"],
    ["PROJECT_HOST_IMPORT_REVIEW_NOT_RECORDED", "不能新建方案覆盖"],
    ["PROJECT_HOST_IMPORT_REVIEW_MISSING", "更新旧项目列表"],
    ["PROJECT_HOST_IMPORT_ADAPTER_UNAVAILABLE", "受支持的稳定点"],
    ["PROJECT_HOST_IMPORT_CHECKPOINT_UNKNOWN", "不会把旧成功记录"],
    ["PROJECT_HOST_IMPORT_ADAPTER_PARAMETERS_INVALID", "不填写目录或脚本"],
    ["PROJECT_HOST_IMPORT_SOURCE_MISSING", "不会补造"],
    ["PROJECT_HOST_IMPORT_ADAPTER_MAPPING_INVALID", "不会补造"],
    ["PROJECT_HOST_IMPORT_ADAPTER_LIMIT", "保留必需产物和检查"],
    ["PROJECT_STAGE_DEBUG_READONLY_ADAPTER_REQUIRED", "不能删除检查"],
    ["PROJECT_STAGE_DEBUG_CHECK_INPUT_UNSUPPORTED", "不能删除检查"],
    ["PROJECT_READONLY_CHECK_SCOPE_CHANGED", "不能删除检查"],
    ["PROJECT_HOST_IMPORTED_STAGE_REVALIDATION_REQUIRED", "重新验证导入成果"],
    ["PROJECT_HOST_IMPORT_REVIEW_CHANGED", "不会自动恢复写入"],
    ["PROJECT_HOST_IMPORT_CHECK_ADAPTER_REQUIRED", "不能沿用旧审批"],
    ["PROJECT_HOST_IMPORT_STAGE_CHECKS_REQUIRED", "不能沿用旧审批"],
    ["PROJECT_HOST_IMPORT_ARTIFACT_CHECK_REQUIRED", "不能沿用旧审批"],
    ["PROJECT_HOST_IMPORT_WORKSPACE_OVERLAP", "不会覆盖原成果"],
    ["FLOW_WORKSPACE_UNSETTLED", "不会自动重放"],
    ["PROJECT_INPUT_RESUME_BLOCKED", "回答已保留"],
    ["PROJECT_HOST_INPUT_RESUME_UNSAFE", "不要重新执行旧步骤"],
    ["PROJECT_HOST_RESULT_APPROVAL_MISMATCH", "重新检查成果"],
    ["PROJECT_HOST_PLAN_MIGRATION_RESOURCE_ADAPTER_REQUIRED", "固定版本"],
    ["PROJECT_HOST_PLAN_MIGRATION_COMPLETED_SKILL_CHANGED", "不能只替换后续步骤"],
    ["PROJECT_HOST_PLAN_MIGRATION_UNCHANGED", "没有可采用"],
    ["PROJECT_HOST_PLAN_MIGRATION_REVIEW_CHANGED", "重新检查"],
    ["PROJECT_HOST_WORKSPACE_OPERATION_ACTIVE", "不会自动重放"]
  ])("explains %s without suggesting unsafe replay", (error, instruction) => {
    expect(projectRuntimeRecoveryMessage(`Error invoking remote method: ${error}`)).toContain(instruction)
  })

  it("leaves unrelated failures to the original diagnostic handling", () => {
    expect(projectRuntimeRecoveryMessage("ARBITRARY_FAILURE")).toBeUndefined()
  })
})
