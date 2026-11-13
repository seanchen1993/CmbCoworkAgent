#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only inspection of supported UTest project environments."""

from __future__ import print_function

import argparse
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.json_writer_common import WriterError, resolve_feature, resolve_workspace  # noqa: E402
from hooks.utest_plan_contract import UTestPlanContractError, load_utest_plan  # noqa: E402
from hooks.utest_blocked_writer import BLOCKING_STATUSES, record_utest_block  # noqa: E402
from hooks.utest_workspace_binding import (  # noqa: E402
    UTestWorkspaceBindingError,
    path_within,
    resolve_task_workspace,
)


SPRING_FRAMEWORKS = ("spring", "spring-boot-2", "spring-boot-3")
FRONTEND_FRAMEWORKS = ("vue", "vue3", "react")
SUPPORTED_FRAMEWORKS = SPRING_FRAMEWORKS + FRONTEND_FRAMEWORKS
JS_LOCKS = (
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
    ("npm-shrinkwrap.json", "npm"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
)
JS_CONFIG_PATTERNS = (
    "vite.config.*",
    "vitest.config.*",
    "jest.config.*",
    "next.config.*",
    "nuxt.config.*",
)


class TestEnvironmentError(Exception):
    """Raised for invalid inspector inputs."""


class RepairArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise TestEnvironmentError(
            "命令参数无效：{}。修复：运行 `{} --help`，只传入产物 workspace 与 feature。".format(
                message, self.prog
            )
        )


def _base_result(framework):
    return {
        "framework": framework,
        "status": "unsupported",
        "runner": None,
        "packageManager": None,
        "configState": "missing",
        "initProfile": None,
        "manifests": [],
        "warnings": [],
        "errors": [],
    }


def _manifest(result, path, root):
    if path.is_file():
        relative = path.relative_to(root).as_posix()
        if relative not in result["manifests"]:
            result["manifests"].append(relative)


def _read_text(path):
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError as exc:
        raise TestEnvironmentError(
            "无法读取 {}：{}。修复：确认文件可读后重试。".format(path, exc)
        )


def _read_package_json(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise TestEnvironmentError(
            "无法读取 {}：{}。修复：确认 package.json 可读后重试。".format(path, exc)
        )
    except ValueError as exc:
        raise TestEnvironmentError(
            "package.json 不是合法 JSON：{}。修复：修正 JSON 语法后重试。".format(exc)
        )
    if not isinstance(data, dict):
        raise TestEnvironmentError(
            "package.json 顶层不是 object。修复：恢复标准 package.json 结构后重试。"
        )
    return data


def _inspect_spring(root, framework):
    result = _base_result(framework)
    pom = root / "pom.xml"
    gradle_files = [root / "build.gradle", root / "build.gradle.kts"]
    present_gradle = [path for path in gradle_files if path.is_file()]
    _manifest(result, pom, root)
    for path in present_gradle:
        _manifest(result, path, root)
    for name in ("settings.gradle", "settings.gradle.kts", "gradlew", "mvnw"):
        _manifest(result, root / name, root)

    if pom.is_file() and present_gradle:
        result["status"] = "conflict"
        result["configState"] = "conflict"
        result["errors"].append(
            "同时发现 Maven 与 Gradle 构建清单。修复：按系统约束选择一个分配仓库或移除冲突清单。"
        )
        return result
    if not pom.is_file() and not present_gradle:
        result["errors"].append(
            "当前 UTest 执行目录未发现 pom.xml 或 build.gradle(.kts)。修复：修正模块声明或补齐项目真实使用的构建清单。"
        )
        return result

    if pom.is_file():
        content = _read_text(pom)
        result["runner"] = "maven"
        result["packageManager"] = "maven"
        has_test_environment = any(
            marker in content
            for marker in ("spring-boot-starter-test", "junit-jupiter", "junit-vintage")
        )
        profile = "spring-maven-junit"
    else:
        content = "\n".join(_read_text(path) for path in present_gradle)
        result["runner"] = "gradle"
        result["packageManager"] = "gradle"
        has_test_environment = any(
            marker in content
            for marker in ("spring-boot-starter-test", "junit-jupiter", "useJUnitPlatform")
        )
        profile = "spring-gradle-junit"

    if has_test_environment:
        result["status"] = "ready"
        result["configState"] = "present"
    else:
        result["status"] = "init_required"
        result["configState"] = "missing"
        result["initProfile"] = profile
        result["warnings"].append(
            "未发现标准 Spring 测试依赖。修复：按 initProfile 初始化后重新检查。"
        )
    return result


def _dependency_names(package):
    names = set()
    for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        values = package.get(key)
        if isinstance(values, dict):
            names.update(str(name) for name in values)
    return names


def _dependency_specs(package, dependency):
    specs = []
    for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        values = package.get(key)
        if not isinstance(values, dict):
            continue
        spec = values.get(dependency)
        if isinstance(spec, str) and spec.strip():
            specs.append(spec.strip())
    return specs


def _is_definite_vue2_spec(spec):
    normalized = spec.strip().lower()
    alias_prefix = "npm:vue@"
    if normalized.startswith(alias_prefix):
        normalized = normalized[len(alias_prefix) :]
    if "||" in normalized:
        return False
    return re.match(r"^(?:\^|~)?v?2(?:\.|$|[x*])", normalized) is not None


def _test_scripts(package):
    scripts = package.get("scripts")
    if not isinstance(scripts, dict):
        return ""
    return "\n".join(
        value.lower()
        for name, value in scripts.items()
        if isinstance(name, str)
        and name.lower().startswith("test")
        and isinstance(value, str)
    )


def _js_package_manager(root, package, result):
    lock_managers = []
    for name, manager in JS_LOCKS:
        path = root / name
        if path.is_file():
            _manifest(result, path, root)
            if manager not in lock_managers:
                lock_managers.append(manager)
    if len(lock_managers) > 1:
        result["status"] = "conflict"
        result["configState"] = "conflict"
        result["errors"].append(
            "发现多个包管理器锁文件：{}。修复：保留项目实际使用的单一锁文件。".format(
                ", ".join(lock_managers)
            )
        )
        return None

    declared = package.get("packageManager")
    declared_manager = ""
    if isinstance(declared, str) and declared.strip():
        declared_manager = declared.split("@", 1)[0].strip().lower()
    manager = lock_managers[0] if lock_managers else declared_manager or "npm"
    if lock_managers and declared_manager and declared_manager != manager:
        result["status"] = "conflict"
        result["configState"] = "conflict"
        result["errors"].append(
            "packageManager={} 与锁文件对应的 {} 冲突。修复：统一 packageManager 声明与锁文件。".format(
                declared_manager, manager
            )
        )
        return None
    if not lock_managers and not declared_manager:
        result["warnings"].append(
            "未发现锁文件或 packageManager 声明；暂按 npm 回落。修复：生成并提交项目使用的锁文件。"
        )
    return manager


def _config_files(root, result):
    found = []
    for pattern in JS_CONFIG_PATTERNS:
        for path in sorted(root.glob(pattern)):
            if path.is_file() and path not in found:
                found.append(path)
                _manifest(result, path, root)
    return found


def _inspect_frontend(root, framework):
    result = _base_result(framework)
    package_path = root / "package.json"
    if not package_path.is_file():
        result["errors"].append(
            "当前 UTest 执行目录未发现 package.json。修复：修正模块声明或补齐项目真实使用的构建清单。"
        )
        return result

    _manifest(result, package_path, root)
    package = _read_package_json(package_path)
    dependencies = _dependency_names(package)
    config_files = _config_files(root, result)
    manager = _js_package_manager(root, package, result)
    if manager is None:
        return result
    result["packageManager"] = manager

    expects_vue = framework in ("vue", "vue3")
    requested_dep = "vue" if expects_vue else "react"
    opposite_dep = "react" if expects_vue else "vue"
    if opposite_dep in dependencies and requested_dep not in dependencies:
        result["status"] = "conflict"
        result["configState"] = "conflict"
        result["errors"].append(
            "系统约束指定 {}，但工程只声明 {}。修复：修正规约或把 assignment 路由到匹配仓库。".format(
                framework, opposite_dep
            )
        )
        return result
    if requested_dep not in dependencies:
        result["warnings"].append(
            "package.json 未声明 {}。修复：确认系统约束与工程 manifest 一致。".format(
                requested_dep
            )
        )
    if expects_vue:
        vue_specs = _dependency_specs(package, "vue")
        incompatible_specs = [spec for spec in vue_specs if _is_definite_vue2_spec(spec)]
        if incompatible_specs:
            result["status"] = "conflict"
            result["configState"] = "conflict"
            result["errors"].append(
                "系统约束指定 Vue3，但 package.json 声明 Vue2（{}）。"
                "修复：修正规约，或把 assignment 路由到 Vue3 仓库；不要自动升级生产框架。".format(
                    ", ".join(incompatible_specs)
                )
            )
            return result

    script = _test_scripts(package)
    has_vitest = "vitest" in dependencies or "vitest" in script or any(
        path.name.startswith("vitest.config.") for path in config_files
    )
    has_jest = "jest" in dependencies or "jest" in script or any(
        path.name.startswith("jest.config.") for path in config_files
    )
    if has_vitest and has_jest:
        result["status"] = "conflict"
        result["configState"] = "conflict"
        result["errors"].append(
            "同时发现 Jest 与 Vitest。修复：在 assignment 中明确复用的既有 runner，并移除冲突配置。"
        )
        return result
    if has_vitest or has_jest:
        result["status"] = "ready"
        result["runner"] = "vitest" if has_vitest else "jest"
        prefix = "vitest.config." if has_vitest else "jest.config."
        result["configState"] = (
            "present"
            if any(path.name.startswith(prefix) for path in config_files)
            else "implicit"
        )
        if result["configState"] == "implicit":
            result["warnings"].append(
                "已发现 {}，但没有专项配置文件；按现有 runner 原样复用。".format(
                    result["runner"]
                )
            )
        return result

    has_vite = "vite" in dependencies or any(
        path.name.startswith("vite.config.") for path in config_files
    )
    has_next = "next" in dependencies or any(
        path.name.startswith("next.config.") for path in config_files
    )
    has_nuxt = "nuxt" in dependencies or any(
        path.name.startswith("nuxt.config.") for path in config_files
    )
    if has_vite:
        result["status"] = "init_required"
        result["configState"] = "missing"
        result["initProfile"] = (
            "vue3-vite-vitest" if expects_vue else "react-vite-vitest"
        )
        result["warnings"].append(
            "Vite 项目缺少 Jest/Vitest。修复：按 initProfile 初始化并保留当前包管理器。"
        )
        return result

    result["status"] = "unsupported"
    result["configState"] = "unsupported"
    stack = "Next/Nuxt" if has_next or has_nuxt else "非 Vite 前端栈"
    result["errors"].append(
        "{} 未配置既有 Jest/Vitest。修复：先由项目维护者配置 runner，或记录 environment 阻断。".format(
            stack
        )
    )
    return result


def inspect_environment(workspace, framework):
    root = Path(workspace).expanduser().resolve()
    normalized = str(framework or "").strip().lower()
    if not root.is_dir():
        raise TestEnvironmentError(
            "自动解析的 projectRoot 不存在或不是目录：{}。修复：重新运行 workspace binding 解析，并检查 scope.workspaceRoots 或显式 scope.modules。".format(
                root
            )
        )
    if not normalized:
        raise TestEnvironmentError(
            "framework 自动识别结果为空。修复：确认解析后的模块包含真实构建清单。"
        )
    if normalized in SPRING_FRAMEWORKS:
        return _inspect_spring(root, normalized)
    if normalized in FRONTEND_FRAMEWORKS:
        return _inspect_frontend(root, normalized)

    result = _base_result(normalized)
    result["configState"] = "unsupported"
    result["errors"].append(
        "未支持框架 {}。修复：仅对 {} 使用自动检查；其他栈复用既有 runner，否则记录 environment 阻断。".format(
            normalized, ", ".join(SUPPORTED_FRAMEWORKS)
        )
    )
    return result


def _detected_framework(root):
    root = Path(root)
    if (root / "pom.xml").is_file() or (root / "build.gradle").is_file() or (
        root / "build.gradle.kts"
    ).is_file():
        return "spring"
    package_path = root / "package.json"
    if package_path.is_file():
        package = _read_package_json(package_path)
        dependencies = _dependency_names(package)
        if "vue" in dependencies:
            return "vue3"
        if "react" in dependencies:
            return "react"
    return None


def _nearest_project_root(execution_root, repository_root):
    current = Path(execution_root).resolve()
    repository_root = Path(repository_root).resolve()
    while path_within(current, repository_root):
        if any(
            (current / name).is_file()
            for name in ("pom.xml", "build.gradle", "build.gradle.kts", "package.json")
        ):
            return current
        if current == repository_root:
            break
        current = current.parent
    return Path(execution_root).resolve()


def _status_for_targets(targets):
    statuses = [item.get("status") for item in targets]
    for value in ("conflict", "unsupported", "init_required"):
        if value in statuses:
            return value
    return "ready" if statuses and all(value == "ready" for value in statuses) else "unsupported"


def inspect_feature_environments(
    workspace,
    feature,
    task_ids=None,
    *,
    code_workspace=None,
    selected_environment_targets=None,
):
    artifact_workspace = resolve_workspace(workspace)
    feature = resolve_feature(feature)
    feature_dir = artifact_workspace / ".autobizdevops" / "features" / feature
    try:
        plan = load_utest_plan(feature_dir)
    except UTestPlanContractError as exc:
        raise UTestWorkspaceBindingError(
            "contract_gap",
            str(exc),
            "repair_plan_task_location",
        )
    selected_environment_targets = dict(selected_environment_targets or {})
    requested = set(task_ids or [])
    known_task_ids = [
        task["id"]
        for batch in plan["batches"]
        for task in batch["tasks"]
    ]
    unknown = sorted(requested - set(known_task_ids))
    if unknown:
        raise TestEnvironmentError(
            "TASK 不属于当前 plan：{}。修复：省略 --task-id 检查全部任务，或使用 router 本轮返回的 TASK ID。".format(
                ", ".join(unknown)
            )
        )
    unknown_selectors = sorted(set(selected_environment_targets) - set(known_task_ids))
    if unknown_selectors:
        raise TestEnvironmentError(
            "environment target 选择包含未知 TASK：{}。修复：使用当前 Plan 的 TASK ID。".format(
                ", ".join(unknown_selectors)
            )
        )
    requested.update(selected_environment_targets)
    selected_task_ids = [task_id for task_id in known_task_ids if not requested or task_id in requested]
    inspected = {}
    task_targets = []
    bindings = {}
    location_warnings = []
    target_selection_required = []
    for task_id in selected_task_ids:
        context = resolve_task_workspace(
            artifact_workspace,
            feature,
            task_id,
            selected_target_id=selected_environment_targets.get(task_id),
            code_workspace=code_workspace,
        )
        bindings[context["workspaceRef"]] = context["binding"]
        for warning in context.get("locationWarnings", []):
            if warning not in location_warnings:
                location_warnings.append(warning)
        if context.get("autoDiscoveryAmbiguous"):
            target_selection_required.append(
                {
                    "taskId": task_id,
                    "candidates": [
                        {
                            "environmentTargetId": target["environmentTargetId"],
                            "projectRoot": target["executionRoot"],
                        }
                        for target in context["targets"]
                    ],
                }
            )
            for target in context["targets"]:
                task_targets.append(
                    {
                        "taskId": task_id,
                        "environmentTargetId": target["environmentTargetId"],
                        "projectRoot": target["executionRoot"],
                    }
                )
            # Do not inspect or initialize candidates until runtime selection.
            # An unrelated malformed manifest must not block a resolvable task.
            continue
        for target in context["targets"]:
            execution_root = Path(target["executionRoot"])
            repository_root = Path(target["repositoryRoot"])
            project_boundary = Path(target.get("projectBoundary") or repository_root)
            project_root = _nearest_project_root(execution_root, project_boundary)
            framework = _detected_framework(project_root)
            if framework is None:
                inspection = _base_result("unknown")
                inspection["errors"].append(
                    "{} 的 UTest 执行目录未发现受支持的测试工程清单。修复：在当前 Plan 绑定仓库内补齐项目真实使用的构建清单；必要时再用 scope.modules 限定执行目录。".format(
                        task_id
                    )
                )
            else:
                inspection = inspect_environment(project_root, framework)
            key = (str(project_root), framework or "unknown")
            shared = inspected.get(key)
            if shared is None:
                shared = dict(target)
                shared.update(inspection)
                shared["projectRoot"] = str(project_root)
                shared["taskIds"] = []
                inspected[key] = shared
            if task_id not in shared["taskIds"]:
                shared["taskIds"].append(task_id)
            task_targets.append(
                {
                    "taskId": task_id,
                    "environmentTargetId": target["environmentTargetId"],
                    "projectRoot": str(project_root),
                }
            )
    targets = list(inspected.values())
    targets.sort(key=lambda item: (item["projectRoot"], item["framework"]))
    warnings = []
    errors = []
    for target in targets:
        warnings.extend(target.get("warnings", []))
        errors.extend(target.get("errors", []))
    status = (
        "environment_target_ambiguous"
        if target_selection_required
        else _status_for_targets(targets)
    )
    result = {
        "status": status,
        "bindings": bindings,
        "targets": targets,
        "taskTargets": task_targets,
        "locationWarnings": location_warnings,
        "warnings": warnings,
        "errors": errors,
    }
    if target_selection_required:
        result["targetSelectionRequired"] = target_selection_required
        result["requiredAction"] = "select_environment_target"
        result["errors"].append(
            "多个自动发现的项目无法由当前 Batch Git 改动定位。请依据 TASK 的实际实现目录，使用列出的 environmentTargetId 重跑该 TASK 的环境检查；不要修改 Plan 或初始化所有候选。"
        )
    return result


def _record_blocked_if_requested(args, payload):
    if args is None or not args.record_blocked or payload.get("status") not in BLOCKING_STATUSES:
        return payload
    result = dict(payload)
    try:
        result["blockedArtifacts"] = record_utest_block(args.workspace, args.feature, result)
    except (UTestPlanContractError, WriterError, ValueError, OSError) as exc:
        result["blockedArtifactError"] = (
            "阻断产物写入失败：{}。修复：修复当前 Plan/产物契约后重新运行同一环境检查命令。".format(
                exc
            )
        )
        result["requiredAction"] = "repair_utest_blocked_artifacts"
    return result


def main(argv=None):
    parser = RepairArgumentParser(description="按当前 plan 自动定位单测环境，并可落盘阻断交接")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--feature", required=True)
    parser.add_argument("--task-id", action="append")
    parser.add_argument(
        "--environment-target",
        action="append",
        default=[],
        metavar="TASK_ID=ENVIRONMENT_TARGET_ID",
        help="仅用于多候选自动发现：针对一个 TASK 选择 inspector 返回的目标 ID。",
    )
    parser.add_argument(
        "--batch-worktree",
        dest="code_workspace",
        help="仅 Workflow 内使用：当前 Batch 的原生 Git Worktree。",
    )
    parser.add_argument("--json", action="store_true", help="输出稳定 JSON（默认格式）")
    parser.add_argument(
        "--record-blocked",
        action="store_true",
        help="对 contract_gap/environment/ambiguous 终态写入 BLOCKED 产物与 FIX_REQUEST",
    )
    args = None
    try:
        args = parser.parse_args(argv)
        selected_environment_targets = {}
        for value in args.environment_target:
            if "=" not in value:
                raise TestEnvironmentError(
                    "--environment-target 格式无效：{}。修复：使用 TASK_ID=ENVIRONMENT_TARGET_ID。".format(
                        value
                    )
                )
            task_id, target_id = value.split("=", 1)
            if not task_id or not target_id or task_id in selected_environment_targets:
                raise TestEnvironmentError(
                    "--environment-target 包含空值或重复 TASK：{}。修复：每个 TASK 只选择一个本轮目标。".format(
                        value
                    )
                )
            selected_environment_targets[task_id] = target_id
        result = inspect_feature_environments(
            args.workspace,
            args.feature,
            args.task_id,
            code_workspace=args.code_workspace,
            selected_environment_targets=selected_environment_targets,
        )
    except UTestWorkspaceBindingError as exc:
        payload = _record_blocked_if_requested(args, exc.payload())
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False))
        return 2
    except TestEnvironmentError as exc:
        payload = {
            "status": "environment_inspection_failed",
            "owner": "inspect_test_environment",
            "requiredAction": "repair_environment_inspection_input",
            "errors": [str(exc)],
        }
        payload = _record_blocked_if_requested(args, payload)
        print(
            json.dumps(
                payload,
                ensure_ascii=False,
                indent=2,
                sort_keys=False,
            )
        )
        return 2
    except (WriterError, ValueError, OSError) as exc:
        payload = {
            "status": "environment_inspection_failed",
            "owner": "inspect_test_environment",
            "requiredAction": "repair_environment_inspection_artifacts",
            "errors": [
                "环境检查失败：{}。修复：检查产物 workspace、Feature 和 workspace binding 后重试。".format(
                    exc
                )
            ],
        }
        payload = _record_blocked_if_requested(args, payload)
        print(
            json.dumps(
                payload,
                ensure_ascii=False,
                indent=2,
                sort_keys=False,
            )
        )
        return 2
    result = _record_blocked_if_requested(args, result)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=False))
    if args.record_blocked and result.get("status") in BLOCKING_STATUSES:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
