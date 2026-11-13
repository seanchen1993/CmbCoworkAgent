#!/usr/bin/env python3
"""Run HTML analysis and write a compact Stage 1 handoff."""

from __future__ import annotations

import argparse
from html import escape
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


def ensure_dir(path: Path) -> None:
    os.makedirs(path, exist_ok=True)


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(v for v in values if v))


def split_html_inputs(values: list[str]) -> list[Path]:
    result: list[Path] = []
    for value in values:
        if not value:
            continue
        for part in value.split(","):
            candidate = part.strip()
            if candidate:
                result.append(Path(candidate).resolve())
    return result


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def extract_html_fragment(content: str) -> str:
    body_match = re.search(r"<body[^>]*>(.*)</body>", content, flags=re.IGNORECASE | re.DOTALL)
    if body_match:
        return body_match.group(1).strip()
    html_match = re.search(r"<html[^>]*>(.*)</html>", content, flags=re.IGNORECASE | re.DOTALL)
    if html_match:
        return html_match.group(1).strip()
    return content.strip()


def build_merged_html_input(sources: list[Path], target: Path) -> Path:
    sections: list[str] = []
    for idx, source in enumerate(sources, start=1):
        fragment = extract_html_fragment(read_text(source))
        if not fragment:
            continue
        sections.append(
            "<section "
            f'data-source-index="{idx}" '
            f'data-source-path="{escape(str(source))}" '
            'style="position: relative; display: block; width: 100%; margin: 0 0 32px 0;">\n'
            f"{fragment}\n"
            "</section>"
        )
    if not sections:
        raise SystemExit("No readable HTML content found in the provided --html-file inputs")
    merged = (
        "<!DOCTYPE html>\n"
        "<html>\n"
        "<head>\n"
        '  <meta charset="utf-8" />\n'
        f"  <title>{escape(target.stem)}</title>\n"
        "</head>\n"
        '<body style="margin:0; padding:0;">\n'
        f"{chr(10).join(sections)}\n"
        "</body>\n"
        "</html>\n"
    )
    write_text(target, merged)
    return target


def render_whole_sections(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for section in manifest.get("sections", []):
        contract = section.get("renderContract") or {}
        if contract.get("mustRenderWholeSection"):
            result.append({
                "ownerPath": section.get("ownerPath", ""),
                "layoutHint": section.get("layoutHint", ""),
                "subsectionTitles": section.get("subsectionTitles", []),
                "tagStripTexts": section.get("tagStripTexts", []),
                "hasSearchBar": bool(contract.get("hasSearchBar")),
                "contentMode": contract.get("contentMode", ""),
            })
    return result


def source_action_texts(full_manifest: dict[str, Any]) -> list[str]:
    texts = []
    for item in full_manifest.get("texts", []):
        if item.get("kind") == "action":
            texts.append(str(item.get("text", "")))
    return unique(texts)


def safe_leaf_slots_summary(full_manifest: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for slot in full_manifest.get("safeLeafSlots", []):
        result.append({
            "slot": str(slot.get("slot", "")),
            "kind": str(slot.get("kind", "")),
            "decision": str(slot.get("decision", "")),
            "candidate": str(slot.get("candidate", "")),
            "applyPriority": str(slot.get("applyPriority", "")),
            "bbox": slot.get("bbox", {}),
        })
    return result[:16]


def deferred_block_slots_summary(full_manifest: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for slot in full_manifest.get("deferredBlockSlots", []):
        result.append({
            "slot": str(slot.get("slot", "")),
            "kind": str(slot.get("kind", "")),
            "decision": str(slot.get("decision", "")),
            "candidate": str(slot.get("candidate", "")),
            "applyPriority": str(slot.get("applyPriority", "")),
            "bbox": slot.get("bbox", {}),
        })
    return result[:16]


def icon_candidates_summary(full_manifest: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for icon in full_manifest.get("iconCandidates", []):
        result.append({
            "owner": str(icon.get("owner", "")),
            "iconRole": str(icon.get("iconRole", "")),
            "iconNature": str(icon.get("iconNature", "")),
            "librarySuggestion": str(icon.get("librarySuggestion", "")),
            "librarySource": str(icon.get("librarySource", "")),
            "nearbyTexts": icon.get("nearbyTexts", []),
            "fallbackSource": str(icon.get("fallbackSource", "")),
            "svgMarkup": str(icon.get("svgMarkup", "")),
            "bbox": icon.get("bbox", {}),
        })
    return result[:24]


def interaction_candidates_summary(full_manifest: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in full_manifest.get("interactionCandidates", []):
        result.append({
            "kind": str(item.get("kind", "")),
            "label": str(item.get("label", "")),
            "evidence": str(item.get("evidence", "")),
            "bbox": item.get("bbox", {}),
        })
    return result[:30]


def build_layout_contract(
    html_source_paths: list[str],
    full_manifest: dict[str, Any],
) -> dict[str, Any]:
    sections = full_manifest.get("sections", [])
    regions = full_manifest.get("regions", [])
    return {
        "status": "required",
        "mustReadBeforeStage1": html_source_paths,
        "stage1PassRequires": [
            "the original high-fidelity HTML source set was used as the primary Stage 1 visual/layout source",
            "the implemented page preserves macro layout before any component replacement",
        ],
        "lightweightBackcheckAfterStage1": [
            "sample-check key sections, actions, and field groups for obvious omissions",
            "use handoff/manifest snippets as a spot-check aid, not as a Stage 1 gate",
            "report omission risks separately from visual fidelity status",
        ],
        "finalBackcheckAfterStage2": [
            "run a final omission check after component replacement",
            "confirm critical fields, actions, statuses, and hints still exist after componentization",
        ],
        "mustCheck": [
            "shell/header/sidebar/breadcrumb ownership",
            "main content width and left offset",
            "left/right panel split and rail/timeline placement",
            "section vertical order and spacing",
            "section width alignment across the page",
        ],
        "sourceRegionCount": len(regions),
        "sourceSectionCount": len(sections),
        "sectionOrder": [
            section.get("ownerPath") or section.get("title") or f"section-{i}"
            for i, section in enumerate(sections, start=1)
        ],
        "passRule": "Mark Stage 1 by visual fidelity first. Use the original high-fidelity HTML source set as the primary source and report omission spot-checks separately.",
    }


def build_checklist(
    task_stem: str,
    html_source_paths: list[str],
    html_input_path: str,
    analysis_source_path: str,
    output_dir: Path,
    full_manifest: dict[str, Any],
) -> dict[str, Any]:
    manifest_path = str(output_dir / f"{task_stem}.json")
    markdown_path = str(output_dir / f"{task_stem}.md")
    checklist_path = str(output_dir / f"{task_stem}-checklist.md")
    whole_sections = render_whole_sections(full_manifest)
    layout_contract = build_layout_contract(html_source_paths, full_manifest)
    analysis_confidence = (full_manifest.get("summary") or {}).get("analysisConfidence") or {}
    componentization_mode = (full_manifest.get("summary") or {}).get("componentizationMode") or {}
    return {
        "taskStem": task_stem,
        "htmlSourcePath": html_source_paths[0] if html_source_paths else "",
        "htmlSourcePaths": html_source_paths,
        "htmlInputPath": html_input_path,
        "analysisSourcePath": analysis_source_path,
        "analysisDir": str(output_dir),
        "files": {
            "manifest": manifest_path,
            "handoffMarkdown": markdown_path,
            "handoffChecklist": checklist_path,
        },
        "mustExist": [
            manifest_path,
            markdown_path,
            checklist_path,
        ],
        "summary": full_manifest.get("summary", {}),
        "mustReadFirst": [
            checklist_path,
            markdown_path,
            *html_source_paths,
        ],
        "referenceOnly": [],
        "sectionHtmlPolicy": "not-generated-by-default; use original HTML for Stage 1. Generate section HTML only with --emit-section-html for debugging.",
        "sectionHtmlFiles": full_manifest.get("sectionFiles", []),
        "multiFragmentPolicy": (
            "When multiple HTML files are provided, the script builds a merged analysis input in source order. "
            "Use the original HTML files as the visual truth; use the merged input only for Stage 1 aggregation."
            if len(html_source_paths) > 1
            else "single-source"
        ),
        "coverageReport": full_manifest.get("coverageReport", {}),
        "layoutContract": layout_contract,
        "localRegressionTargets": full_manifest.get("localRegressionTargets", []),
        "mustRenderWholeSections": whole_sections,
        "sourceActionTexts": source_action_texts(full_manifest),
        "iconCandidates": icon_candidates_summary(full_manifest),
        "interactionCandidates": interaction_candidates_summary(full_manifest),
        "safeLeafSlots": safe_leaf_slots_summary(full_manifest),
        "deferredBlockSlots": deferred_block_slots_summary(full_manifest),
        "buttonRule": "Do not add buttons or actions that are not present in sourceActionTexts unless PRD, YAPI, or project evidence explicitly requires them.",
        "stagePassRule": "Stage 1 cannot be marked passed by description alone; include concrete evidence that the whole original HTML was visually restored. Omission checks are reported separately and do not block Stage 1 by default.",
        "analysisConfidence": analysis_confidence,
        "componentizationMode": componentization_mode,
        "lowConfidenceRule": "If analysisConfidence.level is medium/low, treat manifest as low-confidence assistance only: increase direct reading weight of original HTML and pause large-block componentization until macro layout is corrected.",
        "conservativeModeRule": "If componentizationMode.mode is conservative, do not let replacementSlots decide macro structure. Read original HTML first, restore layout/ownership first, and only componentize leaf controls or already-stable local regions.",
    }


def write_checklist_md(path: Path, checklist: dict[str, Any]) -> None:
    lines = [
        "# HTML Stage 1 Checklist",
        "",
        f"- taskStem: `{checklist['taskStem']}`",
        f"- htmlSourcePath: `{checklist['htmlSourcePath']}`",
        f"- htmlInputPath: `{checklist['htmlInputPath'] or 'none'}`",
        f"- analysisSourcePath: `{checklist['analysisSourcePath']}`",
        f"- manifest: `{checklist['files']['manifest']}`",
        f"- fullHandoff: `{checklist['files']['handoffMarkdown']}`",
        "",
        "## Read First",
    ]
    for value in checklist["mustReadFirst"]:
        lines.append(f"- `{value}`")
    lines.extend(["", "## Section HTML Policy", f"- {checklist.get('sectionHtmlPolicy', '')}"])
    html_source_paths = checklist.get("htmlSourcePaths", [])
    if len(html_source_paths) > 1:
        lines.extend(["", "## HTML Source Set"])
        for value in html_source_paths:
            lines.append(f"- `{value}`")
        lines.append(f"- policy: {checklist.get('multiFragmentPolicy', '')}")
    layout_contract = checklist.get("layoutContract", {})
    lines.extend(["", "## Layout Contract"])
    lines.append(f"- status: {layout_contract.get('status', 'required')}")
    lines.append(f"- passRule: {layout_contract.get('passRule', '')}")
    lines.append("- mustReadBeforeStage1:")
    for value in layout_contract.get("mustReadBeforeStage1", []):
        lines.append(f"  - `{value}`")
    lines.append("- stage1PassRequires:")
    for value in layout_contract.get("stage1PassRequires", []):
        lines.append(f"  - {value}")
    if layout_contract.get("lightweightBackcheckAfterStage1"):
        lines.append("- lightweightBackcheckAfterStage1:")
        for value in layout_contract.get("lightweightBackcheckAfterStage1", []):
            lines.append(f"  - {value}")
    if layout_contract.get("finalBackcheckAfterStage2"):
        lines.append("- finalBackcheckAfterStage2:")
        for value in layout_contract.get("finalBackcheckAfterStage2", []):
            lines.append(f"  - {value}")
    lines.append("- mustCheck:")
    for value in layout_contract.get("mustCheck", []):
        lines.append(f"  - {value}")
    analysis_confidence = checklist.get("analysisConfidence", {})
    if analysis_confidence:
        lines.extend(["", "## Analysis Confidence"])
        lines.append(f"- level: {analysis_confidence.get('level', 'unknown')}")
        issues = analysis_confidence.get("issues", [])
        if issues:
            lines.append("- issues:")
            for value in issues[:20]:
                lines.append(f"  - {value}")
        lines.append(f"- rule: {checklist.get('lowConfidenceRule', '')}")
    componentization_mode = checklist.get("componentizationMode", {})
    if componentization_mode:
        lines.extend(["", "## Componentization Mode"])
        lines.append(f"- mode: {componentization_mode.get('mode', 'balanced')}")
        reasons = componentization_mode.get("reasons", [])
        if reasons:
            lines.append("- reasons:")
            for value in reasons[:20]:
                lines.append(f"  - {value}")
        if componentization_mode.get("readPolicy"):
            lines.append(f"- readPolicy: {componentization_mode.get('readPolicy')}")
        if componentization_mode.get("slotPolicy"):
            lines.append(f"- slotPolicy: {componentization_mode.get('slotPolicy')}")
        lines.append(f"- rule: {checklist.get('conservativeModeRule', '')}")
    order = layout_contract.get("sectionOrder", [])
    if order:
        lines.append("- sectionOrder:")
        for value in order[:60]:
            lines.append(f"  - `{value}`")
    coverage = checklist.get("coverageReport", {})
    lines.extend(["", "## Coverage"])
    lines.append(f"- mode: {coverage.get('mode', 'whole-html-source')}")
    lines.append(f"- totalTextCount: {coverage.get('totalTextCount', 0)}")
    note = coverage.get("note")
    if note:
        lines.append(f"- note: {note}")
    regression_targets = checklist.get("localRegressionTargets", [])
    if regression_targets:
        lines.extend(["", "## Local Regression Targets"])
        for item in regression_targets[:20]:
            flags = ",".join(item.get("riskFlags", []))
            lines.append(
                f"- owner={item.get('owner')} action={item.get('action')} "
                f"flags={flags} path=`{item.get('path')}`"
            )
    lines.extend(["", "## Whole Sections"])
    if checklist["mustRenderWholeSections"]:
        for item in checklist["mustRenderWholeSections"][:30]:
            lines.append(
                f"- `{item['ownerPath']}` layout={item['layoutHint']} "
                f"hasSearchBar={item['hasSearchBar']} tags={item['tagStripTexts']} subsections={item['subsectionTitles']}"
            )
    else:
        lines.append("- none")
    lines.extend(["", "## Source Actions"])
    if checklist["sourceActionTexts"]:
        for action in checklist["sourceActionTexts"][:40]:
            lines.append(f"- `{action}`")
    else:
        lines.append("- none")
    lines.extend(["", "## Icon Candidates"])
    icon_candidates = checklist.get("iconCandidates", [])
    if icon_candidates:
        for item in icon_candidates[:24]:
            nearby = ", ".join(item.get("nearbyTexts", [])[:4]) or "none"
            suggestion = item.get("librarySuggestion") or "none"
            lines.append(
                f"- owner={item.get('owner')} role={item.get('iconRole')} nature={item.get('iconNature')} "
                f"suggestion={suggestion} library={item.get('librarySource') or 'none'} "
                f"fallback={item.get('fallbackSource')} nearbyTexts={nearby}"
            )
            if item.get("svgMarkup"):
                lines.append(f"  - svgFallback: `{item.get('svgMarkup')[:180]}`")
    else:
        lines.append("- none")
    lines.extend(["", "## Interaction Candidates"])
    interaction_candidates = checklist.get("interactionCandidates", [])
    if interaction_candidates:
        for item in interaction_candidates[:30]:
            lines.append(
                f"- kind={item.get('kind')} label={item.get('label') or 'none'} "
                f"bbox={item.get('bbox')}; evidence={item.get('evidence')}"
            )
    else:
        lines.append("- none")
    lines.extend(["", "## Safe Leaf Slots"])
    safe_leaf_slots = checklist.get("safeLeafSlots", [])
    if safe_leaf_slots:
        for item in safe_leaf_slots[:16]:
            lines.append(
                f"- slot={item.get('slot')} kind={item.get('kind')} decision={item.get('decision')} "
                f"candidate={item.get('candidate') or 'none'} priority={item.get('applyPriority') or 'none'} bbox={item.get('bbox')}"
            )
    else:
        lines.append("- none")
    lines.extend(["", "## Deferred Block Slots"])
    deferred_block_slots = checklist.get("deferredBlockSlots", [])
    if deferred_block_slots:
        for item in deferred_block_slots[:16]:
            lines.append(
                f"- slot={item.get('slot')} kind={item.get('kind')} decision={item.get('decision')} "
                f"candidate={item.get('candidate') or 'none'} priority={item.get('applyPriority') or 'none'} bbox={item.get('bbox')}"
            )
    else:
        lines.append("- none")
    lines.extend(["", "## Rule", f"- {checklist['buttonRule']}", f"- {checklist['stagePassRule']}"])
    write_text(path, "\n".join(lines) + "\n")


def verify_paths(paths: list[str]) -> None:
    missing = [path for path in paths if not Path(path).exists()]
    if missing:
        raise SystemExit("Missing required analysis artifacts:\n" + "\n".join(missing))


def main() -> int:
    ap = argparse.ArgumentParser(description="Prepare HTML analysis and write a compact Stage 1 handoff.")
    ap.add_argument("--project-root", required=True)
    ap.add_argument("--html-file", action="append", default=[], help="HTML source file; repeat or comma-separate for same-page multi-fragment analysis.")
    ap.add_argument("--task-stem", required=True)
    ap.add_argument("--copy-html-input", action="store_true")
    ap.add_argument("--emit-section-html", action="store_true", help="Debug mode only; default does not emit section HTML slices.")
    ap.add_argument("--emit-reference-html", action="store_true", help="Debug mode only; default does not emit page-level helper HTML files.")
    args = ap.parse_args()

    project_root = Path(args.project_root).resolve()
    html_files = split_html_inputs(args.html_file)
    if not project_root.exists():
        raise SystemExit(f"Project root not found: {project_root}")
    if not html_files:
        raise SystemExit("At least one --html-file is required")
    missing_html = [str(path) for path in html_files if not path.exists()]
    if missing_html:
        raise SystemExit("HTML source not found:\n" + "\n".join(missing_html))

    output_root = project_root / ".frontend"
    analysis_dir = output_root / "html-analysis"
    html_input_dir = output_root / "html-input"
    ensure_dir(analysis_dir)

    html_input_path = ""
    analysis_inputs = html_files
    if args.copy_html_input:
        ensure_dir(html_input_dir)
        if len(html_files) == 1:
            html_input_target = html_input_dir / f"{args.task_stem}.html"
            html_input_target.write_bytes(html_files[0].read_bytes())
            html_input_path = str(html_input_target)
            analysis_inputs = [html_input_target]
        else:
            copied_paths: list[str] = []
            for idx, source_path in enumerate(html_files, start=1):
                html_input_target = html_input_dir / f"{args.task_stem}-{idx}.html"
                html_input_target.write_bytes(source_path.read_bytes())
                copied_paths.append(str(html_input_target))
            html_input_path = ", ".join(copied_paths)
            analysis_inputs = [Path(path) for path in copied_paths]

    if len(analysis_inputs) == 1:
        analysis_source = analysis_inputs[0]
    else:
        ensure_dir(html_input_dir)
        merged_input_path = html_input_dir / f"{args.task_stem}-merged.html"
        analysis_source = build_merged_html_input(analysis_inputs, merged_input_path)
        if not html_input_path:
            html_input_path = ", ".join(str(path) for path in analysis_inputs)

    analyze_script = Path(__file__).with_name("analyze_absolute_html.py")
    cmd = [
        sys.executable,
        "-B",
        str(analyze_script),
        str(analysis_source),
        "--project-root",
        str(project_root),
        "--out-dir",
        str(analysis_dir),
        "--output-name",
        args.task_stem,
    ]
    if args.emit_section_html:
        cmd.append("--emit-section-html")
    if args.emit_reference_html:
        cmd.append("--emit-reference-html")
    subprocess.run(cmd, check=True)

    # Run assets processing
    assets_script = Path(__file__).with_name("process_assets.py")
    assets_cmd = [
        sys.executable,
        "-B",
        str(assets_script),
        "--project-root",
        str(project_root),
        "--task-stem",
        args.task_stem,
        "--output-dir",
        str(analysis_dir),
    ]
    for html_file in html_files:
        assets_cmd.extend(["--html-file", str(html_file)])

    try:
        subprocess.run(assets_cmd, check=True)
    except subprocess.CalledProcessError as exc:
        print(f"Warning: Assets processing failed: {exc}", file=sys.stderr)
        print("Continuing without assets mapping table", file=sys.stderr)

    manifest_path = analysis_dir / f"{args.task_stem}.json"
    handoff_md_path = analysis_dir / f"{args.task_stem}.md"
    checklist_md_path = analysis_dir / f"{args.task_stem}-checklist.md"
    verify_paths([
        str(manifest_path),
        str(handoff_md_path),
    ])
    if args.emit_section_html:
        verify_paths([str(analysis_dir / f"{args.task_stem}-section-html" / "index.md")])
    if args.emit_reference_html:
        verify_paths([
            str(analysis_dir / f"{args.task_stem}-page-layout.html"),
            str(analysis_dir / f"{args.task_stem}-whole-page-reference.html"),
        ])

    full_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    checklist = build_checklist(
        task_stem=args.task_stem,
        html_source_paths=[str(path) for path in html_files],
        html_input_path=html_input_path,
        analysis_source_path=str(analysis_source),
        output_dir=analysis_dir,
        full_manifest=full_manifest,
    )
    write_checklist_md(checklist_md_path, checklist)

    # Check for assets mapping
    assets_mapping_path = analysis_dir / f"{args.task_stem}-assets-mapping.json"
    assets_info = {}
    if assets_mapping_path.exists():
        try:
            assets_mapping = json.loads(assets_mapping_path.read_text(encoding="utf-8"))
            assets_info = {
                "assetsMappingPath": str(assets_mapping_path),
                "totalAssets": assets_mapping.get("totalAssets", 0),
                "retentionRate": assets_mapping.get("retentionRate", 0.0),
                "retentionCheck": assets_mapping.get("retentionCheck", ""),
                "decisions": assets_mapping.get("decisions", {}),
            }
        except Exception as exc:
            print(f"Warning: Failed to read assets mapping: {exc}", file=sys.stderr)

    print(json.dumps({
        "taskStem": args.task_stem,
        "handoffMarkdown": str(handoff_md_path),
        "handoffChecklist": str(checklist_md_path),
        "manifestPath": str(manifest_path),
        "htmlSourcePaths": [str(path) for path in html_files],
        "analysisSourcePath": str(analysis_source),
        "referenceHtmlFiles": {
            "pageLayoutHtml": str(analysis_dir / f"{args.task_stem}-page-layout.html"),
            "wholePageReferenceHtml": str(analysis_dir / f"{args.task_stem}-whole-page-reference.html"),
        } if args.emit_reference_html else {},
        "layoutContract": checklist["layoutContract"]["passRule"],
        "sectionHtmlPolicy": checklist["sectionHtmlPolicy"],
        "wholeSections": [item["ownerPath"] for item in checklist["mustRenderWholeSections"]],
        "sourceActionTexts": checklist["sourceActionTexts"],
        "assetsProcessing": assets_info,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
