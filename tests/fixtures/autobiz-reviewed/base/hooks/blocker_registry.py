#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阻断规则的举证登记表。

一条规则要以 blocker 身份存在，必须回答：放行会导致哪个下游失败、哪条回归测试
证明了它、由哪个模块判定。举不出下游失败的规则登记在 ``UNPROVEN``，等待降级为
warning。新增 blocker 时必须同时补一条 ``Blocker`` 记录，否则
``tests/test_blocker_registry.py`` 会失败。

与 ``skills/autodev/hooks/repair_registry.py`` 分工不同：那份回答「怎么修」，
这份回答「凭什么拦」。
"""

from __future__ import annotations

from typing import Dict, NamedTuple


class Blocker(NamedTuple):
    module: str            # 判定该规则的模块
    downstream_failure: str  # 放行后下游会怎样失败
    regression_test: str     # 证明该失败的回归测试节点


class Unproven(NamedTuple):
    module: str
    kept_because: str        # 暂时保留的理由
    evidence: str            # 证明「下游并不失败」的测试节点


# 已举证的阻断规则。
BLOCKERS: Dict[str, Blocker] = {
    "invalid_plan_task_scenario_reference": Blocker(
        module="hooks/plan_granularity.py",
        downstream_failure=(
            "场景覆盖用 path#SCN-NNN 精确比对。一条 `#SCN-001~SCN-003` 区间引用会被"
            "计成两个已覆盖场景，覆盖门禁因此对没人实现的场景放行。"
        ),
        regression_test=(
            "tests/test_plan_granularity.py::ScenarioReferenceDownstreamTests"
            "::test_range_reference_creates_false_scenario_coverage"
        ),
    ),
}


# 保留为 blocker、但举不出下游失败的规则。按治理约定，这些是后续降级候选。
UNPROVEN: Dict[str, Unproven] = {
    "oversized_plan_task_must_split": Unproven(
        module="hooks/plan_granularity.py",
        kept_because=(
            "粒度硬上限（scenarios/apis/pages/interactions）目前只由本规则判定，"
            "下游没有任何消费方依赖它；保留是规划偏好，不是契约。"
        ),
        evidence=(
            "tests/test_plan_json_and_evidence.py::PlanJsonTest"
            "::test_hard_caps_have_no_downstream_contract_behind_them"
        ),
    ),
}


def registered_reasons() -> set:
    return set(BLOCKERS) | set(UNPROVEN)
