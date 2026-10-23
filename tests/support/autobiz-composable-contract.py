"""Pure contract boundary tests; complete original-kernel acceptance is a separate suite."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types

sys.path.insert(0, sys.argv[1])
from compiled_contract import install_bound_validators, validate_json_schema, validate_output_schemas
from journal import linked

checks = 0
def rejected(callback, message):
    global checks
    try:
        callback()
        raise AssertionError("Expected rejection: " + message)
    except ValueError as error:
        assert message in str(error), str(error)
    checks += 1

validate_json_schema({"requirements": ["ship"], "revision": 1}, {
    "type": "object", "required": ["requirements"], "additionalProperties": False,
    "properties": {"requirements": {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1}},
                   "revision": {"type": "integer", "minimum": 1}}})
checks += 1
rejected(lambda: validate_json_schema({}, {"type": "object", "required": ["requirements"]}), "SCHEMA_REQUIRED")
rejected(lambda: validate_json_schema({"other": 1}, {"additionalProperties": False}), "SCHEMA_ADDITIONAL")
rejected(lambda: validate_json_schema([], {"type": "array", "minItems": 1}), "SCHEMA_ITEMS")
rejected(lambda: validate_json_schema(True, {"type": "integer"}), "SCHEMA_TYPE")
rejected(lambda: validate_json_schema(0, {"type": "integer", "minimum": 1}), "SCHEMA_RANGE")
rejected(lambda: validate_json_schema("", {"type": "string", "minLength": 1}), "SCHEMA_LENGTH")
rejected(lambda: validate_json_schema("x", {"$ref": "https://untrusted.invalid/schema"}), "SCHEMA_UNSUPPORTED")
rejected(lambda: validate_json_schema(float("nan"), {"type": "number"}), "SCHEMA_NONFINITE")
rejected(lambda: validate_json_schema(float("inf"), {"type": "number"}), "SCHEMA_NONFINITE")
for metadata in [types.SimpleNamespace(st_mode=0, st_file_attributes=0x400),
                 types.SimpleNamespace(st_mode=0, st_reparse_tag=0xA0000003)]:
    assert linked(types.SimpleNamespace(lstat=lambda: metadata))
    checks += 1

with tempfile.TemporaryDirectory(prefix="ab-contract-") as temporary:
    root = Path(temporary).resolve()
    path = root / "mods/business/user.convert/check.py"
    path.parent.mkdir(parents=True)
    path.write_text("def validate(context):\n    return 0\n", encoding="utf-8")
    (root / "devclaw.business-assembly.json").write_text(json.dumps({
        "files": [{"path": "mods/business/user.convert/check.py"}]}), encoding="utf-8")
    original = lambda context: 0
    registry = {"original": original}
    sys.modules["artifact_check"] = types.SimpleNamespace(VALIDATORS=registry)
    node = {"id": "user.convert", "validators": ["business:user.convert"],
            "validatorBindings": {"business:user.convert": {"path": "mods/business/user.convert/check.py", "function": "validate"}}}
    workflow = types.SimpleNamespace(nodes=[node])
    install_bound_validators(root, workflow)
    assert registry["original"] is original and registry["business:user.convert"](None) == 0
    checks += 1
    node["validatorBindings"]["original"] = node["validatorBindings"]["business:user.convert"]
    rejected(lambda: install_bound_validators(root, workflow), "BINDING_INVALID")
    del node["validatorBindings"]["original"]
    node["validatorBindings"]["business:user.convert"]["path"] = "../../outside.py"
    rejected(lambda: install_bound_validators(root, workflow), "BINDING_INVALID")
    node["validatorBindings"]["business:user.convert"]["path"] = "mods/business/user.convert/check.py"
    path.write_text("def validate(context):\n    return True\n", encoding="utf-8")
    install_bound_validators(root, workflow)
    rejected(lambda: registry["business:user.convert"](None), "RESULT_INVALID")
    output = {"artifacts": {"outputs": [{"path": "data.json", "schema": {"type": "object"}}]}}
    rejected(lambda: validate_output_schemas(root, "alpha", output), "SCHEMA_FILE_INVALID")
    output["artifacts"]["outputs"][0]["path"] = "../outside.json"
    rejected(lambda: validate_output_schemas(root, "alpha", output), "OUTPUT_PATH_INVALID")

with tempfile.TemporaryDirectory(prefix="ab-protocol-") as temporary:
    root = Path(temporary).resolve()
    own = root / "plugin/mods/business/autobiz.state-machine"
    # Execute the shipped adapter entry unchanged. Only its original business-check
    # dependency is replaced; no local AutoBiz archive or optional integration flag.
    shutil.copytree(Path(sys.argv[1]).resolve(), own)
    board = root / "plugin/board_core"
    board.mkdir()
    (board / "__init__.py").write_text("", encoding="utf-8")
    (board / "state_store.py").write_text(
        'def check_or_fix_state_sync(workspace, *, fix):\n'
        '    assert fix is False\n'
        '    print("POST_SKILL_FAIL skill=protocol-fixture failures=1")\n'
        '    raise ValueError("ORIGINAL_ARTIFACT_CHECK_REJECTED")\n', encoding="utf-8")
    workspace = root / "workspace"
    control = workspace / ".autobizdevops"
    control.mkdir(parents=True)
    originals = {"state.json": b'{"features":{"alpha":{"checkpoint":"convert_in_progress"}}}\n',
                 "STATE.md": b"| alpha | convert_in_progress |\n"}
    for name, content in originals.items():
        (control / name).write_bytes(content)
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-X", "utf8", str(own / "adapter.py")],
        input=json.dumps({"apiVersion": "autobiz.function-state/v1", "operation": "read", "feature": "alpha"}),
        cwd=workspace, capture_output=True, text=True, encoding="utf-8", timeout=5)
    assert result.returncode == 1, result
    assert len(result.stdout.splitlines()) == 1, result.stdout
    response = json.loads(result.stdout)
    assert response == {"apiVersion": "autobiz.function-state/v1", "ok": False,
                        "status": "not-applied", "errors": ["ORIGINAL_ARTIFACT_CHECK_REJECTED"]}, response
    assert "POST_SKILL_FAIL skill=protocol-fixture failures=1" in result.stderr, result.stderr
    assert "POST_SKILL_FAIL" not in result.stdout, result.stdout
    assert all((control / name).read_bytes() == content for name, content in originals.items())
    assert not (control / "function-state-journal").exists()
    checks += 1

assert checks == 19, checks
print(json.dumps({"passed": True, "checks": checks, "actualAdapterStdoutProtocol": True}))
