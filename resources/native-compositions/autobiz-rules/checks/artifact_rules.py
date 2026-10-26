"""Read-only rules extracted from skills/autodev/hooks/artifact_check.py. See provenance.json."""
from __future__ import annotations
import json
import re
from pathlib import Path
from typing import NamedTuple
from native_context import HookContext, fail_line, info, is_nonempty, read_text
from hooks.implementation_scope import load_scope, scope_path
from hooks.spec_contract import SPEC_REQUIREMENT_DEF_RE, SPEC_SCENARIO_DEF_RE
from hooks.artifact_ref_validator import design_marker_value
from hooks.design_contract_lock import validate_design_contract_lock as validate_locked_design_contract
from hooks.ui_context import validate_ui_context_data, load_ui_context, ui_context_indexes, ui_context_path
from hooks.plan_json import load_and_validate_plan, load_plan_bundle, plan_json_path
from hooks.artifact_ref_validator import validate_task_artifact_refs, validate_plan_design_coverage
from hooks.design_contract_lock import load_confirmed_design_contract
from hooks.plan_scope import resolve_plan_scope, scope_report
from hooks.plan_granularity import validate_plan_task_granularity_item
from hooks.code_task_context import resolve_task_refs
from hooks.parallel_validation_ownership import validation_ownership_errors
from hooks.frontend_route_constants import ROUTE_NONE, ROUTE_SPEC_DRIVEN, ROUTE_ABSOLUTE, ROUTE_STANDARD, ROUTE_MISSING

REQ_ID = re.compile(r"\bREQ-\d{3}\b")


SCN_ID = re.compile(r"\bSCN-\d{3}\b")


SPEC_REQUIREMENT_NUMERIC_RE = re.compile(
    r"^###\s+Requirement\s+(?=\[?(REQ-(?P<digits>\d+))\]?:\s+.+$)(?:\[REQ-\d+\]|REQ-\d+):\s+.+$",
    re.MULTILINE,
)


SPEC_SCENARIO_NUMERIC_RE = re.compile(
    r"^####\s+Scenario\s+(?=\[?(SCN-(?P<digits>\d+))\]?:\s+.+$)(?:\[SCN-\d+\]|SCN-\d+):\s+.+$",
    re.MULTILINE,
)


CONTRACT_HEADING_CANDIDATE = re.compile(r"^#{1,6}[ \t]+.*?\b(?:REQ|SCN)-\S")


SECTION_HEADING = re.compile(r"^##(?!#)\s+\S")


SPEC_DECISION_ID = re.compile(r"\bDEC-\d{3}\b")


SPEC_DECISION_HEADING = re.compile(r"^###\s+(DEC-\d{3})\s*[:：]", re.MULTILINE)


DECISION_LOG_SECTION = re.compile(
    r"^##\s+Decision Log\s*$\n(?P<body>.*?)(?=^##\s|\Z)",
    re.MULTILINE | re.DOTALL,
)


CAPABILITIES_SECTION = re.compile(
    r"^##\s+Capabilities\s*$\n(?P<body>.*?)(?=^##\s|\Z)",
    re.MULTILINE | re.DOTALL,
)


CAPABILITY_ITEM = re.compile(
    r"^[ \t]*[-*][ \t]+`?(?P<name>[a-z0-9]+(?:-[a-z0-9]+)*)`?[ \t]*[:：]",
    re.MULTILINE,
)


DESIGN_API_DEF_RE = re.compile(r"^\|\s*(API-\d{3})\s*\|", re.MULTILINE)


DESIGN_DATA_DEF_RE = re.compile(r"^\|\s*(DATA-\d{3})\s*\|", re.MULTILINE)


DESIGN_DECISION_DEF_RE = re.compile(r"^\|\s*(D-\d{3})\s*\|", re.MULTILINE)


PENDING_CELL = re.compile(r"\|\s*(待确认|读码差异)\s*\|")


FENCE_OPEN_LINE = re.compile(r"^[ \t]{0,3}(?P<fence>`{3,}|~{3,})(?P<info>.*)$")


BLOCKQUOTE_LINE = re.compile(r"^[ \t]{0,3}>")


TEMPLATE_WRAPPER_HEADINGS = {"# 技术设计模板", "# 计划模板"}


def find_template_guidance_residue(text: str) -> list[tuple[int, str]]:
    """Return ``(line number, kind)`` for template-only markup in an artifact.

    Autodev contract artifacts use paragraphs, lists, and tables for explanatory
    content. Markdown blockquotes are reserved for template authoring guidance
    and must not survive generation. Fenced code blocks are ignored so examples
    containing shell redirects or quoted Markdown do not false-positive.
    """
    residues: list[tuple[int, str]] = []
    fence_char = ""
    fence_length = 0
    seen_content = False

    for lineno, line in enumerate(text.splitlines(), 1):
        if fence_char:
            stripped = line.lstrip(" \t")
            run_length = len(stripped) - len(stripped.lstrip(fence_char))
            if run_length >= fence_length and not stripped[run_length:].strip():
                fence_char = ""
                fence_length = 0
            continue

        fence_match = FENCE_OPEN_LINE.match(line)
        if fence_match:
            fence = fence_match.group("fence")
            info = fence_match.group("info").strip().lower()
            if info in {"markdown", "md"} and not seen_content:
                residues.append((lineno, "outer_markdown_fence"))
            fence_char = fence[0]
            fence_length = len(fence)
            seen_content = True
            continue

        stripped = line.strip()
        if stripped in TEMPLATE_WRAPPER_HEADINGS:
            residues.append((lineno, "wrapper_heading"))
        if BLOCKQUOTE_LINE.match(line):
            residues.append((lineno, "blockquote"))
        if stripped:
            seen_content = True

    return residues


def validate_no_template_guidance(
    ctx: HookContext,
    path: Path,
    text: str,
) -> int:
    """Reject template authoring guidance copied into a generated artifact."""
    try:
        artifact = path.relative_to(ctx.feature_dir).as_posix()
    except ValueError:
        artifact = str(path)

    failures = 0
    for lineno, kind in find_template_guidance_residue(text):
        failures += fail_line(
            ctx,
            "artifact_template_guidance_residue",
            f" file={artifact!r} line={lineno} kind={kind}",
            target=f"{artifact}:{lineno}",
        )
    return failures


def spec_files(ctx: HookContext) -> list[Path]:
    return sorted(
        path
        for path in ctx.feature_dir.glob("specs/**/*.md")
        if path.is_file() and path.stat().st_size > 0
    )


def _implementation_scope_contract_errors(ctx: HookContext) -> tuple[str, list[str]]:
    """Load the optional scope contract without breaking legacy Features."""

    manifest = scope_path(ctx.feature_dir)
    if not manifest.is_file():
        return "full_stack", []
    return load_scope(ctx.feature_dir, required=True)


def _report_implementation_scope_errors(ctx: HookContext) -> int:
    _, errors = _implementation_scope_contract_errors(ctx)
    failures = 0
    for error in errors:
        failures += fail_line(
            ctx,
            "invalid_implementation_scope",
            f" detail={error}",
            target=error,
        )
    return failures


def validate_proposal_contract(ctx: HookContext) -> int:
    proposal = ctx.file("proposal.md")
    if not is_nonempty(proposal):
        return fail_line(ctx, "missing_proposal")

    # Only the capability list is consumed as a structural contract downstream.
    # Other proposal sections are authoring guidance, not completion gates.
    failures = _report_implementation_scope_errors(ctx)
    if not CAPABILITIES_SECTION.search(read_text(proposal)):
        failures += fail_line(
            ctx,
            "invalid_proposal_missing_section",
            " section='Capabilities'",
            target="Capabilities",
        )
    return failures


def proposal_capabilities(text: str) -> set[str]:
    """Kebab-case capability names listed under ``## Capabilities``, any group."""
    section = CAPABILITIES_SECTION.search(text)
    if not section:
        return set()
    return {
        match.group("name")
        for match in CAPABILITY_ITEM.finditer(section.group("body"))
    }


def spec_capability_dirs(ctx: HookContext) -> set[str]:
    """Capability directory names following the ``specs/<capability>/spec.md`` shape."""
    return {
        path.parent.name
        for path in ctx.feature_dir.glob("specs/*/spec.md")
        if path.is_file() and path.stat().st_size > 0
    }


def validate_capability_spec_correspondence(ctx: HookContext) -> int:
    """Both directions of ``Capabilities`` <-> ``specs/<capability>/spec.md``.

    Listing a capability without writing its spec, and shipping a spec the
    proposal never claims, are both mechanical facts about files. Neither is
    something the agent should be asked to self-certify in its reply.
    """
    proposal = ctx.file("proposal.md")
    if not is_nonempty(proposal):
        # `proposal_contract` owns this failure; do not report it twice.
        return 0

    text = read_text(proposal)
    if not CAPABILITIES_SECTION.search(text):
        # Missing section is `invalid_proposal_missing_section`, not a mismatch.
        return 0

    declared = proposal_capabilities(text)
    present = spec_capability_dirs(ctx)

    failures = 0
    missing_specs = sorted(declared - present)
    if missing_specs:
        failures += fail_line(
            ctx,
            "proposal_capability_missing_spec",
            f" capabilities={','.join(missing_specs)}",
            target=",".join(missing_specs),
        )
    unlisted = sorted(present - declared)
    if unlisted:
        failures += fail_line(
            ctx,
            "spec_missing_proposal_capability",
            f" capabilities={','.join(unlisted)}",
            target=",".join(unlisted),
        )
    return failures


def validate_specs_contract(ctx: HookContext) -> int:
    specs = spec_files(ctx)
    if not specs:
        return fail_line(ctx, "missing_specs")

    failures = _report_implementation_scope_errors(ctx)
    # Renumbering suggestions have to clear every ID the feature already owns,
    # not just the ones in the file being repaired -- a file-local suggestion
    # walks straight into `duplicate_spec_id_across_specs`.
    taken: set[str] = set()
    for spec in specs:
        spec_text = read_text(spec)
        taken.update(SPEC_REQUIREMENT_DEF_RE.findall(spec_text))
        taken.update(SPEC_SCENARIO_DEF_RE.findall(spec_text))
    for spec in specs:
        text = read_text(spec)
        rel = spec.relative_to(ctx.feature_dir)
        _, duplicate_reasons = _spec_definition_index(text)
        for reason in duplicate_reasons:
            failures += fail_line(ctx, reason, f" file={rel}", target=str(rel))
        width_errors = contract_id_width_errors(text, taken)
        for width_error in width_errors:
            if width_error.suggested:
                taken.add(width_error.suggested)
            failures += fail_line(
                ctx,
                "spec_id_width_invalid",
                f" file={rel} id={width_error.current} suggested={width_error.suggested or 'NONE'}",
                target=str(rel),
                fields={
                    "id": width_error.current,
                    "suggested": width_error.suggested or "三位 ID 空间已耗尽",
                },
            )
        has_requirement_candidate = SPEC_REQUIREMENT_NUMERIC_RE.search(text) is not None
        has_scenario_candidate = SPEC_SCENARIO_NUMERIC_RE.search(text) is not None
        if not has_requirement_candidate:
            failures += fail_line(ctx, "invalid_spec_missing_requirement", f" file={rel}", target=str(rel))
        if not has_scenario_candidate:
            failures += fail_line(ctx, "invalid_spec_missing_scenario", f" file={rel}", target=str(rel))
        malformed = malformed_contract_headings(text)
        if malformed:
            failures += fail_line(
                ctx,
                "spec_contract_heading_malformed",
                f" file={rel} headings={'; '.join(malformed)}",
                target=str(rel),
                fields={"headings": "; ".join(malformed)},
            )
        barren = requirements_without_scenario(text)
        if barren:
            failures += fail_line(
                ctx,
                "spec_requirement_without_scenario",
                f" file={rel} requirements={','.join(barren)}",
                target=str(rel),
                fields={"requirements": ",".join(barren)},
            )
        orphans = scenarios_without_requirement(text)
        if orphans:
            failures += fail_line(
                ctx,
                "spec_scenario_without_requirement",
                f" file={rel} scenarios={','.join(orphans)}",
                target=str(rel),
                fields={"scenarios": ",".join(orphans)},
            )
    failures += _duplicate_ids_across_specs(ctx, specs)
    return failures


def _duplicate_ids_across_specs(ctx: HookContext, specs: list[Path]) -> int:
    """One REQ/SCN ID must name one thing across the whole feature.

    ``collect_spec_definition_index`` merges every spec's IDs into one flat set
    that five validators consume, ``_validate_scenario_coverage`` among them.
    A number reused in a second capability collapses into a single entry there,
    so covering one of them marks both covered -- the same vacuous-coverage
    shape the ID convention mismatch produced.
    """
    owners: dict[str, list[str]] = {}
    for spec in specs:
        text = read_text(spec)
        rel = spec.relative_to(ctx.feature_dir).as_posix()
        for pattern in (SPEC_REQUIREMENT_DEF_RE, SPEC_SCENARIO_DEF_RE):
            for spec_id in set(pattern.findall(text)):
                owners.setdefault(spec_id, []).append(rel)

    reserved = set(owners)
    failures = 0
    for spec_id, files in sorted(owners.items()):
        if len(files) > 1:
            sorted_files = sorted(files)
            prefix = spec_id.split("-", 1)[0]
            replacements: list[str] = []
            for owner in sorted_files[1:]:
                suggested = _next_free_spec_id(prefix, 0, reserved)
                if suggested:
                    reserved.add(suggested)
                    replacements.append(f"{owner}:{spec_id}->{suggested}")
                else:
                    replacements.append(f"{owner}:{spec_id}->三位 ID 空间已耗尽")
            failures += fail_line(
                ctx,
                "duplicate_spec_id_across_specs",
                f" id={spec_id} keep={sorted_files[0]} replacements={';'.join(replacements)}",
                target=spec_id,
                fields={
                    "files": ",".join(sorted_files),
                    "keep": sorted_files[0],
                    "replacements": "; ".join(replacements),
                },
            )
    return failures


def malformed_contract_headings(text: str) -> list[str]:
    """Heading lines carrying a REQ-/SCN- token that the ID indexer will not see."""
    malformed: list[str] = []
    for line in text.splitlines():
        if not CONTRACT_HEADING_CANDIDATE.match(line):
            continue
        if SPEC_REQUIREMENT_DEF_RE.match(line) or SPEC_SCENARIO_DEF_RE.match(line):
            continue
        # 数字 ID 的标题形状正确但位数错误时，由 ``spec_id_width_invalid``
        # 给唯一根因和替换值；这里不再重复报 malformed。
        if SPEC_REQUIREMENT_NUMERIC_RE.match(line) or SPEC_SCENARIO_NUMERIC_RE.match(line):
            continue
        malformed.append(line.strip())
    return malformed


class SpecIdWidth(NamedTuple):
    current: str
    suggested: str


def contract_id_width_errors(text: str, taken: Iterable[str] = ()) -> list[SpecIdWidth]:
    """Well-shaped numeric contract headings whose ID is not exactly three digits."""

    reserved = set(taken)
    reserved.update(SPEC_REQUIREMENT_DEF_RE.findall(text))
    reserved.update(SPEC_SCENARIO_DEF_RE.findall(text))
    errors: list[SpecIdWidth] = []
    for prefix, pattern in (
        ("REQ", SPEC_REQUIREMENT_NUMERIC_RE),
        ("SCN", SPEC_SCENARIO_NUMERIC_RE),
    ):
        highest = 0
        for match in pattern.finditer(text):
            digits = match.group("digits")
            current = match.group(1)
            if len(digits) == 3:
                highest = max(highest, int(digits))
                continue
            suggested = _next_free_spec_id(prefix, highest, reserved)
            if suggested:
                reserved.add(suggested)
                highest = int(suggested.rpartition("-")[2])
            errors.append(SpecIdWidth(current, suggested))
    return errors


def _next_free_spec_id(prefix: str, floor: int, reserved: set[str]) -> str:
    """Lowest ``<prefix>-NNN`` above ``floor`` that nothing else in the feature owns."""
    for number in range(floor + 1, 1000):
        candidate = f"{prefix}-{number:03d}"
        if candidate not in reserved:
            return candidate
    return ""


def scenarios_without_requirement(text: str) -> list[str]:
    """Scenario IDs that no Requirement owns.

    ``requirements_without_scenario`` checks the other direction. A Scenario
    placed before the file's first Requirement, or directly under an operation
    section heading, belongs to nothing -- it is indexed as a defined scenario
    and then demands coverage for a behaviour no Requirement states.
    """
    orphans: list[str] = []
    current_requirement: str | None = None
    for line in text.splitlines():
        if SECTION_HEADING.match(line):
            # A new `## ` section closes the Requirement that came before it.
            current_requirement = None
            continue
        requirement = SPEC_REQUIREMENT_DEF_RE.match(line)
        if requirement:
            current_requirement = requirement.group(1)
            continue
        scenario = SPEC_SCENARIO_DEF_RE.match(line)
        if scenario and current_requirement is None:
            orphans.append(scenario.group(1))
    return orphans


def requirements_without_scenario(text: str) -> list[str]:
    """Requirement IDs whose own block carries no Scenario heading.

    A file-level "has at least one REQ and one SCN" check passes when three
    Requirements share a single Scenario, so slice per Requirement instead.
    Uses the same two module-level patterns the ID indexer uses; introducing a
    third spelling here is what let coverage go vacuous before.
    """
    matches = list(SPEC_REQUIREMENT_DEF_RE.finditer(text))
    barren: list[str] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        block = text[match.end():end]
        # A new `## ` section ends the Requirement even without a following `### `.
        next_section = re.search(r"^##\s+\S", block, re.MULTILINE)
        if next_section:
            block = block[: next_section.start()]
        if not SPEC_SCENARIO_DEF_RE.search(block):
            barren.append(match.group(1))
    return barren


def validate_design_contract(ctx: HookContext) -> int:
    design = ctx.file("design.md")
    if not is_nonempty(design):
        return fail_line(ctx, "missing_design")

    text = read_text(design)
    failures = validate_no_template_guidance(ctx, design, text)
    required_sections = [
        "Context / 输入上下文",
        "Code Evidence",
        "Spec Traceability",
        "API Decisions",
        "Data Decisions",
        "Technical Design",
        "Risks / Open Questions",
    ]
    for section in required_sections:
        if section not in text:
            failures += fail_line(ctx, "invalid_design_missing_section", f" section={section!r}", target=section)

    no_http_api = design_marker_value(text, "x-auto-no-http-api")
    no_sql = design_marker_value(text, "x-auto-no-sql")
    if no_http_api is None:
        failures += fail_line(ctx, "missing_design_api_marker")
    if no_sql is None:
        failures += fail_line(ctx, "missing_design_data_marker")
    design_ids, _ = collect_design_definition_index(ctx)
    if no_http_api is True and design_ids["API"]:
        failures += fail_line(ctx, "design_api_marker_conflicts_with_definitions")
    if no_sql is True and design_ids["DATA"]:
        failures += fail_line(ctx, "design_data_marker_conflicts_with_definitions")
    pending = PENDING_CELL.findall(text)
    if pending:
        failures += fail_line(
            ctx,
            "design_has_pending_cells",
            f" count={len(pending)}",
            target=f"{len(pending)} 处",
        )
    failures += _unresolved_decision_refs(ctx, text)
    return failures


def validate_design_contract_lock(ctx: HookContext) -> int:
    """Require the Design-owned snapshot to match the validated design artifact."""

    failures = 0
    for issue in validate_locked_design_contract(ctx.feature_dir, ctx.slug):
        failures += _emit_artifact_issue(ctx, issue, ".design-contract.lock.json")
    return failures


def _unresolved_decision_refs(ctx: HookContext, design_text: str) -> int:
    """Every ``DEC-NNN`` design cites must exist in the proposal's Decision Log.

    The lookup is scoped to the section, not the whole file: a ``### DEC-001:``
    heading dropped anywhere else in the proposal would otherwise resolve the
    reference, which makes the check report something weaker than it claims.

    Reference resolution only. Whether a decision is well argued, and whether
    every Requirement needs one, are judgements a script cannot make -- and the
    2026-07-29 trace showed that demanding a self-issued status word here just
    teaches the model to forge one. Existence is a fact about files, so that is
    all this checks; ``无`` stays a legal cell value.
    """
    cited = set(SPEC_DECISION_ID.findall(design_text))
    if not cited:
        return 0

    proposal = ctx.file("proposal.md")
    if not is_nonempty(proposal):
        # `proposal_contract` owns a missing proposal; do not report it twice.
        return 0

    section = DECISION_LOG_SECTION.search(read_text(proposal))
    defined = set(SPEC_DECISION_HEADING.findall(section.group("body"))) if section else set()
    missing = sorted(cited - defined)
    if not missing:
        return 0
    return fail_line(
        ctx,
        "design_decision_ref_unresolved",
        f" ids={','.join(missing)}",
        target=",".join(missing),
    )


def _spec_definition_index(text: str) -> tuple[dict[str, set[str]], list[str]]:
    req_ids = SPEC_REQUIREMENT_DEF_RE.findall(text)
    scn_ids = SPEC_SCENARIO_DEF_RE.findall(text)
    failures: list[str] = []
    if len(req_ids) != len(set(req_ids)):
        failures.append("duplicate_requirement_id")
    if len(scn_ids) != len(set(scn_ids)):
        failures.append("duplicate_scenario_id")
    return {"REQ": set(req_ids), "SCN": set(scn_ids)}, failures


def collect_spec_definition_index(ctx: HookContext) -> tuple[dict[str, set[str]], int]:
    failures = 0
    index = {"REQ": set(), "SCN": set()}
    for spec in spec_files(ctx):
        definitions, duplicate_reasons = _spec_definition_index(read_text(spec))
        rel = spec.relative_to(ctx.feature_dir)
        for reason in duplicate_reasons:
            failures += fail_line(ctx, reason, f" file={rel}", target=str(rel))
        index["REQ"].update(definitions["REQ"])
        index["SCN"].update(definitions["SCN"])
    return index, failures


def _design_definition_index(text: str) -> tuple[dict[str, set[str]], list[str]]:
    api_ids = DESIGN_API_DEF_RE.findall(text)
    data_ids = DESIGN_DATA_DEF_RE.findall(text)
    decision_ids = DESIGN_DECISION_DEF_RE.findall(text)
    failures: list[str] = []
    if len(api_ids) != len(set(api_ids)):
        failures.append("duplicate_design_api_id")
    if len(data_ids) != len(set(data_ids)):
        failures.append("duplicate_design_data_id")
    if len(decision_ids) != len(set(decision_ids)):
        failures.append("duplicate_design_decision_id")
    return {"API": set(api_ids), "DATA": set(data_ids), "D": set(decision_ids)}, failures


def collect_design_definition_index(ctx: HookContext) -> tuple[dict[str, set[str]], int]:
    design = ctx.file("design.md")
    if not is_nonempty(design):
        return {"API": set(), "DATA": set(), "D": set()}, 0
    definitions, duplicate_reasons = _design_definition_index(read_text(design))
    failures = 0
    for reason in duplicate_reasons:
        failures += fail_line(ctx, reason, target="design.md")
    return definitions, failures


def load_json_artifact(ctx: HookContext, name: str, *, required: bool = True) -> tuple[dict | None, int]:
    path = ctx.file(name)
    if not is_nonempty(path):
        if not required:
            info(ctx, "json_artifact_missing_degrade", f" file={name}")
            return None, 0
        return None, fail_line(ctx, "missing_json_artifact", f" file={name}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return None, fail_line(ctx, "invalid_json_artifact", f" file={name} detail={exc}")
    if not isinstance(data, dict):
        return None, fail_line(ctx, "invalid_json_artifact_root", f" file={name}")
    return data, 0


def _string_list_value(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return None
        stripped = item.strip()
        if stripped:
            result.append(stripped)
    return result


def _scenario_refs_from_spec_refs(spec_refs: list[str]) -> set[str]:
    return set(SCN_ID.findall(" ".join(spec_refs)))


def validate_ui_context_json(ctx: HookContext) -> int:
    data, failures = load_json_artifact(
        ctx,
        "UI_CONTEXT.json",
        required=ctx.requires_artifact("UI_CONTEXT.json"),
    )
    if data is None:
        return failures
    spec_ids, spec_failures = collect_spec_definition_index(ctx)
    failures += spec_failures
    for error in validate_ui_context_data(
        data,
        feature_id=ctx.slug,
        # PRD creates the confirmed UI scope before spec IDs exist; specs/plan
        # stages still require the context to be locked and reference-resolved.
        require_locked=ctx.requires_artifact("UI_CONTEXT.json")
        and ctx.skill != "autobiz-requirement-discuss",
        defined_requirements=spec_ids["REQ"],
        defined_scenarios=spec_ids["SCN"],
    ):
        failures += fail_line(ctx, "invalid_ui_context_json", f" detail={error}")
    return failures


def _load_ui_context_for_projection(ctx: HookContext) -> tuple[dict | None, int]:
    try:
        data = load_ui_context(ctx.feature_dir)
    except UIContextError as exc:
        return None, fail_line(ctx, "invalid_ui_context_json", f" detail={exc}")
    if data is None:
        if ctx.requires_artifact("UI_CONTEXT.json"):
            return None, fail_line(ctx, "missing_json_artifact", " file=UI_CONTEXT.json")
        info(ctx, "ui_context_not_in_contract_degrade")
        return None, 0
    return data, 0


def _visual_source_expected_frontend_route(source: dict) -> str | None:
    route = source.get("route")
    if isinstance(route, str) and route in {
        ROUTE_SPEC_DRIVEN,
        ROUTE_ABSOLUTE,
        ROUTE_STANDARD,
        ROUTE_MISSING,
    }:
        return route
    source_type = source.get("type")
    if source_type == "high_fidelity_html":
        return ROUTE_ABSOLUTE
    if source_type == "standard_html":
        return ROUTE_STANDARD
    return None


def validate_plan_ui_projection(ctx: HookContext) -> int:
    ui_data, failures = _load_ui_context_for_projection(ctx)
    if ui_data is None:
        return failures
    indexes = ui_context_indexes(ui_data)
    visual_sources_by_id = {
        item["sourceId"]: item
        for item in ui_data.get("visualSources", [])
        if isinstance(item, dict) and isinstance(item.get("sourceId"), str)
    }
    capabilities = [
        item
        for item in ui_data.get("capabilities", [])
        if isinstance(item, dict) and item.get("uiRequired") is not False
    ]

    plan_data, errors = load_and_validate_plan(plan_json_path(ctx.feature_dir))
    if errors or plan_data is None:
        return failures

    raw_tasks = plan_data.get("tasks")
    if not isinstance(raw_tasks, list):
        return failures

    feature_ui_required = ui_data.get("uiRequired") is True
    ui_task_count = 0
    for index, task in enumerate(raw_tasks):
        if not isinstance(task, dict):
            continue
        task_id = task.get("id") if isinstance(task.get("id"), str) else f"tasks[{index}]"
        task_ui_required = task.get("uiRequired") is True
        ui_refs = task.get("uiRefs")

        if not feature_ui_required:
            if task_ui_required:
                failures += fail_line(ctx, "plan_ui_task_when_feature_not_ui", f" task={task_id}")
            if isinstance(ui_refs, dict) and ui_refs:
                failures += fail_line(ctx, "plan_ui_refs_when_feature_not_ui", f" task={task_id}")
            continue

        if not task_ui_required:
            if isinstance(ui_refs, dict) and ui_refs:
                failures += fail_line(ctx, "plan_ui_refs_for_non_ui_task", f" task={task_id}")
            continue

        if task_ui_required:
            ui_task_count += 1
            if not isinstance(ui_refs, dict):
                failures += fail_line(ctx, "plan_ui_task_missing_uiRefs", f" task={task_id}")
                continue
            for field, known in (
                ("pageRefs", indexes["page"]),
                ("interactionRefs", indexes["interaction"]),
                ("visualSourceRefs", indexes["visualSource"]),
            ):
                refs = _string_list_value(ui_refs.get(field))
                if refs is None:
                    failures += fail_line(ctx, "invalid_plan_ui_refs", f" task={task_id} field={field}")
                    continue
                if field == "pageRefs" and not refs:
                    failures += fail_line(ctx, "missing_plan_ui_refs", f" task={task_id} field={field}")
                for ref in refs:
                    if ref not in known:
                        failures += fail_line(ctx, "unknown_plan_ui_ref", f" task={task_id} field={field} ref={ref}")
            frontend_route = ui_refs.get("frontendRoute")
            if not isinstance(frontend_route, str) or frontend_route not in {
                ROUTE_NONE,
                ROUTE_SPEC_DRIVEN,
                ROUTE_ABSOLUTE,
                ROUTE_STANDARD,
                ROUTE_MISSING,
            }:
                failures += fail_line(ctx, "invalid_plan_ui_frontend_route", f" task={task_id}")
                continue
            visual_refs = _string_list_value(ui_refs.get("visualSourceRefs")) or []
            task_spec_refs = set(_string_list_value(task.get("specRefs")) or [])
            matching_capabilities = [
                capability
                for capability in capabilities
                if task_spec_refs.intersection(_string_list_value(capability.get("specRefs")) or [])
            ]
            if matching_capabilities and any(
                "visualSourceRefs" in capability for capability in matching_capabilities
            ):
                expected_visual_refs = {
                    ref
                    for capability in matching_capabilities
                    for ref in (_string_list_value(capability.get("visualSourceRefs")) or [])
                }
                if set(visual_refs) != expected_visual_refs:
                    failures += fail_line(
                        ctx,
                        "plan_ui_visual_source_projection_mismatch",
                        (
                            f" task={task_id} expected={','.join(sorted(expected_visual_refs)) or 'none'}"
                            f" actual={','.join(sorted(visual_refs)) or 'none'}"
                        ),
                    )
                if not expected_visual_refs and frontend_route != ROUTE_SPEC_DRIVEN:
                    failures += fail_line(
                        ctx,
                        "plan_ui_route_without_visual_source",
                        f" task={task_id} expected={ROUTE_SPEC_DRIVEN} actual={frontend_route}",
                    )
            for visual_ref in visual_refs:
                visual_source = visual_sources_by_id.get(visual_ref)
                if visual_source is None:
                    continue
                expected_route = _visual_source_expected_frontend_route(visual_source)
                if expected_route is not None and frontend_route != expected_route:
                    failures += fail_line(
                        ctx,
                        "plan_ui_frontend_route_mismatch",
                        f" task={task_id} visualSource={visual_ref} expected={expected_route} actual={frontend_route}",
                    )

    implementation_scope, _ = load_scope(ctx.feature_dir)
    selections, _ = resolve_plan_scope(ctx.feature_dir)
    scenario_selection = selections["scenario"]
    in_scope_ui = feature_ui_required and implementation_scope != "backend_only"
    if scenario_selection.deferred or scenario_selection.unpartitioned:
        in_scope_ui = in_scope_ui and any(
            scenario_selection.included.intersection(_string_list_value(capability.get("specRefs")) or [])
            for capability in capabilities
        )
    if in_scope_ui and ui_task_count == 0:
        failures += fail_line(ctx, "plan_ui_required_without_ui_task")
    return failures


def _artifact_issue_target(issue: dict, fallback: str) -> str:
    task_ids = issue.get("taskIds")
    task_id = ""
    if isinstance(task_ids, list):
        task_id = ",".join(str(item) for item in task_ids if item)

    field = issue.get("field")
    location = ".".join(
        item for item in (task_id, str(field) if field else "") if item
    )
    current_value = issue.get("currentValue")
    if current_value not in (None, ""):
        return f"{location} {current_value}".strip()
    return location or fallback


def _emit_artifact_issue(ctx: HookContext, issue: dict, fallback: str) -> int:
    reason = str(issue.get("reason") or "invalid_artifact_ref")
    detail = str(issue.get("detail") or "")
    return fail_line(
        ctx,
        reason,
        f" {detail}" if detail else "",
        target=_artifact_issue_target(issue, fallback),
        fields={"detail": detail},
    )


def _validate_plan_json_traceability(ctx: HookContext, data: dict) -> int:
    failures = 0
    spec_ids, spec_failures = collect_spec_definition_index(ctx)
    # dev.design already validated and locked design.md.  Plan consumes the
    # snapshot instead of reopening the upstream artifact.
    design_contract, design_issues = load_confirmed_design_contract(ctx.feature_dir, ctx.slug)
    failures += spec_failures
    for issue in design_issues:
        failures += _emit_artifact_issue(ctx, issue, "design.md")

    raw_tasks = data.get("tasks")
    if not isinstance(raw_tasks, list):
        return failures

    for index, task in enumerate(raw_tasks):
        context = f"tasks[{index}]"
        if not isinstance(task, dict):
            continue
        task_id = task.get("id") if isinstance(task.get("id"), str) else context

        spec_refs = _string_list_value(task.get("specRefs")) or []
        req_refs = set(REQ_ID.findall(" ".join(spec_refs)))
        scn_refs = _scenario_refs_from_spec_refs(spec_refs)
        if not req_refs:
            failures += fail_line(ctx, "missing_plan_json_requirement_ref", f" task={task_id}", target=task_id)
        if not scn_refs:
            failures += fail_line(ctx, "missing_plan_json_scenario_ref", f" task={task_id}", target=task_id)
        for req_id in sorted(req_refs):
            if req_id not in spec_ids["REQ"]:
                failures += fail_line(
                    ctx,
                    "unknown_plan_json_requirement_ref",
                    f" task={task_id} id={req_id}",
                    target=f"{task_id}.specRefs {req_id}",
                )
        for scn_id in sorted(scn_refs):
            if scn_id not in spec_ids["SCN"]:
                failures += fail_line(
                    ctx,
                    "unknown_plan_json_scenario_ref",
                    f" task={task_id} id={scn_id}",
                    target=f"{task_id}.specRefs {scn_id}",
                )

        for issue in validate_task_artifact_refs(
            ctx.feature_dir,
            task,
            design_contract=design_contract,
            check_design_artifact=False,
        ):
            failures += _emit_artifact_issue(ctx, issue, task_id)
    selections, partition_errors = resolve_plan_scope(ctx.feature_dir)
    for issue in partition_errors:
        failures += _emit_artifact_issue(ctx, issue, "IMPLEMENTATION_SCOPE.json")
    report = scope_report(selections)
    if report:
        info(ctx, "plan_scope_report " + json.dumps(report, ensure_ascii=False))
    for issue in validate_plan_design_coverage(design_contract, raw_tasks, included_ids=selections["design"].included):
        reason = str(issue.get("reason") or "")
        fallback = {
            "missing_design_api_id": "API Decisions",
            "missing_design_data_id": "Data Decisions",
        }.get(reason, "plan.json")
        failures += _emit_artifact_issue(ctx, issue, fallback)
    return failures


def _plan_task_string_list(task: dict, field: str) -> list[str]:
    return _string_list_value(task.get(field)) or []


def _spec_scenario_refs_by_path(ctx: HookContext) -> dict[str, set[str]]:
    refs_by_id: dict[str, set[str]] = {}
    for spec in spec_files(ctx):
        rel = spec.relative_to(ctx.feature_dir).as_posix()
        for scn_id in SPEC_SCENARIO_DEF_RE.findall(read_text(spec)):
            refs_by_id.setdefault(scn_id, set()).add(f"{rel}#{scn_id}")
    return refs_by_id


def _covered_spec_scenario_refs(spec_refs: list[str], refs_by_id: dict[str, set[str]]) -> set[str]:
    covered: set[str] = set()
    for raw_ref in spec_refs:
        if not isinstance(raw_ref, str):
            continue
        path_part, _, anchor = raw_ref.partition("#")
        scenario_ids = SCN_ID.findall(anchor or raw_ref)
        if not scenario_ids:
            continue
        normalized_path = path_part.strip().replace("\\", "/")
        for scn_id in scenario_ids:
            if normalized_path:
                covered.add(f"{normalized_path}#{scn_id}")
            elif len(refs_by_id.get(scn_id, set())) == 1:
                covered.update(refs_by_id[scn_id])
    return covered


def validate_plan_task_granularity(ctx: HookContext) -> int:
    plan_json = ctx.file("plan.json")
    if not ctx.requires_artifact("plan.json") and not is_nonempty(plan_json):
        info(ctx, "plan_task_granularity_not_in_contract_degrade")
        return 0

    data, errors = load_and_validate_plan(plan_json)
    failures = 0
    if errors:
        for error in errors:
            failures += fail_line(ctx, "invalid_plan_json", f" detail={error}", target=str(error))
        return failures
    if data is None:
        return fail_line(ctx, "missing_plan_json", target="plan.json")

    raw_tasks = data.get("tasks")
    if not isinstance(raw_tasks, list):
        return failures
    for index, task in enumerate(raw_tasks):
        if not isinstance(task, dict):
            continue
        task_id = task.get("id") if isinstance(task.get("id"), str) else f"tasks[{index}]"
        task_errors = validate_plan_task_granularity_item(task, task_id=task_id)
        for error in task_errors:
            failures += fail_line(
                ctx,
                error["reason"],
                " " + error.get("detail", ""),
                target=task_id,
                fields={"detail": error.get("detail", "")},
                diagnostics=error,
            )
    return failures


def validate_plan_scenario_coverage(ctx: HookContext) -> int:
    plan_json = ctx.file("plan.json")
    if not ctx.requires_artifact("plan.json") and not is_nonempty(plan_json):
        info(ctx, "plan_scenario_coverage_not_in_contract_degrade")
        return 0

    refs_by_id = _spec_scenario_refs_by_path(ctx)
    selections, partition_errors = resolve_plan_scope(ctx.feature_dir)
    expected_refs = selections["scenario"].included
    if partition_errors:
        return sum(_emit_artifact_issue(ctx, issue, "IMPLEMENTATION_SCOPE.json") for issue in partition_errors)
    if not expected_refs:
        info(ctx, "plan_scenario_coverage_no_specs_degrade")
        return 0

    data, errors = load_and_validate_plan(plan_json)
    failures = 0
    if errors:
        for error in errors:
            failures += fail_line(ctx, "invalid_plan_json", f" detail={error}", target=str(error))
        return failures
    if data is None:
        return fail_line(ctx, "missing_plan_json", target="plan.json")

    covered_refs: set[str] = set()
    raw_tasks = data.get("tasks")
    if isinstance(raw_tasks, list):
        for task in raw_tasks:
            if not isinstance(task, dict):
                continue
            covered_refs.update(_covered_spec_scenario_refs(_plan_task_string_list(task, "specRefs"), refs_by_id))

    missing_refs = expected_refs - covered_refs
    if missing_refs:
        failures += fail_line(
            ctx,
            "missing_plan_scenario_coverage",
            f" ids={','.join(sorted(missing_refs))}",
            target=",".join(sorted(missing_refs)),
        )
    return failures


def validate_plan_ref_resolution(ctx: HookContext) -> int:
    plan_json = ctx.file("plan.json")
    if not ctx.requires_artifact("plan.json") and not is_nonempty(plan_json):
        info(ctx, "plan_ref_resolution_not_in_contract_degrade")
        return 0

    data, errors = load_and_validate_plan(plan_json)
    failures = 0
    if errors:
        for error in errors:
            failures += fail_line(ctx, "invalid_plan_json", f" detail={error}", target=str(error))
        return failures
    if data is None:
        return fail_line(ctx, "missing_plan_json", target="plan.json")

    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        return failures
    for index, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        task_id = task.get("id") if isinstance(task.get("id"), str) else f"tasks[{index}]"
        _, _, ref_errors = resolve_task_refs(ctx.feature_dir, task)
        for error in ref_errors:
            detail = error.get("detail", "")
            suffix = f" task={task_id} detail={detail}" if detail else f" task={task_id}"
            failures += fail_line(
                ctx,
                error.get("reason", "invalid_artifact_ref"),
                suffix,
                target=task_id,
                fields={"detail": detail},
            )
    return failures


def validate_plan_json_initial_tasks(ctx: HookContext) -> int:
    if not ctx.requires_artifact("plan.json") and not is_nonempty(ctx.file("plan.json")):
        if is_nonempty(ctx.file("PLAN.md")):
            return fail_line(
                ctx,
                "missing_plan_json",
                " detail=PLAN.md_present_but_not_machine_source",
                target="plan.json（当前只有 PLAN.md，它是投影视图不是事实源）",
            )
        info(ctx, "plan_json_not_in_contract_degrade")
        return 0
    data, errors = load_and_validate_plan(ctx.file("plan.json"), require_initial_status=True)
    failures = 0
    for error in errors:
        failures += fail_line(ctx, "invalid_plan_json", f" detail={error}", target=str(error))
    if data is not None and not errors and data.get("taskSetStatus") != "finalized":
        failures += fail_line(ctx, "plan_task_set_not_finalized", target="plan.json.taskSetStatus")
    return failures


def validate_parallel_batch_pipeline_contract(ctx: HookContext) -> int:
    """Require the per-Batch UTest plus E2E-only pipeline contract."""
    plan_json = ctx.file("plan.json")
    if not ctx.requires_artifact("plan.json") and not is_nonempty(plan_json):
        info(ctx, "parallel_batch_pipeline_not_in_contract_degrade")
        return 0
    try:
        bundle = load_plan_bundle(ctx.feature_dir)
    except Exception as exc:  # plan_json_contract reports the structural cause too.
        return fail_line(ctx, "invalid_parallel_batch_pipeline", f" detail={exc}")

    failures = 0
    for error in validation_ownership_errors(bundle.root, bundle.batches):
        failures += fail_line(
            ctx,
            "invalid_parallel_batch_pipeline",
            f" detail={error}",
            target=error,
        )
    return failures


def validate_plan_json_contract(ctx: HookContext) -> int:
    plan_json = ctx.file("plan.json")
    if not ctx.requires_artifact("plan.json") and not is_nonempty(plan_json):
        if is_nonempty(ctx.file("PLAN.md")):
            return fail_line(
                ctx,
                "missing_plan_json",
                " detail=PLAN.md_present_but_not_machine_source",
                target="plan.json（当前只有 PLAN.md，它是投影视图不是事实源）",
            )
        info(ctx, "plan_json_not_in_contract_degrade")
        return 0

    data, errors = load_and_validate_plan(plan_json)
    failures = 0
    if errors:
        for error in errors:
            failures += fail_line(ctx, "invalid_plan_json", f" detail={error}", target=str(error))
        return failures
    if data is None:
        return fail_line(ctx, "missing_plan_json", target="plan.json")
    implementation_scope, scope_errors = _implementation_scope_contract_errors(ctx)
    for error in scope_errors:
        failures += fail_line(ctx, "invalid_implementation_scope", f" detail={error}", target=error)
    if scope_path(ctx.feature_dir).is_file() and not scope_errors:
        plan_scope = data.get("implementationScope")
        if plan_scope != implementation_scope:
            failures += fail_line(
                ctx,
                "plan_implementation_scope_mismatch",
                f" plan={plan_scope!r} feature={implementation_scope!r}",
                target=f"plan={plan_scope!r} feature={implementation_scope!r}",
            )
    failures += _validate_plan_json_traceability(ctx, data)
    failures += validate_plan_ui_projection(ctx)
    return failures
