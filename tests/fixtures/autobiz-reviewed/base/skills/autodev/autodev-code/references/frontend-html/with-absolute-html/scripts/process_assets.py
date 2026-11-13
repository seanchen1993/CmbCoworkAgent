#!/usr/bin/env python3
"""Process assets from high-fidelity HTML and generate mapping table."""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path
from typing import Any


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def extract_asset_references(html_content: str) -> list[dict[str, Any]]:
    """Extract all asset references from HTML."""
    references = []

    # Pattern 1: <img src="./assets/...">
    img_pattern = r'<img[^>]+src=["\'](\.\/assets\/[^"\']+)["\']'
    for match in re.finditer(img_pattern, html_content, re.IGNORECASE):
        asset_path = match.group(1)
        # Extract alt text if present
        alt_match = re.search(r'alt=["\'](.*?)["\']', match.group(0))
        alt_text = alt_match.group(1) if alt_match else ""
        references.append({
            "path": asset_path,
            "type": "img",
            "context": match.group(0)[:200],
            "altText": alt_text,
        })

    # Pattern 2: CSS background-image: url(./assets/...)
    css_pattern = r'background-image:\s*url\(["\']?(\.\/assets\/[^"\')\s]+)["\']?\)'
    for match in re.finditer(css_pattern, html_content, re.IGNORECASE):
        asset_path = match.group(1)
        references.append({
            "path": asset_path,
            "type": "css-background",
            "context": match.group(0)[:200],
            "altText": "",
        })

    # Pattern 3: <svg> or inline SVG with xlink:href
    svg_pattern = r'xlink:href=["\'](\.\/assets\/[^"\']+)["\']'
    for match in re.finditer(svg_pattern, html_content, re.IGNORECASE):
        asset_path = match.group(1)
        references.append({
            "path": asset_path,
            "type": "svg-xlink",
            "context": match.group(0)[:200],
            "altText": "",
        })

    return references


def extract_semantic(file_path: str, alt_text: str, context: str) -> str:
    """Extract semantic meaning from file name, alt text, and context."""
    filename = Path(file_path).name.lower()

    # Common semantic mappings
    semantic_map = {
        "箭头": "箭头",
        "arrow": "箭头",
        "right": "右",
        "left": "左",
        "down": "下",
        "up": "上",
        "用户": "用户",
        "user": "用户",
        "search": "搜索",
        "搜索": "搜索",
        "close": "关闭",
        "关闭": "关闭",
        "edit": "编辑",
        "编辑": "编辑",
        "delete": "删除",
        "删除": "删除",
        "setting": "设置",
        "设置": "设置",
        "logo": "Logo",
        "ai": "AI",
        "menu": "菜单",
        "菜单": "菜单",
        "home": "首页",
        "首页": "首页",
    }

    # Try to extract semantic from filename
    for key, value in semantic_map.items():
        if key in filename:
            return value

    # Try from alt text
    if alt_text:
        return alt_text[:50]

    # Fallback to filename stem
    return Path(file_path).stem[:50]


def classify_asset(
    asset_ref: dict[str, Any],
    project_root: Path,
) -> dict[str, Any]:
    """Classify asset into one of 4 priority levels."""
    file_path = asset_ref["path"]
    filename = Path(file_path).name.lower()
    semantic = extract_semantic(file_path, asset_ref["altText"], asset_ref["context"])

    # Check if file exists in assets folder
    asset_full_path = None
    if file_path.startswith("./assets/"):
        relative_path = file_path[2:]  # Remove ./
        asset_full_path = project_root / relative_path

    file_exists = asset_full_path and asset_full_path.exists()
    file_ext = Path(filename).suffix.lower()

    # Priority 1: Ant Design icons
    antd_mapping = map_to_antd_icon(semantic, filename)
    if antd_mapping:
        return {
            "originalFile": file_path,
            "semantic": semantic,
            "decision": "useAntdIcon",
            "replacement": antd_mapping["component"],
            "reason": "通用图标，图标库已有",
            "fileExists": file_exists,
            "fileExtension": file_ext,
        }

    # Priority 2: Project existing icons (placeholder - would need actual check)
    # This would require scanning project's src/assets/icons/ etc.
    # Skipping for now as it requires project context

    # Priority 3: CSS implementation for simple shapes
    css_replacement = check_css_replacement(semantic, filename)
    if css_replacement:
        return {
            "originalFile": file_path,
            "semantic": semantic,
            "decision": "useCss",
            "replacement": css_replacement,
            "reason": "简单几何图形，可用 CSS 实现",
            "fileExists": file_exists,
            "fileExtension": file_ext,
        }

    # Priority 4: Keep special design assets
    keep_reason = check_should_keep(semantic, filename, file_ext)
    if keep_reason:
        target_dir = determine_target_directory(semantic, file_ext)
        target_path = f"{target_dir}/{Path(file_path).name}"
        return {
            "originalFile": file_path,
            "semantic": semantic,
            "decision": "copyToProject",
            "targetPath": target_path,
            "importStatement": f"import {to_camel_case(Path(file_path).stem)} from '@/{target_path}'",
            "reason": keep_reason,
            "fileExists": file_exists,
            "fileExtension": file_ext,
        }

    # Default: treat as icon that should use Ant Design or CSS
    return {
        "originalFile": file_path,
        "semantic": semantic,
        "decision": "useCss",
        "replacement": '<div className="w-4 h-4 bg-gray-400" />',
        "reason": "无明确分类，建议用 CSS 占位或检查是否可用图标库",
        "fileExists": file_exists,
        "fileExtension": file_ext,
    }


def map_to_antd_icon(semantic: str, filename: str) -> dict[str, str] | None:
    """Map semantic to Ant Design icon component."""
    mappings = {
        "右箭头": {"component": "<RightOutlined />", "import": "RightOutlined"},
        "右": {"component": "<RightOutlined />", "import": "RightOutlined"},
        "左箭头": {"component": "<LeftOutlined />", "import": "LeftOutlined"},
        "左": {"component": "<LeftOutlined />", "import": "LeftOutlined"},
        "下箭头": {"component": "<DownOutlined />", "import": "DownOutlined"},
        "下": {"component": "<DownOutlined />", "import": "DownOutlined"},
        "上箭头": {"component": "<UpOutlined />", "import": "UpOutlined"},
        "上": {"component": "<UpOutlined />", "import": "UpOutlined"},
        "用户": {"component": "<UserOutlined />", "import": "UserOutlined"},
        "搜索": {"component": "<SearchOutlined />", "import": "SearchOutlined"},
        "关闭": {"component": "<CloseOutlined />", "import": "CloseOutlined"},
        "编辑": {"component": "<EditOutlined />", "import": "EditOutlined"},
        "删除": {"component": "<DeleteOutlined />", "import": "DeleteOutlined"},
        "设置": {"component": "<SettingOutlined />", "import": "SettingOutlined"},
        "菜单": {"component": "<MenuOutlined />", "import": "MenuOutlined"},
        "首页": {"component": "<HomeOutlined />", "import": "HomeOutlined"},
    }

    # Check semantic first
    if semantic in mappings:
        return mappings[semantic]

    # Check filename keywords
    for key in mappings:
        if key in filename:
            return mappings[key]

    return None


def check_css_replacement(semantic: str, filename: str) -> str | None:
    """Check if asset can be replaced with CSS."""
    css_keywords = {
        "分隔线": '<div className="w-full h-px bg-gray-300" />',
        "矩形": '<div className="w-4 h-4 bg-gray-400 rounded" />',
        "圆点": '<div className="w-2 h-2 rounded-full bg-gray-400" />',
        "直线": '<div className="w-full h-px bg-gray-300" />',
        "line": '<div className="w-full h-px bg-gray-300" />',
        "rectangle": '<div className="w-4 h-4 bg-gray-400 rounded" />',
        "dot": '<div className="w-2 h-2 rounded-full bg-gray-400" />',
    }

    for key, replacement in css_keywords.items():
        if key in semantic or key in filename:
            return replacement

    return None


def check_should_keep(semantic: str, filename: str, file_ext: str) -> str | None:
    """Determine if asset should be kept based on special design criteria."""
    keep_keywords = {
        "logo": "品牌 Logo，必须保留",
        "ai": "品牌特殊设计图标",
        "brand": "品牌标识",
        "illustration": "插画，需保留",
        "screenshot": "截图，需保留",
        "product": "产品图片，需保留",
    }

    for key, reason in keep_keywords.items():
        if key in semantic.lower() or key in filename:
            return reason

    # Keep non-SVG images by default (PNG, JPG, etc.)
    if file_ext in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
        return "位图资源，需保留"

    # Keep complex SVG (heuristic: large file name suggests complexity)
    if file_ext == ".svg" and len(Path(filename).stem) > 20:
        return "复杂 SVG，需保留"

    return None


def determine_target_directory(semantic: str, file_ext: str) -> str:
    """Determine target directory for asset."""
    if "logo" in semantic.lower():
        return "src/assets/logos"
    elif file_ext == ".svg":
        return "src/assets/icons"
    else:
        return "src/assets/images"


def to_camel_case(snake_str: str) -> str:
    """Convert string to CamelCase for import names."""
    # Remove special characters and split
    clean = re.sub(r'[^a-zA-Z0-9一-鿿]+', '_', snake_str)
    components = clean.split('_')
    return ''.join(x.title() for x in components if x)


def generate_mapping_table(
    task_stem: str,
    html_files: list[Path],
    project_root: Path,
) -> dict[str, Any]:
    """Generate complete assets mapping table."""
    all_references = []

    for html_file in html_files:
        content = read_text(html_file)
        refs = extract_asset_references(content)
        all_references.extend(refs)

    # Deduplicate by path
    unique_refs = {ref["path"]: ref for ref in all_references}.values()

    # Classify each asset
    mappings = []
    decisions = {
        "useAntdIcon": 0,
        "useProjectIcon": 0,
        "useCss": 0,
        "copyToProject": 0,
    }

    for ref in unique_refs:
        classification = classify_asset(ref, project_root)
        mappings.append(classification)
        decision = classification["decision"]
        if decision == "useAntdIcon":
            decisions["useAntdIcon"] += 1
        elif decision == "useProjectIcon":
            decisions["useProjectIcon"] += 1
        elif decision == "useCss":
            decisions["useCss"] += 1
        elif decision == "copyToProject":
            decisions["copyToProject"] += 1

    total = len(mappings)
    retention_rate = decisions["copyToProject"] / total if total > 0 else 0.0

    return {
        "taskStem": task_stem,
        "totalAssets": total,
        "referencedAssets": total,
        "decisions": decisions,
        "retentionRate": round(retention_rate, 3),
        "retentionCheck": "PASS" if retention_rate <= 0.30 else "WARNING - 建议保留率在 30% 以内",
        "mappings": mappings,
        "htmlSources": [str(f) for f in html_files],
    }


def copy_assets_to_project(
    mappings: list[dict[str, Any]],
    project_root: Path,
    html_dir: Path,
) -> dict[str, Any]:
    """Copy assets marked as 'copyToProject' to project directories."""
    copied_files = []
    failed_files = []

    for mapping in mappings:
        if mapping["decision"] != "copyToProject":
            continue

        original_file = mapping["originalFile"]
        target_path = mapping["targetPath"]

        # Resolve source file path (relative to HTML directory)
        if original_file.startswith("./"):
            source_path = html_dir / original_file[2:]
        else:
            source_path = html_dir / original_file

        # Resolve target path (relative to project root)
        if target_path.startswith("src/"):
            target_full_path = project_root / target_path
        elif target_path.startswith("public/"):
            target_full_path = project_root / target_path
        else:
            # Default to src/assets if no prefix
            target_full_path = project_root / "src" / target_path

        # Check if source file exists
        if not source_path.exists():
            failed_files.append({
                "originalFile": original_file,
                "targetPath": target_path,
                "reason": f"Source file not found: {source_path}",
            })
            continue

        # Create target directory
        target_full_path.parent.mkdir(parents=True, exist_ok=True)

        # Copy file
        try:
            shutil.copy2(source_path, target_full_path)
            copied_files.append({
                "originalFile": original_file,
                "sourcePath": str(source_path),
                "targetPath": str(target_full_path.relative_to(project_root)),
                "importStatement": mapping["importStatement"],
            })
        except Exception as e:
            failed_files.append({
                "originalFile": original_file,
                "targetPath": target_path,
                "reason": f"Copy failed: {str(e)}",
            })

    return {
        "copiedCount": len(copied_files),
        "failedCount": len(failed_files),
        "copiedFiles": copied_files,
        "failedFiles": failed_files,
    }


def write_mapping_table(output_path: Path, mapping: dict[str, Any]) -> None:
    """Write mapping table to JSON file."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(mapping, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def print_summary(mapping: dict[str, Any]) -> None:
    """Print assets processing summary."""
    decisions = mapping["decisions"]
    total = mapping["totalAssets"]

    summary_lines = []
    summary_lines.append("\n### Assets 处理总结\n")
    summary_lines.append(f"- HTML 中引用的 assets 文件总数：{total} 个")
    if total > 0:
        summary_lines.append(f"- 使用 Ant Design 图标替代：{decisions['useAntdIcon']} 个 ({decisions['useAntdIcon']/total*100:.0f}%)")
    summary_lines.append(f"- 使用项目已有图标：{decisions['useProjectIcon']} 个")
    if total > 0:
        summary_lines.append(f"- CSS 实现：{decisions['useCss']} 个 ({decisions['useCss']/total*100:.0f}%)")
    if total > 0:
        summary_lines.append(f"- 复制到项目 assets：{decisions['copyToProject']} 个 ({decisions['copyToProject']/total*100:.0f}%)")
    summary_lines.append(f"\n{mapping['retentionCheck']}")

    # List assets to copy
    to_copy = [m for m in mapping["mappings"] if m["decision"] == "copyToProject"]
    if to_copy:
        summary_lines.append("\n需要复制到项目的文件：")
        for item in to_copy:
            summary_lines.append(f"  - {item['originalFile']} -> {item['targetPath']}")
            summary_lines.append(f"    理由：{item['reason']}")

    # Print with proper encoding handling
    summary_text = "\n".join(summary_lines)
    try:
        print(summary_text)
    except UnicodeEncodeError:
        # Fallback for Windows console
        print(summary_text.encode('utf-8', errors='replace').decode('utf-8', errors='replace'))


def main() -> int:
    ap = argparse.ArgumentParser(description="Process assets and generate mapping table.")
    ap.add_argument("--project-root", required=True, help="Project root directory")
    ap.add_argument("--html-file", action="append", default=[], help="HTML source files")
    ap.add_argument("--task-stem", required=True, help="Task stem identifier")
    ap.add_argument("--output-dir", required=True, help="Output directory for mapping table")
    args = ap.parse_args()

    project_root = Path(args.project_root).resolve()
    html_files = [Path(f).resolve() for f in args.html_file if f]
    output_dir = Path(args.output_dir).resolve()

    if not project_root.exists():
        print(f"Error: Project root not found: {project_root}", file=sys.stderr)
        return 1

    if not html_files:
        print("Warning: No HTML files provided, skipping assets processing")
        return 0

    missing = [str(f) for f in html_files if not f.exists()]
    if missing:
        print(f"Error: HTML files not found:\n" + "\n".join(missing), file=sys.stderr)
        return 1

    # Determine HTML directory (assume all HTML files are in the same directory)
    html_dir = html_files[0].parent

    # Generate mapping table
    mapping = generate_mapping_table(args.task_stem, html_files, project_root)

    # Copy assets to project
    copy_result = copy_assets_to_project(mapping["mappings"], project_root, html_dir)
    mapping["assetsCopyResult"] = copy_result

    # Write to output
    output_path = output_dir / f"{args.task_stem}-assets-mapping.json"
    write_mapping_table(output_path, mapping)

    # Print summary
    print_summary(mapping)

    # Print copy result
    if copy_result["copiedCount"] > 0:
        print(f"\n✅ 已复制 {copy_result['copiedCount']} 个文件到项目目录")
        for item in copy_result["copiedFiles"]:
            print(f"  {item['originalFile']} -> {item['targetPath']}")

    if copy_result["failedCount"] > 0:
        print(f"\n❌ 复制失败 {copy_result['failedCount']} 个文件")
        for item in copy_result["failedFiles"]:
            print(f"  {item['originalFile']}: {item['reason']}")

    # Output result for caller
    print(json.dumps({
        "mappingPath": str(output_path),
        "totalAssets": mapping["totalAssets"],
        "retentionRate": mapping["retentionRate"],
        "retentionCheck": mapping["retentionCheck"],
        "decisions": mapping["decisions"],
        "copiedCount": copy_result["copiedCount"],
        "failedCount": copy_result["failedCount"],
    }, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    import sys
    raise SystemExit(main())
