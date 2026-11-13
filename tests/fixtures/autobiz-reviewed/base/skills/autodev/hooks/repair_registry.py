#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""产物契约预检的修复信息注册表。

每个 reason 一条记录，回答四个问题：哪个产物、定位到哪、什么问题、怎么改。
放在注册表而不是散在 142 个 ``fail_line`` 调用点，是为了让「新增一个失败但
没写修复动作」能被枚举式契约测试直接抓住——调用点只负责传 ``target``。

``problem`` / ``action`` 用 ``str.format_map`` 渲染，可用占位符：
``{target}`` 以及调用点通过 ``fields=`` 传入的任意键；缺失的键渲染成空串，
预检不能因为文案参数缺失而崩掉。
"""

from __future__ import annotations

from typing import Dict, NamedTuple


# route 取值闭集；调用方按当前产物修复、回流或用户裁定处理。
ROUTE_FIX_CURRENT = "fix_current"      # 在当前阶段按 action 修
ROUTE_RETURN_SPECS = "return_specs"    # 停止当前阶段，回 dev.specs
ROUTE_RETURN_PLAN = "return_plan"      # 停止当前阶段，回 dev.plan
ROUTE_ASK_USER = "ask_user"            # 必须回到用户确认，禁止自行填值

ROUTES = (ROUTE_FIX_CURRENT, ROUTE_RETURN_SPECS, ROUTE_RETURN_PLAN, ROUTE_ASK_USER)


# plan 机器产物的编辑禁令。只在 plan.json / PLAN.md 相关错误里输出，
# 不在技能正文里重复枚举。
PLAN_NO_HAND_EDIT = (
    "禁止直接编辑 plan.json / plans/Bxxx/plan.json / PLAN.md（PLAN.md 是投影视图）。"
)

# Plan v2 的唯一修正路径：review plan 只能整份重建，不能逐条修补。
PLAN_REPUBLISH = (
    "Critic 前的 review plan：修正 Plan v2 输入后用 hooks/plan_writer.py prepare-plan 整份覆盖并重新回检；"
    "plan.json 已定稿后才通过 Plan rollback 回到 plan_in_progress，再重走生成与回检。"
)


class Repair(NamedTuple):
    artifact: str
    problem: str
    action: str
    route: str = ROUTE_FIX_CURRENT


class _BlankDict(dict):
    def __missing__(self, key: str) -> str:  # pragma: no cover - 平凡分支
        return ""


def render(template: str, target: str, fields: Dict[str, str] | None = None) -> str:
    values = _BlankDict(fields or {})
    values.setdefault("target", target)
    try:
        return template.format_map(values)
    except (IndexError, ValueError):
        # 文案里出现了不合法的花括号；宁可原样输出也不要让预检挂掉。
        return template


# --------------------------------------------------------------------------
# 入场 / 早退路径（run_postcheck 在跑 validator 之前就可能失败）
# --------------------------------------------------------------------------

_ENTRY: Dict[str, Repair] = {
    "missing_required_artifacts": Repair(
        artifact="{target}",
        problem="本阶段的必备产物缺失或为空：{target}",
        action=(
            "先把缺失产物生成出来再重跑预检。proposal.md / specs/<capability>/spec.md 由 "
            "/autodev-specs 生成；design.md 由 /autodev-design 生成；plan.json 通过"
            "hooks/plan_writer.py prepare-plan 生成，PLAN.md 通过 publish-plan 投影，" + PLAN_NO_HAND_EDIT
        ),
    ),
    "missing_feature_dir": Repair(
        artifact="{target}",
        problem="Feature 目录不存在：{target}",
        action="确认 --feature / FEATURE_ID 与看板上的 Feature 一致；不一致时用正确的 feature 重跑，不要手工创建目录。",
    ),
    "invalid_board_config": Repair(
        artifact="board_core/board_config.json",
        problem="工作流契约加载失败：{target}",
        action="这是配置问题不是产物问题：修正 board_config.json 后重跑；不要为了绕过它改产物。",
    ),
    "unknown_validator": Repair(
        artifact="board_core/board_config.json",
        problem="节点声明了未注册的 validator：{target}",
        action="在 skills/autodev/hooks/artifact_check.py 的 VALIDATORS 中注册该 validator，或从 board_config.json 移除该声明。",
    ),
}


# --------------------------------------------------------------------------
# dev.specs
# --------------------------------------------------------------------------

_SPECS: Dict[str, Repair] = {
    "invalid_source_context": Repair(
        artifact="source-context.json / sources/",
        problem="来源索引或快照不合法：{target}",
        action="按预检详情修正 source-context.json 的来源、快照路径或 targets 后重跑；已有快照时不要改成 never_provided。",
    ),
    "missing_proposal": Repair(
        artifact="proposal.md",
        problem="proposal.md 不存在或为空",
        action="生成非空 proposal.md，在「## Capabilities」中列出能力名及说明，与 specs/<capability>/spec.md 对应。",
    ),
    "missing_specs": Repair(
        artifact="specs/**/spec.md",
        problem="specs/ 下没有任何非空 spec.md",
        action="至少生成一个 specs/<capability>/spec.md，capability 名取自 proposal.md 的「## Capabilities」节。",
    ),
    "invalid_proposal_missing_section": Repair(
        artifact="proposal.md",
        problem="proposal.md 缺少必备章节「{target}」",
        action="在 proposal.md 补齐「## {target}」，用 kebab-case 能力名列表对应实际 spec 文件。",
    ),
    "artifact_template_guidance_residue": Repair(
        artifact="{target}",
        problem="{target} 里残留了模板的写作指引或占位符，不是真实内容",
        action="删掉模板指引行与 [占位符]，换成本 Feature 的真实内容；整段无内容时写「无」，不要保留模板示例。",
    ),
    "invalid_implementation_scope": Repair(
        artifact=".autobizdevops/features/<feature>/implementation-scope.json",
        problem="实现范围声明不合法：{target}",
        action="使用 hooks/implementation_scope.py set 写入 full_stack、backend_only 或 frontend_only，并确保 featureId 与当前 Feature 一致。",
    ),
    "invalid_spec_missing_requirement": Repair(
        artifact="{target}",
        problem="{target} 没有任何合法 Requirement",
        action="按「### Requirement REQ-NNN: <标题>」写出 Requirement，NNN 使用三位数字。",
    ),
    "invalid_spec_missing_scenario": Repair(
        artifact="{target}",
        problem="{target} 没有任何合法 Scenario",
        action="按「#### Scenario SCN-NNN: <标题>」补 Scenario，并归属到本文件已有的 Requirement 下。",
    ),
    "spec_contract_heading_malformed": Repair(
        artifact="{target}",
        problem="{target} 中的契约标题写法不规范，索引器读不到：{headings}",
        action=(
            "把报错的标题改成「### Requirement REQ-NNN: <标题>」/"
            "「#### Scenario SCN-NNN: <标题>」。NNN 是三位数字，ID 外的方括号可有可无。"
        ),
    ),
    "spec_id_width_invalid": Repair(
        artifact="{target}",
        problem="{target} 中的规格 ID {id} 不是三位数字",
        action=(
            "把 {id} 改为 {suggested}，并同步已有引用。"
            "该错误只处理位数，不要改 Requirement 内容。"
        ),
    ),
    "spec_requirement_without_scenario": Repair(
        artifact="{target}",
        problem="{target} 中这些 Requirement 自身块内没有 Scenario：{requirements}",
        action=(
            "为报错的每个 Requirement 补至少一个「#### Scenario SCN-NNN: <标题>」；"
            "REMOVED Requirement 用 Scenario 描述旧入口被触发时的期望响应。"
        ),
    ),
    "spec_scenario_without_requirement": Repair(
        artifact="{target}",
        problem="{target} 中这些 Scenario 不归属任何 Requirement：{scenarios}",
        action=(
            "把报错的每个 Scenario 移到它所属的「### Requirement REQ-NNN:」标题之下；"
            "Scenario 出现在首个 Requirement 之前或操作段标题正下方时不归属任何 Requirement。"
        ),
    ),
    "duplicate_spec_id_across_specs": Repair(
        artifact="specs/**/spec.md",
        problem="{target} 在多个 spec 中重复定义：{files}",
        action=(
            "ID 在同一 feature 内必须全局唯一——覆盖检查按扁平 ID 集合判定，"
            "重号会让覆盖其中一个就算覆盖全部。给其中一处换一个未使用的编号，"
            "并同步所有引用它的地方。"
        ),
    ),
    "duplicate_requirement_id": Repair(
        artifact="{target}",
        problem="{target} 中存在重复的 REQ 编号",
        action="REQ 编号在同一 Feature 内全局唯一：把重复项改成未使用的新编号；已删除的编号不复用。",
    ),
    "duplicate_scenario_id": Repair(
        artifact="{target}",
        problem="{target} 中存在重复的 SCN 编号",
        action="SCN 编号在同一 Feature 内全局唯一：把重复项改成未使用的新编号；已删除的编号不复用。",
    ),
    "proposal_capability_missing_spec": Repair(
        artifact="specs/**/spec.md",
        problem="proposal.md 列出的这些 capability 没有对应 spec：{target}",
        action=(
            "为报错的每个 capability 生成 specs/<capability>/spec.md；"
            "若该 capability 不该单独成 spec，回 proposal.md 将其移除或并入其他 capability。"
        ),
    ),
    "spec_missing_proposal_capability": Repair(
        artifact="proposal.md",
        problem="这些 spec 目录在 proposal.md 的 Capabilities 中没有出处：{target}",
        action=(
            "把报错的每个 capability 补进 proposal.md 的「## Capabilities」列表；"
            "若该 spec 不属于本轮范围，删除对应 specs/<capability>/ 目录。"
        ),
    ),
}


# --------------------------------------------------------------------------
# dev.design — design.md
# --------------------------------------------------------------------------

_DESIGN: Dict[str, Repair] = {
    "missing_design": Repair(
        artifact="design.md",
        problem="design.md 不存在或为空",
        action="生成 design.md，必备章节为 Context / 输入上下文、Code Evidence、Spec Traceability、API Decisions、Data Decisions、Technical Design、Risks / Open Questions。",
    ),
    "invalid_design_contract": Repair(
        artifact="design.md",
        problem="design.md 无法作为设计契约读取：{detail}",
        action="修复 design.md 的编码或读取错误，确保文件为有效 UTF-8 文本，再重新生成 Plan。",
    ),
    "invalid_design_missing_section": Repair(
        artifact="design.md",
        problem="design.md 缺少必备章节「{target}」",
        action="在 design.md 补齐「{target}」节，写本 Feature 的真实内容；无内容时写「无」并说明理由。",
    ),
    "missing_design_api_marker": Repair(
        artifact="design.md",
        problem="design.md 缺少 x-auto-no-http-api 标记",
        action="在 API Decisions 节写入 `x-auto-no-http-api: true|false`：本轮不涉及 HTTP 接口写 true，涉及写 false 并列出 API-NNN 定义。",
    ),
    "missing_design_data_marker": Repair(
        artifact="design.md",
        problem="design.md 缺少 x-auto-no-sql 标记",
        action="在 Data Decisions 节写入 `x-auto-no-sql: true|false`：本轮不涉及数据结构变更写 true，涉及写 false 并列出 DATA-NNN 定义。",
    ),
    "design_api_marker_conflicts_with_definitions": Repair(
        artifact="design.md",
        problem="x-auto-no-http-api=true 与已有 API 定义冲突：{detail}",
        action="若本轮存在 HTTP API，将 x-auto-no-http-api 改为 false；否则删除不属于本轮的 API-NNN 定义。",
    ),
    "design_data_marker_conflicts_with_definitions": Repair(
        artifact="design.md",
        problem="x-auto-no-sql=true 与已有 DATA 定义冲突：{detail}",
        action="若本轮存在数据结构变更，将 x-auto-no-sql 改为 false；否则删除不属于本轮的 DATA-NNN 定义。",
    ),
    "design_has_pending_cells": Repair(
        artifact="design.md",
        problem="design.md 仍有待确认单元格（{target}）",
        action="这些内容影响行为且没有依据，禁止自行填值：把每一处待确认整理成问题回到用户确认，拿到答复后再写入 design.md。",
        route=ROUTE_ASK_USER,
    ),
    "design_decision_ref_unresolved": Repair(
        artifact="design.md",
        problem="design.md 引用的 DEC 编号在 proposal.md 的「## Decision Log」节内不存在：{target}",
        action=(
            "把该单元格改成 proposal.md 的「## Decision Log」中实际存在的编号；没有对应规格决策时写「无」。"
            "不要为满足引用而补造决策记录。"
            "技术决策用 Design Coverage 列的 D-NNN，不要写进 Decision 列。"
        ),
    ),
    "duplicate_design_api_id": Repair(
        artifact="design.md",
        problem="design.md 中存在重复的 API 编号",
        action="API 编号在同一 Feature 内唯一：把重复项改成未使用的新编号，并同步 plan 中引用它的任务。",
    ),
    "duplicate_design_data_id": Repair(
        artifact="design.md",
        problem="design.md 中存在重复的 DATA 编号",
        action="DATA 编号在同一 Feature 内唯一：把重复项改成未使用的新编号，并同步 plan 中引用它的任务。",
    ),
    "duplicate_design_decision_id": Repair(
        artifact="design.md",
        problem="design.md 中存在重复的 D（技术决策）编号",
        action="D 编号在同一 Feature 内唯一：把重复项改成未使用的新编号，并同步 plan 中引用它的任务。",
    ),
}


# --------------------------------------------------------------------------
# dev.plan — plan.json / 引用 / 覆盖 / 粒度
# --------------------------------------------------------------------------

_PLAN: Dict[str, Repair] = {
    "missing_json_artifact": Repair(
        artifact="{target}",
        problem="必需的 JSON 事实源缺失：{target}",
        action="按当前阶段 writer 契约生成该 JSON；UI_CONTEXT.json 使用 hooks/ui_context_writer.py，计划使用 hooks/plan_writer.py prepare-plan。",
    ),
    "invalid_ui_context_json": Repair(
        artifact="UI_CONTEXT.json",
        problem="UI_CONTEXT.json 不满足 UI 事实源契约：{target}",
        action="使用 hooks/ui_context_writer.py 修正 UI 范围、页面、交互和视觉源，不要绕过 UI validator。",
    ),
    "plan_ui_task_when_feature_not_ui": Repair(
        artifact="plan.json",
        problem="{target} 标记为 UI 任务，但 UI_CONTEXT.json 声明当前 Feature 不需要 UI",
        action="以 UI_CONTEXT.json 为事实源：确认需要 UI 时先回上游修正并锁定 UI_CONTEXT；否则去掉该任务 Plan v2 输入中的 ui 字段。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_ui_refs_when_feature_not_ui": Repair(
        artifact="plan.json",
        problem="{target} 在非 UI Feature 中携带 uiRefs",
        action="去掉非 UI 任务 Plan v2 输入中的 ui 字段。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_ui_refs_for_non_ui_task": Repair(
        artifact="plan.json",
        problem="{target} 未标记为 UI 任务却携带 uiRefs",
        action="根据 UI_CONTEXT.json 决定该任务是否为 UI 任务，据此保留或去掉 Plan v2 输入中的 ui 字段。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_ui_task_missing_uiRefs": Repair(
        artifact="plan.json",
        problem="{target} 是 UI 任务但缺少 uiRefs",
        action="按 UI_CONTEXT.json 为该任务补齐 Plan v2 输入的 ui.pages、ui.interactions 和 ui.route。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "invalid_plan_ui_refs": Repair(
        artifact="plan.json",
        problem="{target} 的 UI 引用字段不是字符串数组",
        action="按 UI_CONTEXT.json 中的稳定 ID 修正 Plan v2 输入的 ui 字段；不要手工猜测页面、交互或视觉源 ID。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_plan_ui_refs": Repair(
        artifact="plan.json",
        problem="{target} 缺少必需的页面或交互引用",
        action="从 UI_CONTEXT.json 补齐 Plan v2 输入中对应的 PAGE/UIX 引用。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "unknown_plan_ui_ref": Repair(
        artifact="plan.json",
        problem="{target} 引用了 UI_CONTEXT.json 中不存在的 ID",
        action="核对 UI_CONTEXT.json 中的 PAGE/UIX/VIS ID，在 Plan v2 输入中改为现有稳定 ID。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "invalid_plan_ui_frontend_route": Repair(
        artifact="plan.json",
        problem="{target} 的 frontendRoute 非法",
        action="用 frontend route resolver 基于 UI_CONTEXT.json 解析合法路线，写入 Plan v2 输入的 ui.route。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_ui_visual_source_projection_mismatch": Repair(
        artifact="plan.json",
        problem="{target} 的视觉源投影与 UI_CONTEXT.json capability 不一致",
        action="visualSourceRefs 由 writer 按任务命中的 capability 自动投影：核对 UI_CONTEXT.json 的 capability 与该任务的 ui.pages。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_ui_route_without_visual_source": Repair(
        artifact="plan.json",
        problem="{target} 没有视觉源却选择了 HTML 前端路线",
        action="没有 VIS 输入时 ui.route 使用 spec-driven-ui；有 HTML/设计输入时先将其登记到 UI_CONTEXT.json。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_ui_frontend_route_mismatch": Repair(
        artifact="plan.json",
        problem="{target} 的 frontendRoute 与视觉源类型不一致",
        action="使用 frontend route resolver 按 VIS 类型重新解析路线，写入 Plan v2 输入的 ui.route。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_ui_required_without_ui_task": Repair(
        artifact="plan.json",
        problem="UI_CONTEXT.json 要求 UI，但计划中没有 UI 实现任务",
        action="为 UI_CONTEXT.json 中的 UI capability 建立至少一个带 ui 字段的 Plan v2 任务。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_plan_json": Repair(
        artifact="plan.json",
        problem="plan.json 不存在或为空{target}",
        action="plan.json 是任务 DAG 的机器事实源，用 hooks/plan_writer.py prepare-plan 生成。" + PLAN_NO_HAND_EDIT,
    ),
    "invalid_plan_json": Repair(
        artifact="plan.json",
        problem="plan.json 结构不合法：{target}",
        action="修正 Plan v2 输入，不要就地改字段。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_task_set_not_finalized": Repair(
        artifact="plan.json",
        problem="任务集尚未定稿（taskSetStatus != finalized）",
        action="Plan Critic 收敛后，用 hooks/plan_writer.py publish-plan 将 review plan 定稿为 finalized 并投影 PLAN.md。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_implementation_scope_mismatch": Repair(
        artifact="plan.json",
        problem="plan.json 的 implementationScope 与 Feature 声明的实现范围不一致：{target}",
        action="回到 /autodev-plan 重新生成 plan.json，禁止手工修改 uiRequired 绕过范围门禁。" + PLAN_NO_HAND_EDIT,
    ),
    "missing_design_api_id": Repair(
        artifact="design.md",
        problem="design.md 的 API Decisions 没有可引用的 API 编号（{target}）",
        action="在 design.md 的 API Decisions 节补出 API-NNN 定义；本轮确实无 HTTP 接口时把 x-auto-no-http-api 置 true。",
    ),
    "missing_design_data_id": Repair(
        artifact="design.md",
        problem="design.md 的 Data Decisions 没有可引用的 DATA 编号（{target}）",
        action="在 design.md 的 Data Decisions 节补出 DATA-NNN 定义；本轮确实无数据结构变更时把 x-auto-no-sql 置 true。",
    ),
    "missing_plan_json_requirement_ref": Repair(
        artifact="plan.json",
        problem="{target} 没有引用任何 Requirement",
        action="在 Plan v2 输入的 refs.requirements 中补上该任务实际实现的 REQ。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_plan_json_scenario_ref": Repair(
        artifact="plan.json",
        problem="{target} 没有引用任何 Scenario",
        action="在 Plan v2 输入的 refs.scenarios 中补上该任务实际实现的 SCN（逐条展开、全限定）。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_plan_json_decision_ref": Repair(
        artifact="plan.json",
        problem="{target} 没有引用任何设计依据（API/DATA/D）",
        action="在 Plan v2 输入的 refs.api / refs.data / refs.decisions 中补上该任务对应的 design.md 锚点。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "unknown_plan_json_requirement_ref": Repair(
        artifact="plan.json",
        problem="{target} 引用的 REQ 在 specs 中不存在",
        action=(
            "先核对是不是编号写错：写错就在 Plan v2 输入的 refs.requirements 中改成正确的 REQ 后重新发布。"
            "若 specs 里确实没有这条需求，停止 plan 阶段回 dev.specs 补定义，不要在 plan 里编一个。"
            + PLAN_NO_HAND_EDIT
        ),
    ),
    "unknown_plan_json_scenario_ref": Repair(
        artifact="plan.json",
        problem="{target} 引用的 SCN 在 specs 中不存在",
        action=(
            "先核对是不是编号写错：写错就在 Plan v2 输入的 refs.scenarios 中改成正确的 SCN 后重新发布。"
            "若 specs 里确实没有这条场景，停止 plan 阶段回 dev.specs 补定义，不要在 plan 里编一个。"
            + PLAN_NO_HAND_EDIT
        ),
    ),
    "unknown_plan_json_api_ref": Repair(
        artifact="design.md",
        problem="{target} 引用的 API 编号在 design.md 中未定义",
        action="编号写错就在 Plan v2 输入的 refs.api 中改正后重新发布；design.md 确实还没定义就先在 API Decisions 节补出该 API-NNN。",
    ),
    "unknown_plan_json_data_ref": Repair(
        artifact="design.md",
        problem="{target} 引用的 DATA 编号在 design.md 中未定义",
        action="编号写错就在 Plan v2 输入的 refs.data 中改正后重新发布；design.md 确实还没定义就先在 Data Decisions 节补出该 DATA-NNN。",
    ),
    "unknown_plan_json_decision_ref": Repair(
        artifact="design.md",
        problem="{target} 引用的 D（技术决策）编号在 design.md 中未定义",
        action="编号写错就在 Plan v2 输入的 refs.decisions 中改正后重新发布；design.md 确实还没定义就先在 Technical Design 节补出该 D-NNN。",
    ),
    "plan_api_ref_forbidden_by_design_marker": Repair(
        artifact="plan.json",
        problem="{target} 引用了 API，但 design.md 声明 x-auto-no-http-api=true：{detail}",
        action="Design 是事实源：从 Plan v2 输入的 refs.api 中移除该 API 引用。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "plan_data_ref_forbidden_by_design_marker": Repair(
        artifact="plan.json",
        problem="{target} 引用了 DATA，但 design.md 声明 x-auto-no-sql=true：{detail}",
        action="Design 是事实源：从 Plan v2 输入的 refs.data 中移除该 DATA 引用。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_plan_json_api_coverage": Repair(
        artifact="plan.json",
        problem="design.md 定义的 API {target} 没有被任何实现任务覆盖",
        action="把该 API 写进实际实现它的任务的 refs.api；若本轮不实现，回 design.md 明确标注无需实现。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_plan_json_data_coverage": Repair(
        artifact="plan.json",
        problem="design.md 定义的 DATA {target} 没有被任何实现任务覆盖",
        action="把该 DATA 写进实际实现它的任务的 refs.data；若本轮不实现，回 design.md 明确标注无需实现。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_plan_json_decision_coverage": Repair(
        artifact="plan.json",
        problem="design.md 定义的技术决策 {target} 没有被任何实现任务覆盖",
        action="把该 D 写进落实它的主交付任务的 refs.decisions；若本轮不落实，回 design.md 明确标注无需实现。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_plan_scenario_coverage": Repair(
        artifact="plan.json",
        problem="specs 中这些 Scenario 没有被任何任务覆盖：{target}",
        action="把报错的每个 SCN 写进实际实现它的任务的 refs.scenarios。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "invalid_plan_task_scenario_reference": Repair(
        artifact="plan.json",
        problem="{target} 的 specRefs 里 Scenario 引用没有逐条展开或没有全限定",
        action="把 refs.scenarios 写成逐条展开的全限定形式（一个 SCN 一项，不用区间/通配）。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "oversized_plan_task_must_split": Repair(
        artifact="plan.json",
        problem="{target} 超出单任务上限：{detail}",
        action="按报错里超限的那个维度拆分该任务（场景/接口/页面/交互），拆成多个仍然是用户可观察 vertical slice 的任务。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "invalid_plan_task_matrix_validation": Repair(
        artifact="plan.json",
        problem="{target} 的验证矩阵不合法：{detail}",
        action="按报错维度补齐该任务的 testPoints 与 verification.intent，确保每个场景都有可自行判读的验证。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "invalid_artifact_ref": Repair(
        artifact="plan.json",
        problem="{target} 的引用格式不合法：{detail}",
        action="引用写成 `<文件路径>#<锚点>` 形式（如 specs/<capability>/spec.md#REQ-001、design.md#API-001）。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "invalid_artifact_ref_format": Repair(
        artifact="plan.json",
        problem="{target} 的引用格式不合法：{detail}",
        action="引用写成 `<文件路径>#<锚点>` 形式（如 specs/<capability>/spec.md#REQ-001、design.md#API-001）。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "invalid_artifact_ref_type": Repair(
        artifact="plan.json",
        problem="{target} 的引用类型与字段不匹配：{detail}",
        action="refs.requirements / refs.scenarios 只放 REQ/SCN，refs.api / refs.design / refs.data / refs.decisions 只放对应 Design ID。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "ambiguous_ref_anchor": Repair(
        artifact="plan.json",
        problem="{target} 的短引用无法唯一定位：{detail}",
        action="把短引用改成带相对文件路径的完整形式 `<文件路径>#<锚点>`。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_ref_file": Repair(
        artifact="plan.json",
        problem="{target} 引用的文件不存在：{detail}",
        action="核对路径是否写错；文件确实还没生成时，先补齐上游产物（specs 缺失回 dev.specs，design 缺失就地补写）。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
    "missing_ref_anchor": Repair(
        artifact="plan.json",
        problem="{target} 引用的锚点在目标文件中不存在：{detail}",
        action="核对编号是否写错；目标文件确实没有该定义时，specs 缺失回 dev.specs 补，design 缺失就地在 design.md 补。" + PLAN_REPUBLISH + PLAN_NO_HAND_EDIT,
    ),
}


REPAIRS: Dict[str, Repair] = {}
REPAIRS.update(_ENTRY)
REPAIRS.update(_SPECS)
REPAIRS.update(_DESIGN)
REPAIRS.update(_PLAN)


# ``invalid_plan_json`` 的 detail 是 plan_json.py 的扁平码。高频码给精确动作，
# 其余走 REPAIRS["invalid_plan_json"] 兜底——兜底同样带完整五字段。
_PLAN_JSON_CODE_ACTIONS = (
    ("monolithic_plan_requires_rebuild", "根 plan.json 不得内联 tasks：用 hooks/plan_writer.py prepare-plan 重建成「根索引 + plans/Bxxx/plan.json 批次」结构。"),
    ("legacy_plan_requires_rebuild", "这是旧版 plan.json：用 hooks/plan_writer.py prepare-plan 重建 Plan v2，不要手工补字段。"),
    ("plan_json_missing_feature_id", "plan.json 缺 featureId：重新发布 Plan v2，featureId 必须与当前 Feature 一致。"),
    ("plan_json_status_not_initial", "plan 初始状态必须是 todo：重新发布 Plan v2，不要就地改 status。"),
    ("plan_json_status_not_done", "所有任务完成后状态才应为 done：用任务状态机推进，不要就地改 status。"),
    ("plan_json_status_invalid", "status 取值非法：重新发布 Plan v2。"),
    ("plan_json_taskSetStatus_invalid", "taskSetStatus 取值非法：重新发布 Plan v2，writer 一次性写入 finalized。"),
    ("plan_json_implementationScope_invalid", "implementationScope 取值非法：用 hooks/implementation_scope.py set 修正后重建 plan。"),
    ("plan_json_batchPolicy", "批次策略字段必须与约定一致：重新发布 Plan v2，不要手工调整 batchPolicy。"),
    ("dependency_unknown", "任务依赖指向了不存在的任务号：核对任务号后修正 Plan v2 输入的 dependsOn 并重新发布。"),
    ("dependency_cycle", "任务依赖成环：调整 Plan v2 输入的 dependsOn 使任务 DAG 无环后重新发布。"),
)


def _plan_json_code_action(detail: str) -> str:
    for code, action in _PLAN_JSON_CODE_ACTIONS:
        if code in detail:
            return action + PLAN_NO_HAND_EDIT
    return ""


def lookup(reason: str, detail: str = "") -> Repair | None:
    """返回该 reason 的修复信息；未注册返回 None（调用点退回旧行为）。"""
    repair = REPAIRS.get(reason)
    if repair is None:
        return None
    if reason == "invalid_plan_json":
        action = _plan_json_code_action(detail)
        if action:
            return repair._replace(action=action)
    return repair
