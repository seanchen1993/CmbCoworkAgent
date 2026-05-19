#!/usr/bin/env python3
import argparse
import json
import re
from collections import defaultdict
from pathlib import Path


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def iter_results(data):
    seen = set()

    def is_result(value):
        if not isinstance(value, dict):
            return False
        return any(key in value for key in ("output", "response", "assertions", "gradingResult", "success"))

    def visit(value):
        if isinstance(value, list):
            for item in value:
                yield from visit(item)
            return
        if not isinstance(value, dict):
            return
        if is_result(value):
            marker = id(value)
            if marker not in seen:
                seen.add(marker)
                yield value
            return
        for key in ("results", "table", "tests", "prompts", "outputs"):
            if key in value:
                yield from visit(value[key])

    yield from visit(data)


def parse_output(result):
    output = result.get("output")
    if output is None and isinstance(result.get("response"), dict):
        output = result["response"].get("output")
    if not isinstance(output, str):
        return {}
    try:
        return json.loads(output)
    except Exception:
        return {}


def parse_assertions(result):
    assertions = result.get("assertions") or result.get("gradingResult", {}).get("componentResults")
    return assertions if isinstance(assertions, list) else []


def assertion_score(assertion):
    for key in ("score", "grade"):
        value = assertion.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return 1.0 if assertion.get("pass") is True else 0.0


def assertion_pass(assertion):
    if "pass" in assertion:
        return bool(assertion["pass"])
    if "success" in assertion:
        return bool(assertion["success"])
    return assertion_score(assertion) >= 0.7


def normalize_skill(name):
    raw = str(name or "").strip()
    if not raw:
        return ""
    return re.sub(r"-v\d+(?:\.\d+){0,3}$", "", raw)


def skill_key(run_summary, assertions):
    expected = run_summary.get("expectedSkill")
    if expected:
        return normalize_skill(expected)
    for assertion in assertions:
        metadata = assertion.get("metadata") or {}
        used = metadata.get("usedSkills")
        if isinstance(used, list) and used:
            return normalize_skill(used[0])
    used = run_summary.get("usedSkills")
    if isinstance(used, list) and used:
        return normalize_skill(used[0])
    return "unknown"


def build_cards(results):
    groups = defaultdict(list)
    failures = []

    for result in results:
        summary = parse_output(result)
        assertions = parse_assertions(result)
        skill = skill_key(summary, assertions)
        scores = [assertion_score(item) for item in assertions]
        passes = [assertion_pass(item) for item in assertions]
        score = sum(scores) / len(scores) if scores else (1.0 if result.get("success") else 0.0)
        ok = all(passes) if passes else bool(result.get("success"))
        row = {
            "caseId": summary.get("caseId") or result.get("description") or "unknown",
            "score": score,
            "pass": ok,
            "tracePath": summary.get("tracePath"),
            "runDir": summary.get("runDir"),
            "usedSkills": summary.get("usedSkills") or [],
            "totalToolCalls": summary.get("totalToolCalls"),
            "durationMs": summary.get("durationMs"),
            "assertions": assertions,
        }
        groups[skill].append(row)
        if not ok:
            failures.append(row)

    cards = []
    for skill, rows in sorted(groups.items()):
        avg = sum(row["score"] for row in rows) / len(rows)
        pass_rate = sum(1 for row in rows if row["pass"]) / len(rows)
        avg_tools = [
            row["totalToolCalls"] for row in rows
            if isinstance(row.get("totalToolCalls"), (int, float))
        ]
        avg_duration = [
            row["durationMs"] for row in rows
            if isinstance(row.get("durationMs"), (int, float))
        ]
        cards.append({
            "skill": skill,
            "score": round(avg * 100, 1),
            "passRate": round(pass_rate * 100, 1),
            "cases": len(rows),
            "avgToolCalls": round(sum(avg_tools) / len(avg_tools), 2) if avg_tools else None,
            "avgDurationMs": round(sum(avg_duration) / len(avg_duration), 2) if avg_duration else None,
            "failedCases": [row["caseId"] for row in rows if not row["pass"]],
        })
    return cards, failures


def render_markdown(cards, failures):
    lines = ["# Skill Quality Cards", ""]
    if not cards:
        lines.append("No Promptfoo results found.")
        return "\n".join(lines) + "\n"

    lines.append("| Skill | Score | Pass Rate | Cases | Avg Tools | Avg Duration |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
    for card in cards:
        avg_tools = "" if card["avgToolCalls"] is None else str(card["avgToolCalls"])
        avg_duration = "" if card["avgDurationMs"] is None else f'{card["avgDurationMs"]}ms'
        lines.append(
            f'| {card["skill"]} | {card["score"]} | {card["passRate"]}% | '
            f'{card["cases"]} | {avg_tools} | {avg_duration} |'
        )

    if failures:
        lines.extend(["", "## Failed Cases", ""])
        for row in failures[:20]:
            lines.append(f'- `{row["caseId"]}` score={row["score"]:.2f} trace={row.get("tracePath") or ""}')
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Generate skill quality cards from Promptfoo JSON output.")
    parser.add_argument("result_json", help="Promptfoo JSON output path")
    parser.add_argument("--out", default="", help="Markdown output path")
    args = parser.parse_args()

    data = load_json(args.result_json)
    cards, failures = build_cards(list(iter_results(data)))
    markdown = render_markdown(cards, failures)

    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(markdown, encoding="utf-8")
    print(markdown)


if __name__ == "__main__":
    main()
