---
name: autobiz-native-plan
description: 从已确认的设计和规格创建有追溯、可执行的 AutoBiz 批次计划。
---

读取 NORMALIZED_REQUIREMENTS.json、PRD.bundle.json、SPECS.bundle.json、DESIGN.bundle.json 的实际内容。设计确认由 Host 处理，不能修改上游设计或伪造确认。

输出 PLAN.bundle.json：`{feature,stage:"plan",files:{"plan.json":"UTF-8 JSON text","plans/B001/plan.json":"UTF-8 JSON text",...}}`。files 只允许计划根索引和各批次计划，不写旧 STATE.md/state.json/checkpoint。

保留原 AutoBiz Plan v2 约束：
- plan.json 是批次索引，禁止 monolithic tasks/version/taskDetailVersion。含 featureId、implementationScope、taskSetStatus="finalized"、status="todo"、batchPolicy={strategy:"minimal_closed_delivery_v2",maxTasks:3}。
- taskValidationPolicy={mode:"defer_to_test_stages",orchestration:"inline",codeGate:"review_only",maxTestStageRepairAttempts:3}。这描述业务验证归属，不代表验证已完成。
- 每个批次声明 id BNNN、path plans/BNNN/plan.json、title、executionLane、workspaceRef、specRoots、deps、taskIds、deliveryKind、status。单任务批次是默认；2—3任务必须同一不可分交付闭环并声明atomicGroup和足够说明。任务与批次依赖必须存在、无环、顺序兼容。
- 每份批次计划含 featureId、batchId、title、executionLane、status="todo"、deliveryKind、taskCount、completedTaskCount=0、completionEvidenceIds=[]、tasks。
- 任务含 id TNNN、title、goal、status="todo"、executionMode、workspaceRef、specRefs、designRefs、apiIds、dataIds、decisionIds、scope、implementationPoints、testPoints、verificationIntent、acceptanceCriteria、completionPolicy、validationBoundary、nonGoals。证据数组初始为空，不能预填成功证据；blockers如实记录，expectedFiles是计划生产文件，不是完成证明，不能被误认为必须为空。
- REQ/SCN 引用必须实际存在；每个场景展开成独立完整 `specs/<capability>/spec.md#SCN-NNN`。覆盖已确认范围内全部场景；API/DATA/D引用从已固定设计锁读取，不另造ID，不删除困难场景来通过。
- UI任务与UI_CONTEXT的page/interaction/visualSource/route一致。源引用与范围分区继承PRD，不能由计划自行改写。
- parallelBatchPipeline必须保留prepare→implement→review→test；每个REVIEW-BNNN归所属批次review，每个非external_dependency任务的UTEST-TNNN归所属批次test，唯一合并后验证为V-E2E；finalization必须evidence_aggregate_only并禁止重复执行。planRevision是原验证器要求的规范化摘要，必须根据实际计划计算，不能填占位字符串。

所有业务检查会调用固定的真实Python规则。错误需要修改本阶段产物后重新检查；不能降低检查或调用旧writer推进状态。workspaceRef只能使用default或本包executionResources已声明且用户配置的仓库ID；同批次任务必须同仓。当前Code按依赖串行、每仓复用资源并独立批准合并；外部依赖、frontend、并行合并列车及其他能力缺失仍须保留真实计划需求并报告缺项。

## 编写前先区分格式枚举与本包可执行范围

下表是原校验器的精确值；不要把业务描述另造为枚举。

| 字段 | 原格式允许值 | 本包当前可执行选择 |
| --- | --- | --- |
| task.executionMode | `code`、`verified_existing`、`external_dependency` | 必须显式 `code` |
| batch.executionLane | `backend`、`frontend` | `backend`；任务 `uiRequired:false` |
| deliveryKind | `single_task`、`atomic_group` | 单任务用 `single_task`；同一不可分闭环的2—3任务才用 `atomic_group` |
| task.completionPolicy | `all_required_validations_pass`、`external_dependency_recorded` | `code` 使用 `all_required_validations_pass` |
| implementationScope | `full_stack`、`backend_only`、`frontend_only` | 继承已确认的 `backend_only`，不能在Plan擅自改范围 |

`inline` 仅是 `taskValidationPolicy.orchestration` 的值，不是 executionMode；`sequential_single_workspace` 不是 executionLane；`vertical_slice`、`verification_harness` 不是 deliveryKind；`evidence_required` 不是 completionPolicy。原格式对 external_dependency 要求 externalDependency={system,owner,trackingRefs:[...]} 且 completionPolicy=external_dependency_recorded；其他模式禁止 externalDependency。本包工作流尚不执行 verified_existing/external_dependency/frontend，不能把格式校验接受当作执行能力；若真实业务必须使用这些能力，应报告阻断，不伪装成 code 或删除需求。当前最多8批，每批最多3任务；不要通过拆批绕过不可分闭环与写入归属。

### 必填结构、初始值与跨文件一致性

- 根索引没有 tasks/version/taskDetailVersion。初始 `status:"todo"`、`taskSetStatus:"finalized"`，batchPolicy 和 taskValidationPolicy 使用前述精确对象，不加其他 policy 字段。activeBatchId/nextBatchId 非必填；初稿可省略。不要填运行时间、完成计数或 PASS 事实。
- 批次ID为 B 加3位数字、任务ID为 T 加3位数字，任务ID跨批唯一。根条目的 path 必须精确为 plans/BNNN/plan.json；taskIds 与对应批次 tasks 顺序一致。根/批次的 featureId、executionLane、status、deliveryKind 一致；workspaceRef 与该批全部任务一致。taskCount 是实际长度，completedTaskCount=0，completionEvidenceIds=[]。
- 单任务根条目/批次不写 atomicGroupId、batchRationale，任务不写 atomicGroup。2—3任务原子组则根/批次同一个 atomicGroupId=AG加3位数字、batchRationale 至少10字符，每个任务 atomicGroup={id:同ID,rationale:至少10字符}。不得混仓、混lane或把4任务写进一批。
- 每任务 deps 是任务ID数组；根条目 deps 是批次ID数组，无依赖显式 []。跨批任务依赖必须同时投影到根批次 deps，所依赖批次排在前面；所有引用存在且无环。
- scope 必须含 `modules/entrypoints/pages/dataObjects` 字符串数组，无适用项也写 []。公开样例另显式声明 paths；paths 非空时必须有 workspaceRoots。单仓写 `workspaceRef:"default", scope.workspaceRoots:{"default":"."}`，paths 只写仓库相对路径，不加 default:，不含绝对路径/..。多仓只使用包已声明且已绑定的ID，workspaceRoots 只有该ID一项、值为仓内相对根，paths 使用 `仓库ID:相对路径`，不要重复根目录前缀。此对象是计划路径说明，不授予目录权限；不要额外生成带本机绝对路径的 codeWorkspaces。
- 后端 `uiRequired:false`、scope.pages=[]；uiRefs 可省略，不伪造页面、路由或视觉来源。implementationPoints/testPoints/nonGoals 是字符串数组，goal/verificationIntent/validationBoundary 是明确业务文本。testPoints、verificationIntent 必须足以让独立测试作者覆盖全部任务验收，不写“以后补测试”替代条件。
- acceptanceCriteria 是非空对象数组，每项 `{id:"AC-T001-01",text:"可观测验收条件",scenarioRefs:["specs/实际能力/spec.md#SCN-001"]}`；id 必须属于当前任务且唯一，后缀2—3位数字。scenarioRefs 非空，每项只能是实际存在的 SCN 场景锚点完整路径，且必须已出现在该任务 specRefs；不得混入 REQ 需求引用，即使该 REQ 在 specRefs 中合法存在。不得写字符串数组、场景范围或裸SCN编号。
- specRefs 包含实际REQ和逐个展开的SCN完整路径；从 SPECS.bundle.json 的 files 键与文件中定义读取，不能凭能力名称猜路径。逐项核对文件存在、锚点存在、所属能力正确，并覆盖已确认范围全部场景。designRefs 只引用原始已确认设计中实际存在的编号 ID，使用 `design.md#API-NNN`、`design.md#DATA-NNN` 或 `design.md#D-NNN`（NNN为原三位编号）；不可引用章节标题、描述性锚点或自造编号，例如 `design.md#整体架构` 不合法。apiIds/dataIds/decisionIds/sourceRefs 同样只引用实际已固定材料；不适用数组可为空，适用的设计与来源覆盖不可省略。不要把教学例的空设计ID数组复制到含 API/DATA/D 决策的真实项目。
- evidenceIds/completionEvidenceIds/implementationEvidenceIds/validationEvidenceIds 初始为空；后两者可省略，latest*EvidenceId、implementationRevision、validationRepairAttempts 等运行字段可省略，不伪造通过。blockers 如实记录。expectedFiles 是计划生产文件数组，可声明实际预期路径，也可在确无已知路径时为空；它不是写入或完成证据。scope.paths/expectedFiles 不应给生产角色分配测试资产。

### 每批先形成可测试的生产闭环

工作流顺序是生产实现→原命令动作编译→独立只读评审→独立 test-author 生成测试→原命令动作运行测试，最后合并并进行独立最终验证。不要将 test-author 的工作重复安排成生产任务，也不要把首批必须的编译/测试入口拖到后续批次。小型单仓后端可用一个生产任务覆盖全部业务闭环；大项目仍按真实依赖拆批，并不要求所有项目单批。

生产实现只写生产代码和本批必要工程配置，不写 src/test、tests、test_*.py、*.test.*、*.spec.* 等测试资产，也不执行测试。独立 test-author 根据全部 testPoints/acceptanceCriteria/SCN 写测试，不改生产代码或验收条件。原命令策略把 pom.xml 视为生产配置：如果 Java 测试依赖生产POM把 Maven test 绑定到独立Java检查Main，该绑定必须在本批生产实现就绪；独立测试作者再创建对应 src/test 源码，并通过既有 Maven test 入口运行。不能让测试作者临时改 pom.xml，也不能预写空测试或空PASS入口。生产 compile 目标不能触发测试；直接 java Main 不是当前测试命令策略认可的测试入口，Maven test 必须实际运行断言，不能跳过测试或仅编译。具体类名/插件/命令依已确认设计与实际工程选择，不照抄教学路径。

## 完整单批教学例（不是当前项目的业务计划）

下面两份 JSON 是可直接解析的完整教学计划，feature 为 orders；对应独立教学上游：specs/order-query/spec.md 定义 REQ-001“订单查询必须在2秒内返回”与 SCN-001“已有订单查询”，已确认设计使用内存索引且明确无HTTP API、无SQL、无其他API/DATA/D ID。正式项目必须替换为自己的真实全部需求/场景/设计引用及文件，不能借教学例删除需求。原完整 checker 的回归使用该独立教学上游，不能把示例或测试结果当成当前项目的成功证据。

根文档 plan.json：

<!-- autobiz-plan-example-root:start -->
```json
{
  "featureId": "orders",
  "implementationScope": "backend_only",
  "taskSetStatus": "finalized",
  "status": "todo",
  "batchPolicy": {
    "strategy": "minimal_closed_delivery_v2",
    "maxTasks": 3
  },
  "taskValidationPolicy": {
    "mode": "defer_to_test_stages",
    "orchestration": "inline",
    "codeGate": "review_only",
    "maxTestStageRepairAttempts": 3
  },
  "batches": [
    {
      "id": "B001",
      "path": "plans/B001/plan.json",
      "title": "订单查询",
      "executionLane": "backend",
      "status": "todo",
      "workspaceRef": "default",
      "deliveryKind": "single_task",
      "taskIds": [
        "T001"
      ],
      "specRoots": [
        "specs/order-query"
      ],
      "deps": []
    }
  ],
  "parallelBatchPipeline": {
    "schemaVersion": "autobiz.parallel.pipeline.v1",
    "planRevision": "sha256:b01b7757bfa7f801f6762e6dbd0b3b87dff71df8a4c46b9c3e9dbb49cc92cd42",
    "deliveryStages": [
      "prepare",
      "implement",
      "review",
      "test"
    ],
    "validationBatches": [
      {
        "id": "V-E2E",
        "type": "validation",
        "stage": "e2e_test",
        "dependsOn": "all_delivery",
        "executionTarget": "merged_main"
      }
    ],
    "validationOwnership": {
      "REVIEW-B001": {
        "ownerBatchId": "B001",
        "stage": "review",
        "kind": "review"
      },
      "UTEST-T001": {
        "ownerBatchId": "B001",
        "stage": "test",
        "kind": "utest_target",
        "taskId": "T001",
        "sourceBatchId": "B001"
      }
    },
    "finalization": {
      "mode": "evidence_aggregate_only",
      "forbidPostMergeDuplicateExecution": true
    }
  }
}
```
<!-- autobiz-plan-example-root:end -->

批次文档 plans/B001/plan.json：

<!-- autobiz-plan-example-batch:start -->
```json
{
  "featureId": "orders",
  "batchId": "B001",
  "title": "订单查询",
  "executionLane": "backend",
  "status": "todo",
  "deliveryKind": "single_task",
  "taskCount": 1,
  "completedTaskCount": 0,
  "tasks": [
    {
      "id": "T001",
      "title": "订单查询",
      "goal": "订单查询必须在2秒内返回",
      "status": "todo",
      "deps": [],
      "executionMode": "code",
      "executionLane": "backend",
      "workspaceRef": "default",
      "specRefs": [
        "specs/order-query/spec.md#REQ-001",
        "specs/order-query/spec.md#SCN-001"
      ],
      "designRefs": [],
      "apiIds": [],
      "dataIds": [],
      "decisionIds": [],
      "uiRequired": false,
      "scope": {
        "modules": [
          "order-query"
        ],
        "entrypoints": [
          "query"
        ],
        "pages": [],
        "dataObjects": [],
        "paths": [
          "pom.xml",
          "src/main/java/example/OrderQuery.java"
        ],
        "workspaceRoots": {
          "default": "."
        }
      },
      "implementationPoints": [
        "使用内存索引返回订单",
        "本批提供生产编译及 Maven test 阶段的测试入口绑定；测试源码由后续独立测试作者创建，生产 compile 不运行测试"
      ],
      "testPoints": [
        "已有订单在2秒内返回"
      ],
      "verificationIntent": "已有订单查询返回相同订单且耗时小于2秒",
      "nonGoals": [
        "用户界面"
      ],
      "validationBoundary": "隔离订单存储及计时器",
      "completionPolicy": "all_required_validations_pass",
      "acceptanceCriteria": [
        {
          "id": "AC-T001-01",
          "text": "2秒内返回订单",
          "scenarioRefs": [
            "specs/order-query/spec.md#SCN-001"
          ]
        }
      ],
      "blockers": [],
      "completionEvidenceIds": [],
      "evidenceIds": [],
      "expectedFiles": [
        "pom.xml",
        "src/main/java/example/OrderQuery.java"
      ]
    }
  ],
  "completionEvidenceIds": []
}
```
<!-- autobiz-plan-example-batch:end -->

封装时外层是 `{feature:"orders",stage:"plan",files:{"plan.json":JSON文本字符串,"plans/B001/plan.json":JSON文本字符串}}`，不是把内层对象直接作为 files 值。上例 pipeline 摘要只对上例有效；替换业务内容后必须使用下方原纯 helper 重新派生，保持每份文本≤20,000 UTF-8字节、整个PLAN.bundle.json≤28,000字节。完成前逐项核对枚举、初始值、根/批次投影、首批可执行闭环、真实路径与全部场景覆盖；自检和 helper 输出均不能代替 Host 原业务检查。

## parallelBatchPipeline 的精确派生契约

先由你依据已确认的业务材料编写根索引和所有批次任务。下列计算不创建任务、不补业务字段、不选择范围，也不证明计划有效。它仅从你已写的 `PLAN.bundle.json` 派生根索引的 `parallelBatchPipeline`；仍须由你将输出对象写入 `files["plan.json"]` 的 JSON 文本，保持其他业务字段不变，再交 Host 执行原业务检查。不要把计算成功当成检查、执行或人工批准成功。

该对象恰有六个字段：
- `schemaVersion` 固定为 `autobiz.parallel.pipeline.v1`。
- `planRevision` 为 `sha256:` 加下述投影的 UTF-8 SHA-256 小写十六进制摘要，不能直接哈希整个 bundle 或 plan.json。
- `deliveryStages` 严格为 `["prepare","implement","review","test"]`。
- `validationBatches` 严格为 `[{"id":"V-E2E","type":"validation","stage":"e2e_test","dependsOn":"all_delivery","executionTarget":"merged_main"}]`。
- `validationOwnership` 为对象：每批 `REVIEW-<batchId>` 的值是 `{ownerBatchId,stage:"review",kind:"review"}`；每个非 `external_dependency` 任务 `UTEST-<taskId>` 的值是 `{ownerBatchId,stage:"test",kind:"utest_target",taskId,sourceBatchId}`。两个 batchId 字段均为该任务所属批次 ID。
- `finalization` 严格为 `{"mode":"evidence_aggregate_only","forbidPostMergeDuplicateExecution":true}`。

摘要只覆盖 `{batches:[...]}`，批次顺序沿用根索引；每个批次投影为 `id/deps/taskIds/workspaceRef/writeSet/taskVerification`。`writeSet` 按批次任务顺序拼接每个任务的 `scope.paths`；`taskVerification` 按任务顺序保留 `id/testPoints/verificationIntent/acceptanceCriteria`。**对象键排序，数组不排序、不去重**；缺失 `deps/taskIds/scope.paths/testPoints/acceptanceCriteria` 依原规则取空数组，缺失 `id/workspaceRef/verificationIntent` 依原规则取 null，不能借此回避必填字段检查。序列化使用 Python `json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(",", ":"))`，不加换行后哈希。修改任何被投影字段后必须重新计算。

以下是原 `hooks/parallel_validation_ownership.py` 中常量、`_canonical`、`_pipeline_revision` 和 `build_pipeline_contract` 的纯标准库实现，外加只读 stdin/stdout 入口。将完整代码作为 Python 程序，通过原命令工具的正常授权执行，例如 `python -I -B -X utf8 -c <完整代码>`，stdin 传入你自己的完整 PLAN.bundle.json 文本。不要导入未随本包提供的旧 writer 或固定开发机路径。程序不写文件、不执行计划、不输出任何成功证据；stdout 只有派生对象。

<!-- autobiz-pipeline-helper:start -->
```python
import hashlib
import json
import sys
from typing import Any

PIPELINE_SCHEMA_VERSION = "autobiz.parallel.pipeline.v1"
DELIVERY_STAGES = ("prepare", "implement", "review", "test")
VALIDATION_BATCHES = (
    {
        "id": "V-E2E",
        "type": "validation",
        "stage": "e2e_test",
        "dependsOn": "all_delivery",
        "executionTarget": "merged_main",
    },
)


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _pipeline_revision(root: dict[str, Any], batches: dict[str, dict[str, Any]]) -> str:
    contract = {
        "batches": [
            {
                "id": entry.get("id"),
                "deps": entry.get("deps", []),
                "taskIds": entry.get("taskIds", []),
                "workspaceRef": entry.get("workspaceRef"),
                "writeSet": [
                    path
                    for task in batches.get(str(entry.get("id")), {}).get("tasks", [])
                    if isinstance(task, dict)
                    for path in (task.get("scope", {}).get("paths", []) if isinstance(task.get("scope"), dict) else [])
                ],
                "taskVerification": [
                    {
                        "id": task.get("id"),
                        "testPoints": task.get("testPoints", []),
                        "verificationIntent": task.get("verificationIntent"),
                        "acceptanceCriteria": task.get("acceptanceCriteria", []),
                    }
                    for task in batches.get(str(entry.get("id")), {}).get("tasks", [])
                    if isinstance(task, dict)
                ],
            }
            for entry in root.get("batches", [])
            if isinstance(entry, dict)
        ],
    }
    return "sha256:" + hashlib.sha256(_canonical(contract).encode("utf-8")).hexdigest()


def build_pipeline_contract(root: dict[str, Any], batches: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Create the deterministic pipeline projection written by Plan Writer."""
    ownership: dict[str, dict[str, Any]] = {}
    for entry in root.get("batches", []):
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        batch_id = entry["id"]
        batch = batches.get(batch_id, {})
        ownership[f"REVIEW-{batch_id}"] = {
            "ownerBatchId": batch_id,
            "stage": "review",
            "kind": "review",
        }
        for task in batch.get("tasks", []) if isinstance(batch, dict) else []:
            if not isinstance(task, dict) or not isinstance(task.get("id"), str):
                continue
            if task.get("executionMode") == "external_dependency":
                continue
            target_id = f"UTEST-{task['id']}"
            ownership[target_id] = {
                "ownerBatchId": batch_id,
                "stage": "test",
                "kind": "utest_target",
                "taskId": task["id"],
                "sourceBatchId": batch_id,
            }

    return {
        "schemaVersion": PIPELINE_SCHEMA_VERSION,
        "planRevision": _pipeline_revision(root, batches),
        "deliveryStages": list(DELIVERY_STAGES),
        "validationBatches": [dict(item) for item in VALIDATION_BATCHES],
        "validationOwnership": ownership,
        "finalization": {
            "mode": "evidence_aggregate_only",
            "forbidPostMergeDuplicateExecution": True,
        },
    }


def pipeline_from_bundle(bundle):
    if bundle.get("stage") != "plan" or not isinstance(bundle.get("files"), dict):
        raise ValueError("PLAN_BUNDLE_REQUIRED")
    root = json.loads(bundle["files"]["plan.json"])
    batches = {entry["id"]: json.loads(bundle["files"][entry["path"]])
               for entry in root["batches"]}
    return build_pipeline_contract(root, batches)


if __name__ == "__main__":
    print(json.dumps(pipeline_from_bundle(json.load(sys.stdin)), ensure_ascii=False))
```
<!-- autobiz-pipeline-helper:end -->

### Windows 与其他平台的 UTF-8 执行约定

主程序和每个 Python 子程序都显式使用 `python -I -B -X utf8 ...`。主程序的 `-X utf8` 不会自动成为 `subprocess` 子程序的参数；Windows 默认 GBK 解码 UTF-8 stdin 可能产生 `\udc80` 一类代理字符，导致规范化哈希失败。将上面的纯 helper 原文保存为 UTF-8（无 BOM），不改变算法；编排程序也用 `python -I -B -X utf8 <编排程序.py>` 启动，文件读取显式指定 UTF-8。

下面两种传输均保留完整中文、补充平面字符和数组顺序。文本 input 显式 `encoding="utf-8"`；bytes input 严格编码 UTF-8，子程序仍带 `-X utf8`，stdout 严格按 UTF-8 解码。不得使用 `errors="replace"/"ignore"`、GBK 往返、添加/剥除 BOM 或删改中文让哈希“成功”。planRevision 仍由上面原算法的规范化 UTF-8 投影计算，不能更改输入来迎合摘要。

<!-- autobiz-plan-utf8-launcher:start -->
```python
import json
import subprocess
import sys


def run_utf8_helper(helper_path, payload, as_bytes=False):
    argv = [sys.executable, "-I", "-B", "-X", "utf8", str(helper_path)]
    text = json.dumps(payload, ensure_ascii=False)
    if as_bytes:
        result = subprocess.run(argv, input=text.encode("utf-8"), capture_output=True,
                                check=True, timeout=30)
        return json.loads(result.stdout.decode("utf-8"))
    result = subprocess.run(argv, input=text, encoding="utf-8", capture_output=True,
                            check=True, timeout=30)
    return json.loads(result.stdout)
```
<!-- autobiz-plan-utf8-launcher:end -->
