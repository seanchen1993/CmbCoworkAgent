import json
import os
import re
from pathlib import Path

PASS_THRESHOLD = 0.7


def _load_json(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        return json.loads(value)
    except Exception:
        return {}


def _load_trace(trace_path):
    if not trace_path:
        return None, "trace path is empty"
    path = Path(trace_path)
    if not path.exists():
        return None, f"trace file not found: {trace_path}"
    last = None
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if line.strip():
            try:
                last = json.loads(line)
            except Exception as exc:
                return None, f"trace parse error at {trace_path}:{line_number}: {exc}"
    if last is None:
        return None, f"trace file is empty: {trace_path}"
    return last, None


def _normalize_skill(name):
    raw = str(name or "").strip()
    if not raw:
        return ""
    return re.sub(r"-v\d+(?:\.\d+){0,3}$", "", raw)


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return [value]


def _iter_tool_calls(trace):
    node_calls = []
    for node in trace.get("nodes") or []:
        if node.get("type") != "tool":
            continue
        node_calls.append({
            "name": node.get("name") or "unknown",
            "args": node.get("input") or {},
            "result": node.get("output"),
            "status": node.get("status"),
            "source": "node",
        })
    if node_calls:
        yield from node_calls
        return

    for step in trace.get("steps") or []:
        for call in step.get("toolCalls") or []:
            yield {
                "name": call.get("name") or "unknown",
                "args": call.get("args") or {},
                "result": call.get("result"),
                "source": "step",
            }


def _stringify_command(args):
    if not isinstance(args, dict):
        return ""
    parts = []
    for key in ("command", "cmd", "script"):
        value = args.get(key)
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, list):
            parts.append(" ".join(str(item) for item in value))
    try:
        parts.append(json.dumps(args, ensure_ascii=False, sort_keys=True))
    except Exception:
        parts.append(str(args))
    return "\n".join(part for part in parts if part)


def _parse_bool(value, default=True):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "pass"}:
        return True
    if text in {"0", "false", "no", "n", "fail"}:
        return False
    return default


def _parse_max_tool_calls(value):
    if value is None or value == "":
        return None, None
    try:
        parsed = int(value)
    except Exception:
        return None, f"max_tool_calls must be an integer, got {value!r}"
    if parsed < 0:
        return None, f"max_tool_calls must be non-negative, got {value!r}"
    return parsed, None


def _build_result(score, reason, details=None, vars_=None, allow_expect_inversion=True):
    expected_pass = _parse_bool((vars_ or {}).get("expect_pass"), True)
    raw_score = round(float(score), 4)
    raw_pass = raw_score >= PASS_THRESHOLD
    final_pass = raw_pass
    final_score = raw_score
    final_reason = reason
    metadata = details

    if allow_expect_inversion and expected_pass is False:
        final_pass = not raw_pass
        final_score = 1.0 if final_pass else 0.0
        final_reason = (
            f"expected failure observed: {reason}"
            if final_pass else
            f"expected failure but trajectory passed: {reason}"
        )
        metadata = dict(details or {})
        metadata.update({
            "expectedPass": False,
            "rawPass": raw_pass,
            "rawScore": raw_score,
            "rawReason": reason,
        })

    payload = {
        "pass": final_pass,
        "score": final_score,
        "reason": final_reason,
    }
    if metadata is not None:
        payload["metadata"] = metadata
    return payload


def get_assert(output, context):
    data = _load_json(output)
    vars_ = {}
    if isinstance(context, dict):
        vars_ = context.get("vars") or {}

    trace, trace_error = _load_trace(data.get("tracePath"))
    if not trace:
        return _build_result(
            0,
            trace_error or "trace file not found",
            {"provider": data},
            vars_=vars_,
            allow_expect_inversion=False,
        )

    expected_skill = vars_.get("expected_skill") or data.get("expectedSkill")
    required_tools = _as_list(vars_.get("required_tools"))
    forbidden_tools = set(str(item) for item in _as_list(vars_.get("forbidden_tools")))
    forbidden_commands = [str(item) for item in _as_list(vars_.get("forbidden_commands"))]
    max_tool_calls, max_tool_calls_error = _parse_max_tool_calls(vars_.get("max_tool_calls"))
    if max_tool_calls_error:
        return _build_result(
            0,
            max_tool_calls_error,
            {"caseId": data.get("caseId") or vars_.get("case_id"), "provider": data},
            vars_=vars_,
            allow_expect_inversion=False,
        )

    used_skills = [_normalize_skill(skill) for skill in trace.get("usedSkills") or []]
    tool_calls = list(_iter_tool_calls(trace))
    tool_names = [call["name"] for call in tool_calls]
    total_tool_calls = trace.get("totalToolCalls")
    if not isinstance(total_tool_calls, int):
        total_tool_calls = len(tool_calls)

    checks = []
    failures = []

    def add_check(name, ok, weight=1.0, detail=None):
        checks.append({"name": name, "ok": bool(ok), "weight": weight, "detail": detail})
        if not ok:
            failures.append(name if detail is None else f"{name}: {detail}")

    add_check("trace_outcome_success", trace.get("outcome") == "success", 1.0, trace.get("outcome"))

    if expected_skill:
        add_check(
            "expected_skill_used",
            _normalize_skill(expected_skill) in used_skills,
            2.0,
            {"expected": expected_skill, "used": trace.get("usedSkills") or []},
        )

    for tool_name in required_tools:
        add_check(
            f"required_tool:{tool_name}",
            tool_name in tool_names,
            1.0,
            {"tools": tool_names},
        )

    if forbidden_tools:
        hits = [name for name in tool_names if name in forbidden_tools]
        add_check("forbidden_tools_absent", len(hits) == 0, 2.0, {"hits": hits})

    if forbidden_commands:
        commands = [_stringify_command(call.get("args")) for call in tool_calls]
        hits = []
        for command in commands:
            for forbidden in forbidden_commands:
                if forbidden and forbidden in command:
                    hits.append(command)
        add_check("forbidden_commands_absent", len(hits) == 0, 3.0, {"hits": hits})

    if max_tool_calls is not None:
        add_check(
            "tool_call_budget",
            total_tool_calls <= max_tool_calls,
            1.0,
            {"actual": total_tool_calls, "max": max_tool_calls},
        )

    # TraceCollector records failed tool-like nodes with status="error".
    error_nodes = [
        node for node in trace.get("nodes") or []
        if node.get("type") in ("tool", "tool_result", "error") and node.get("status") == "error"
    ]
    add_check("no_tool_errors", len(error_nodes) == 0, 1.0, {"count": len(error_nodes)})

    total_weight = sum(item["weight"] for item in checks) or 1.0
    earned = sum(item["weight"] for item in checks if item["ok"])
    score = earned / total_weight

    details = {
        "caseId": data.get("caseId") or vars_.get("case_id"),
        "traceId": trace.get("traceId"),
        "tracePath": data.get("tracePath"),
        "usedSkills": trace.get("usedSkills") or [],
        "toolNames": tool_names,
        "totalToolCalls": total_tool_calls,
        "checks": checks,
        "runDir": data.get("runDir"),
    }
    reason = "trajectory checks passed" if not failures else "; ".join(failures)
    return _build_result(score, reason, details, vars_=vars_)


if __name__ == "__main__":
    output = os.environ.get("PROMPTFOO_OUTPUT", "{}")
    context = _load_json(os.environ.get("PROMPTFOO_CONTEXT", "{}"))
    print(json.dumps(get_assert(output, context), ensure_ascii=False))
