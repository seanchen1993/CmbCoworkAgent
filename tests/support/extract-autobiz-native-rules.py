"""Reproducible, static extraction of reviewed read-only AutoBiz rule definitions.

Run from repository root. This reads only named Python sources, never plugin manifests
or MCP configuration. No source is imported or executed during extraction.
"""
import ast
import hashlib
import json
from pathlib import Path

SOURCE = Path("output/deliveries/autobiz-requirements-composition-20261023-r13/revision-2/complete-plugin")
TARGET = Path("resources/native-compositions/autobiz-rules/checks")
PROVENANCE = []


def extract(source, destination, roots, imports):
    original_bytes = (SOURCE / source).read_bytes()
    raw = original_bytes.decode("utf-8")
    tree = ast.parse(raw)
    symbols = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            symbols[node.name] = node
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    symbols[target.id] = node
    selected = set()
    pending = list(roots)
    while pending:
        name = pending.pop()
        if name in selected or name not in symbols:
            continue
        selected.add(name)
        pending.extend(item.id for item in ast.walk(symbols[name])
                       if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load))
    nodes = {id(symbols[name]) for name in selected}
    bodies = []
    for node in tree.body:
        if id(node) not in nodes:
            continue
        start = min([node.lineno] + [decorator.lineno for decorator in getattr(node, "decorator_list", [])])
        bodies.append("\n".join(raw.splitlines()[start - 1:node.end_lineno]))
    text = ('"""Read-only rules extracted from ' + source + '. See provenance.json."""\n'
            + "from __future__ import annotations\n" + imports + "\n\n" + "\n\n\n".join(bodies) + "\n")
    output = TARGET / destination
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8", newline="\n")
    PROVENANCE.append({"source": source, "sourceSha256": hashlib.sha256(original_bytes).hexdigest(),
                       "target": destination, "symbols": sorted(selected),
                       "targetSha256": hashlib.sha256(text.encode()).hexdigest()})


extract("hooks/spec_contract.py", "hooks/spec_contract.py",
        ["SPEC_REQUIREMENT_DEF_RE", "SPEC_SCENARIO_DEF_RE", "spec_heading"],
        "import re\nfrom typing import Match, Optional, Pattern")
extract("hooks/ui_context.py", "hooks/ui_context.py", ["validate_ui_context_data", "ui_context_indexes", "load_ui_context", "ui_context_path"],
        "import json\nimport re\nfrom pathlib import Path\nfrom typing import Any")
extract("hooks/source_references.py", "hooks/source_references.py",
        ["split_source_reference_section", "has_source_section", "extract_source_references"],
        "import re\nfrom dataclasses import dataclass")
extract("hooks/source_context.py", "hooks/source_context.py", ["validate_source_context", "load_source_context", "source_index"],
        "import json\nimport re\nfrom pathlib import Path\nfrom typing import Any, Dict, List, Optional, Set, Tuple")
extract("hooks/artifact_ref_validator.py", "hooks/artifact_ref_validator.py",
        ["design_marker_value", "load_design_contract", "design_contract_snapshot", "validate_task_artifact_refs", "validate_plan_design_coverage"],
        "import hashlib\nimport re\nfrom pathlib import Path\nfrom typing import Any\nfrom hooks.spec_contract import spec_heading")
extract("hooks/design_contract_lock.py", "hooks/design_contract_lock.py",
        ["validate_design_contract_lock", "load_confirmed_design_contract"],
        "import json\nimport re\nfrom pathlib import Path\nfrom typing import Any\n"
        "from hooks.artifact_ref_validator import load_design_contract, design_contract_snapshot\n"
        "def load_json(path):\n    return json.loads(path.read_text(encoding='utf-8'))")
extract("hooks/implementation_scope.py", "hooks/implementation_scope.py", ["load_scope", "scope_path"],
        "import json\nfrom pathlib import Path\nfrom typing import Any")
extract("skills/autobiz/hooks/prd_rules.py", "prd_rules.py",
        ["iter_headings", "pending_marker_lines", "REQUIRED_PRD_SECTIONS", "FORMAL_SECTION_MAX_LEVEL"],
        "import re\nfrom dataclasses import dataclass\nfrom typing import List, Sequence, Union")
extract("hooks/plan_write_ownership.py", "hooks/plan_write_ownership.py", ["write_ownership_error_codes", "is_test_asset_path"],
        "from collections import defaultdict\nfrom typing import Any, Iterable, Mapping")
extract("hooks/plan_json.py", "hooks/plan_json.py", ["load_and_validate_plan", "load_plan_bundle"],
        "import hashlib\nimport json\nimport re\nfrom dataclasses import dataclass\nfrom pathlib import Path, PurePosixPath, PureWindowsPath\nfrom typing import Any\n"
        "from hooks.plan_write_ownership import write_ownership_error_codes")
extract("hooks/plan_scope.py", "hooks/plan_scope.py", ["resolve_plan_scope", "scope_report"],
        "import json\nimport re\nfrom pathlib import Path\nfrom typing import Any, NamedTuple\n"
        "from hooks.implementation_scope import scope_path\nfrom hooks.spec_contract import SPEC_SCENARIO_DEF_RE\n"
        "from hooks.design_contract_lock import load_confirmed_design_contract\nfrom hooks.source_context import load_source_context, source_index")
extract("hooks/plan_granularity.py", "hooks/plan_granularity.py", ["validate_plan_task_granularity_item"],
        "import re\nfrom typing import Any")
extract("hooks/code_task_context.py", "hooks/code_task_context.py", ["resolve_task_refs"],
        "import re\nfrom pathlib import Path\nfrom typing import Any\nfrom hooks.spec_contract import spec_heading\n"
        "from hooks.source_context import load_source_context, source_index\nclass WriterError(ValueError): pass")
extract("hooks/parallel_validation_ownership.py", "hooks/parallel_validation_ownership.py", ["validation_ownership_errors", "build_pipeline_contract"],
        "import hashlib\nimport json\nfrom pathlib import Path\nfrom typing import Any\nfrom hooks.plan_json import PlanBundle, load_plan_bundle")
extract("hooks/resolve_frontend_html_route.py", "hooks/frontend_route_constants.py", ["ROUTE_NONE", "ROUTE_SPEC_DRIVEN", "ROUTE_ABSOLUTE", "ROUTE_STANDARD", "ROUTE_MISSING"], "")
extract("hooks/code_shell_analysis.py", "hooks/command_executable.py", ["executable"], "import re\nimport posixpath")
extract("hooks/code_execution_guard.py", "hooks/compile_command_policy.py", ["_production_compile_argv"], "import re\nfrom pathlib import Path\nfrom hooks.command_executable import executable")
extract("hooks/utest_plan_contract.py", "hooks/utest_command_policy.py", ["command_executes_tests"], "from pathlib import Path")
extract("hooks/utest_plan_contract.py", "hooks/utest_repair_contract.py",
        ["validate_source_bug", "public_target", "derive_check_matrix", "derive_unverified_checks", "derive_scenario_coverage"],
        "import hashlib\nimport json\nimport re\nfrom pathlib import Path")
extract("hooks/check-secrets-new.py", "hooks/secret_rules.py", ["check_line"], "import re")
# Preserve matching semantics; remove the original debug print that exposed complete values.
secret_path = TARGET / "hooks/secret_rules.py"
secret_text = secret_path.read_text(encoding="utf-8").replace('    print(f"line: {line}", file=sys.stderr)\n', '')
secret_path.write_text(secret_text, encoding="utf-8", newline="\n")
PROVENANCE[-1]["adaptations"] = ["Remove stderr debug print of the complete input line; no secret values are logged."]
PROVENANCE[-1]["targetSha256"] = hashlib.sha256(secret_text.encode()).hexdigest()
package_hooks = Path("resources/native-compositions/autobiz/hooks")
package_hooks.mkdir(parents=True, exist_ok=True)
(package_hooks / "secret_rules.py").write_text(secret_text, encoding="utf-8", newline="\n")
extract("hooks/performance_checker.py", "hooks/performance_rules.py",
        ["run_check", "FRONTEND_EXTENSIONS"], "import re\nfrom typing import List, Dict, Tuple")
extract("skills/autodev/hooks/artifact_check.py", "artifact_rules.py", [
    "validate_proposal_contract", "validate_specs_contract", "validate_capability_spec_correspondence",
    "validate_design_contract", "validate_design_contract_lock", "validate_ui_context_json",
    "validate_plan_json_initial_tasks", "validate_plan_json_contract", "validate_plan_task_granularity",
    "validate_plan_scenario_coverage", "validate_plan_ref_resolution", "validate_parallel_batch_pipeline_contract"
], "import json\nimport re\nfrom pathlib import Path\nfrom typing import NamedTuple\n"
   "from native_context import HookContext, fail_line, info, is_nonempty, read_text\n"
   "from hooks.implementation_scope import load_scope, scope_path\n"
   "from hooks.spec_contract import SPEC_REQUIREMENT_DEF_RE, SPEC_SCENARIO_DEF_RE\n"
   "from hooks.artifact_ref_validator import design_marker_value\n"
   "from hooks.design_contract_lock import validate_design_contract_lock as validate_locked_design_contract\n"
   "from hooks.ui_context import validate_ui_context_data, load_ui_context, ui_context_indexes, ui_context_path\n"
   "from hooks.plan_json import load_and_validate_plan, load_plan_bundle, plan_json_path\n"
   "from hooks.artifact_ref_validator import validate_task_artifact_refs, validate_plan_design_coverage\n"
   "from hooks.design_contract_lock import load_confirmed_design_contract\n"
   "from hooks.plan_scope import resolve_plan_scope, scope_report\n"
   "from hooks.plan_granularity import validate_plan_task_granularity_item\n"
   "from hooks.code_task_context import resolve_task_refs\n"
   "from hooks.parallel_validation_ownership import validation_ownership_errors\n"
   "from hooks.frontend_route_constants import ROUTE_NONE, ROUTE_SPEC_DRIVEN, ROUTE_ABSOLUTE, ROUTE_STANDARD, ROUTE_MISSING")
(TARGET / "provenance.json").write_text(json.dumps(PROVENANCE, ensure_ascii=False, indent=2) + "\n",
                                         encoding="utf-8", newline="\n")
rules = {path.relative_to(TARGET).as_posix(): path.read_text(encoding="utf-8")
         for path in sorted(TARGET.rglob("*.py"))}
(TARGET.parent / "mods/rules-bundle.ts").write_text(
    "// Static checked source bundle; included in the public action code identity.\nexport const rules = "
    + json.dumps(rules, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
print(json.dumps({"files": len(PROVENANCE), "symbols": sum(len(row["symbols"]) for row in PROVENANCE)}))

workflow = Path("resources/native-compositions/autobiz/workflows/native-code.workflow.js").read_bytes()
(TARGET.parent / "mods/code-script-identity.ts").write_text(
    "// Exact retained native workflow source, verified against the original run.\nexport const nativeCodeScriptSha256 = "
    + json.dumps(hashlib.sha256(workflow).hexdigest()) + "\n", encoding="utf-8", newline="\n")
