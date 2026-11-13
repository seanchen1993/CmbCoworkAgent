#!/usr/bin/env python3
"""Read actual AutoBiz evidence for Mods without changing state or running validators.

The guest writes returned Markdown/JSON through the native file SDK only after
this read-only process completes. A report is always pending human review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from board_core.artifact_paths import resolve_artifact_files_exact  # noqa: E402
from board_core.contracts import artifact_dicts, load_record_workflow_contracts  # noqa: E402
from board_core.state import find_feature_dir  # noqa: E402
from board_core.state_store import load_state_json_records_result  # noqa: E402
from board_core.workflow import find_effective_current_node  # noqa: E402

SCHEMA = "autobiz.mods.delivery-evidence/v1"
MAX_INPUT = 256 * 1024
MAX_FILES = 128
MAX_FILE_BYTES = 1024 * 1024
DIGEST = re.compile(r"^[0-9a-f]{64}$")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def relative(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 240:
        raise ValueError("路径必须是项目内的非空相对路径")
    if any(ord(c) < 32 for c in value) or re.search(r'[\\:*?\[\]<>"|]', value):
        raise ValueError("路径包含不支持的字符")
    parts = value.split("/")
    if any(p in {"", ".", ".."} or p[-1:] in {".", " "} for p in parts):
        raise ValueError("路径不能包含绝对路径、空段或上级目录")
    if any(re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", p, re.I) for p in parts):
        raise ValueError("路径不能使用特殊设备名")
    return value


def feature_id(value: object) -> str:
    name = relative(value)
    if "/" in name:
        raise ValueError("Feature 必须是单一标识")
    return name


def scoped_file(workspace: Path, name: str, maximum: int = MAX_FILE_BYTES) -> tuple[Path, bytes]:
    relative(name)
    current = workspace
    for part in name.split("/"):
        current = current / part
        if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
            raise ValueError(f"不读取链接或重解析目录：{name}")
    target = current.resolve(strict=True)
    if not target.is_relative_to(workspace) or not target.is_file():
        raise ValueError(f"文件不在当前项目范围：{name}")
    if target.stat().st_size > maximum:
        raise ValueError(f"文件超出读取上限：{name}")
    data = target.read_bytes()
    if len(data) > maximum:
        raise ValueError(f"读取期间文件超出上限：{name}")
    return target, data


def file_evidence(workspace: Path, name: str, **metadata: object) -> dict:
    target, data = scoped_file(workspace, name)
    text = data.decode("utf-8-sig")
    return {**metadata, "path": name, "digest": sha256(data), "bytes": len(data),
            "excerpt": text[:1200], "excerptTruncated": len(text) > 1200,
            "present": True}


def live_evidence(workspace: Path, feature: str, sources: list[str]) -> dict:
    _, before = scoped_file(workspace, ".autobizdevops/state.json", MAX_INPUT)
    state = load_state_json_records_result(workspace)
    if not state.exists or state.fatal_errors or state.record_errors.get(feature):
        raise ValueError("原规范状态无法读取：" + "; ".join(state.fatal_errors + state.record_errors.get(feature, [])))
    record = state.records.get(feature)
    if record is None:
        raise ValueError("Feature 不在当前原规范状态中")
    contracts = load_record_workflow_contracts(ROOT, record, workspace=workspace)
    index, node_id = find_effective_current_node(
        list(contracts.nodes), record["checkpoint"], record.get("needsFixFromCheckpoint"),
        stage=record.get("stage"), stage_labels=contracts.stage_labels,
    )
    if index < 0:
        raise ValueError("当前 checkpoint 不属于有效流程，不能推断完成")
    feature_dir = find_feature_dir(workspace, feature, record.get("iteration"))
    if feature_dir is None or not feature_dir.resolve().is_relative_to(workspace):
        raise ValueError("Feature 产物目录不存在或越界")
    outputs: list[dict] = []
    for node_index, node in enumerate(contracts.nodes):
        completed = node_index < index or (node_index == index and record["checkpoint"].endswith("_done")) or record["checkpoint"] == "archived"
        for artifact in artifact_dicts(node, "outputs"):
            expected = bool(artifact.get("required", True)) and completed and not node.get("skipped")
            matches = resolve_artifact_files_exact(feature_dir, artifact["path"])
            if not matches:
                outputs.append({"id": artifact["id"], "nodeId": node["id"], "declaredPath": artifact["path"],
                                "requiredNow": expected, "present": False})
            for match in matches:
                name = match.relative_to(workspace).as_posix()
                outputs.append(file_evidence(workspace, name, id=artifact["id"], nodeId=node["id"],
                                             declaredPath=artifact["path"], requiredNow=expected))
            if len(outputs) > MAX_FILES:
                raise ValueError("声明产物超过 128 项，报告未生成")
    source_files = [file_evidence(workspace, name, observation="explicit-current-file; no baseline comparison") for name in sources]
    _, after = scoped_file(workspace, ".autobizdevops/state.json", MAX_INPUT)
    if before != after:
        raise ValueError("收集期间状态改变，请重新核对，不自动重试")
    return {"sourceMode": "live-project", "feature": feature, "checkpoint": record["checkpoint"],
            "stage": record["stage"], "currentNodeId": node_id, "record": record,
            "stateSha256": sha256(before), "contextPath": "", "sourcePaths": sources,
            "artifacts": outputs, "sources": source_files,
            "validators": [{"nodeId": n["id"], "declared": n.get("validators", []), "executedByThisAction": False} for n in contracts.nodes]}


def checked_digest(value: object, content: bytes, context: str) -> str:
    if not isinstance(value, str) or not DIGEST.fullmatch(value) or sha256(content) != value:
        raise ValueError(f"交接字节与声明 SHA256 不一致：{context}")
    return value


def handoff_evidence(workspace: Path, name: str, feature: str | None) -> dict:
    _, data = scoped_file(workspace, name, MAX_INPUT)
    payload = json.loads(data.decode("utf-8-sig"))
    if not isinstance(payload, dict) or payload.get("apiVersion") != "devclaw.autobiz-context/v1":
        raise ValueError("不是宿主声明的 AutoBiz 交接资料格式")
    producer = payload.get("producer")
    if not isinstance(producer, dict):
        raise ValueError("交接缺少真实生产方标识")
    actual_feature = feature_id(producer.get("featureId"))
    if feature and actual_feature != feature:
        raise ValueError("交接 Feature 与所选 Feature 不一致")
    files = payload.get("files")
    if not isinstance(files, list) or not files or len(files) > MAX_FILES:
        raise ValueError("交接资料清单为空或超限")
    outputs: list[dict] = []
    seen: set[str] = set()
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("content"), str):
            raise ValueError("交接资料缺少正文")
        source_name = relative(item.get("path"))
        if source_name.casefold() in seen:
            raise ValueError("交接资料路径重复")
        seen.add(source_name.casefold())
        body = item["content"].encode("utf-8")
        checked_digest(item.get("digest"), body, source_name)
        receipt = item.get("checkedBy")
        if not isinstance(receipt, dict) or not all(isinstance(receipt.get(k), str) and receipt[k] for k in ("nodeId", "checkId", "contractDigest")):
            raise ValueError("交接资料缺少原检查出处")
        outputs.append({"id": item.get("id"), "nodeId": item.get("outputNodeId"), "path": source_name,
                        "digest": item["digest"], "bytes": len(body), "present": True, "requiredNow": True,
                        "checkedBy": receipt, "excerpt": item["content"][:1200], "excerptTruncated": len(item["content"]) > 1200})
    changes = payload.get("sourceChanges")
    sources: list[dict] = []
    if changes is not None:
        if not isinstance(changes, dict) or changes.get("apiVersion") != "devclaw.source-evidence/v1" or not isinstance(changes.get("changes"), list) or len(changes["changes"]) > MAX_FILES:
            raise ValueError("源码变更交接格式无效")
        for item in changes["changes"]:
            source_name = relative(item.get("path"))
            change = item.get("change")
            if change not in {"added", "modified", "deleted"}:
                raise ValueError("源码变更类型未知")
            if change == "deleted":
                if "content" in item:
                    raise ValueError("删除记录不能携带当前正文")
                sources.append({"path": source_name, "change": change, "beforeDigest": item.get("beforeDigest")})
            else:
                body = item.get("content")
                if not isinstance(body, str):
                    raise ValueError("源码变更缺少正文")
                checked_digest(item.get("digest"), body.encode("utf-8"), source_name)
                sources.append({"path": source_name, "change": change, "digest": item["digest"],
                                "bytes": len(body.encode("utf-8")), "excerpt": body[:1200], "excerptTruncated": len(body) > 1200})
    _, after = scoped_file(workspace, name, MAX_INPUT)
    if data != after:
        raise ValueError("收集期间交接资料改变")
    return {"sourceMode": "host-handoff", "feature": actual_feature,
            "checkpoint": "handoff_terminal", "stage": "原流程已交接（本动作未重跑审批或验证）",
            "stateSha256": sha256(data), "contextPath": name, "sourcePaths": [],
            "producer": producer, "scope": payload.get("scope"), "artifacts": outputs, "sources": sources,
            "sourceChangesScope": changes.get("scope") if changes else None,
            "validators": [], "handoffDigestMeaning": "SHA256 of copied verified-context UTF-8 bytes, not live state.json"}


def collect(workspace: Path, *, feature: str | None = None, source_paths: list[str] | None = None,
            context_path: str | None = None, expected_digest: str | None = None) -> dict:
    workspace = workspace.resolve(strict=True)
    sources = list(dict.fromkeys(relative(p) for p in (source_paths or [])))
    if len(sources) > 16:
        raise ValueError("最多显式选择 16 份当前源码文件")
    if feature is not None:
        feature_id(feature)
    if context_path:
        if sources:
            raise ValueError("交接模式仅使用已映射源码，不额外读取当前目录源码")
        result = handoff_evidence(workspace, relative(context_path), feature)
    else:
        if not feature:
            raise ValueError("当前项目模式需要明确 Feature")
        result = live_evidence(workspace, feature, sources)
    if expected_digest and result["stateSha256"] != expected_digest:
        raise ValueError("证据已改变，不能沿用上一步快照生成报告")
    result["schemaVersion"] = SCHEMA
    result["generatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    result["qualityStatus"] = "needs_review"
    result["missingRequiredCount"] = sum(1 for a in result["artifacts"] if a.get("requiredNow") and not a["present"])
    result["artifactCount"] = sum(1 for a in result["artifacts"] if a["present"])
    stable_evidence = {key: value for key, value in result.items() if key != "generatedAt"}
    result["evidenceDigest"] = sha256(json.dumps(stable_evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    result["summary"] = f"{result['feature']}：已核对 {result['artifactCount']} 份产物、{len(result['sources'])} 份源码记录；必需缺失 {result['missingRequiredCount']} 项，待人工审查。"
    result["limits"] = ["报告不执行原 validators、测试、部署或人工批准，也不推进 checkpoint。",
                        "文件存在、内容与哈希匹配不等于业务质量通过。",
                        "交接模式核对输入字节及原检查出处，不独立认证原运行或原审批；流程来源由宿主映射负责。",
                        "来源正文只显示有标记的节选；哈希针对完整读取字节。"]
    result["markdown"] = markdown(result)
    if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 240 * 1024:
        raise ValueError("报告证据超过输出上限，未返回不完整报告")
    return result


def markdown(result: dict) -> str:
    lines = [f"# AutoBiz 交付检查报告：{result['feature']}", "", result["summary"], "",
             f"- 状态来源：{result['sourceMode']}", f"- checkpoint：{result['checkpoint']}",
             f"- 阶段：{result['stage']}", f"- 输入字节 SHA256：{result['stateSha256']}",
             f"- 证据摘要 SHA256：{result['evidenceDigest']}", "- 质量结论：待人工审查（needs_review）", "",
             "## 声明产物", ""]
    for item in result["artifacts"]:
        lines.append(f"- {'已读取' if item['present'] else '未找到'}：{item.get('path', item.get('declaredPath'))}，节点 {item.get('nodeId')}，SHA256 {item.get('digest', '无')}，当前必需 {item.get('requiredNow')}")
    lines.extend(["", "## 明确范围内的源码", ""])
    for item in result["sources"]:
        lines.append(f"- {item['path']}，{item.get('change', '当前文件')}，SHA256 {item.get('digest', item.get('beforeDigest', '无'))}")
        if "excerpt" in item:
            # A quoted, escaped excerpt cannot silently terminate the report structure.
            lines.extend(["", "正文节选：", *('> ' + line for line in item["excerpt"].splitlines()), ""])
    lines.extend(["", "## 检查与审批边界", "", *('- ' + line for line in result["limits"])])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--feature")
    parser.add_argument("--context-path")
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--expected-digest")
    args = parser.parse_args()
    try:
        result = collect(Path(args.project_root), feature=args.feature, source_paths=args.source,
                         context_path=args.context_path, expected_digest=args.expected_digest)
        print(json.dumps({"ok": True, "evidence": result}, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
