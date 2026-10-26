"""Project original immutable failed-command receipts into the retained UT contract.

This private compatibility projection does not update the legacy writer/state tree.
The caller obtains the receipt from native.workflow, never from model evidence.
"""
import json
import tempfile
from pathlib import Path
from hooks.utest_repair_contract import (
    load_utest_plan, expand_plan_targets, public_target, shell_join_argv,
    derive_verdict, derive_check_matrix, derive_unverified_checks,
    derive_scenario_coverage, plan_scenario_refs, validate_source_bug,
)


def check(request):
    from check import safe_path
    plan_bundle, receipt = request["plan"], request["receipt"]
    output = receipt.get("output", {})
    if (receipt.get("status") != "failed" or receipt.get("outputTruncated")
            or output.get("passed") is not False or output.get("phase") != "test"
            or not isinstance(output.get("exitCode"), int) or isinstance(output["exitCode"], bool)
            or output["exitCode"] == 0 or output.get("logTruncated")
            or not output.get("testFiles") or not output.get("taskIds")):
        raise ValueError("UT_REPAIR_REQUIRES_COMPLETE_FAILED_COMMAND_RECEIPT")
    with tempfile.TemporaryDirectory(prefix="autobiz-ut-attestation-") as directory:
        root = Path(directory)
        for name, text in plan_bundle["files"].items():
            safe_path(name)
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        plan = load_utest_plan(root)
        targets = expand_plan_targets(plan)
        if not set(output["taskIds"]).issubset({target["taskId"] for target in targets}):
            raise ValueError("UT_REPAIR_TASK_NOT_IN_CURRENT_PLAN")
        selected = [target for target in targets if target["taskId"] in output["taskIds"]]
        if any(target["validationLocations"] != [{"repo": output.get("workspaceRef"), "cwd": "."}] for target in selected):
            raise ValueError("UT_REPAIR_REPOSITORY_MISMATCH")
        records = []
        for target in targets:
            if target["taskId"] not in output["taskIds"]:
                continue
            evidence_id = receipt["executionId"] + ":" + target["taskId"]
            command = shell_join_argv(output["argv"])
            target.update(result="FAIL", evidenceIds=[evidence_id], command=command)
            records.append({"evidenceId": evidence_id, "taskId": target["taskId"],
                "taskDigest": target["taskDigest"], "specRefs": target["specRefs"],
                "covers": target["covers"], "changedFiles": output["testFiles"],
                "validation": {"commandId": target["commandId"], "required": True,
                    "covers": target["covers"], "repo": target["validationLocations"][0]["repo"], "cwd": target["validationLocations"][0]["cwd"],
                    "argv": output["argv"], "command": command, "testFiles": output["testFiles"],
                    "result": "fail", "exitCode": output["exitCode"]}})
        public = [public_target(target) for target in targets]
        matrix = derive_check_matrix(public, targets)
        result = {"version": 1, "targets": public, "verdict": derive_verdict(public, targets),
            "checks": matrix, "unverifiedChecks": derive_unverified_checks(matrix),
            "scenarioCoverage": derive_scenario_coverage(targets, public,
                {record["evidenceId"]: record for record in records}, scenario_refs=plan_scenario_refs(plan))}
        (root / "evidence").mkdir()
        (root / "evidence/EVIDENCE.jsonl").write_text(
            "\n".join(json.dumps(record, ensure_ascii=False) for record in records), encoding="utf-8")
        attestations = [validate_source_bug(root, result, target["taskId"], target["commandId"],
            target["targetId"], target["taskDigest"], target["evidenceIds"][-1])
            for target in targets if target["taskId"] in output["taskIds"]]
        return {"passed": True, "errors": [], "warnings": [], "failedExecutionId": receipt["executionId"],
            "headCommit": output["headCommit"], "workspaceRef": output["workspaceRef"],
            "argv": output["argv"], "attestations": attestations}
