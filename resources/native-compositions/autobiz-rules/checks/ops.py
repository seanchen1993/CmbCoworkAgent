"""Native read-only CI/CD preparation and immutable archive rules.

Derived from autoops-cicd/autoops-archive SKILL contracts, not the old state writer.
External publication requires a separately bound native provider and original receipts.
This package deliberately cannot claim it performed an external deployment.
"""
import hashlib
import json

ARTIFACTS = ["NORMALIZED_REQUIREMENTS.json", "PRD.bundle.json", "SPECS.bundle.json", "DESIGN.bundle.json", "PLAN.bundle.json", "CODE_RESULT.json"]

def check(request):
    stage, current, sources = request["stage"], request["current"], request["sources"]
    feature = json.loads(sources["NORMALIZED_REQUIREMENTS.json"])["feature"]
    if current.get("feature") != feature or current.get("stage") != stage:
        raise ValueError("AUTOBIZ_OPS_IDENTITY_MISMATCH")
    if stage == "cicd":
        if current.get("publication") != {"mode": "not-requested", "status": "prepared-only"}:
            raise ValueError("AUTOBIZ_EXTERNAL_PUBLICATION_PROVIDER_REQUIRED")
        files = current.get("files", {})
        if set(files) != {"CICD_CHECKLIST.md", "PR_BODY.md"} or any(not isinstance(text, str) or not text.strip() for text in files.values()):
            raise ValueError("AUTOBIZ_CICD_DOCUMENTS_REQUIRED")
        checklist = files["CICD_CHECKLIST.md"]
        for heading in ["## 交付范围", "## 验证证据", "## 发布状态", "## 已知阻断问题", "## 回滚计划"]:
            if heading not in checklist:
                raise ValueError("AUTOBIZ_CICD_SECTION_MISSING:" + heading)
        if "未请求外部发布" not in checklist or "prepared-only" not in checklist:
            raise ValueError("AUTOBIZ_CICD_PREPARATION_MUST_BE_EXPLICIT")
        code = json.loads(sources["CODE_RESULT.json"])
        if current.get("codeRunId") != code.get("runId") or code.get("feature") != feature:
            raise ValueError("AUTOBIZ_CICD_CODE_RUN_CHANGED")
        if code["runId"] not in checklist or not all(path in checklist for path in ["PRD.bundle.json", "SPECS.bundle.json", "DESIGN.bundle.json"]):
            raise ValueError("AUTOBIZ_CICD_SOURCE_LINEAGE_REQUIRED")
    elif stage == "archive":
        expected = ARTIFACTS + ["CICD.bundle.json"]
        files, digests = current.get("files", {}), current.get("artifactDigests", {})
        if set(files) != set(expected) or set(digests) != set(expected):
            raise ValueError("AUTOBIZ_ARCHIVE_ARTIFACT_COVERAGE_INVALID")
        for name in expected:
            if files[name] != sources[name] or digests[name] != hashlib.sha256(sources[name].encode("utf-8")).hexdigest():
                raise ValueError("AUTOBIZ_ARCHIVE_SOURCE_CHANGED:" + name)
        if current.get("publicationStatus") != "prepared-only":
            raise ValueError("AUTOBIZ_ARCHIVE_PUBLICATION_CLAIM_INVALID")
        check({"stage": "cicd", "current": json.loads(sources["CICD.bundle.json"]), "sources": sources})
    else:
        raise ValueError("AUTOBIZ_OPS_STAGE_INVALID")
    return {"passed": True, "errors": [], "warnings": ["未请求或执行外部发布；成果仅为CI/CD准备及过程归档。"], "publicationStatus": "prepared-only"}
