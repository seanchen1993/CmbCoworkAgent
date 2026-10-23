"""Plugin adapter for the original, record-specific composable workflow contract."""

import hashlib
import json
from pathlib import Path

from journal import linked, policy_digest, read_record


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def artifact_view(item):
    value = {"id": item["id"], "path": item["path"], "required": item.get("required", True)}
    if "schemaVersion" in item:
        value["schemaVersion"] = item["schemaVersion"]
    if "schema" in item:
        if len(canonical(item["schema"]).encode("utf-8")) > 16384:
            raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_LIMIT")
        value["schema"] = item["schema"]
    return value


def effective_contract(source, workspace, record):
    from board_core.contracts import load_record_workflow_contracts
    workflow = load_record_workflow_contracts(source, record, workspace=workspace)
    if not workflow.nodes or len(workflow.nodes) > 64:
        raise ValueError("AUTOBIZ_WORKFLOW_CONTRACT_INVALID")
    overlays = []
    directory = workspace / ".autobizdevops" / "workflow.d"
    if directory.exists():
        if linked(directory):
            raise ValueError("AUTOBIZ_WORKFLOW_LINK_UNSUPPORTED")
        for path in sorted(directory.glob("*.json")):
            if linked(path) or path.stat().st_size > 262144 or len(overlays) >= 64:
                raise ValueError("AUTOBIZ_WORKFLOW_LIMIT")
            overlays.append([path.name, hashlib.sha256(path.read_bytes()).hexdigest()])
    value = {"apiVersion": "devclaw.compiled-workflow/v1",
             "nodes": [node["id"] for node in workflow.nodes],
             "stages": [{"id": node["id"], "skill": node.get("skill"),
                         "inputs": [artifact_view(item) for item in node.get("artifacts", {}).get("inputs", [])],
                         "outputs": [artifact_view(item) for item in node.get("artifacts", {}).get("outputs", [])]}
                        for node in workflow.nodes],
             "definitionDigest": hashlib.sha256(canonical(list(workflow.nodes)).encode("utf-8")).hexdigest(),
             "allowedNext": {key: sorted(targets) for key, targets in workflow.allowed_next.items()},
             "initial": sorted(workflow.initial_checkpoints),
             "policyDigest": policy_digest(source), "overlays": overlays,
             "overlayDigest": hashlib.sha256(canonical(overlays).encode("utf-8")).hexdigest()}
    if len(canonical(value).encode("utf-8")) > 65536:
        raise ValueError("AUTOBIZ_WORKFLOW_CONTRACT_LIMIT")
    value["digest"] = hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()
    return value


def assert_contract(source, workspace, record, expected):
    value = effective_contract(source, workspace, record)
    if expected != value["digest"]:
        raise ValueError("AUTOBIZ_WORKFLOW_CONTRACT_CHANGED")
    return value


def validate_json_schema(value, schema, depth=0):
    """A deliberately bounded portable subset; unsupported assertions fail closed."""
    import math
    if type(value) is float and not math.isfinite(value):
        raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_NONFINITE")
    supported = {"$schema", "title", "description", "type", "properties", "required",
                 "additionalProperties", "items", "minItems", "maxItems", "enum", "const",
                 "minLength", "maxLength", "minimum", "maximum"}
    if depth > 16 or not isinstance(schema, dict) or set(schema) - supported:
        raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_UNSUPPORTED")
    if "additionalProperties" in schema and type(schema["additionalProperties"]) is not bool:
        raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_UNSUPPORTED")
    kinds = {"object": lambda item: isinstance(item, dict),
             "array": lambda item: isinstance(item, list),
             "string": lambda item: isinstance(item, str),
             "boolean": lambda item: type(item) is bool,
             "integer": lambda item: type(item) is int,
             "number": lambda item: type(item) in (int, float),
             "null": lambda item: item is None}
    kind = schema.get("type")
    if kind is not None and (kind not in kinds or not kinds[kind](value)):
        raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_TYPE")
    if "const" in schema and canonical(value) != canonical(schema["const"]):
        raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_CONST")
    if "enum" in schema:
        if (not isinstance(schema["enum"], list) or len(schema["enum"]) > 256
                or not any(canonical(value) == canonical(item) for item in schema["enum"])):
            raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_ENUM")
    if isinstance(value, dict):
        properties, required = schema.get("properties", {}), schema.get("required", [])
        if not isinstance(properties, dict) or not isinstance(required, list):
            raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_INVALID")
        if any(key not in value for key in required):
            raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_REQUIRED")
        if schema.get("additionalProperties") is False and set(value) - set(properties):
            raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_ADDITIONAL")
        for key, item in value.items():
            if key in properties:
                validate_json_schema(item, properties[key], depth + 1)
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", 4096):
            raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_ITEMS")
        if "items" in schema:
            for item in value:
                validate_json_schema(item, schema["items"], depth + 1)
    if isinstance(value, str) and (len(value) < schema.get("minLength", 0)
                                  or len(value) > schema.get("maxLength", 262144)):
        raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_LENGTH")
    if type(value) in (int, float):
        if ("minimum" in schema and value < schema["minimum"]
                or "maximum" in schema and value > schema["maximum"]):
            raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_RANGE")


def validate_output_schemas(workspace, feature, node):
    base = workspace / ".autobizdevops" / "features" / feature
    for output in node.get("artifacts", {}).get("outputs", []):
        if "schema" not in output:
            continue
        relative = output.get("path", "")
        path = Path(relative)
        if (not relative or path.is_absolute() or ".." in path.parts
                or "\\" in relative or ":" in relative):
            raise ValueError("AUTOBIZ_OUTPUT_PATH_INVALID")
        target = base / path
        if any(linked(parent) for parent in [target, *target.parents] if parent != base.parent):
            raise ValueError("AUTOBIZ_OUTPUT_PATH_INVALID")
        if not target.exists() and output.get("required") is False:
            continue
        if not target.is_file() or target.stat().st_size > 262144:
            raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_FILE_INVALID")
        before = target.read_bytes()
        def reject_constant(_value):
            raise ValueError("AUTOBIZ_OUTPUT_SCHEMA_NONFINITE")
        validate_json_schema(json.loads(before, parse_constant=reject_constant), output["schema"])
        if target.read_bytes() != before:
            raise ValueError("AUTOBIZ_OUTPUT_CHANGED")


def assert_verified_inputs(source, workspace, feature, record, target_checkpoint):
    """New module handoffs bind exact checked bytes; legacy inputs retain original checks."""
    from board_core.contracts import load_record_workflow_contracts
    from stage_checks import contract_value
    workflow = load_record_workflow_contracts(source, record, workspace=workspace)
    nodes = list(workflow.nodes)
    source_policy = policy_digest(source)
    consumers = [(index, node) for index, node in enumerate(nodes)
                 if target_checkpoint in node.get("checkpoints", [])]
    for index, node in consumers:
        outputs = {item["path"] for item in node.get("artifacts", {}).get("outputs", [])}
        completing = target_checkpoint != node.get("checkpoints", [None])[0]
        for item in node.get("artifacts", {}).get("inputs", []):
            if item.get("required") is False or completing and item["path"] in outputs:
                continue  # A declared read/update stage can change its own output after entry.
            producers = [previous for previous in nodes[:index]
                         if any(output["path"] == item["path"] for output in previous.get("artifacts", {}).get("outputs", []))]
            if not producers:
                continue
            producer = producers[-1]
            produced = producer.get("artifacts", {}).get("outputs", [])
            directory = workspace / ".autobizdevops/function-state-journal"
            paths = list(directory.glob("*.json"))
            if len(paths) > 512 or linked(directory):
                raise ValueError("AUTOBIZ_JOURNAL_INVALID")
            published_checks = []
            historical_strict = False
            for journal_path in paths:
                if journal_path.name.endswith(".physical.json"):
                    continue
                row = read_record(journal_path)
                binding = row.get("request", {})
                if (row.get("phase") != "committed" or binding.get("feature") != feature
                        or binding.get("policyDigest") != source_policy):
                    continue
                checks = row.get("stageChecks", [])
                check_digest = hashlib.sha256(canonical(checks).encode("utf-8")).hexdigest()
                receipt_path = directory / (row["operationId"] + ".physical.json")
                if not receipt_path.exists():
                    continue
                receipt = read_record(receipt_path)
                if (receipt.get("operationId") != row["operationId"]
                        or receipt.get("stageChecksDigest") != check_digest
                        or receipt.get("policyDigest") != binding["policyDigest"]):
                    continue
                strict_nodes = receipt.get("strictHandoffNodes")
                if (not isinstance(strict_nodes, list) or len(strict_nodes) > 64
                        or any(not isinstance(value, str) for value in strict_nodes)
                        or len(set(strict_nodes)) != len(strict_nodes)
                        or receipt.get("strictHandoffDigest") != hashlib.sha256(canonical({
                            "stageChecks": checks, "strictHandoffNodes": strict_nodes
                        }).encode("utf-8")).hexdigest()):
                    continue
                for check in checks:
                    if (check.get("nodeId") != producer["id"] or check.get("outcome") != "passed"
                            or check.get("checkId") != "postcheck"):
                        continue
                    historical_strict = historical_strict or producer["id"] in strict_nodes
                    if (producer["id"] in strict_nodes
                            and binding.get("to") == producer.get("checkpoints", [None])[-1]):
                        published_checks.append(check)
            if not (producer.get("validatorBindings") or any("schema" in output for output in produced)
                    or historical_strict):
                continue  # Legacy contracts retain their original checks, without a new evidence gate.
            expected_contract = contract_value(workflow.contract_for_skill(producer["skill"]),
                                               feature, node=producer)["contractDigest"]
            relative = ".autobizdevops/features/" + feature + "/" + item["path"]
            path = workspace / relative
            if (linked(path) or not path.is_file() or path.stat().st_size > 262144
                    or any(linked(parent) for parent in path.parents if parent != workspace.parent)):
                raise ValueError("AUTOBIZ_UPSTREAM_ARTIFACT_CHANGED")
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            found = any(check.get("contractDigest") == expected_contract and any(
                artifact.get("path") == relative and artifact.get("digest") == actual
                for artifact in check.get("artifacts", [])) for check in published_checks)
            if not found:
                raise ValueError("AUTOBIZ_UPSTREAM_ARTIFACT_CHANGED")


def install_bound_validators(source, workflow):
    """Extend the plugin's registry; existing original validators are never replaced."""
    import importlib.util
    import sys
    import artifact_check
    closure = read_record(source / "devclaw.business-assembly.json")
    names = {item.get("path") for item in closure.get("files", []) if isinstance(item, dict)}
    for node in workflow.nodes:
        node_id = node.get("id", "")
        bindings = node.get("validatorBindings", {})
        if not isinstance(bindings, dict):
            raise ValueError("AUTOBIZ_CUSTOM_VALIDATOR_BINDING_INVALID")
        for key, binding in bindings.items():
            if key != "business:" + node_id or key not in node.get("validators", []):
                raise ValueError("AUTOBIZ_CUSTOM_VALIDATOR_BINDING_INVALID")
            name = binding.get("path", "")
            relative = Path(name)
            if (not isinstance(name, str) or "\\" in name or ":" in name
                    or relative.is_absolute() or ".." in relative.parts
                    or not name.startswith("mods/business/" + node_id + "/")):
                raise ValueError("AUTOBIZ_CUSTOM_VALIDATOR_BINDING_INVALID")
            path = source / relative
            if name not in names:
                raise ValueError("AUTOBIZ_CUSTOM_VALIDATOR_RESOURCE_UNDECLARED")
            if (any(linked(parent) for parent in [path, *path.parents] if parent != source.parent)
                    or not path.is_file() or path.stat().st_size > 262144):
                raise ValueError("AUTOBIZ_CUSTOM_VALIDATOR_SOURCE_INVALID")
            identity = hashlib.sha256((str(path) + hashlib.sha256(path.read_bytes()).hexdigest()).encode()).hexdigest()
            spec = importlib.util.spec_from_file_location("mod_validator_" + identity, path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            function = getattr(module, binding.get("function", ""), None)
            if not callable(function):
                raise ValueError("AUTOBIZ_CUSTOM_VALIDATOR_FUNCTION_INVALID")
            previous = artifact_check.VALIDATORS.get(key)
            if previous is not None and not getattr(previous, "_devclaw_binding", False):
                raise ValueError("AUTOBIZ_CUSTOM_VALIDATOR_OVERRIDE_REJECTED")
            def checked(context, callback=function):
                result = callback(context)
                if type(result) is not int or result < 0:
                    raise ValueError("AUTOBIZ_CUSTOM_VALIDATOR_RESULT_INVALID")
                return result
            checked._devclaw_binding = True
            artifact_check.VALIDATORS[key] = checked
