"""Validate pinned artifact bytes in private scratch space, never the project workspace.

JSON stdin contains only the action's captured bundle and preceding Host artifact
bundles. Stage selection comes from the locked public action's command.
"""
import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path
from native_context import HookContext, fail_line
from prd_rules import iter_headings, pending_marker_lines, REQUIRED_PRD_SECTIONS, FORMAL_SECTION_MAX_LEVEL
from hooks.source_references import split_source_reference_section, extract_source_references
from hooks.source_context import validate_source_context
from hooks.implementation_scope import load_scope
from artifact_rules import (validate_proposal_contract, validate_specs_contract,
    validate_capability_spec_correspondence, validate_design_contract,
    validate_design_contract_lock, validate_ui_context_json, validate_plan_json_initial_tasks,
    validate_plan_json_contract, validate_plan_task_granularity, validate_plan_scenario_coverage,
    validate_plan_ref_resolution, validate_parallel_batch_pipeline_contract)

OWNED = {
    "prd": {"PRD.md", "UI_CONTEXT.json", "IMPLEMENTATION_SCOPE.json", "source-context.json"},
    "specs": {"proposal.md", "UI_CONTEXT.json"},
    "design": {"design.md", ".design-contract.lock.json"},
    "plan": {"plan.json"},
}
REQUIRED = {
    "prd": {"PRD.md", "UI_CONTEXT.json", "IMPLEMENTATION_SCOPE.json"},
    "specs": {"proposal.md", "UI_CONTEXT.json"},
    "design": {"design.md", ".design-contract.lock.json"},
    "plan": {"plan.json"},
}


def safe_path(name):
    if (not isinstance(name, str) or len(name) > 240 or "\\" in name or ":" in name
        or any(part in {"", ".", ".."} or re.search(r'[<>"|?*\x00-\x1f]|[. ]$', part)
               or re.match(r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)', part, re.I)
               for part in name.split("/"))):
        raise ValueError("ARTIFACT_BUNDLE_PATH_INVALID")
    return name


def normalized(value):
    if (not isinstance(value, dict) or not re.fullmatch(r"[a-zA-Z0-9][\w.-]{0,63}", str(value.get("feature", "")))
        or not isinstance(value.get("revision"), int) or isinstance(value.get("revision"), bool)
        or value["revision"] < 2 or not isinstance(value.get("requirements"), list)
        or not value["requirements"] or any(not isinstance(row, str) or not row.strip() for row in value["requirements"])):
        raise ValueError("NORMALIZED_REQUIREMENTS_INVALID")
    return value


def merge_bundle(files, bundle, stage, feature):
    if (not isinstance(bundle, dict) or bundle.get("feature") != feature or bundle.get("stage") != stage
        or not isinstance(bundle.get("files"), dict) or not REQUIRED[stage].issubset(bundle["files"])):
        raise ValueError("ARTIFACT_BUNDLE_INVALID")
    for name, content in bundle["files"].items():
        safe_path(name)
        if not (name in OWNED[stage] or stage == "specs" and re.fullmatch(r"specs/[a-z0-9]+(?:-[a-z0-9]+)*/spec\.md", name)
                or stage == "plan" and re.fullmatch(r"plans/B\d{3}/plan\.json", name)
                or stage == "prd" and re.fullmatch(r"sources/SRC-\d{3}/[a-zA-Z0-9_.-]+", name)):
            raise ValueError("ARTIFACT_BUNDLE_OWNERSHIP")
        if not isinstance(content, str) or not content.strip() or len(content.encode()) > 20000:
            raise ValueError("ARTIFACT_BUNDLE_CONTENT_INVALID")
        if name.lower() in {key.lower() for key in files} and name not in files:
            raise ValueError("ARTIFACT_BUNDLE_PATH_COLLISION")
        files[name] = content


def check_prd(ctx, requirements):
    content = ctx.file("PRD.md").read_text(encoding="utf-8")
    if any(item not in content for item in requirements) or "来源：NORMALIZED_REQUIREMENTS.json" not in content:
        fail_line(ctx, "AUTOBIZ_PRD_REQUIREMENTS_NOT_COVERED")
    headings = [row.text for row in iter_headings(content) if row.level <= FORMAL_SECTION_MAX_LEVEL]
    markers = headings + re.findall(r"\*\*(.+?)\*\*", content)
    for section in REQUIRED_PRD_SECTIONS:
        if not any(section in marker for marker in markers):
            fail_line(ctx, "PRD_REQUIRED_SECTION", section)
    if pending_marker_lines(content):
        fail_line(ctx, "PRD_PENDING_DECISION")
    _, scope_errors = load_scope(ctx.feature_dir, required=True)
    for error in scope_errors:
        fail_line(ctx, "IMPLEMENTATION_SCOPE_INVALID", error)
    if "当前实现范围" not in content:
        fail_line(ctx, "PRD_SCOPE_SECTION_MISSING")
    errors, warnings = split_source_reference_section(content)
    for error in errors:
        fail_line(ctx, "PRD_SOURCE_REFERENCE_INVALID", error)
    ctx.warnings.extend(warnings)
    refs = {row.source_id for row in extract_source_references(content)}
    if refs:
        errors, warnings = validate_source_context(ctx.feature_dir, refs)
        for error in errors:
            fail_line(ctx, "PRD_SOURCE_CONTEXT_INVALID", error)
        ctx.warnings.extend(warnings)
    validate_ui_context_json(ctx)


def run(request):
    stage = request.get("stage")
    if stage == "repair-evidence":
        from repair import check
        return check(request)
    if stage in {"cicd", "archive"}:
        from ops import check
        return check(request)
    if stage == "performance":
        from performance import check
        return check(request.get("current", {}))
    if stage == "command-policy":
        from hooks.compile_command_policy import _production_compile_argv
        from hooks.utest_command_policy import command_executes_tests
        command = request.get("current", {})
        argv = command.get("argv")
        if not isinstance(argv, list) or not argv or len(argv) > 64 or any(not isinstance(arg, str) or not arg or len(arg) > 1024 for arg in argv):
            raise ValueError("CODE_COMMAND_INVALID")
        passed = (_production_compile_argv(argv) if command.get("phase") == "compile"
                  else command_executes_tests(command) if command.get("phase") in {"test", "e2e"} else False)
        from hooks.plan_write_ownership import is_test_asset_path
        paths = command.get("changedPaths", [])
        if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
            raise ValueError("CODE_CHANGED_PATHS_INVALID")
        ownership = all(not is_test_asset_path(path) for path in paths) if command.get("phase") == "compile" else all(is_test_asset_path(path) for path in paths)
        protected = any(path.startswith((".devclaw/", ".cmbcoworkagent/", ".git/")) or path in {
            "NORMALIZED_REQUIREMENTS.json", "PRD.bundle.json", "SPECS.bundle.json", "DESIGN.bundle.json",
            "PLAN.bundle.json", "CODE_RESULT.json", "CICD.bundle.json", "ARCHIVE.bundle.json"} for path in paths)
        return {"passed": passed and ownership and not protected,
            "testFiles": [path for path in command.get("trackedPaths", []) if is_test_asset_path(path)],
            "errors": ([] if passed else [{"code": "CODE_COMMAND_POLICY_DENIED"}])
                + ([] if ownership else [{"code": "CODE_PRODUCTION_TEST_WRITE_BOUNDARY"}])
                + ([{"code": "CODE_HOST_ARTIFACT_WRITE_DENIED"}] if protected else []), "warnings": []}
    if stage not in {"convert", "prd", "specs", "design", "plan"}:
        raise ValueError("STAGE_UNSUPPORTED")
    upstream = normalized(request["current"] if stage == "convert" else request["normalized"])
    if stage == "convert":
        return {"passed": True, "errors": [], "warnings": []}
    feature = upstream["feature"]
    files = {"NORMALIZED_REQUIREMENTS.json": json.dumps(upstream, ensure_ascii=False)}
    order = ["prd", "specs", "design", "plan"]
    for entry in order[:order.index(stage) + 1]:
        merge_bundle(files, request["current"] if entry == stage else request[entry], entry, feature)
    if len(files) > 40 or sum(len(text.encode()) for text in files.values()) > 100000:
        raise ValueError("ARTIFACT_BUNDLE_LIMIT")
    with tempfile.TemporaryDirectory(prefix="autobiz-native-check-") as directory:
        root = Path(directory) / feature
        root.mkdir()
        for name, content in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
        ctx = HookContext(root, feature, stage)
        check_prd(ctx, upstream["requirements"])
        if stage in {"specs", "design", "plan"}:
            validate_proposal_contract(ctx)
            validate_specs_contract(ctx)
            validate_capability_spec_correspondence(ctx)
        if stage in {"design", "plan"}:
            validate_design_contract(ctx)
            validate_design_contract_lock(ctx)
        if stage == "plan":
            validate_plan_json_initial_tasks(ctx)
            validate_plan_json_contract(ctx)
            validate_plan_task_granularity(ctx)
            validate_plan_scenario_coverage(ctx)
            validate_plan_ref_resolution(ctx)
            validate_parallel_batch_pipeline_contract(ctx)
        return {"passed": not ctx.errors, "errors": ctx.errors, "warnings": ctx.warnings,
                "inputSha256": hashlib.sha256(json.dumps(request["current"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}


if __name__ == "__main__":
    try:
        raw = sys.stdin.read(120001)
        if len(raw.encode()) > 120000:
            raise ValueError("ARTIFACT_BUNDLE_LIMIT")
        result = run(json.loads(raw))
    except Exception as error:
        result = {"passed": False, "errors": [{"code": type(error).__name__, "detail": str(error)}], "warnings": []}
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["passed"] else 1)
