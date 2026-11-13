#!/usr/bin/env python3
"""
Analyze large absolute-position HTML exports before LLM conversion.

The script turns noisy Figma/MasterGo-style div HTML into compact artifacts:
- .frontend/html-analysis/<name>.json: machine-readable manifest
- .frontend/html-analysis/<name>.md: human/LLM handoff report

It uses only the Python standard library so it can run in restricted projects.
"""

from __future__ import annotations

import argparse
import hashlib
import html as html_lib
import json
import math
import os
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


CONTROL_WORDS = {
    "确定", "取消", "重置", "提交", "保存", "返回", "新增", "添加", "删除", "编辑",
    "添加规则", "新增评分维度", "新建课程", "填写报告",
}

FORM_TRIGGER_WORDS = {
    "请输入", "请选择", "保存", "提交", "确认", "重置", "搜索", "上传", "导入",
}

SECTION_WORDS = {
    "企业信息", "基本信息", "关键人信息", "评分规则", "人员情况", "课程管理",
}

SECTION_HINT_WORDS = {
    "信息", "结果", "记录", "详情", "明细", "报告", "内容", "流程", "节点", "处理",
    "概览", "概况", "清单", "列表", "说明", "查询",
}

COMMON_SECTION_TITLES = {
    "基本信息",
    "详细信息",
    "详情信息",
    "所有权信息",
    "节点记录",
    "处理基本信息",
    "任务处理信息",
    "处理信息",
    "受益所有人信息",
    "附加信息",
    "备注信息",
    "我行受益所有人留存信息",
    "人行受益所有人查询结果",
    "任务处理信息",
    "处理基本信息",
    "分析结论",
    "差异报告",
    "核验结果",
}

KNOWN_FIELD_WORDS = {
    "课程名称", "课程简介", "企业名称", "企业痛点", "关键人介绍", "角色设定",
    "姓名", "年龄", "职位", "性别", "字段名称", "内容",
}

DISPLAY_ONLY_LABEL_WORDS = {
    "较同期",
}

NON_HEADING_PATTERNS = [
    r"报告ID",
    r"报告编号",
    r"审批通过",
    r"审批驳回",
    r"提交处理信息",
    r"撤回处理信息",
    r"报告被退回",
    r"发现差异",
]

LIKELY_NOISE_TEXTS = {
    "选中标签",
}

PAGINATION_SIGNAL_TERMS = {
    "条/页", "共 ", "跳至", "上一页", "下一页", "分页",
}

LIST_RECORD_PREFIXES = (
    "客户号：",
    "核验时间：",
    "差异发现时间：",
    "管户市场经理：",
)


FILTER_ACTION_TEXTS = {
    "查询",
    "重置",
    "搜索",
}

GENERIC_TABLE_HEADER_TERMS = {
    "企业信息",
    "企业名称",
    "公司名称",
    "客户信息",
    "客户名称",
    "用户信息",
    "名称",
    "联系人",
    "联系方式",
    "所在地区",
    "所属行业",
    "状态",
    "创建时间",
    "更新时间",
    "备注",
    "操作",
}

AVATAR_COLUMN_HINTS = {
    "企业信息",
    "客户信息",
    "用户信息",
    "名称",
    "企业名称",
    "客户名称",
}

CHART_SIGNAL_WORDS = {
    "图表",
    "趋势",
    "走势",
    "分析",
    "分布",
    "占比",
    "同比",
    "环比",
    "排名",
    "排行",
    "榜单",
    "近7天",
    "近30天",
    "top",
    "ranking",
    "chart",
    "graph",
    "trend",
    "analysis",
    "plot",
    "dashboard",
    "折线",
    "面积",
    "柱状",
    "条形",
    "饼图",
    "环图",
    "雷达",
    "漏斗",
    "散点",
    "仪表盘",
}

RANKING_SIGNAL_WORDS = {
    "top",
    "排名",
    "排行",
    "榜单",
}

CHART_CLASS_HINTS = (
    "chart",
    "graph",
    "trend",
    "analysis",
    "plot",
    "dashboard",
    "echart",
    "g2",
)

CHART_TYPE_HINTS = {
    "line": {"折线", "走势", "趋势", "line", "trend"},
    "area": {"面积", "area"},
    "bar": {"柱状", "条形", "bar", "histogram"},
    "pie": {"饼图", "pie"},
    "donut": {"环图", "donut", "ring"},
    "radar": {"雷达", "radar"},
    "funnel": {"漏斗", "funnel"},
    "scatter": {"散点", "scatter"},
    "gauge": {"仪表盘", "gauge", "dashboard"},
}


def parse_style(style: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for part in style.split(";"):
        if ":" not in part:
            continue
        key, value = part.split(":", 1)
        result[key.strip().lower()] = value.strip()
    return result


TAILWIND_COLOR_MAP = {
    "white": "#ffffff",
    "gray-300": "#d1d5db",
    "gray-400": "#9ca3af",
    "gray-500": "#6b7280",
    "gray-800": "#1f2937",
    "green-500": "#22c55e",
    "red-500": "#ef4444",
}


def px(value: str | None) -> float | None:
    if not value:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", value)
    return float(m.group(0)) if m else None


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def merge_style_dict(base: dict[str, str], extra: dict[str, str]) -> dict[str, str]:
    merged = dict(base)
    for key, value in extra.items():
        if value != "":
            merged[key] = value
    return merged


def tailwind_spacing(token: str) -> str:
    if token == "px":
        return "1px"
    if token == "0":
        return "0px"
    try:
        value = float(token)
    except ValueError:
        return ""
    return f"{value * 4:g}px"


def tailwind_opacity_to_rgba(color_hex: str, opacity_token: str) -> str:
    color_hex = color_hex.lstrip("#")
    if len(color_hex) != 6:
        return ""
    try:
        opacity = float(opacity_token) / 100.0
    except ValueError:
        return ""
    r = int(color_hex[0:2], 16)
    g = int(color_hex[2:4], 16)
    b = int(color_hex[4:6], 16)
    return f"rgba({r}, {g}, {b}, {opacity:.4f})"


def parse_tailwind_classes(class_name: str) -> dict[str, str]:
    styles: dict[str, str] = {}
    tokens = [token for token in re.split(r"\s+", class_name.strip()) if token]
    if not tokens:
        return styles
    gradient_from = ""
    gradient_to = ""
    for token in tokens:
        if token == "flex":
            styles["display"] = "flex"
        elif token == "inline-flex":
            styles["display"] = "inline-flex"
        elif token == "grid":
            styles["display"] = "grid"
        elif token == "flex-col":
            styles["flex-direction"] = "column"
        elif token == "flex-row":
            styles["flex-direction"] = "row"
        elif token == "items-center":
            styles["align-items"] = "center"
        elif token == "items-end":
            styles["align-items"] = "flex-end"
        elif token == "items-start":
            styles["align-items"] = "flex-start"
        elif token == "justify-center":
            styles["justify-content"] = "center"
        elif token == "justify-end":
            styles["justify-content"] = "flex-end"
        elif token == "justify-start":
            styles["justify-content"] = "flex-start"
        elif token == "justify-between":
            styles["justify-content"] = "space-between"
        elif token == "relative":
            styles["position"] = "relative"
        elif token == "absolute":
            styles["position"] = "absolute"
        elif token == "rounded":
            styles["border-radius"] = "4px"
        elif token == "border":
            styles["border"] = "1px solid #d1d5db"
        elif token.startswith("border-") and token[7:] in TAILWIND_COLOR_MAP:
            color = TAILWIND_COLOR_MAP[token[7:]]
            styles["border"] = f"1px solid {color}"
        elif token.startswith("bg-") and token[3:] in TAILWIND_COLOR_MAP:
            styles["background"] = TAILWIND_COLOR_MAP[token[3:]]
        elif token == "bg-gradient-to-b":
            styles["background-image"] = "linear-gradient(180deg, var(--tw-gradient-from), var(--tw-gradient-to))"
        elif token.startswith("from-"):
            match = re.fullmatch(r"from-([a-z]+-\d+)(?:/(\d+))?", token)
            if match and match.group(1) in TAILWIND_COLOR_MAP:
                base = TAILWIND_COLOR_MAP[match.group(1)]
                gradient_from = tailwind_opacity_to_rgba(base, match.group(2)) if match.group(2) else base
        elif token.startswith("to-"):
            match = re.fullmatch(r"to-([a-z]+-\d+)(?:/(\d+))?", token)
            if match and match.group(1) in TAILWIND_COLOR_MAP:
                base = TAILWIND_COLOR_MAP[match.group(1)]
                gradient_to = tailwind_opacity_to_rgba(base, match.group(2)) if match.group(2) else base
        elif token.startswith("text-"):
            if token[5:] in TAILWIND_COLOR_MAP:
                styles["color"] = TAILWIND_COLOR_MAP[token[5:]]
            elif token == "text-base":
                styles["font-size"] = "16px"
            elif token == "text-sm":
                styles["font-size"] = "14px"
            elif token == "text-xs":
                styles["font-size"] = "12px"
            else:
                match = re.fullmatch(r"text-\[(.+)\]", token)
                if match:
                    styles["font-size"] = match.group(1)
        elif token == "font-bold":
            styles["font-weight"] = "700"
        elif token.startswith("opacity-"):
            match = re.fullmatch(r"opacity-(\d+)", token)
            if match:
                try:
                    styles["opacity"] = f"{int(match.group(1)) / 100.0:.2f}"
                except ValueError:
                    pass
        elif token.startswith("w-[") and token.endswith("]"):
            styles["width"] = token[3:-1]
        elif token.startswith("h-[") and token.endswith("]"):
            styles["height"] = token[3:-1]
        elif token.startswith("left-[") and token.endswith("]"):
            styles["left"] = token[6:-1]
        elif token.startswith("top-[") and token.endswith("]"):
            styles["top"] = token[5:-1]
        elif token.startswith("right-[") and token.endswith("]"):
            styles["right"] = token[7:-1]
        elif token.startswith("bottom-[") and token.endswith("]"):
            styles["bottom"] = token[8:-1]
        elif token.startswith("min-w-[") and token.endswith("]"):
            styles["min-width"] = token[7:-1]
        elif token.startswith("max-w-[") and token.endswith("]"):
            styles["max-width"] = token[7:-1]
        elif token.startswith("min-h-[") and token.endswith("]"):
            styles["min-height"] = token[7:-1]
        elif token.startswith("max-h-[") and token.endswith("]"):
            styles["max-height"] = token[7:-1]
        elif token.startswith("top-"):
            styles["top"] = tailwind_spacing(token[4:])
        elif token.startswith("left-"):
            styles["left"] = tailwind_spacing(token[5:])
        elif token.startswith("p-"):
            styles["padding"] = tailwind_spacing(token[2:])
        elif token.startswith("px-"):
            value = tailwind_spacing(token[3:])
            if value:
                styles["padding-left"] = value
                styles["padding-right"] = value
        elif token.startswith("py-"):
            value = tailwind_spacing(token[3:])
            if value:
                styles["padding-top"] = value
                styles["padding-bottom"] = value
        elif token.startswith("gap-"):
            value = tailwind_spacing(token[4:])
            if value:
                styles["gap"] = value
    if gradient_from or gradient_to:
        start = gradient_from or "rgba(34, 197, 94, 0.15)"
        end = gradient_to or "rgba(34, 197, 94, 0.02)"
        styles["background"] = f"linear-gradient(180deg, {start} 0%, {end} 100%)"
    return styles


def decode_data_svg_markup(value: str) -> str:
    if not value:
        return ""
    match = re.search(r"data:image/svg\+xml,([^'\")]+)", value, re.IGNORECASE)
    if not match:
        return ""
    payload = match.group(1)
    try:
        from urllib.parse import unquote
        return unquote(payload)
    except Exception:
        return payload


def package_dependencies(project_root: Path | None) -> dict[str, Any]:
    if not project_root or not project_root.exists():
        return {}
    package_file = project_root / "package.json"
    if not package_file.exists():
        return {}
    try:
        package = json.loads(package_file.read_text(encoding="utf-8", errors="ignore"))
    except json.JSONDecodeError:
        return {}
    deps: dict[str, Any] = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        value = package.get(key)
        if isinstance(value, dict):
            deps.update(value)
    return deps


def is_real_svg_asset(node: "Node", attrs: dict[str, str], bg_image: str) -> bool:
    src = str(attrs.get("src", "") or "")
    if "data:image/svg+xml" in src.lower():
        return True
    if node.tag == "svg":
        return True
    if "data-svg-icon" in attrs:
        return True
    if "data:image/svg+xml" in str(bg_image or "").lower():
        return False
    return False


def component_source_rank(source: str) -> int:
    return {
        "architecture-public-doc": 0,
        "architecture-shared-doc": 1,
        "output-components-doc": 2,
        "project-components": 3,
    }.get(source, 3)


def display_path_relative_to(path: Path, root: Path | None) -> str:
    if root is None:
        return str(path)
    try:
        return str(path.relative_to(root))
    except (ValueError, TypeError):
        return str(path)


def collect_component_doc_entries(
    doc_path: Path,
    source: str,
    components: dict[str, dict[str, Any]],
    project_root: Path | None,
) -> None:
    if not doc_path.exists() or not doc_path.is_file():
        return
    try:
        text = doc_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return
    names = []
    for match in re.finditer(r"^#{1,3}\s+([A-Z][A-Za-z0-9_-]+)\s*$", text, re.MULTILINE):
        names.append(match.group(1))
    names = list(dict.fromkeys(names))
    for name in names:
        entry = components.setdefault(name, {
            "name": name,
            "paths": [],
            "kind": infer_component_kind(name),
            "usageCount": 0,
            "sourceType": source,
            "sourceRank": component_source_rank(source),
        })
        current_rank = int(entry.get("sourceRank", 9))
        new_rank = component_source_rank(source)
        if new_rank < current_rank:
            entry["sourceType"] = source
            entry["sourceRank"] = new_rank
        display_path = display_path_relative_to(doc_path, project_root)
        entry["paths"].append(display_path)
        entry["usageCount"] = max(entry.get("usageCount", 0), 1)


@dataclass
class Node:
    idx: int
    tag: str
    attrs: dict[str, str]
    parent: int | None
    children: list[int] = field(default_factory=list)
    text_parts: list[str] = field(default_factory=list)
    style: dict[str, str] = field(default_factory=dict)
    x: float | None = None
    y: float | None = None
    w: float | None = None
    h: float | None = None
    abs_x: float = 0
    abs_y: float = 0
    depth: int = 0

    @property
    def node_id(self) -> str:
        return self.attrs.get("id", "")

    @property
    def class_name(self) -> str:
        return self.attrs.get("class", "")

    @property
    def text(self) -> str:
        return clean_text(" ".join(self.text_parts))


class TreeParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.nodes: list[Node] = []
        self.stack: list[int] = []
        self.global_absolute_hint = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_dict = {k: v or "" for k, v in attrs}
        style = merge_style_dict(parse_tailwind_classes(attr_dict.get("class", "")), parse_style(attr_dict.get("style", "")))
        parent = self.stack[-1] if self.stack else None
        node = Node(
            idx=len(self.nodes),
            tag=tag.lower(),
            attrs=attr_dict,
            parent=parent,
            style=style,
            x=px(style.get("left")) if px(style.get("left")) is not None else px(attr_dict.get("x")),
            y=px(style.get("top")) if px(style.get("top")) is not None else px(attr_dict.get("y")),
            w=px(style.get("width")) if px(style.get("width")) is not None else px(attr_dict.get("width")),
            h=px(style.get("height")) if px(style.get("height")) is not None else px(attr_dict.get("height")),
            depth=len(self.stack),
        )
        self.nodes.append(node)
        if parent is not None:
            self.nodes[parent].children.append(node.idx)
        if tag.lower() not in {"br", "img", "input", "meta", "link"}:
            self.stack.append(node.idx)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        while self.stack:
            idx = self.stack.pop()
            if self.nodes[idx].tag == tag:
                break

    def handle_data(self, data: str) -> None:
        text = clean_text(data)
        if text and self.stack:
            self.nodes[self.stack[-1]].text_parts.append(text)

    def handle_comment(self, data: str) -> None:
        if "position: absolute" in data.lower():
            self.global_absolute_hint = True


def detect_global_absolute_hint(html: str) -> bool:
    normalized = re.sub(r"\s+", " ", html).lower()
    return any(
        pattern in normalized
        for pattern in [
            "body { * { box-sizing: border-box; position: absolute; } }",
            "body{*{box-sizing:border-box;position:absolute;}}",
            "position:absolute",
        ]
    )


def should_use_global_absolute_coords(node: Node, parent: Node) -> bool:
    if node.x is None and node.y is None:
        return False
    position = str(node.style.get("position", "")).replace(" ", "").lower()
    parent_position = str(parent.style.get("position", "")).replace(" ", "").lower()
    if position != "absolute" or parent_position != "absolute":
        return False
    child_x = float(node.x or 0.0)
    child_y = float(node.y or 0.0)
    parent_w = float(parent.w or 0.0)
    parent_h = float(parent.h or 0.0)
    if parent_w > 0 and child_x > parent_w + max(24.0, parent_w * 0.15):
        return True
    if parent_h > 0 and child_y > parent_h + max(24.0, parent_h * 0.15):
        return True
    if parent_w > 0 and parent_w <= 120 and child_x >= 220:
        return True
    if parent_h > 0 and parent_h <= 80 and child_y >= 120:
        return True
    return False


def compute_abs(nodes: list[Node]) -> None:
    for node in nodes:
        if node.parent is None:
            base_x = base_y = 0.0
        else:
            parent = nodes[node.parent]
            if should_use_global_absolute_coords(node, parent):
                base_x = base_y = 0.0
            else:
                base_x, base_y = parent.abs_x, parent.abs_y
        node.abs_x = base_x + (node.x or 0.0)
        node.abs_y = base_y + (node.y or 0.0)


def flow_layout(nodes: list[Node]) -> None:
    for node in nodes:
        if node.parent is None:
            continue
        parent = nodes[node.parent]
        if node.x is not None or node.y is not None:
            continue
        position = node.style.get("position", "").strip().lower()
        if position == "absolute":
            continue

        siblings = [nodes[idx] for idx in parent.children if idx < node.idx]
        parent_padding_left = px(parent.style.get("padding-left")) or px(parent.style.get("padding")) or 0.0
        parent_padding_top = px(parent.style.get("padding-top")) or px(parent.style.get("padding")) or 0.0
        gap = px(parent.style.get("gap")) or 0.0
        display = re.sub(r"\s+", "", parent.style.get("display", "").lower())
        direction = parent.style.get("flex-direction", "").strip().lower() or "row"

        if display in {"flex", "inline-flex"}:
            if direction == "column":
                current_y = parent.abs_y + parent_padding_top
                for sibling in siblings:
                    sibling_h = sibling.h or approx_text_bbox(sibling)["h"]
                    current_y = max(current_y, sibling.abs_y + sibling_h + gap)
                node.abs_x = parent.abs_x + parent_padding_left
                node.abs_y = current_y
            else:
                current_x = parent.abs_x + parent_padding_left
                for sibling in siblings:
                    sibling_w = sibling.w or approx_text_bbox(sibling)["w"]
                    current_x = max(current_x, sibling.abs_x + sibling_w + gap)
                node.abs_x = current_x
                node.abs_y = parent.abs_y + parent_padding_top
        else:
            current_y = parent.abs_y + parent_padding_top
            for sibling in siblings:
                sibling_h = sibling.h or approx_text_bbox(sibling)["h"]
                current_y = max(current_y, sibling.abs_y + sibling_h)
            node.abs_x = parent.abs_x + parent_padding_left
            node.abs_y = current_y


def approx_text_bbox(node: Node) -> dict[str, float]:
    font = px(node.style.get("font-size")) or 14.0
    line_height = px(node.style.get("line-height")) or max(font * 1.4, 18.0)
    width = node.w or max(len(node.text) * font * 0.68, 24.0)
    height = node.h or line_height
    return {
        "x": round(node.abs_x, 2),
        "y": round(node.abs_y, 2),
        "w": round(width, 2),
        "h": round(height, 2),
    }


def node_descendant_tags(node: Node, nodes: list[Node]) -> list[str]:
    tags: list[str] = []
    stack = list(node.children)
    while stack:
        child_idx = stack.pop()
        child = nodes[child_idx]
        tags.append(child.tag)
        stack.extend(child.children)
    return tags


def nearest_explicit_layout(node: Node, nodes: list[Node]) -> dict[str, str]:
    current: Node | None = node
    while current is not None:
        display = re.sub(r"\s+", "", current.style.get("display", "").lower())
        if display in {"flex", "inline-flex", "grid", "inline-grid"}:
            direction = current.style.get("flex-direction", "").strip().lower()
            if "flex" in display and not direction:
                direction = "row"
            return {
                "display": display,
                "direction": direction,
                "nodeId": current.node_id,
                "className": current.class_name,
            }
        current = nodes[current.parent] if current.parent is not None else None
    return {}


def item_center(item: dict[str, Any]) -> tuple[float, float]:
    box = item["bbox"]
    return box["x"] + box["w"] / 2, box["y"] + box["h"] / 2


def extract_text_items(nodes: list[Node]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for node in nodes:
        text = node.text
        if not text:
            continue
        box = approx_text_bbox(node)
        layout_ancestor = nearest_explicit_layout(node, nodes)
        items.append({
            "text": text,
            "nodeId": node.node_id,
            "tag": node.tag,
            "bbox": box,
            "fontSize": px(node.style.get("font-size")),
            "color": node.style.get("color", ""),
            "cursor": node.style.get("cursor", "").strip().lower(),
            "sequence": node.idx,
            "depth": node.depth,
            "nodeDisplay": node.style.get("display", "").strip().lower(),
            "nodeFlexDirection": node.style.get("flex-direction", "").strip().lower(),
            "nearestLayoutDisplay": layout_ancestor.get("display", ""),
            "nearestLayoutDirection": layout_ancestor.get("direction", ""),
            "nearestLayoutNodeId": layout_ancestor.get("nodeId", ""),
        })
    return sorted(items, key=lambda it: (it["bbox"]["y"], it["bbox"]["x"], it["text"]))


def infer_kind(text: str) -> str:
    if text.startswith("请输入") or text.startswith("请选择"):
        return "placeholder"
    if text.startswith("*"):
        return "required-label"
    if re.fullmatch(r"企业客户\d+", text):
        return "chip"
    if text in CONTROL_WORDS or text.endswith("规则") and len(text) <= 8:
        return "action"
    if text in SECTION_WORDS:
        return "section-title"
    if re.fullmatch(r"\d+\.", text) or re.fullmatch(r"[一二三四五六七八九十]、", text):
        return "index"
    if re.search(r"\d+\s*分$", text):
        return "score"
    if text in KNOWN_FIELD_WORDS:
        return "field-label"
    if text.endswith(("列表", "信息", "详情", "记录", "结果")) and len(text) >= 5:
        return "section-title"
    if is_percent_text(text):
        return "value"
    if re.fullmatch(r"[\d,]+(?:\.\d+)?", text):
        return "value"
    if re.fullmatch(r"[\d,]+(?:\.\d+)?(?:pct|PCT)", text):
        return "value"
    if re.fullmatch(r"[人次年月日周天%％]+", text):
        return "unit"
    if len(text) <= 12 and not text.startswith("请输入"):
        return "label"
    return "copy"


def box_has_container_style(box: dict[str, Any]) -> bool:
    return bool(
        str(box.get("background", "") or "").strip()
        or str(box.get("border", "") or "").strip()
        or str(box.get("borderRadius", "") or "").strip()
    )


def is_control_container_box(box: dict[str, Any]) -> bool:
    kind = str(box.get("kind", ""))
    bbox = box.get("bbox") or {}
    w = float(bbox.get("w", 0) or 0)
    h = float(bbox.get("h", 0) or 0)
    if kind in {"icon-fragment", "divider", "chart-surface"}:
        return False
    if w < 56 or h < 24 or w > 520 or h > 120:
        return False
    if kind == "control":
        return True
    return kind == "box" and box_has_container_style(box)


def is_suffix_toggle_text(item: dict[str, Any], control_bbox: dict[str, Any]) -> bool:
    text = clean_text(str(item.get("text", "")))
    if text not in {">", "v", "V", "∨", "⌄", "▾", "▼", "﹀"}:
        return False
    item_bbox = item.get("bbox") or {}
    cx = item_bbox.get("x", 0) + item_bbox.get("w", 0) / 2
    cy = item_bbox.get("y", 0) + item_bbox.get("h", 0) / 2
    control_cy = control_bbox.get("y", 0) + control_bbox.get("h", 0) / 2
    return (
        cx >= control_bbox.get("x", 0) + control_bbox.get("w", 0) * 0.72
        and abs(cy - control_cy) <= max(12.0, control_bbox.get("h", 0) * 0.36)
    )


def control_box_local_items(
    control_bbox: dict[str, Any],
    items: list[dict[str, Any]],
    label_item: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    local: list[dict[str, Any]] = []
    for item in items:
        if label_item is not None and item is label_item:
            continue
        if center_inside(item.get("bbox", {}), control_bbox, 8):
            local.append(item)
    return local


def has_select_suffix_icon(control_bbox: dict[str, Any], visual_boxes: list[dict[str, Any]]) -> bool:
    control_cy = control_bbox.get("y", 0) + control_bbox.get("h", 0) / 2
    for box in visual_boxes:
        bbox = box.get("bbox") or {}
        if not bbox:
            continue
        if not contains_bbox(control_bbox, bbox, pad=8):
            continue
        w = float(bbox.get("w", 0) or 0)
        h = float(bbox.get("h", 0) or 0)
        cx = bbox.get("x", 0) + w / 2
        cy = bbox.get("y", 0) + h / 2
        if cx < control_bbox.get("x", 0) + control_bbox.get("w", 0) * 0.72:
            continue
        if abs(cy - control_cy) > max(12.0, control_bbox.get("h", 0) * 0.36):
            continue
        if box.get("kind") == "icon-fragment" or (w <= 18 and h <= 18):
            return True
    return False


def chip_container_for_item(
    item: dict[str, Any],
    control_bbox: dict[str, Any],
    visual_boxes: list[dict[str, Any]],
) -> dict[str, Any] | None:
    item_bbox = item.get("bbox") or {}
    for box in visual_boxes:
        bbox = box.get("bbox") or {}
        if not bbox:
            continue
        if not contains_bbox(control_bbox, bbox, pad=6):
            continue
        if not contains_bbox(bbox, item_bbox, pad=10):
            continue
        w = float(bbox.get("w", 0) or 0)
        h = float(bbox.get("h", 0) or 0)
        if 18 <= h <= 40 and 24 <= w <= 180 and box_has_container_style(box):
            return box
    return None


def detect_select_like_signals(
    label_item: dict[str, Any],
    control_bbox: dict[str, Any],
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    placeholder_text: str = "",
) -> dict[str, Any]:
    local_items = control_box_local_items(control_bbox, items, label_item)
    has_placeholder = bool(placeholder_text) or any(
        str(item.get("text", "")).startswith("请选择") for item in local_items
    )
    has_dropdown_arrow = has_select_suffix_icon(control_bbox, visual_boxes) or any(
        is_suffix_toggle_text(item, control_bbox) for item in local_items
    )
    chip_like_items: list[dict[str, Any]] = []
    for item in local_items:
        text = clean_text(str(item.get("text", "")))
        if not text or len(text) > 18:
            continue
        if text.startswith("请选择") or is_suffix_toggle_text(item, control_bbox):
            continue
        if infer_kind(text) in {"action", "section-title", "required-label", "placeholder", "score", "index"}:
            continue
        if chip_container_for_item(item, control_bbox, visual_boxes):
            chip_like_items.append(item)
    chip_rows = len({
        round((item.get("bbox", {}).get("y", 0) + item.get("bbox", {}).get("h", 0) / 2) / 14)
        for item in chip_like_items
    })
    chip_count = len(chip_like_items)
    multiple = chip_count >= 2 or (chip_count >= 1 and has_dropdown_arrow)
    select_like = has_placeholder or has_dropdown_arrow or multiple
    return {
        "selectLike": select_like,
        "multiple": multiple,
        "chipCount": chip_count,
        "chipRows": chip_rows,
        "hasDropdownArrow": has_dropdown_arrow,
        "hasPlaceholder": has_placeholder,
        "chipTexts": [item.get("text", "") for item in chip_like_items[:8]],
    }


def find_control_box_for_label(
    label: dict[str, Any],
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
) -> dict[str, Any]:
    label_bbox = label.get("bbox", {}) or {}
    lx = label_bbox.get("x", 0)
    ly = label_bbox.get("y", 0)
    label_cy = ly + label_bbox.get("h", 0) / 2
    candidates: list[tuple[float, dict[str, Any]]] = []
    for box in visual_boxes:
        if not is_control_container_box(box):
            continue
        bbox = box.get("bbox") or {}
        bx = bbox.get("x", 0)
        by = bbox.get("y", 0)
        bw = bbox.get("w", 0)
        bh = bbox.get("h", 0)
        if bw <= 0 or bh <= 0:
            continue
        box_cy = by + bh / 2
        same_row = abs(box_cy - label_cy) <= max(24.0, bh * 0.5) and bx + bw >= lx
        vertical_follow = abs(bx - lx) <= 140 and 0 <= by - (ly + label_bbox.get("h", 0)) <= 72
        if not same_row and not vertical_follow:
            continue
        if same_row and bx - lx > max(420.0, label_bbox.get("w", 0) + 260.0):
            continue
        blocked_by_same_row_label = any(
            other is not label
            and infer_kind(str(other.get("text", ""))) in {"required-label", "field-label", "label"}
            and abs((other.get("bbox", {}) or {}).get("y", 0) - ly) <= 12
            and lx + label_bbox.get("w", 0) <= (other.get("bbox", {}) or {}).get("x", 0) < bx
        for other in items)
        if blocked_by_same_row_label:
            continue
        local_count = len(control_box_local_items(bbox, items, label))
        score = 0.0
        if same_row:
            score += 5.0
        if vertical_follow:
            score += 3.0
        if bx >= lx - 24:
            score += 1.5
        if 1 <= local_count <= 8:
            score += 2.5
        if 24 <= bh <= 72:
            score += 1.5
        if box_has_container_style(box):
            score += 1.0
        score -= area(bbox) / 50000.0
        candidates.append((score, bbox))
    if not candidates:
        return {}
    best_score, best_bbox = max(candidates, key=lambda item: item[0])
    if best_score < 4.0:
        return {}
    return best_bbox


def infer_fields(items: list[dict[str, Any]], visual_boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    labels = [
        it for it in items
        if infer_kind(it["text"]) in {"required-label", "field-label", "label"}
        and not is_non_field_label(it)
    ]
    placeholders = [it for it in items if infer_kind(it["text"]) == "placeholder"]
    fields: list[dict[str, Any]] = []
    used: set[int] = set()
    for label in labels:
        label_text = label["text"].lstrip("*")
        if not label_text or len(label_text) > 20:
            continue
        if label_text in {":", "："}:
            continue
        if infer_kind(label_text) == "section-title":
            continue
        if any(word in label_text for word in ["渗透率", "指标"]) and not label["text"].startswith("*"):
            continue
        if label_text in {"搜索关键字", "选中标签"}:
            continue
        if re.fullmatch(r"[\u4e00-\u9fff]\*[\u4e00-\u9fff]", label_text):
            continue
        lx, ly = item_center(label)
        best_i = None
        best_score = math.inf
        for i, ph in enumerate(placeholders):
            if i in used:
                continue
            px_, py_ = item_center(ph)
            dx = abs(px_ - lx)
            dy = abs(py_ - ly)
            if dy > 42:
                continue
            same_band = dy <= 110 and dx <= 900
            placeholder_after_label = ph["bbox"]["x"] >= label["bbox"]["x"] - 20
            blocked_by_closer_label = any(
                other is not label
                and abs(other["bbox"]["x"] - label["bbox"]["x"]) <= 80
                and label["bbox"]["y"] < other["bbox"]["y"] < ph["bbox"]["y"]
                for other in labels
            )
            if blocked_by_closer_label:
                continue
            if same_band and placeholder_after_label:
                score = dy * 3 + dx
                if score < best_score:
                    best_i = i
                    best_score = score
        placeholder = placeholders[best_i] if best_i is not None else None
        if best_i is not None:
            used.add(best_i)
        control_box = placeholder["bbox"] if placeholder else find_control_box_for_label(label, items, visual_boxes)
        control_signals = detect_select_like_signals(
            label,
            control_box,
            items,
            visual_boxes,
            placeholder["text"] if placeholder else "",
        ) if control_box else {}
        if not label["text"].startswith("*") and placeholder is None and not control_box and label_text not in KNOWN_FIELD_WORDS:
            continue
        label_box = label["bbox"]
        fields.append({
            "label": label_text,
            "required": label["text"].startswith("*"),
            "placeholder": placeholder["text"] if placeholder else "",
            "labelNodeId": label["nodeId"],
            "placeholderNodeId": placeholder["nodeId"] if placeholder else "",
            "labelBbox": label_box,
            "controlBbox": control_box,
            "controlSignals": control_signals,
            "bbox": combined_bbox([label_box, control_box]) if control_box else label_box,
        })
    return fields


def section_contains_form_signals(section: dict[str, Any]) -> bool:
    texts = [str(text) for text in section.get("texts", [])]
    if not texts:
        return False
    joined = " ".join(texts)
    if any(word in joined for word in FORM_TRIGGER_WORDS):
        return True
    action_hits = sum(1 for text in texts if text in {"保存", "提交", "确认", "重置", "搜索", "上传", "导入"})
    placeholder_hits = sum(1 for text in texts if text.startswith("请输入") or text.startswith("请选择"))
    return action_hits + placeholder_hits >= 2


def field_has_control_evidence(field: dict[str, Any], sections: list[dict[str, Any]]) -> bool:
    placeholder = str(field.get("placeholder", "") or "")
    if placeholder:
        return True
    control_box = field.get("controlBbox") or {}
    label_text = str(field.get("label", "") or "")
    if infer_kind(label_text) in {"value", "unit"}:
        return False
    if control_box and area(control_box) >= 1200:
        local_texts = []
        if control_box:
            local_texts = [
                text for text in [
                    label_text,
                    str(field.get("placeholder", "") or ""),
                ]
                if text
            ]
        if any(text.startswith("请输入") or text.startswith("请选择") for text in local_texts):
            return True
        control_signals = field.get("controlSignals") or {}
        if control_signals.get("selectLike") or int(control_signals.get("chipCount", 0) or 0) >= 2:
            return True
        return False
    control_signals = field.get("controlSignals") or {}
    if control_signals.get("selectLike") or int(control_signals.get("chipCount", 0) or 0) >= 2:
        return True
    if any(word in label_text for word in ["日期", "时间", "选择", "上传", "附件", "电话", "邮箱", "手机号"]):
        return True
    if label_text in {"性别", "差异报告"} and not control_box:
        return False
    field_box = field.get("bbox", {}) or {}
    matched_section = False
    for section in sections:
        content_box = section.get("contentBbox") or section.get("containerBbox") or {}
        if not content_box:
            continue
        if not contains_bbox(content_box, field_box, pad=24):
            continue
        matched_section = True
        contract = section.get("renderContract") or {}
        if contract.get("mustRenderWholeSection") and not section_contains_form_signals(section):
            return False
        if description_like_layout(section) and not section_contains_form_signals(section):
            return False
        return True
    if not matched_section:
        return True
    return False


def field_inside_metric_card(field: dict[str, Any], visual_boxes: list[dict[str, Any]], items: list[dict[str, Any]]) -> bool:
    field_bbox = field.get("bbox", {}) or {}
    if not field_bbox:
        return False
    for box in visual_boxes:
        bbox = box.get("bbox") or {}
        if not bbox:
            continue
        if area(bbox) < 16000 or area(bbox) > 26000:
            continue
        if not contains_bbox(bbox, field_bbox, pad=6):
            continue
        local_items = [item for item in items if center_inside(item.get("bbox", {}), bbox, 8)]
        local_texts = [str(item.get("text", "")) for item in local_items]
        if looks_like_metric_card_region({"texts": local_texts}):
            return True
    return False


def is_non_field_label(item: dict[str, Any]) -> bool:
    text = item["text"].lstrip("*")
    kind = infer_kind(item["text"])
    y = item["bbox"]["y"]
    x = item["bbox"]["x"]
    if y < 120:
        return True
    if x < 200 and y < 220:
        return True
    if kind in {"section-title", "action", "index", "score", "chip"}:
        return True
    if kind in {"value", "unit"}:
        return True
    if text in DISPLAY_ONLY_LABEL_WORDS:
        return True
    if text in {">", "v", "V", "∨", "⌄", "▾", "▼", "﹀"}:
        return True
    if text in {":", "："}:
        return True
    if "/" in text and len(text) > 6:
        return True
    if re.fullmatch(r"\d+/\d+", text):
        return True
    if is_percent_text(text):
        return True
    if re.fullmatch(r"[\d,]+(?:\.\d+)?(?:pct|PCT)?", text):
        return True
    if re.fullmatch(r"[人次年月日周天%％]+", text):
        return True
    if text in {"男", "女", "逻辑能力", "总分:100/100"}:
        return True
    return False


def infer_regions(items: list[dict[str, Any]], canvas: dict[str, float]) -> list[dict[str, Any]]:
    width = canvas.get("width") or 0
    height = canvas.get("height") or 0
    regions: list[dict[str, Any]] = []

    def collect(name: str, pred) -> None:
        selected = [it for it in items if pred(it)]
        if not selected:
            return
        xs = [it["bbox"]["x"] for it in selected]
        ys = [it["bbox"]["y"] for it in selected]
        rs = [it["bbox"]["x"] + it["bbox"]["w"] for it in selected]
        bs = [it["bbox"]["y"] + it["bbox"]["h"] for it in selected]
        regions.append({
            "name": name,
            "bbox": {
                "x": round(min(xs), 2),
                "y": round(min(ys), 2),
                "w": round(max(rs) - min(xs), 2),
                "h": round(max(bs) - min(ys), 2),
            },
            "texts": [it["text"] for it in selected[:60]],
            "nodeIds": [it["nodeId"] for it in selected[:80] if it["nodeId"]],
        })

    collect("top-nav", lambda it: it["bbox"]["y"] <= 90)
    collect("left-nav", lambda it: it["bbox"]["x"] <= max(260, width * 0.16) and it["bbox"]["y"] > 90)
    collect("main-content", lambda it: it["bbox"]["x"] > max(220, width * 0.12) and 90 < it["bbox"]["y"] < max(height - 100, 0))
    collect("footer-actions", lambda it: it["bbox"]["y"] >= max(height - 140, 0) or it["text"] in {"重置", "取消", "确定", "保存", "提交"})
    return regions


def infer_regions_from_containers(
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    canvas: dict[str, float],
    is_fidelity_html: bool = False,
) -> list[dict[str, Any]]:
    width = float(canvas.get("width") or 0.0)
    height = float(canvas.get("height") or 0.0)
    if width <= 0 or height <= 0:
        return []

    container_boxes = []
    for box in visual_boxes:
        bbox = box.get("bbox") or {}
        if not bbox:
            continue
        if is_fidelity_html:
            canvas_area = max(width * height, 1.0)
            box_area = area(bbox)
            if box_area / canvas_area >= 0.78:
                continue
        if area(bbox) < max(40000, width * height * 0.015):
            continue
        if box.get("kind") not in {"panel", "box", "control", "header"} and not box_has_container_style(box):
            continue
        container_boxes.append(box)

    if not container_boxes:
        return []

    container_boxes.sort(key=lambda box: area(box.get("bbox", {})), reverse=True)
    selected: list[dict[str, Any]] = []
    for box in container_boxes:
        bbox = box.get("bbox") or {}
        if any(
            overlap_ratio(bbox, kept.get("bbox", {})) >= 0.86
            or overlap_ratio(kept.get("bbox", {}), bbox) >= 0.86
            for kept in selected
        ):
            continue
        selected.append(box)
        if len(selected) >= 12:
            break

    regions: list[dict[str, Any]] = []
    footer_action_terms = {"重置", "取消", "确定", "保存", "提交", "查询"}
    for box in selected:
        bbox = box.get("bbox") or {}
        local_items = [item for item in items if center_inside(item.get("bbox", {}), bbox, 12)]
        texts = [str(item.get("text", "")) for item in local_items if str(item.get("text", "")).strip()]
        if not texts:
            continue
        label = "main-content"
        x = float(bbox.get("x", 0) or 0)
        y = float(bbox.get("y", 0) or 0)
        w = float(bbox.get("w", 0) or 0)
        h = float(bbox.get("h", 0) or 0)
        if y <= max(96.0, height * 0.08) and w >= width * 0.55:
            label = "top-nav"
        elif x <= max(260.0, width * 0.16) and y > max(72.0, height * 0.05) and h >= height * 0.18:
            label = "left-nav"
        elif y + h >= height - max(120.0, height * 0.08) or any(text in footer_action_terms for text in texts):
            label = "footer-actions"
        elif x > max(220.0, width * 0.12):
            label = "main-content"
        owner = f"{label}@{int(x)},{int(y)}"
        regions.append({
            "name": owner,
            "regionKind": label,
            "bbox": bbox,
            "texts": texts[:60],
            "nodeIds": [item.get("nodeId", "") for item in local_items[:80] if item.get("nodeId")],
        })

    if is_fidelity_html:
        return sorted(regions, key=lambda region: (region.get("bbox", {}).get("y", 0), region.get("bbox", {}).get("x", 0)))

    collapsed: list[dict[str, Any]] = []
    for kind in ("top-nav", "left-nav", "main-content", "footer-actions"):
        kind_regions = [region for region in regions if region.get("regionKind") == kind]
        if not kind_regions:
            continue
        combined = combined_bbox([region.get("bbox", {}) for region in kind_regions])
        texts: list[str] = []
        node_ids: list[str] = []
        for region in kind_regions:
            for text in region.get("texts", []):
                if text not in texts:
                    texts.append(text)
            for node_id in region.get("nodeIds", []):
                if node_id and node_id not in node_ids:
                    node_ids.append(node_id)
        collapsed.append({
            "name": kind,
            "bbox": combined,
            "texts": texts[:60],
            "nodeIds": node_ids[:80],
        })
    return collapsed


def looks_like_fidelity_html(html: str, nodes: list[Node], visual_boxes: list[dict[str, Any]]) -> bool:
    low = html.lower()
    absolute_nodes = sum(1 for node in nodes if node.style.get("position", "").replace(" ", "") == "absolute")
    bracket_signal = any(
        token in low
        for token in ["left-[", "top-[", "w-[", "h-[", "clip-path", "data:image/svg+xml", "shadow-["]
    )
    dense_visual_boxes = sum(1 for box in visual_boxes if area(box.get("bbox", {})) >= 1600)
    return (
        "position: absolute" in low
        or bracket_signal
        or absolute_nodes / max(len(nodes), 1) > 0.35
        or dense_visual_boxes >= 12
    )


def detect_page_archetypes(
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    chart_candidates: list[dict[str, Any]],
    progress_candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    texts = [str(item.get("text", "")) for item in items]
    joined = " ".join(texts)
    archetypes: list[dict[str, Any]] = []

    if len(chart_candidates) >= 3 and any("漏斗" in text for text in texts):
        archetypes.append({
            "name": "funnel-metric-dashboard",
            "confidence": "high",
            "evidence": ["multiple-chart-candidates", "contains-funnel-label"],
        })

    if len(progress_candidates) >= 2 and len(chart_candidates) >= 1 and any("分组" in text for text in texts):
        archetypes.append({
            "name": "comparison-grid-with-inline-trends",
            "confidence": "high",
            "evidence": ["multiple-progress-candidates", "chart-cluster", "contains-group-label"],
        })

    if any(term in joined for term in ["报错", "会话", "MCP工具", "查看报错详情"]) and any(term in joined for term in ["共 200 条记录", "跳至", "条/页"]):
        archetypes.append({
            "name": "list-table-with-kpis",
            "confidence": "high",
            "evidence": ["error-session-terms", "pagination-terms"],
        })

    if any(term in joined for term in ["任务详情", "节点记录", "上传文件成功", "受益所有人", "处理信息"]):
        archetypes.append({
            "name": "workflow-detail-with-compare-panels",
            "confidence": "high",
            "evidence": ["detail-title", "timeline-terms", "upload-terms", "compare-detail-terms"],
        })

    return archetypes


def estimate_analysis_confidence(
    items: list[dict[str, Any]],
    regions: list[dict[str, Any]],
    chart_candidates: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    is_fidelity_html: bool,
) -> dict[str, Any]:
    issues: list[str] = []
    text_count = len(items)
    region_count = len(regions)
    large_boxes = sum(1 for box in visual_boxes if area(box.get("bbox", {})) >= 12000)
    has_pagination_terms = any(term in str(item.get("text", "")) for item in items for term in ["条/页", "跳至", "分页", "上一页", "下一页"])
    has_chart_terms = any(term in str(item.get("text", "")) for item in items for term in ["趋势", "漏斗", "占比", "图表", "渗透率", "使用情况", "价值情况"])
    if is_fidelity_html and region_count <= 1:
        issues.append("too-few-regions-for-fidelity-html")
    if is_fidelity_html and large_boxes >= 6 and region_count <= 2:
        issues.append("large-visual-boxes-not-partitioned")
    if has_chart_terms and not chart_candidates:
        issues.append("chart-terms-without-chart-candidates")
    if has_pagination_terms and text_count >= 80 and region_count <= 2:
        issues.append("list-signals-but-structure-not-recovered")
    level = "high"
    if issues:
        level = "low" if len(issues) >= 2 else "medium"
    return {"level": level, "issues": issues}


def detect_expected_blocks(
    items: list[dict[str, Any]],
    page_archetypes: list[dict[str, Any]],
    sections: list[dict[str, Any]],
) -> dict[str, Any]:
    texts = [str(item.get("text", "")) for item in items]
    section_titles = {str(section.get("title", "")) for section in sections}
    section_owner_paths = {str(section.get("ownerPath", "")) for section in sections}
    archetype_names = {str(item.get("name", "")) for item in page_archetypes}

    expected: list[dict[str, Any]] = []
    if "workflow-detail-with-compare-panels" in archetype_names:
        expected = [
            {"name": "基本信息", "keywords": ["基本信息", "备案主体名称", "客户号码"]},
            {"name": "受益所有人信息", "keywords": ["受益所有人信息", "差异明细类型", "行内受益人姓名"]},
            {"name": "我行受益所有人留存信息", "keywords": ["我行受益所有人留存信息", "所有权信息"]},
            {"name": "人行受益所有人查询结果", "keywords": ["人行受益所有人查询结果", "所有权信息"]},
            {"name": "任务处理信息", "keywords": ["任务处理信息", "处理基本信息", "分析结论"]},
            {"name": "差异报告", "keywords": ["差异报告", "报告编号", "报告审核结果"]},
            {"name": "节点记录", "keywords": ["节点记录", "审批通过", "报告被退回"]},
        ]

    result: list[dict[str, Any]] = []
    for block in expected:
        keywords = block["keywords"]
        present_in_source = any(keyword in text for text in texts for keyword in keywords)
        matched_section = any(
            keyword == title or keyword in title or keyword in owner
            for keyword in keywords
            for title in section_titles
            for owner in section_owner_paths
        )
        if not matched_section and block["name"] in {"我行受益所有人留存信息", "人行受益所有人查询结果"}:
            matched_section = any(
                keyword in text
                for text in texts
                for keyword in block["keywords"]
            )
        result.append({
            "name": block["name"],
            "presentInSource": present_in_source,
            "matchedSection": matched_section,
            "keywords": keywords,
        })
    missing = [
        item["name"]
        for item in result
        if item.get("presentInSource") and not item.get("matchedSection")
    ]
    return {"items": result, "missing": missing}


def infer_componentization_mode(
    *,
    is_fidelity_html: bool,
    analysis_confidence: dict[str, Any],
    page_archetypes: list[dict[str, Any]],
    table_structures: list[dict[str, Any]],
    chart_candidates: list[dict[str, Any]],
    progress_candidates: list[dict[str, Any]],
    sections: list[dict[str, Any]],
) -> dict[str, Any]:
    reasons: list[str] = []
    level = str(analysis_confidence.get("level", "") or "")
    if level and level != "high":
        reasons.append(f"analysis-confidence-{level}")

    archetype_names = {str(item.get("name", "")) for item in page_archetypes}
    if archetype_names & {
        "workflow-detail-with-compare-panels",
        "funnel-metric-dashboard",
        "comparison-grid-with-inline-trends",
        "list-table-with-kpis",
    }:
        reasons.append("complex-page-archetype")

    if is_fidelity_html and table_structures and len(sections) >= 2:
        reasons.append("fidelity-table-page")
    if is_fidelity_html and chart_candidates:
        reasons.append("fidelity-chart-page")
    if is_fidelity_html and len(progress_candidates) >= 2 and len(chart_candidates) >= 1:
        reasons.append("dense-metric-or-trend-region")

    mode = "conservative" if reasons else "balanced"
    return {
        "mode": mode,
        "reasons": unique_preserve_order(reasons),
        "readPolicy": (
            "Read original HTML first to lock macro layout and section ownership. "
            "Use checklist/manifest only for whole-section preservation, omission checks, and targeted spot checks."
            if mode == "conservative"
            else "Use original HTML as the visual source of truth; use checklist/manifest as a compact accelerator."
        ),
        "slotPolicy": (
            "Do not let replacementSlots drive large-block componentization. "
            "Freeze table/chart/section/form/filter/tabs/page-pattern slots until macro layout is already stable."
            if mode == "conservative"
            else "Replacement slots may be used as positive componentization candidates after verifying they do not break the visual contract."
        ),
    }


def contains_bbox(outer: dict[str, float], inner: dict[str, float], pad: float = 0.0) -> bool:
    return (
        inner["x"] >= outer["x"] - pad
        and inner["y"] >= outer["y"] - pad
        and inner["x"] + inner["w"] <= outer["x"] + outer["w"] + pad
        and inner["y"] + inner["h"] <= outer["y"] + outer["h"] + pad
    )


def has_value_below(item: dict[str, Any], items: list[dict[str, Any]]) -> bool:
    x0 = item["bbox"]["x"]
    y0 = item["bbox"]["y"]
    for other in items:
        if other is item:
            continue
        if abs(other["bbox"]["x"] - x0) <= 36 and 20 <= other["bbox"]["y"] - y0 <= 36:
            if other["text"] != item["text"]:
                return True
    return False


def has_heading_marker(item: dict[str, Any], visual_boxes: list[dict[str, Any]]) -> bool:
    x0 = item["bbox"]["x"]
    y0 = item["bbox"]["y"]
    for box in visual_boxes:
        bbox = box["bbox"]
        bg = str(box.get("background", "")).lower()
        near_y = abs(bbox["y"] - y0) <= 16 or abs((bbox["y"] + bbox["h"] / 2) - (y0 + item["bbox"]["h"] / 2)) <= 16
        if not near_y:
            continue
        if box["kind"] == "divider" and (
            "#1774ff" in bg
            or bbox["w"] <= 8
            or bbox["h"] <= 8
        ):
            if bbox["x"] <= x0 + 16 and bbox["x"] + bbox["w"] >= x0 - 24:
                return True
        if box["kind"] == "box" and bbox["w"] >= 320 and 28 <= bbox["h"] <= 64:
            if contains_bbox(bbox, item["bbox"], pad=24):
                return True
    return False


def count_dense_content_below(
    item: dict[str, Any],
    items: list[dict[str, Any]],
    container_bbox: dict[str, float],
) -> int:
    y0 = item["bbox"]["y"]
    count = 0
    for other in items:
        if other is item:
            continue
        if not contains_bbox(container_bbox, other["bbox"], pad=4):
            continue
        if y0 + 10 <= other["bbox"]["y"] <= y0 + 220:
            count += 1
    return count


def count_same_row_items(
    item: dict[str, Any],
    items: list[dict[str, Any]],
    container_bbox: dict[str, float],
) -> int:
    y0 = item["bbox"]["y"]
    count = 0
    for other in items:
        if not contains_bbox(container_bbox, other["bbox"], pad=4):
            continue
        if abs(other["bbox"]["y"] - y0) <= 8:
            count += 1
    return count


def is_tab_or_chip_label(item: dict[str, Any], visual_boxes: list[dict[str, Any]]) -> bool:
    font = float(item.get("fontSize") or 0.0)
    if font > 12.5:
        return False
    for box in visual_boxes:
        bbox = box["bbox"]
        if not contains_bbox(bbox, item["bbox"], pad=12):
            continue
        if 24 <= bbox["h"] <= 40 and 40 <= bbox["w"] <= 120:
            return True
    return False


def is_table_like_header(
    item: dict[str, Any],
    items: list[dict[str, Any]],
    container_bbox: dict[str, float],
) -> bool:
    row_items = [
        other for other in items
        if contains_bbox(container_bbox, other["bbox"], pad=4)
        and abs(other["bbox"]["y"] - item["bbox"]["y"]) <= 8
    ]
    distinct_x = sorted({round(other["bbox"]["x"] / 24) for other in row_items})
    return len(row_items) >= 3 and len(distinct_x) >= 3


def find_section_container(
    item: dict[str, Any],
    visual_boxes: list[dict[str, Any]],
    canvas: dict[str, float],
) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    for box in visual_boxes:
        bbox = box["bbox"]
        area = bbox["w"] * bbox["h"]
        if box["kind"] not in {"panel", "box", "header"}:
            continue
        if bbox["w"] < 260 or bbox["h"] < 120:
            continue
        if contains_bbox(bbox, item["bbox"], pad=6):
            candidates.append(box)
    if candidates:
        return min(candidates, key=lambda box: box["bbox"]["w"] * box["bbox"]["h"])
    return {
        "kind": "canvas",
        "bbox": {
            "x": 0.0,
            "y": 0.0,
            "w": float(canvas.get("width") or 0.0),
            "h": float(canvas.get("height") or 0.0),
        },
    }


def looks_like_heading(
    item: dict[str, Any],
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    canvas: dict[str, float],
) -> bool:
    text = item["text"]
    if not text or len(text) > 36:
        return False
    if item["bbox"]["y"] < 120:
        return False
    if (item.get("fontSize") or 0) < 13.5:
        return False
    if infer_kind(text) in {"placeholder", "action", "chip", "index", "score", "required-label"}:
        return False
    if text in KNOWN_FIELD_WORDS:
        return False
    if any(keyword in text for keyword in ["指标", "渗透率", "趋势", "分析"]):
        return True
    if item["bbox"]["x"] < 220 and text not in COMMON_SECTION_TITLES and text != "任务详情":
        return False
    if "/" in text and len(text) > 10:
        return False
    if "：" in text or ":" in text:
        if text not in COMMON_SECTION_TITLES:
            return False
    if any(re.search(pattern, text, re.IGNORECASE) for pattern in NON_HEADING_PATTERNS):
        return False
    if re.fullmatch(r"[\d\-\s:～*]+", text):
        return False
    if has_value_below(item, items):
        return False
    container = find_section_container(item, visual_boxes, canvas)
    if is_tab_or_chip_label(item, visual_boxes):
        return False
    if is_table_like_header(item, items, container["bbox"]):
        return False
    score = 0
    if text in COMMON_SECTION_TITLES:
        score += 5
    if infer_kind(text) == "section-title":
        score += 4
    if any(word in text for word in SECTION_HINT_WORDS):
        score += 2
    if has_heading_marker(item, visual_boxes):
        score += 2
    if count_dense_content_below(item, items, container["bbox"]) >= 6:
        score += 2
    if count_same_row_items(item, items, container["bbox"]) >= 3 and text not in COMMON_SECTION_TITLES:
        score -= 2
    color = str(item.get("color", "")).lower()
    if "#1774ff" in color and text not in COMMON_SECTION_TITLES and not has_heading_marker(item, visual_boxes):
        return False
    return score >= 4


def section_column_tolerance(container_bbox: dict[str, float]) -> float:
    return max(180.0, container_bbox["w"] * 0.3)

def infer_layout_hint(section_items: list[dict[str, Any]], title: str) -> str:
    pair_count = 0
    same_row_count = 0
    unique_x_bands: set[int] = set()
    has_search_keyword = any("搜索关键字" in str(item.get("text", "")) for item in section_items)
    short_tag_count = sum(
        1 for item in section_items
        if len(str(item.get("text", ""))) <= 8 and (item.get("fontSize") or 0) <= 12.5
    )
    explicit_column = sum(
        1 for item in section_items
        if str(item.get("nearestLayoutDisplay", "")).lower() in {"flex", "inline-flex"}
        and str(item.get("nearestLayoutDirection", "")).lower() in {"column", "column-reverse"}
    )
    if explicit_column >= 2:
        return "descriptions-vertical"
    for item in section_items:
        x0 = item["bbox"]["x"]
        y0 = item["bbox"]["y"]
        row_hits = 0
        for other in section_items:
            if other is item:
                continue
            if abs(other["bbox"]["x"] - x0) <= 36 and 20 <= other["bbox"]["y"] - y0 <= 36:
                pair_count += 1
                unique_x_bands.add(round(x0 / 40))
                break
            if abs(other["bbox"]["y"] - y0) <= 8:
                row_hits += 1
        if row_hits >= 3:
            same_row_count += 1
    if pair_count >= 4 and title in {"基本信息", "所有权信息", "处理基本信息"}:
        return "descriptions-vertical"
    if has_search_keyword or short_tag_count >= 4:
        if pair_count >= 6:
            return "field-block-grid"
    if pair_count >= 6 and len(unique_x_bands) >= 3 and same_row_count >= 4:
        return "descriptions-vertical"
    if pair_count >= 6:
        return "field-block-grid"
    return ""


def description_like_layout(section: dict[str, Any]) -> bool:
    if section.get("layoutHint") in {"descriptions-vertical", "field-block-grid"}:
        return True
    texts = [str(text) for text in section.get("texts", [])]
    if not texts:
        return False
    field_like_count = sum(
        1 for text in texts
        if infer_kind(text) in {"field-label", "required-label", "label"} and len(text.lstrip("*")) <= 24
    )
    detail_word_count = sum(
        1 for text in texts
        if any(word in text for word in ["描述", "说明", "内容", "简介", "介绍", "备注", "详情"])
    )
    return field_like_count >= 6 and field_like_count >= max(4, len(texts) * 0.28) and detail_word_count >= 1


def section_has_real_table_evidence(section: dict[str, Any]) -> bool:
    if description_like_layout(section):
        return False
    texts = [str(text) for text in section.get("texts", [])]
    joined = " ".join(texts).lower()
    hard_signals = ["table", "表头", "分页", "条/页", "上一页", "下一页", "共 "]
    if any(signal in joined for signal in hard_signals):
        return True
    row_words = {"序号", "操作", "状态", "创建时间", "更新时间"}
    row_word_hits = sum(1 for text in texts if text in row_words)
    repeated_short_labels = len([text for text in texts if 1 <= len(text) <= 10]) >= 8
    return row_word_hits >= 3 and repeated_short_labels


def unique_preserve_order(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def extract_subsection_titles(
    selected_items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    title_item: dict[str, Any],
    container_bbox: dict[str, float],
) -> list[str]:
    titles: list[str] = []
    for item in selected_items:
        text = item["text"]
        if item is title_item:
            continue
        if item["bbox"]["y"] <= title_item["bbox"]["y"] + 24:
            continue
        if not text or len(text) > 28:
            continue
        if (item.get("fontSize") or 0) < 13.5:
            continue
        if text in LIKELY_NOISE_TEXTS:
            continue
        if infer_kind(text) in {"placeholder", "action", "chip", "index", "score", "required-label"}:
            continue
        if has_value_below(item, selected_items):
            continue
        if text in COMMON_SECTION_TITLES or has_heading_marker(item, visual_boxes):
            if count_dense_content_below(item, selected_items, container_bbox) >= 3:
                titles.append(text)
    return unique_preserve_order(titles)


def extract_tag_strip_texts(
    selected_items: list[dict[str, Any]],
    title_item: dict[str, Any],
    visual_boxes: list[dict[str, Any]] | None = None,
) -> list[str]:
    tags: list[str] = []
    for item in selected_items:
        text = item["text"]
        if item["bbox"]["y"] <= title_item["bbox"]["y"] + 18 or item["bbox"]["y"] >= title_item["bbox"]["y"] + 120:
            continue
        if (item.get("fontSize") or 0) > 14.5:
            continue
        if not text or len(text) > 20:
            continue
        kind = infer_kind(text)
        tab_like = bool(visual_boxes) and is_tab_or_chip_label(item, visual_boxes or [])
        if kind in {"placeholder", "index", "score"}:
            continue
        if kind == "action" and text not in {"查看", "全部", "更多", "对比"} and not tab_like:
            continue
        if not tab_like and text not in {"查看", "选中标签", "全部", "更多", "对比"}:
            continue
        tags.append(text)
    return unique_preserve_order(tags)


def infer_render_contract(
    title: str,
    layout_hint: str,
    selected_items: list[dict[str, Any]],
    title_item: dict[str, Any],
    container_bbox: dict[str, float],
    subsection_titles: list[str],
    tag_strip_texts: list[str],
) -> dict[str, Any]:
    visible_texts = unique_preserve_order([item["text"] for item in selected_items if item["text"]])
    has_search = "搜索关键字" in visible_texts
    kind = "section"
    must_render_whole = False
    if container_bbox["w"] >= 520 and len(visible_texts) >= 18:
        if len(tag_strip_texts) >= 2:
            kind = "detail-panel-with-tab-strip"
            must_render_whole = True
        elif subsection_titles:
            kind = "detail-panel-with-subsections"
            must_render_whole = True
        elif title.endswith(("信息", "结果", "记录", "详情", "列表")):
            kind = "detail-panel"
            must_render_whole = True
    if layout_hint == "descriptions-vertical":
        kind = "detail-summary"
        must_render_whole = True
    return {
        "kind": kind,
        "mustRenderWholeSection": must_render_whole,
        "mustRenderTitle": True,
        "hasSearchBar": has_search,
        "tagStripTexts": tag_strip_texts,
        "subsectionTitles": subsection_titles,
        "layoutHint": layout_hint,
        "contentMode": "panel-whole" if must_render_whole else "section-fragment",
        "failureIfMissing": [
            "section-title-missing",
            "subsection-missing" if subsection_titles else "",
            "panel-content-missing" if must_render_whole else "",
        ],
    }


def infer_sections(
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    canvas: dict[str, float],
) -> list[dict[str, Any]]:
    heading_candidates = [it for it in items if looks_like_heading(it, items, visual_boxes, canvas)]
    headings: list[dict[str, Any]] = []
    for heading in heading_candidates:
        container = find_section_container(heading, visual_boxes, canvas)
        headings.append({
            "item": heading,
            "text": heading["text"],
            "bbox": heading["bbox"],
            "containerBbox": container["bbox"],
            "containerKind": container["kind"],
            "containerArea": container["bbox"]["w"] * container["bbox"]["h"],
        })

    sections: list[dict[str, Any]] = []
    sorted_items = sorted(items, key=lambda it: (it["bbox"]["y"], it["bbox"]["x"]))
    heading_order = sorted(heading_candidates, key=lambda it: int(it.get("sequence", 0)))

    def slice_by_sequence(title_item: dict[str, Any]) -> list[dict[str, Any]]:
        seq = int(title_item.get("sequence", 0))
        later_titles = [
            int(other.get("sequence", 0))
            for other in heading_order
            if int(other.get("sequence", 0)) > seq
        ]
        next_seq = min(later_titles) if later_titles else 10**9
        selected_seq = [
            it for it in sorted(items, key=lambda candidate: int(candidate.get("sequence", 0)))
            if seq <= int(it.get("sequence", 0)) < next_seq
        ]
        return selected_seq[:220]

    for heading in headings:
        item = heading["item"]
        container_bbox = heading["containerBbox"]
        tol = section_column_tolerance(container_bbox)
        y0 = item["bbox"]["y"]
        lower_headings = [
            other for other in headings
            if other is not heading
            and other["bbox"]["y"] > y0 + 6
            and contains_bbox(container_bbox, other["bbox"], pad=8)
            and abs(other["bbox"]["x"] - item["bbox"]["x"]) <= tol
        ]
        y1 = min((other["bbox"]["y"] for other in lower_headings), default=container_bbox["y"] + container_bbox["h"] + 1)
        selected_geo = [
            it for it in sorted_items
            if contains_bbox(container_bbox, it["bbox"], pad=8)
            and y0 <= it["bbox"]["y"] < y1
        ][:160]
        selected_seq = slice_by_sequence(item)
        prefer_sequence = False
        if len(selected_geo) < 6 and len(selected_seq) >= 6:
            prefer_sequence = True
        elif len(selected_geo) >= 1 and len(selected_seq) >= len(selected_geo) * 1.6:
            prefer_sequence = True
        elif item["text"] in {"任务处理信息", "处理基本信息", "分析结论", "差异报告", "受益所有人信息"} and len(selected_seq) >= 6:
            prefer_sequence = True
        selected = selected_seq if prefer_sequence else selected_geo
        layout_hint = infer_layout_hint(selected, item["text"])
        content_bbox = combined_bbox([it["bbox"] for it in selected])
        subsection_titles = extract_subsection_titles(selected, visual_boxes, item, container_bbox)
        tag_strip_texts = extract_tag_strip_texts(selected, item, visual_boxes)
        parent_heading = next(
            (
                other for other in sorted(
                    headings,
                    key=lambda candidate: candidate["bbox"]["y"],
                    reverse=True,
                )
                if other is not heading
                and other["bbox"]["y"] < y0 - 12
                and contains_bbox(other["containerBbox"], item["bbox"], pad=8)
                and other["containerArea"] >= heading["containerArea"]
                and abs(other["bbox"]["x"] - item["bbox"]["x"]) <= section_column_tolerance(other["containerBbox"])
            ),
            None,
        )
        owner_path = item["text"]
        if parent_heading and parent_heading["text"] != item["text"]:
            owner_path = f"{parent_heading['text']} / {item['text']}"
        sections.append({
            "title": item["text"],
            "ownerPath": owner_path,
            "nodeId": item["nodeId"],
            "sequenceStart": min((int(it.get("sequence", 0)) for it in selected), default=int(item.get("sequence", 0))),
            "sequenceEnd": max((int(it.get("sequence", 0)) for it in selected), default=int(item.get("sequence", 0))),
            "bbox": item["bbox"],
            "containerBbox": container_bbox,
            "contentBbox": content_bbox,
            "layoutHint": layout_hint,
            "subsectionTitles": subsection_titles,
            "tagStripTexts": tag_strip_texts,
            "renderContract": infer_render_contract(
                item["text"],
                layout_hint,
                selected,
                item,
                container_bbox,
                subsection_titles,
                tag_strip_texts,
            ),
            "texts": [it["text"] for it in selected],
        })
    if len(sections) >= 3:
        return sections

    fallback_titles = [
        "基本信息",
        "受益所有人信息",
        "核验结果",
        "我行受益所有人留存信息",
        "人行受益所有人查询结果",
        "任务处理信息",
        "处理基本信息",
        "分析结论",
        "差异报告",
        "节点记录",
    ]
    existing_titles = {section.get("title", "") for section in sections}
    sorted_items = sorted(items, key=lambda it: (it["bbox"]["y"], it["bbox"]["x"]))
    for title in fallback_titles:
        if title in existing_titles:
            continue
        title_matches = [it for it in sorted_items if it.get("text") == title]
        if not title_matches:
            continue
        if title in {"我行受益所有人留存信息", "人行受益所有人查询结果"}:
            match = max(title_matches, key=lambda it: it["bbox"]["x"])
        elif title in {"基本信息", "受益所有人信息", "核验结果", "任务处理信息", "处理基本信息", "分析结论", "差异报告"}:
            match = max(title_matches, key=lambda it: (it["bbox"]["y"], it["bbox"]["x"]))
        else:
            match = title_matches[0]
        container = find_section_container(match, visual_boxes, canvas)
        container_bbox = container["bbox"]
        y0 = match["bbox"]["y"]
        lower_y = min(
            (
                other["bbox"]["y"]
                for other in sorted_items
                if other is not match and other.get("text") in fallback_titles and other["bbox"]["y"] > y0 + 8
            ),
            default=container_bbox["y"] + container_bbox["h"] + 1,
        )
        selected_geo = [
            it for it in sorted_items
            if contains_bbox(container_bbox, it["bbox"], pad=8)
            and y0 <= it["bbox"]["y"] < lower_y
        ][:220]
        title_seq = int(match.get("sequence", 0))
        next_seq = min(
            (
                int(other.get("sequence", 0))
                for other in heading_order
                if int(other.get("sequence", 0)) > title_seq
            ),
            default=10**9,
        )
        selected_seq = [
            it for it in sorted(items, key=lambda candidate: int(candidate.get("sequence", 0)))
            if title_seq <= int(it.get("sequence", 0)) < next_seq
        ][:260]
        selected = selected_seq if len(selected_seq) >= max(6, len(selected_geo)) else selected_geo
        if len(selected) < 4:
            continue
        layout_hint = infer_layout_hint(selected, title)
        subsection_titles = extract_subsection_titles(selected, visual_boxes, match, container_bbox)
        tag_strip_texts = extract_tag_strip_texts(selected, match, visual_boxes)
        sections.append({
            "title": title,
            "ownerPath": title,
            "nodeId": match.get("nodeId", ""),
            "sequenceStart": min((int(it.get("sequence", 0)) for it in selected), default=title_seq),
            "sequenceEnd": max((int(it.get("sequence", 0)) for it in selected), default=title_seq),
            "bbox": match["bbox"],
            "containerBbox": container_bbox,
            "contentBbox": combined_bbox([it["bbox"] for it in selected]),
            "layoutHint": layout_hint,
            "subsectionTitles": subsection_titles,
            "tagStripTexts": tag_strip_texts,
            "renderContract": infer_render_contract(
                title,
                layout_hint,
                selected,
                match,
                container_bbox,
                subsection_titles,
                tag_strip_texts,
            ),
            "texts": [it["text"] for it in selected],
        })
    return sections


def maybe_build_workflow_detail_sections(
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    canvas: dict[str, float],
) -> list[dict[str, Any]]:
    texts = [str(item.get("text", "")) for item in items]
    joined = " ".join(texts)
    if not any(term in joined for term in ["任务详情", "节点记录", "受益所有人", "处理信息"]):
        return []

    sequence_items = sorted(items, key=lambda it: int(it.get("sequence", 0)))
    index_by_id = {id(item): idx for idx, item in enumerate(sequence_items)}
    block_specs = [
        ("基本信息", ["备案主体名称", "客户号码", "统一社会信用代码", "差异发现时间"]),
        ("受益所有人信息", ["差异明细类型", "行内受益人姓名", "人行受益人姓名", "差异信息"]),
        ("我行受益所有人留存信息", ["我行受益所有人留存信息", "所有权信息", "受益人编码", "证件号码"]),
        ("人行受益所有人查询结果", ["人行受益所有人查询结果", "所有权信息", "受益人编码", "证件号码"]),
        ("任务处理信息", ["任务处理信息", "处理基本信息", "分析结论", "差异报告"]),
        ("处理基本信息", ["处理基本信息", "备案主体名称", "客户号码", "统一社会信用代码"]),
        ("分析结论", ["分析结论", "上传文件成功", "客户是否同意", "人行留存受益所有人信息有误"]),
        ("差异报告", ["差异报告", "报告编号", "报告审核结果"]),
        ("节点记录", ["节点记录", "审批通过", "审批驳回", "报告被退回"]),
    ]

    def pick_anchor(title: str, keywords: list[str]) -> dict[str, Any] | None:
        candidates = [item for item in sequence_items if item.get("text") == title]
        if not candidates:
            return None
        best = None
        best_score = -10**9
        for candidate in candidates:
            idx = index_by_id[id(candidate)]
            window = sequence_items[idx: min(len(sequence_items), idx + 80)]
            window_text = " ".join(str(item.get("text", "")) for item in window)
            score = 0
            for keyword in keywords:
                if keyword in window_text:
                    score += 80
            x = float(candidate.get("bbox", {}).get("x", 0) or 0)
            y = float(candidate.get("bbox", {}).get("y", 0) or 0)
            if title == "我行受益所有人留存信息":
                if x < 500:
                    score += 24
                else:
                    score -= 18
            elif title == "人行受益所有人查询结果":
                if x >= 500:
                    score += 24
                else:
                    score -= 18
            elif title in {"任务处理信息", "处理基本信息", "分析结论", "差异报告"}:
                if y >= 1500:
                    score += 40
                elif y >= 120:
                    score += 8
                else:
                    score -= 18
            elif title in {"基本信息", "核验结果", "受益所有人信息"}:
                if 220 <= y <= 760:
                    score += 24
                elif 100 <= y <= 900:
                    score += 10
            elif title == "节点记录":
                if x >= 1400:
                    score += 40
                else:
                    score -= 20
            score += int(candidate.get("sequence", 0)) * 0.01
            if score > best_score:
                best = candidate
                best_score = score
        return best

    anchor_map: dict[str, dict[str, Any]] = {}
    for title, keywords in block_specs:
        anchor = pick_anchor(title, keywords)
        if anchor is not None:
            anchor_map[title] = anchor
    if len(anchor_map) < 4:
        return []

    def expand_bbox(box: dict[str, Any], pad: float = 16.0) -> dict[str, float]:
        if not box:
            return {}
        return {
            "x": max(float(box.get("x", 0) or 0) - pad, 0.0),
            "y": max(float(box.get("y", 0) or 0) - pad, 0.0),
            "w": float(box.get("w", 0) or 0) + pad * 2,
            "h": float(box.get("h", 0) or 0) + pad * 2,
        }

    def build_section(
        title: str,
        selected: list[dict[str, Any]],
        *,
        layout_hint: str = "",
        subsection_titles: list[str] | None = None,
    ) -> dict[str, Any] | None:
        anchor = anchor_map.get(title)
        if anchor is None or len(selected) < 3:
            return None
        inferred_hint = layout_hint or infer_layout_hint(selected, title)
        content_bbox = combined_bbox([item["bbox"] for item in selected])
        container_bbox = expand_bbox(content_bbox, 18.0)
        subsection_titles = subsection_titles or []
        tag_strip_texts = extract_tag_strip_texts(selected, anchor, visual_boxes)
        return {
            "title": title,
            "ownerPath": title,
            "nodeId": anchor.get("nodeId", ""),
            "bbox": anchor.get("bbox", {}),
            "sequenceStart": min((int(it.get("sequence", 0)) for it in selected), default=int(anchor.get("sequence", 0))),
            "sequenceEnd": max((int(it.get("sequence", 0)) for it in selected), default=int(anchor.get("sequence", 0))),
            "containerBbox": container_bbox,
            "contentBbox": content_bbox,
            "layoutHint": inferred_hint,
            "subsectionTitles": subsection_titles,
            "tagStripTexts": tag_strip_texts,
            "renderContract": infer_render_contract(
                title,
                inferred_hint,
                selected,
                anchor,
                container_bbox,
                subsection_titles,
                tag_strip_texts,
            ),
            "texts": [item["text"] for item in selected],
        }

    def seq_of(title: str, default: int = 10**9) -> int:
        anchor = anchor_map.get(title)
        return int(anchor.get("sequence", default)) if anchor else default

    def slice_by_sequence_range(start_title: str, end_title: str | None = None) -> list[dict[str, Any]]:
        start_seq = seq_of(start_title, -1)
        if start_seq < 0:
            return []
        end_seq = seq_of(end_title) if end_title else 10**9
        return [
            item for item in sequence_items
            if start_seq <= int(item.get("sequence", 0)) < end_seq
        ]

    task_processing_seq = seq_of("任务处理信息")
    timeline_seq = seq_of("节点记录")
    compare_start_seq = min(seq_of("我行受益所有人留存信息"), seq_of("人行受益所有人查询结果"))

    basic_info_items = slice_by_sequence_range("基本信息", "受益所有人信息")
    beneficiary_diff_items = slice_by_sequence_range("受益所有人信息", "我行受益所有人留存信息")
    compare_items = [
        item for item in sequence_items
        if compare_start_seq <= int(item.get("sequence", 0)) < task_processing_seq
    ]
    left_compare_items = [item for item in compare_items if float(item.get("bbox", {}).get("x", 0) or 0) < 760]
    right_compare_items = [item for item in compare_items if float(item.get("bbox", {}).get("x", 0) or 0) >= 760]
    task_processing_items = slice_by_sequence_range("任务处理信息", "节点记录")
    process_basic_items = slice_by_sequence_range("处理基本信息", "分析结论")
    analysis_items = slice_by_sequence_range("分析结论", "差异报告")
    report_items = slice_by_sequence_range("差异报告", "节点记录")
    timeline_items = [
        item for item in sequence_items
        if timeline_seq <= int(item.get("sequence", 0)) <= seq_of("节点记录", timeline_seq) + 120
        and float(item.get("bbox", {}).get("x", 0) or 0) >= 1450
    ]

    sections: list[dict[str, Any]] = []
    for built in [
        build_section("基本信息", basic_info_items, layout_hint="field-block-grid"),
        build_section("受益所有人信息", beneficiary_diff_items, layout_hint="field-block-grid"),
        build_section("我行受益所有人留存信息", left_compare_items, layout_hint="field-block-grid", subsection_titles=["基本信息", "所有权信息"]),
        build_section("人行受益所有人查询结果", right_compare_items, layout_hint="field-block-grid", subsection_titles=["基本信息", "所有权信息"]),
        build_section("任务处理信息", task_processing_items, layout_hint="field-block-grid", subsection_titles=["处理基本信息", "分析结论", "差异报告"]),
        build_section("处理基本信息", process_basic_items, layout_hint="field-block-grid"),
        build_section("分析结论", analysis_items, layout_hint="field-block-grid"),
        build_section("差异报告", report_items, layout_hint="field-block-grid"),
        build_section("节点记录", timeline_items, layout_hint="field-block-grid"),
    ]:
        if built is not None:
            sections.append(built)
    return sections


def maybe_build_usage_dashboard_sections(
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    texts = [str(item.get("text", "")) for item in items]
    joined = " ".join(texts)
    if not any(term in joined for term in ["使用情况", "客户经理Claw使用漏斗", "渗透率指标"]):
        return []

    sequence_items = sorted(items, key=lambda it: int(it.get("sequence", 0)))

    def section_from_filters(
        title: str,
        predicate,
        layout_hint: str = "field-block-grid",
        whole: bool = False,
    ) -> dict[str, Any] | None:
        selected = [item for item in sequence_items if predicate(item)]
        if len(selected) < 3:
            return None
        anchor = next((item for item in selected if item.get("text") == title), selected[0])
        content_bbox = combined_bbox([item["bbox"] for item in selected])
        container_bbox = {
            "x": max(float(content_bbox.get("x", 0) or 0) - 18.0, 0.0),
            "y": max(float(content_bbox.get("y", 0) or 0) - 18.0, 0.0),
            "w": float(content_bbox.get("w", 0) or 0) + 36.0,
            "h": float(content_bbox.get("h", 0) or 0) + 36.0,
        }
        render_contract = infer_render_contract(
            title,
            layout_hint,
            selected,
            anchor,
            container_bbox,
            [],
            [],
        )
        if whole:
            render_contract["mustRenderWholeSection"] = True
            render_contract["contentMode"] = "panel-whole"
        return {
            "title": title,
            "ownerPath": title,
            "nodeId": anchor.get("nodeId", ""),
            "bbox": anchor.get("bbox", {}),
            "sequenceStart": min(int(item.get("sequence", 0)) for item in selected),
            "sequenceEnd": max(int(item.get("sequence", 0)) for item in selected),
            "containerBbox": container_bbox,
            "contentBbox": content_bbox,
            "layoutHint": layout_hint,
            "subsectionTitles": [],
            "tagStripTexts": [],
            "renderContract": render_contract,
            "texts": [item["text"] for item in selected],
        }

    sections: list[dict[str, Any]] = []
    for built in [
        section_from_filters(
            "使用情况",
            lambda item: int(item.get("sequence", 0)) <= 21,
            layout_hint="field-block-grid",
            whole=True,
        ),
        section_from_filters(
            "行为频次指标",
            lambda item: 22 <= int(item.get("sequence", 0)) <= 57,
        ),
        section_from_filters(
            "活跃用户指标",
            lambda item: 64 <= int(item.get("sequence", 0)) <= 118,
        ),
        section_from_filters(
            "渗透率指标",
            lambda item: 124 <= int(item.get("sequence", 0)) <= 178,
        ),
        section_from_filters(
            "客户经理Claw使用漏斗",
            lambda item: int(item.get("sequence", 0)) >= 184,
            layout_hint="field-block-grid",
            whole=True,
        ),
    ]:
        if built is not None:
            sections.append(built)
    return sections


def maybe_build_regions_from_sections(
    sections: list[dict[str, Any]],
    fallback_regions: list[dict[str, Any]],
    is_fidelity_html: bool,
) -> list[dict[str, Any]]:
    if not is_fidelity_html or len(fallback_regions) > 2 or len(sections) < 4:
        return fallback_regions
    derived = []
    for section in sections[:12]:
        bbox = section.get("contentBbox") or section.get("containerBbox") or section.get("bbox") or {}
        if not bbox or area(bbox) <= 0:
            continue
        derived.append({
            "name": section.get("ownerPath") or section.get("title") or "section",
            "regionKind": "section-derived",
            "bbox": bbox,
            "texts": list(dict.fromkeys(section.get("texts", [])))[:30],
            "nodeIds": [section.get("nodeId", "")] if section.get("nodeId") else [],
        })
    return derived or fallback_regions


def refine_workflow_compare_columns(
    sections: list[dict[str, Any]],
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    title_to_section = {str(section.get("title", "")): dict(section) for section in sections}
    left = title_to_section.get("我行受益所有人留存信息")
    right = title_to_section.get("人行受益所有人查询结果")
    if not left or not right:
        return sections

    left_seq_start = int(left.get("sequenceStart", 0))
    left_seq_end = int(left.get("sequenceEnd", left_seq_start))
    right_seq_start = int(right.get("sequenceStart", 0))
    right_seq_end = int(right.get("sequenceEnd", right_seq_start))

    left_items = [
        item for item in items
        if left_seq_start <= int(item.get("sequence", 0)) <= left_seq_end
        and float(item.get("bbox", {}).get("x", 0) or 0) < 600
    ]
    right_items = [
        item for item in items
        if right_seq_start <= int(item.get("sequence", 0)) <= right_seq_end
        and float(item.get("bbox", {}).get("x", 0) or 0) >= 600
    ]
    def split_compare_bands(local_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        tag_band = [item for item in local_items if float(item.get("bbox", {}).get("y", 0) or 0) < 330]
        basic_band = [item for item in local_items if 330 <= float(item.get("bbox", {}).get("y", 0) or 0) < 760]
        ownership_band = [item for item in local_items if float(item.get("bbox", {}).get("y", 0) or 0) >= 760]
        ordered: list[dict[str, Any]] = []
        for band in [tag_band, basic_band, ownership_band]:
            ordered.extend(sorted(band, key=lambda item: (item["bbox"]["y"], item["bbox"]["x"])))
        return ordered

    left_items = split_compare_bands(left_items)
    right_items = split_compare_bands(right_items)

    if left_items:
        left["contentBbox"] = combined_bbox([item["bbox"] for item in left_items])
        left["containerBbox"] = {
            "x": max(float(left["contentBbox"].get("x", 0) or 0) - 16.0, 0.0),
            "y": max(float(left["contentBbox"].get("y", 0) or 0) - 16.0, 0.0),
            "w": float(left["contentBbox"].get("w", 0) or 0) + 32.0,
            "h": float(left["contentBbox"].get("h", 0) or 0) + 32.0,
        }
        left["texts"] = [item["text"] for item in left_items]
        anchor = next((item for item in left_items if str(item.get("text", "")) == "我行受益所有人留存信息"), left_items[0])
        left["tagStripTexts"] = extract_tag_strip_texts(left_items, anchor, visual_boxes)
        left["renderContract"] = infer_render_contract(
            left.get("title", "我行受益所有人留存信息"),
            str(left.get("layoutHint", "") or ""),
            left_items,
            anchor,
            left.get("containerBbox", {}) or left.get("contentBbox", {}) or left.get("bbox", {}),
            left.get("subsectionTitles", []) or [],
            left.get("tagStripTexts", []) or [],
        )
    if right_items:
        right["contentBbox"] = combined_bbox([item["bbox"] for item in right_items])
        right["containerBbox"] = {
            "x": max(float(right["contentBbox"].get("x", 0) or 0) - 16.0, 0.0),
            "y": max(float(right["contentBbox"].get("y", 0) or 0) - 16.0, 0.0),
            "w": float(right["contentBbox"].get("w", 0) or 0) + 32.0,
            "h": float(right["contentBbox"].get("h", 0) or 0) + 32.0,
        }
        right["texts"] = [item["text"] for item in right_items]
        anchor = next((item for item in right_items if str(item.get("text", "")) == "人行受益所有人查询结果"), right_items[0])
        right["tagStripTexts"] = extract_tag_strip_texts(right_items, anchor, visual_boxes)
        right["renderContract"] = infer_render_contract(
            right.get("title", "人行受益所有人查询结果"),
            str(right.get("layoutHint", "") or ""),
            right_items,
            anchor,
            right.get("containerBbox", {}) or right.get("contentBbox", {}) or right.get("bbox", {}),
            right.get("subsectionTitles", []) or [],
            right.get("tagStripTexts", []) or [],
        )

    refined = []
    for section in sections:
        title = str(section.get("title", ""))
        if title == "我行受益所有人留存信息":
            refined.append(left)
        elif title == "人行受益所有人查询结果":
            refined.append(right)
        else:
            refined.append(section)
    return refined


def split_task_processing_sections(
    sections: list[dict[str, Any]],
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    title_to_section = {str(section.get("title", "")): dict(section) for section in sections}
    task = title_to_section.get("任务处理信息")
    if not task:
        return sections

    seq_start = int(task.get("sequenceStart", 0))
    seq_end = int(task.get("sequenceEnd", seq_start))
    task_items = [
        item for item in items
        if seq_start <= int(item.get("sequence", 0)) <= seq_end
    ]
    if not task_items:
        return sections

    process_basic = [item for item in task_items if int(item.get("sequence", 0)) < 149]
    analysis = [item for item in task_items if 149 <= int(item.get("sequence", 0)) < 473]
    report = [item for item in task_items if int(item.get("sequence", 0)) >= 473]

    def rewrite(section: dict[str, Any], selected: list[dict[str, Any]]) -> dict[str, Any]:
        section = dict(section)
        if not selected:
            return section
        section["sequenceStart"] = min(int(item.get("sequence", 0)) for item in selected)
        section["sequenceEnd"] = max(int(item.get("sequence", 0)) for item in selected)
        section["contentBbox"] = combined_bbox([item["bbox"] for item in selected])
        section["containerBbox"] = {
            "x": max(float(section["contentBbox"].get("x", 0) or 0) - 16.0, 0.0),
            "y": max(float(section["contentBbox"].get("y", 0) or 0) - 16.0, 0.0),
            "w": float(section["contentBbox"].get("w", 0) or 0) + 32.0,
            "h": float(section["contentBbox"].get("h", 0) or 0) + 32.0,
        }
        section["texts"] = [item["text"] for item in selected]
        return section

    refined = []
    for section in sections:
        title = str(section.get("title", ""))
        if title == "任务处理信息":
            refined.append(rewrite(section, task_items))
        elif title == "处理基本信息":
            refined.append(rewrite(section, process_basic))
        elif title == "分析结论":
            refined.append(rewrite(section, analysis))
        elif title == "差异报告":
            refined.append(rewrite(section, report))
        else:
            refined.append(section)
    return refined


def refine_workflow_detail_sections(
    sections: list[dict[str, Any]],
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not sections:
        return sections

    section_items = []
    for section in sections:
        seq_start = int(section.get("sequenceStart", 0))
        seq_end = int(section.get("sequenceEnd", seq_start))
        seq_items = [
            item for item in items
            if seq_start <= int(item.get("sequence", 0)) <= seq_end
        ]
        section_items.append((section, seq_items))

    title_rules = {
        "节点记录": {
            "keep": ["节点记录", "审批通过", "审批驳回", "报告被退回", "提交处理信息", "撤回处理信息", "报告ID", "备注："],
            "drop": ["基本信息", "所有权信息", "客户号码", "统一社会信用代码", "受益人编码", "差异报告"],
        },
        "基本信息": {
            "keep": ["基本信息", "姓名", "受益人编码", "证件类型", "国籍", "证件号码", "证件有效期", "生日", "手机号", "地址", "固定电话"],
            "drop": ["任务处理信息", "差异报告", "节点记录", "审批通过", "审批驳回", "报告被退回"],
        },
        "受益所有人信息": {
            "keep": ["受益所有人信息", "核验结果", "差异明细类型", "行内受益人姓名", "人行受益人姓名", "差异信息", "行内核验差异明细", "人行核验差异明细"],
            "drop": ["任务处理信息", "差异报告", "节点记录", "审批通过", "审批驳回", "报告被退回"],
        },
        "核验结果": {
            "keep": ["核验结果", "备案主体名称", "客户号码", "核验时间", "期望完成时间", "备案主体类型", "差异结果", "管户机构", "统一社会信用代码", "差异发现时间", "一级分行", "二级分行", "处理人", "管户市场经理"],
            "drop": ["受益所有人信息", "差异报告", "任务处理信息", "节点记录", "审批通过", "审批驳回", "报告被退回"],
        },
        "我行受益所有人留存信息": {
            "keep": ["我行受益所有人留存信息", "查看", "选中标签", "所有权信息", "基本信息", "受益人编码", "姓名", "证件类型", "国籍", "证件号码", "证件有效期", "生日", "手机号", "地址", "固定电话", "受益所有权形成日期", "受益所有权终止日期", "实施实际控制"],
            "drop": ["任务处理信息", "差异报告", "节点记录", "审批通过", "审批驳回", "报告被退回"],
        },
        "人行受益所有人查询结果": {
            "keep": ["人行受益所有人查询结果", "查看", "选中标签", "所有权信息", "基本信息", "受益人编码", "姓名", "证件类型", "国籍", "证件号码", "证件有效期", "生日", "手机号", "地址", "固定电话", "受益所有权形成日期", "受益所有权终止日期", "实施实际控制", "重大差异：受益所有人不匹配"],
            "drop": ["任务处理信息", "差异报告", "节点记录", "审批通过", "审批驳回", "报告被退回"],
        },
        "任务处理信息": {
            "keep": ["任务处理信息", "处理基本信息", "分析结论", "与客户的沟通记录", "上传文件成功", "客户是否同意", "差异报告", "报告编号", "报告审核结果", "人行留存受益所有人信息有误", "否"],
            "drop": ["首页", "年终奖专区", "重要商机", "高级搜索", "企业管户", "进企经营", "客群经营", "营销工具", "工作管理", "合规管理", "人员管理", "知识中心", "节点记录"],
        },
        "处理基本信息": {
            "keep": ["处理基本信息", "备案主体名称", "客户号码", "备案主体类型", "统一社会信用代码", "处理人", "管户机构", "管户市场经理"],
            "drop": ["节点记录", "审批通过", "审批驳回", "报告被退回", "首页", "年终奖专区", "重要商机"],
        },
        "分析结论": {
            "keep": ["分析结论", "与客户的沟通记录", "上传文件成功", "客户是否同意", "人行留存受益所有人信息有误", "否"],
            "drop": ["首页", "年终奖专区", "重要商机", "高级搜索", "企业管户", "进企经营", "客群经营", "营销工具", "工作管理", "合规管理", "人员管理", "知识中心", "节点记录"],
        },
        "差异报告": {
            "keep": ["差异报告", "报告编号", "报告审核结果", "一级分行", "二级分行", "管户机构", "管户市场经理", "报告ID"],
            "drop": ["节点记录", "审批通过", "审批驳回", "报告被退回", "首页", "年终奖专区", "重要商机"],
        },
    }

    refined: list[dict[str, Any]] = []
    for section, seq_items in section_items:
        title = str(section.get("title", ""))
        rule = title_rules.get(title)
        if not rule:
            refined.append(section)
            continue
        kept = []
        for item in seq_items:
            text = str(item.get("text", ""))
            if any(token in text for token in rule["drop"]):
                if text != title:
                    continue
            if any(token in text for token in rule["keep"]) or text == title:
                kept.append(item)
        if len(kept) < 3:
            refined.append(section)
            continue
        layout_hint = infer_layout_hint(kept, title)
        subsection_titles = extract_subsection_titles(kept, visual_boxes, kept[0], section.get("containerBbox", {}) or section.get("contentBbox", {}) or section.get("bbox", {}))
        tag_strip_texts = extract_tag_strip_texts(kept, kept[0])
        section = dict(section)
        section["contentBbox"] = combined_bbox([item["bbox"] for item in kept])
        section["layoutHint"] = layout_hint
        section["subsectionTitles"] = subsection_titles
        section["tagStripTexts"] = tag_strip_texts
        section["renderContract"] = infer_render_contract(
            title,
            layout_hint,
            kept,
            kept[0],
            section.get("containerBbox", {}) or section.get("contentBbox", {}) or section.get("bbox", {}),
            subsection_titles,
            tag_strip_texts,
        )
        section["texts"] = [item["text"] for item in kept]
        refined.append(section)
    return refined


def build_content_inventory(
    items: list[dict[str, Any]],
    sections: list[dict[str, Any]],
    regions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    if sections:
        for section in sections:
            texts = list(dict.fromkeys(section.get("texts", [])))
            inventory.append({
                "owner": section.get("ownerPath") or section.get("title", ""),
                "title": section.get("title", ""),
                "kind": "section",
                "bbox": section.get("bbox", {}),
                "containerBbox": section.get("containerBbox", {}),
                "contentBbox": section.get("contentBbox", {}),
                "layoutHint": section.get("layoutHint", ""),
                "subsectionTitles": section.get("subsectionTitles", []),
                "tagStripTexts": section.get("tagStripTexts", []),
                "renderContract": section.get("renderContract", {}),
                "textCount": len(texts),
                "visibleTexts": texts,
                "controlTexts": [text for text in texts if infer_kind(text) in {"action", "chip"}],
                "fieldLikeTexts": [text for text in texts if infer_kind(text) in {"field-label", "required-label", "label"}],
                "mustPreserve": True,
            })
    else:
        for region in regions:
            texts = list(dict.fromkeys(region.get("texts", [])))
            inventory.append({
                "owner": region.get("name", ""),
                "kind": "region",
                "bbox": region.get("bbox", {}),
                "textCount": len(texts),
                "visibleTexts": texts,
                "controlTexts": [text for text in texts if infer_kind(text) in {"action", "chip"}],
                "fieldLikeTexts": [text for text in texts if infer_kind(text) in {"field-label", "required-label", "label"}],
                "mustPreserve": region.get("name") not in {"top-nav", "left-nav"},
            })
    if not inventory and items:
        texts = list(dict.fromkeys(item["text"] for item in items))
        inventory.append({
            "owner": "page",
            "kind": "page",
            "bbox": combined_bbox([item.get("bbox", {}) for item in items]),
            "textCount": len(texts),
            "visibleTexts": texts,
            "controlTexts": [text for text in texts if infer_kind(text) in {"action", "chip"}],
            "fieldLikeTexts": [text for text in texts if infer_kind(text) in {"field-label", "required-label", "label"}],
            "mustPreserve": True,
        })
    return inventory


def scan_project_components(project_root: Path | None) -> list[dict[str, Any]]:
    components: dict[str, dict[str, Any]] = {}
    search_roots: list[tuple[Path, str]] = []
    if project_root and project_root.exists():
        collect_component_doc_entries(project_root / "architecture" / "publicComponents.md", "architecture-public-doc", components, project_root)
        collect_component_doc_entries(project_root / "architecture" / "shared-components.md", "architecture-shared-doc", components, project_root)
        collect_component_doc_entries(project_root / "output" / "components.md", "output-components-doc", components, project_root)
        search_roots.extend([
            (project_root / "components", "project-components"),
            (project_root / "src" / "components", "project-components"),
        ])
    for root, source in search_roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".tsx", ".jsx", ".vue", ".ts", ".md"}:
                continue
            name = path.stem
            if name in {"index", "README"}:
                name = path.parent.name
            entry = components.setdefault(name, {
                "name": name,
                "paths": [],
                "kind": infer_component_kind(name),
                "usageCount": 0,
                "sourceType": source,
                "sourceRank": component_source_rank(source),
            })
            current_rank = int(entry.get("sourceRank", 9))
            new_rank = component_source_rank(source)
            if new_rank < current_rank:
                entry["sourceType"] = source
                entry["sourceRank"] = new_rank
            display_path = display_path_relative_to(path, project_root or skill_root)
            entry["paths"].append(display_path)
    src = project_root / "src" if project_root else None
    if src and src.exists():
        source_texts: list[str] = []
        for path in src.rglob("*"):
            if path.suffix.lower() in {".tsx", ".jsx", ".vue"} and path.is_file():
                try:
                    source_texts.append(path.read_text(encoding="utf-8", errors="ignore"))
                except OSError:
                    pass
        corpus = "\n".join(source_texts)
        for name, entry in components.items():
            entry["usageCount"] = len(re.findall(rf"<{re.escape(name)}\b", corpus))

    return sorted(components.values(), key=lambda x: (x.get("sourceRank", 9), -x["usageCount"], x["name"]))


def infer_component_kind(name: str) -> str:
    low = name.lower()
    if any(k in low for k in ["chart", "graph", "trend", "plot", "dashboard", "echart", "radar", "funnel", "gauge"]):
        return "chart"
    if any(k in low for k in ["filteropts", "filteropt"]):
        return "filter-region"
    if any(k in low for k in ["form", "search", "filter"]):
        return "form"
    if any(k in low for k in ["button", "action", "toolbar"]):
        return "button"
    if any(k in low for k in ["table", "list", "grid", "tablecomponent", "datatable"]):
        return "table"
    if any(k in low for k in ["modal", "drawer", "dialog"]):
        return "modal"
    if "tab" in low:
        return "tabs"
    if any(k in low for k in ["avatar", "customavatar"]):
        return "avatar"
    if any(k in low for k in ["tag", "badge", "status", "chip"]):
        return "tag"
    if any(k in low for k in ["step", "timeline"]):
        return "timeline"
    if any(k in low for k in ["cascadertree", "orgtree", "tree"]):
        return "tree-select"
    if any(k in low for k in ["select", "picker", "date", "time", "input"]):
        return "field-control"
    if any(k in low for k in ["pagination", "pager"]):
        return "pagination"
    if any(k in low for k in ["dropdown", "popover", "tooltip", "menu"]):
        return "overlay"
    if any(k in low for k in ["upload", "import", "batch"]):
        return "upload"
    if any(k in low for k in ["layout", "menu", "nav", "side", "header"]):
        return "shell"
    return "unknown"


def is_avatar_like_box(box: dict[str, Any]) -> bool:
    kind = str(box.get("kind", ""))
    bbox = box.get("bbox") or {}
    w = float(bbox.get("w", 0) or 0)
    h = float(bbox.get("h", 0) or 0)
    bg = str(box.get("background", "")).lower()
    radius = str(box.get("borderRadius", "")).lower()
    if kind == "icon-fragment" and 18 <= w <= 48 and 18 <= h <= 48:
        return True
    if 20 <= w <= 52 and 20 <= h <= 52 and abs(w - h) <= 10:
        if "50%" in radius or "999" in radius:
            return True
        if "url(" in bg or "linear-gradient" in bg:
            return True
    return False


def looks_like_table_header_text(text: str) -> bool:
    if text in TABLE_HEADER_TERMS or text in GENERIC_TABLE_HEADER_TERMS:
        return True
    if len(text) > 12:
        return False
    return text in {"名称", "状态", "操作", "备注"}


UI_LIBRARY_PACKAGES = [
    ("antd", "Ant Design", {"antd", "@ant-design/pro-components"}),
    ("element-plus", "Element Plus", {"element-plus", "element-ui"}),
]

CHART_LIBRARY_PACKAGES = [
    ("echarts", "ECharts", {"echarts", "echarts-for-react", "vue-echarts"}),
    ("ant-design-charts", "Ant Design Charts", {"@ant-design/charts"}),
    ("antv-g2", "AntV G2", {"@antv/g2", "@antv/g2plot", "@antv/plots", "@antv/l7"}),
    ("bizcharts", "BizCharts", {"bizcharts"}),
    ("recharts", "Recharts", {"recharts"}),
    ("chartjs", "Chart.js", {"chart.js", "react-chartjs-2"}),
    ("highcharts", "Highcharts", {"highcharts", "highcharts-react-official"}),
]

COMPONENT_NAMES = {
    "antd": {
        "form": "AntD Form",
        "input": "AntD Input",
        "textarea": "AntD Input.TextArea",
        "select": "AntD Select",
        "select-multiple": "AntD Select (multiple)",
        "radio": "AntD Radio.Group",
        "checkbox": "AntD Checkbox.Group",
        "date": "AntD DatePicker",
        "button": "AntD Button",
        "table": "AntD Table",
        "tabs": "AntD Tabs",
        "tag": "AntD Tag",
        "pagination": "AntD Pagination",
        "modal": "AntD Modal",
        "upload": "AntD Upload",
        "timeline": "AntD Timeline",
        "progress": "AntD Progress",
        "overlay": "AntD Dropdown/Popover",
    },
    "element-plus": {
        "form": "Element Plus ElForm",
        "input": "Element Plus ElInput",
        "textarea": "Element Plus ElInput textarea",
        "select": "Element Plus ElSelect",
        "select-multiple": "Element Plus ElSelect multiple",
        "radio": "Element Plus ElRadioGroup",
        "checkbox": "Element Plus ElCheckboxGroup",
        "date": "Element Plus ElDatePicker",
        "button": "Element Plus ElButton",
        "table": "Element Plus ElTable",
        "tabs": "Element Plus ElTabs",
        "tag": "Element Plus ElTag",
        "pagination": "Element Plus ElPagination",
        "modal": "Element Plus ElDialog",
        "upload": "Element Plus ElUpload",
        "timeline": "Element Plus ElTimeline",
        "progress": "Element Plus ElProgress",
        "overlay": "Element Plus ElDropdown/ElPopover",
    },
    "project-ui": {
        "form": "project Form component",
        "input": "project Input component",
        "textarea": "project TextArea component",
        "select": "project Select component",
        "select-multiple": "project Select component (multiple)",
        "radio": "project Radio component",
        "checkbox": "project Checkbox component",
        "date": "project DatePicker component",
        "button": "project Button component",
        "table": "project Table component",
        "tabs": "project Tabs component",
        "tag": "project Tag/Badge component",
        "pagination": "project Pagination component",
        "modal": "project Modal/Dialog component",
        "upload": "project Upload component",
        "timeline": "project Timeline component",
        "progress": "project Progress component",
        "overlay": "project Dropdown/Popover component",
    },
}


def detect_ui_libraries(project_root: Path | None) -> list[dict[str, Any]]:
    if not project_root or not project_root.exists():
        return [{"id": "project-ui", "name": "Project UI", "packages": [], "evidence": "project root unavailable"}]
    package_file = project_root / "package.json"
    if not package_file.exists():
        return [{"id": "project-ui", "name": "Project UI", "packages": [], "evidence": "package.json not found"}]
    try:
        package = json.loads(package_file.read_text(encoding="utf-8", errors="ignore"))
    except json.JSONDecodeError:
        return [{"id": "project-ui", "name": "Project UI", "packages": [], "evidence": "package.json unreadable"}]
    deps: dict[str, Any] = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        value = package.get(key)
        if isinstance(value, dict):
            deps.update(value)
    found: list[dict[str, Any]] = []
    for lib_id, name, packages in UI_LIBRARY_PACKAGES:
        hits = sorted(pkg for pkg in packages if pkg in deps)
        if hits:
            found.append({
                "id": lib_id,
                "name": name,
                "packages": hits,
                "evidence": "package.json",
            })
    if found:
        return found
    return [{"id": "project-ui", "name": "Project UI", "packages": [], "evidence": "no known UI library package found"}]


def detect_chart_libraries(project_root: Path | None) -> list[dict[str, Any]]:
    if not project_root or not project_root.exists():
        return []
    package_file = project_root / "package.json"
    if not package_file.exists():
        return []
    try:
        package = json.loads(package_file.read_text(encoding="utf-8", errors="ignore"))
    except json.JSONDecodeError:
        return []
    deps: dict[str, Any] = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        value = package.get(key)
        if isinstance(value, dict):
            deps.update(value)

    source_files: list[Path] = []
    src = project_root / "src"
    if src.exists():
        for path in src.rglob("*"):
            if path.is_file() and path.suffix.lower() in {".tsx", ".jsx", ".vue", ".ts", ".js"}:
                source_files.append(path)
    corpus_parts: list[str] = []
    for path in source_files:
        try:
            corpus_parts.append(path.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
    corpus = "\n".join(corpus_parts)

    found: list[dict[str, Any]] = []
    for lib_id, name, packages in CHART_LIBRARY_PACKAGES:
        installed = sorted(pkg for pkg in packages if pkg in deps)
        if not installed:
            continue
        used_packages = [pkg for pkg in installed if pkg in corpus]
        extra_evidence: list[str] = []
        if lib_id == "echarts" and any(token in corpus for token in ["ECharts", "echarts.init", "ReactECharts", "VueECharts"]):
            extra_evidence.append("source-symbols")
        if lib_id == "recharts" and any(token in corpus for token in ["LineChart", "BarChart", "PieChart", "AreaChart", "ResponsiveContainer"]):
            extra_evidence.append("source-symbols")
        if lib_id == "ant-design-charts" and any(token in corpus for token in ["Line ", "Column ", "Pie ", "Area ", "DualAxes "]):
            extra_evidence.append("source-symbols")
        if lib_id == "chartjs" and any(token in corpus for token in ["ChartJS", "react-chartjs-2", "new Chart("]):
            extra_evidence.append("source-symbols")
        if lib_id == "highcharts" and any(token in corpus for token in ["Highcharts", "highcharts-react-official"]):
            extra_evidence.append("source-symbols")
        if lib_id == "bizcharts" and "BizCharts" in corpus:
            extra_evidence.append("source-symbols")
        if lib_id == "antv-g2" and any(token in corpus for token in ["G2Plot", "@antv/g2", "@antv/g2plot", "@antv/plots"]):
            extra_evidence.append("source-symbols")
        evidence = []
        if installed:
            evidence.append("package.json")
        if used_packages:
            evidence.append("source-import")
        evidence.extend(extra_evidence)
        found.append({
            "id": lib_id,
            "name": name,
            "packages": installed,
            "usedPackages": used_packages,
            "evidence": ",".join(dict.fromkeys(evidence)) if evidence else "",
            "proven": bool(used_packages or extra_evidence),
        })
    found.sort(key=lambda item: (0 if item.get("proven") else 1, item.get("name", "")))
    return found


def primary_chart_library(chart_libraries: list[dict[str, Any]]) -> dict[str, Any] | None:
    for lib in chart_libraries:
        if lib.get("proven"):
            return lib
    return None


def primary_ui_library(ui_libraries: list[dict[str, Any]]) -> str:
    if not ui_libraries:
        return "project-ui"
    return str(ui_libraries[0].get("id") or "project-ui")


def component_name(ui_library: str, family: str) -> str:
    mapping = COMPONENT_NAMES.get(ui_library) or COMPONENT_NAMES["project-ui"]
    return mapping.get(family, COMPONENT_NAMES["project-ui"].get(family, f"{ui_library} {family} component"))


def match_components(
    fields: list[dict[str, Any]],
    regions: list[dict[str, Any]],
    components: list[dict[str, Any]],
    chart_candidates: list[dict[str, Any]] | None = None,
    progress_candidates: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    desired = set()
    all_texts = [t for r in regions for t in r.get("texts", [])]
    page_text = " ".join(all_texts)
    joined = " ".join(all_texts).lower()
    has_pagination_signal = any(term in " ".join(all_texts) for term in PAGINATION_SIGNAL_TERMS)
    has_list_record_signal = any(term in " ".join(all_texts) for term in LIST_RECORD_PREFIXES)
    if fields:
        desired.add("form")
    if any("评分" in " ".join(r.get("texts", [])) for r in regions):
        desired.add("form")
    if any("机构" in str(field.get("label", "")) for field in fields):
        desired.add("tree-select")
    if any(r["name"] in {"top-nav", "left-nav"} for r in regions):
        desired.add("shell")
    if any(t in {"确定", "取消"} for r in regions for t in r.get("texts", [])):
        desired.add("modal")
    if any(t in CONTROL_WORDS for t in all_texts):
        desired.add("button")
    if any(term in joined for term in ["table", "表头", "分页", "共 ", "条/页", "上一页", "下一页"]):
        desired.add("table")
        desired.add("pagination")
    if has_pagination_signal and has_list_record_signal:
        desired.add("table")
        desired.add("pagination")
    if any("查询" in text or "重置" in text for text in all_texts):
        desired.add("form")
    if any(term in joined for term in ["tab", "选项卡", "基本信息", "详情", "报告"]):
        desired.add("tabs")
    if any(infer_kind(t) == "chip" for t in all_texts):
        desired.add("tag")
    if any(term in joined for term in ["时间线", "节点", "记录", "处理时间"]):
        desired.add("timeline")
    if any(term in joined for term in ["上传", "导入", "附件", "文件"]):
        desired.add("upload")
    if any("头像" in text for text in all_texts):
        desired.add("avatar")
    if progress_candidates:
        desired.add("progress")
    if chart_candidates or any(term in page_text for term in ["图表", "趋势", "走势", "分析", "分布", "占比", "同比", "环比", "排名"]):
        desired.add("chart")

    for kind in sorted(desired):
        cands = [c for c in components if c["kind"] == kind][:5]
        matches.append({
            "regionKind": kind,
            "candidates": cands,
            "rule": "matched by semantic region and component name/usage",
        })
    return matches


def first_component_path(component: dict[str, Any]) -> str:
    paths = component.get("paths") or []
    return paths[0] if paths else ""


def field_control_type(field: dict[str, Any]) -> str:
    placeholder = field.get("placeholder", "")
    label = field.get("label", "")
    text = f"{label} {placeholder}".lower()
    label_text = label.lower()
    control_signals = field.get("controlSignals") or {}
    if control_signals.get("multiple"):
        return "select-multiple"
    if control_signals.get("selectLike"):
        return "select"
    if "\u8bf7\u9009\u62e9" in text or "select" in text:
        return "select"
    if any(term in text for term in ["radio", "\u6027\u522b"]):
        return "radio"
    if any(term in text for term in ["checkbox", "\u590d\u9009"]):
        return "checkbox"
    if any(term in text for term in ["date", "time", "\u65e5\u671f", "\u65f6\u95f4"]):
        return "date"
    if any(term in label_text for term in ["\u7b80\u4ecb", "\u4ecb\u7ecd", "\u75db\u70b9", "\u5185\u5bb9", "\u63cf\u8ff0"]):
        return "textarea"
    return "input"


def ui_component_for_control(control_type: str, ui_library: str) -> str:
    return component_name(ui_library, control_type)


def item_belongs_to_multi_select(item: dict[str, Any], fields: list[dict[str, Any]]) -> bool:
    item_bbox = item.get("bbox", {}) or {}
    item_text = str(item.get("text", "") or "")
    for field in fields:
        signals = field.get("controlSignals") or {}
        if not signals.get("multiple"):
            continue
        if item_text and item_text in signals.get("chipTexts", []):
            control_bbox = field.get("controlBbox") or {}
            if control_bbox and contains_bbox(control_bbox, item_bbox, pad=10):
                return True
    return False


def top_candidate(matches: list[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    for match in matches:
        if match.get("regionKind") == kind and match.get("candidates"):
            return match["candidates"][0]
    return None


def build_replacement_slots(
    fields: list[dict[str, Any]],
    regions: list[dict[str, Any]],
    sections: list[dict[str, Any]],
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    component_matches: list[dict[str, Any]],
    similar_pages: list[dict[str, Any]],
    ui_libraries: list[dict[str, Any]],
    chart_libraries: list[dict[str, Any]],
    table_structures: list[dict[str, Any]],
    progress_candidates: list[dict[str, Any]],
    chart_candidates: list[dict[str, Any]],
    icon_candidates: list[dict[str, Any]],
    componentization_mode: dict[str, Any],
) -> list[dict[str, Any]]:
    slots: list[dict[str, Any]] = []
    ui_library = primary_ui_library(ui_libraries)
    ui_library_name = str((ui_libraries[0] if ui_libraries else {}).get("name") or "Project UI")
    actionable_fields = [
        field for field in fields
        if field_has_control_evidence(field, sections)
        and not field_inside_metric_card(field, visual_boxes, items)
    ]
    filter_candidate = top_candidate(component_matches, "form")
    tree_candidate = top_candidate(component_matches, "tree-select")
    chart_component = top_candidate(component_matches, "chart")
    progress_component = top_candidate(component_matches, "progress")
    proven_chart_library = primary_chart_library(chart_libraries)
    chart_boxes = [chart.get("bbox", {}) for chart in chart_candidates if chart.get("bbox")]

    shell_candidate = top_candidate(component_matches, "shell")
    for region in regions:
        name = region.get("name", "")
        if name in {"top-nav", "left-nav"}:
            if shell_candidate:
                decision = "reuse-project-component"
                candidate = shell_candidate["name"]
                component = first_component_path(shell_candidate)
                reason = "shell region matched an existing project component"
                constraint = "component owns the shell region; remove duplicated source divs"
            else:
                decision = "fidelity-only"
                candidate = ""
                component = ""
                reason = "no project shell component evidence"
                constraint = "preserve visual boxes and text positions"
            slots.append({
                "slot": name,
                "kind": "shell",
                "bbox": region.get("bbox", {}),
                "decision": decision,
                "candidate": candidate,
                "componentPath": component,
                "evidence": reason,
                "constraint": constraint,
            })

    form_candidate = top_candidate(component_matches, "form")
    if actionable_fields:
        if form_candidate:
            slots.append({
                "slot": "form-region",
                "kind": "form",
                "bbox": combined_bbox([field.get("bbox", {}) for field in actionable_fields]),
                "decision": "reuse-project-component-or-pattern",
                "candidate": form_candidate["name"],
                "componentPath": first_component_path(form_candidate),
                "evidence": "fields with control evidence matched an existing project form component",
                "constraint": "component must stay inside the original form region bbox",
            })
        else:
            slots.append({
                "slot": "form-region",
                "kind": "form",
                "bbox": combined_bbox([field.get("bbox", {}) for field in actionable_fields]),
                "decision": "use-ui-library",
                "candidate": component_name(ui_library, "form"),
                "componentPath": "",
                "evidence": f"field region has explicit control evidence; uiLibrary={ui_library_name}",
                "constraint": "use Form layout inside the original region; do not move sibling sections",
            })

    filter_region = detect_filter_region(actionable_fields, items)
    if not filter_region:
        filter_region = detect_filter_region_from_table_context(items, table_structures)
    if filter_region:
        slots.append({
            "slot": "filter-region:main",
            "kind": "filter-region",
            "bbox": filter_region.get("bbox", {}),
            "decision": "reuse-project-component-or-pattern" if filter_candidate else "use-ui-library",
            "candidate": filter_candidate["name"] if filter_candidate else f"{component_name(ui_library, 'form')} + standard filter controls",
            "componentPath": first_component_path(filter_candidate) if filter_candidate else "",
            "evidence": "multiple actionable filter fields plus query/reset actions indicate a whole search/filter region",
            "constraint": "treat the whole filter strip as one region; do not split into unrelated standalone controls when a filter component is available",
        })

    for field in actionable_fields:
        control_type = field_control_type(field)
        label_text = str(field.get("label", ""))
        candidate = ui_component_for_control(control_type, ui_library)
        decision = "use-ui-library-control"
        evidence = f"label/placeholder indicates a standard {control_type} control; uiLibrary={ui_library_name}"
        component_path = ""
        if "机构" in label_text and tree_candidate:
            candidate = tree_candidate["name"]
            decision = "reuse-project-component-or-pattern"
            evidence = "field label suggests institution/organization tree selection and matched CascaderTree-like component"
            component_path = first_component_path(tree_candidate)
        slots.append({
            "slot": f"field:{field.get('label', '')}",
            "kind": "field-control",
            "bbox": field.get("bbox", {}),
            "decision": decision,
            "candidate": candidate,
            "componentPath": component_path,
            "evidence": evidence,
            "constraint": "component may correct internal control alignment, but wrapper stays in the original field slot",
        })

    seen_control_slots: set[tuple[str, str]] = set()
    for item in items:
        kind = item.get("kind")
        family = ""
        if kind == "action":
            family = "button"
        elif kind == "chip":
            family = "tag"
        elif item_belongs_to_multi_select(item, actionable_fields):
            continue
        if not family:
            continue
        text = str(item.get("text", ""))
        key = (family, text)
        if key in seen_control_slots:
            continue
        seen_control_slots.add(key)
        slots.append({
            "slot": f"{family}:{text}",
            "kind": family,
            "bbox": item.get("bbox", {}),
            "decision": "use-ui-library-control",
            "candidate": component_name(ui_library, family),
            "componentPath": "",
            "evidence": f"text classified as {kind}; uiLibrary={ui_library_name}",
            "constraint": "replace only this control slot; preserve surrounding layout and exact text",
        })

    for index, progress in enumerate(progress_candidates):
        progress_bbox = progress.get("bbox", {})
        if any(
            progress_bbox
            and (
                overlap_ratio(progress_bbox, chart_box) >= 0.68
                or overlap_ratio(chart_box, progress_bbox) >= 0.68
            )
            for chart_box in chart_boxes
        ):
            continue
        signals = ", ".join(progress.get("evidence", [])[:4])
        progress_type = str(progress.get("progressType") or "line")
        if progress_component:
            decision = "reuse-project-component-or-pattern"
            candidate = progress_component["name"]
            component_path = first_component_path(progress_component)
            evidence = f"detected {progress_type} progress region with percent text; matched project progress component"
        else:
            decision = "use-ui-library-control"
            candidate = component_name(ui_library, "progress")
            component_path = ""
            evidence = f"detected {progress_type} progress region with percent text; uiLibrary={ui_library_name}"
        if signals:
            evidence = f"{evidence}; signals={signals}"
        slots.append({
            "slot": f"progress:{progress.get('owner') or index}",
            "kind": "progress",
            "bbox": progress.get("bbox", {}),
            "decision": decision,
            "candidate": candidate,
            "componentPath": component_path,
            "evidence": evidence,
            "constraint": "only convert when the geometry and percent text clearly indicate a progress pattern; otherwise keep chart detection unchanged",
            "progressType": progress_type,
            "percentText": progress.get("percentText", ""),
        })

    for index, chart in enumerate(chart_candidates):
        chart_type = str(chart.get("chartType", "") or "chart")
        signals = ", ".join(chart.get("evidence", [])[:4])
        if chart_component:
            decision = "reuse-project-component-or-pattern"
            candidate = chart_component["name"]
            component_path = first_component_path(chart_component)
            evidence = (
                f"chart-like region inferred as {chart_type} with {chart.get('confidence', 'medium')} confidence; "
                f"matched project chart component"
            )
            chart_library_name = str(proven_chart_library.get("name", "")) if proven_chart_library else ""
            chart_library_source = "project-component"
        elif proven_chart_library:
            decision = "use-installed-chart-library"
            chart_library_name = str(proven_chart_library.get("name", ""))
            candidate = f"{chart_library_name} {chart_type}"
            component_path = ""
            evidence = (
                f"chart-like region inferred as {chart_type} with {chart.get('confidence', 'medium')} confidence; "
                f"using proven installed chart library {chart_library_name}"
            )
            chart_library_source = "installed-and-proven"
        else:
            decision = "use-echarts-fallback"
            chart_library_name = "ECharts"
            candidate = f"ECharts {chart_type}"
            component_path = ""
            evidence = (
                f"chart-like region inferred as {chart_type} with {chart.get('confidence', 'medium')} confidence; "
                f"no proven project chart component/library evidence, fallback to ECharts"
            )
            chart_library_source = "fallback-echarts"
        if signals:
            evidence = f"{evidence}; signals={signals}"
        slots.append({
            "slot": f"chart:{chart.get('owner') or index}",
            "kind": "chart",
            "bbox": chart.get("bbox", {}),
            "decision": decision,
            "candidate": candidate,
            "componentPath": component_path,
            "evidence": evidence,
            "constraint": "preserve chart type, axis/legend text, and local filters inside the original chart region",
            "chartType": chart_type,
            "confidence": chart.get("confidence", ""),
            "chartLibrary": chart_library_name,
            "chartLibrarySource": chart_library_source,
            "fallbackExpression": chart.get("fallbackExpression", ""),
        })

    for index, icon in enumerate(icon_candidates):
        library_suggestion = str(icon.get("librarySuggestion", "") or "")
        nearby_texts = ", ".join(icon.get("nearbyTexts", [])[:4])
        real_svg_asset = bool(icon.get("realSvgAsset"))
        if library_suggestion:
            decision = "use-installed-icon-library-if-shape-matches"
            candidate = library_suggestion
            evidence = f"source icon looks like {icon.get('iconRole', 'icon')}; nearbyTexts={nearby_texts or 'none'}"
        elif real_svg_asset:
            decision = "preserve-source-svg-fallback"
            candidate = "source svg"
            evidence = f"real source svg asset kept as fallback; reason={icon.get('fallbackReason', '')}; nearbyTexts={nearby_texts or 'none'}"
        else:
            decision = "semantic-remap-required"
            candidate = icon.get("iconRole") or "semantic icon"
            evidence = f"placeholder vector cannot be used as final icon fallback; infer semantic content for this slot first; nearbyTexts={nearby_texts or 'none'}"
        slots.append({
            "slot": f"icon:{icon.get('owner') or index}",
            "kind": "icon",
            "bbox": icon.get("bbox", {}),
            "decision": decision,
            "candidate": candidate,
            "componentPath": "",
            "evidence": evidence,
            "constraint": "real svg asset may fallback to source svg; placeholder vector must be replaced by the semantically correct content/icon for this slot",
            "iconRole": icon.get("iconRole", ""),
            "svgFallback": icon.get("svgMarkup", ""),
            "iconLibrarySource": icon.get("librarySource", ""),
        })

    table_candidate = top_candidate(component_matches, "table")
    tabs_candidate = top_candidate(component_matches, "tabs")
    for table in table_structures:
        slots.append({
            "slot": "table-structure:main",
            "kind": "table",
            "bbox": table.get("bbox", {}),
            "decision": "reuse-project-component-or-pattern" if table_candidate else "use-ui-library",
            "candidate": table_candidate["name"] if table_candidate else component_name(ui_library, "table"),
            "componentPath": first_component_path(table_candidate) if table_candidate else "",
            "evidence": "detected stable header row, data rows, and column-aligned values",
            "constraint": "preserve table columns, rows, pagination, and composite cell ownership",
        })
        for cell in table.get("compositeCells", []):
            slots.append({
                "slot": f"composite-cell:{cell.get('columnTitle', '')}",
                "kind": "composite-cell",
                "bbox": cell.get("cellBbox", {}),
                "decision": "fidelity-or-custom-render",
                "candidate": "column render with nested cell content",
                "componentPath": "",
                "evidence": f"detected composite table cell under column {cell.get('columnTitle', '')}",
                "constraint": "keep this composite content inside its table column and row",
            })
    for section in sections:
        title = section.get("title", "")
        texts = " ".join(section.get("texts", []))
        lower = texts.lower()
        if description_like_layout(section):
            if len(section.get("tagStripTexts", [])) >= 2:
                decision = "reuse-project-component-or-pattern" if tabs_candidate else "use-ui-library"
                candidate = tabs_candidate["name"] if tabs_candidate else component_name(ui_library, "tabs")
                path = first_component_path(tabs_candidate) if tabs_candidate else ""
                evidence = (
                    "field-heavy detail section also has a stable tab strip; keep detail layout inside each tab panel"
                    if tabs_candidate
                    else f"field-heavy detail section with stable tab strip; uiLibrary={ui_library_name}"
                )
            else:
                decision = "fidelity-or-descriptions"
                candidate = "Descriptions or fidelity structure"
                path = ""
                evidence = "field-heavy detail section; preserve vertical Descriptions/field-block layout unless the local region has explicit control evidence"
        elif section_has_real_table_evidence(section):
            if table_candidate:
                decision = "reuse-project-component-or-pattern"
                candidate = table_candidate["name"]
                path = first_component_path(table_candidate)
                evidence = "section has explicit table/pagination/list evidence and project candidate exists"
            else:
                decision = "use-ui-library"
                candidate = component_name(ui_library, "table")
                path = ""
                evidence = f"section has explicit table/pagination/list evidence; uiLibrary={ui_library_name}"
        elif any(term in lower for term in ["tab", "\u9009\u9879\u5361"]) or len(section.get("tagStripTexts", [])) >= 2:
            decision = "reuse-project-component-or-pattern" if tabs_candidate else "use-ui-library"
            candidate = tabs_candidate["name"] if tabs_candidate else component_name(ui_library, "tabs")
            path = first_component_path(tabs_candidate) if tabs_candidate else ""
            evidence = (
                "section resembles tabs and matched a project tabs component"
                if tabs_candidate
                else f"section resembles tabs; uiLibrary={ui_library_name}"
            )
        else:
            decision = "fidelity-only"
            candidate = ""
            path = ""
            evidence = "no component evidence for this section"
        slots.append({
            "slot": f"section:{title}",
            "kind": "section",
            "bbox": section.get("bbox", {}),
            "decision": decision,
            "candidate": candidate,
            "componentPath": path,
            "evidence": evidence,
            "constraint": "preserve section boundary; detail/Descriptions sections must keep field order and vertical rhythm",
        })

    all_texts = " ".join(item.get("text", "") for item in items).lower()
    for family, signals in {
        "pagination": ["上一页", "下一页", "条/页", "共 ", "pagination"],
        "timeline": ["时间线", "节点", "记录", "处理时间"],
        "upload": ["上传", "导入", "附件", "文件"],
        "overlay": ["更多", "+", "dropdown", "popover"],
    }.items():
        if any(signal.lower() in all_texts for signal in signals):
            candidate_match = top_candidate(component_matches, family)
            if family == "pagination":
                decision = "reuse-project-component-or-pattern" if candidate_match else "use-ui-library-control"
            elif family in {"timeline", "upload"}:
                decision = "reuse-project-component-or-pattern" if candidate_match else "use-ui-library"
            else:
                decision = "inspect-and-use-component-if-gates-pass"
            slots.append({
                "slot": f"page-detected:{family}",
                "kind": family,
                "bbox": {},
                "decision": decision,
                "candidate": candidate_match["name"] if candidate_match else component_name(ui_library, family),
                "componentPath": first_component_path(candidate_match) if candidate_match else "",
                "evidence": f"page text contains {family} signals; uiLibrary={ui_library_name}",
                "constraint": "componentize only after source content and interaction contract are mapped",
            })

    if similar_pages:
        slots.append({
            "slot": "page-pattern",
            "kind": "pattern",
            "bbox": {},
            "decision": "inspect-similar-page-before-final-code",
            "candidate": similar_pages[0].get("path", ""),
            "componentPath": similar_pages[0].get("path", ""),
            "evidence": "similar project page scored highest for manifest terms",
            "constraint": "reuse page pattern only where it does not change non-component fidelity regions",
        })

    is_conservative_mode = str(componentization_mode.get("mode", "")) == "conservative"
    if is_conservative_mode:
        defer_kinds = {
            "form",
            "filter-region",
            "progress",
            "chart",
            "table",
            "section",
            "pagination",
            "timeline",
            "upload",
            "overlay",
            "pattern",
            "composite-cell",
        }
        leaf_kinds = {"field-control", "button", "tag"}
        for slot in slots:
            kind = str(slot.get("kind", ""))
            if kind in defer_kinds:
                slot["decision"] = "review-original-html-first"
                slot["applyPriority"] = "defer-until-layout-stable"
                slot["constraint"] = (
                    "keep the original HTML structure and macro layout for this block first; "
                    "only componentize after the final block boundary, row/column ownership, and neighboring rhythm are visually stable"
                )
                slot["rawLayerAction"] = "keep source raw/fidelity structure"
                slot["contentContract"] = (
                    "preserve all source texts, values, statuses, actions, and local layout relationships inside this source region"
                )
                if kind == "chart":
                    slot["decision"] = "preserve-visual-slot-first"
                    slot["constraint"] = (
                        "do not auto-upgrade to a chart component/library from script output alone; "
                        "first keep the chart region visually intact and only replace after original HTML confirms chart ownership and local filters"
                    )
                elif kind == "table":
                    slot["decision"] = "fidelity-or-custom-render"
                    slot["constraint"] = (
                        "do not auto-upgrade this table block to AntD/Element Table from script output alone; "
                        "first preserve headers, cell grouping, row rhythm, pagination, and surrounding annotations"
                    )
            elif kind in leaf_kinds and str(slot.get("decision", "")).startswith("use-"):
                slot["decision"] = "leaf-control-candidate"
                slot["applyPriority"] = "leaf-only-after-layout-stable"
                slot["constraint"] = (
                    "only replace this leaf control after macro layout is stable; "
                    "if wrapper bbox, neighboring labels, or row rhythm shift, keep the fidelity structure"
                )

    for slot in slots:
        decision = str(slot.get("decision", ""))
        slot.setdefault("uiLibrary", ui_library_name)
        slot.setdefault("contentContract", "preserve every visible source text/value/status/control in this source region")
        slot.setdefault("layoutContract", slot.get("constraint", "stay inside the source section and preserve macro layout"))
        slot.setdefault(
            "rawLayerAction",
            "suppress only raw nodes owned by this slot" if "use-" in decision or "reuse-" in decision else "keep source raw/fidelity structure",
        )
        slot.setdefault("fallback", "split into smaller slots or use fidelity-only if any gate fails")

    return slots


def combined_bbox(boxes: list[dict[str, Any]]) -> dict[str, float]:
    valid = [box for box in boxes if {"x", "y", "w", "h"} <= set(box)]
    if not valid:
        return {}
    x0 = min(box["x"] for box in valid)
    y0 = min(box["y"] for box in valid)
    x1 = max(box["x"] + box["w"] for box in valid)
    y1 = max(box["y"] + box["h"] for box in valid)
    return {
        "x": round(x0, 2),
        "y": round(y0, 2),
        "w": round(x1 - x0, 2),
        "h": round(y1 - y0, 2),
    }


def extract_terms(items: list[dict[str, Any]], fields: list[dict[str, Any]], sections: list[dict[str, Any]]) -> list[str]:
    terms: list[str] = []
    for field in fields:
        terms.append(field["label"])
    for section in sections:
        terms.append(section["title"])
    for item in items:
        text = item["text"]
        if infer_kind(text) in {"action", "section-title", "field-label", "required-label"}:
            terms.append(text.lstrip("*"))
    stop = {"请输入", "请输入内容", "添加规则", "确定", "取消", "重置"}
    result: list[str] = []
    for term in terms:
        term = term.strip()
        if len(term) < 2 or term in stop:
            continue
        if term not in result:
            result.append(term)
    return result[:80]


def scan_similar_pages(project_root: Path | None, terms: list[str]) -> list[dict[str, Any]]:
    if not project_root or not project_root.exists():
        return []
    roots = [project_root / "src" / "pages", project_root / "src" / "views", project_root / "src"]
    files: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path in seen or not path.is_file():
                continue
            if path.suffix.lower() in {".tsx", ".jsx", ".vue", ".ts"}:
                seen.add(path)
                files.append(path)

    page_terms = terms + ["Form", "Table", "Modal", "Drawer", "Tabs", "Upload", "Chart", "Trend", "Analysis", "ECharts", "评分", "规则", "课程", "企业"]
    scored: list[dict[str, Any]] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        hits = []
        score = 0
        for term in page_terms:
            if term and term in text:
                hits.append(term)
                score += 3 if term in terms else 1
        import_hits = re.findall(r"import\s+[^;]+from\s+['\"]([^'\"]+)['\"]", text)
        component_hits = re.findall(r"<([A-Z][A-Za-z0-9]*)\b", text)
        score += min(len(set(component_hits)), 20) * 0.2
        if score > 0:
            scored.append({
                "path": str(path.relative_to(project_root)),
                "score": round(score, 2),
                "matchedTerms": hits[:20],
                "componentTags": sorted(set(component_hits))[:30],
                "imports": import_hits[:20],
            })
    return sorted(scored, key=lambda x: (-x["score"], x["path"]))[:20]


def canvas_size(nodes: list[Node]) -> dict[str, float]:
    max_r = 0.0
    max_b = 0.0
    for n in nodes:
        box = approx_text_bbox(n) if (not n.w or not n.h) and n.text else None
        width = n.w or (box["w"] if box else 0.0)
        height = n.h or (box["h"] if box else 0.0)
        if width:
            max_r = max(max_r, n.abs_x + width)
        if height:
            max_b = max(max_b, n.abs_y + height)
    return {"width": round(max_r, 2), "height": round(max_b, 2)}


def extract_visual_boxes(nodes: list[Node]) -> list[dict[str, Any]]:
    boxes: list[dict[str, Any]] = []
    for node in nodes:
        style = node.style
        approx_box = approx_text_bbox(node) if node.text else {}
        width = node.w or approx_box.get("w")
        height = node.h or approx_box.get("h")
        if not width or not height:
            continue
        area = float(width) * float(height)
        bg = style.get("background") or style.get("background-color", "")
        bg_image = style.get("background-image", "")
        has_fill = bool(bg)
        has_border = any(k == "border" or k.startswith("border-") for k in style)
        has_radius = bool(style.get("border-radius"))
        is_divider = float(width) <= 2 or float(height) <= 2
        dom_hint_text = f"{node.class_name} {node.node_id}".lower()
        svg_markup = decode_data_svg_markup(bg_image)
        descendant_tags = node_descendant_tags(node, nodes)
        has_vector_markup = bool(svg_markup) or node.tag == "svg" or "svg" in descendant_tags
        real_svg_asset = is_real_svg_asset(node, node.attrs, bg_image)
        has_chart_surface = node.tag in {"svg", "canvas"}
        has_chart_class_hint = any(hint in dom_hint_text for hint in CHART_CLASS_HINTS)
        has_svg_bg = "data:image/svg+xml" in bg_image.lower()
        svg_signal_text = f"{svg_markup} {' '.join(descendant_tags)}".lower()
        has_svg_polyline = "polyline" in svg_signal_text
        has_svg_multi_point_line = bool(re.search(r"points\\s*=\\s*['\\\"]?[^>]*[,\\s][^>]*[,\\s][^>]*[,\\s]", svg_signal_text))
        has_svg_path = "<path" in svg_signal_text or " path " in f" {svg_signal_text} "
        has_svg_circle = "<circle" in svg_signal_text or " circle " in f" {svg_signal_text} "
        has_svg_arrow_polygon = "polygon" in svg_signal_text and (
            float(width) <= 20
            or float(height) <= 20
        )
        is_likely_chart_svg = (
            float(width) >= 56
            and float(height) >= 20
            and (has_svg_polyline or has_svg_multi_point_line or has_svg_path)
        )
        is_likely_icon_svg = (
            has_vector_markup
            and float(width) <= 24
            and float(height) <= 24
            and not is_likely_chart_svg
        ) or has_svg_arrow_polygon or (
            has_vector_markup
            and float(width) <= 20
            and float(height) <= 20
            and not has_svg_multi_point_line
            and not (has_svg_path and float(width) >= 40)
        )
        if not (has_fill or has_border or has_radius or is_divider or has_chart_surface or has_chart_class_hint or has_svg_bg):
            continue
        node_area = float(width) * float(height)
        if node_area < 16 and not is_divider:
            continue
        if node_area < 40 and not node.text and not is_divider:
            continue
        kind = "box"
        if is_likely_icon_svg:
            kind = "icon-fragment"
        elif has_chart_surface or is_likely_chart_svg:
            kind = "chart-surface"
        elif node.abs_y <= 80 and float(width) > 800:
            kind = "header"
        elif is_divider:
            kind = "divider"
        elif float(width) > 320 and float(height) > 120:
            kind = "panel"
        elif 24 <= float(height) <= 58 and 40 <= float(width) <= 320:
            kind = "control"
        elif float(width) <= 40 and float(height) <= 40:
            kind = "icon-fragment"
        shape_hint = ""
        if kind == "icon-fragment":
            shape_hint = "icon-svg"
        elif has_chart_surface or is_likely_chart_svg:
            if has_svg_polyline or has_svg_multi_point_line:
                shape_hint = "line-fragment"
            elif has_svg_path and float(width) >= 56 and float(height) >= 20:
                shape_hint = "line-fragment"
            else:
                shape_hint = "chart-surface"
        elif is_divider and max(float(width), float(height)) >= 28:
            shape_hint = "line-fragment"
        elif not node.text and 4 <= min(float(width), float(height)) <= 18 and max(float(width), float(height)) / max(min(float(width), float(height)), 1) <= 1.8:
            shape_hint = "dot-fragment"
        elif not node.text and ((6 <= float(width) <= 32 and float(height) >= 18) or (6 <= float(height) <= 24 and float(width) >= 48)):
            shape_hint = "bar-fragment"
        elif not node.text and has_fill and float(width) >= 72 and float(height) >= 24 and (
            (
                "linear-gradient" in bg.lower()
                and (
                    "clip-path" in style
                    or "polygon(" in style.get("clip-path", "").lower()
                    or "url(" in str(style.get("background-image", "")).lower()
                    or node.tag in {"svg", "canvas"}
                )
            )
            or (
                style.get("opacity") not in {"", "1", "1.0"}
                and ("clip-path" in style or node.tag in {"svg", "canvas"})
            )
        ):
            shape_hint = "area-fragment"
            if kind == "panel" and "clip-path" not in style and node.tag not in {"svg", "canvas"}:
                shape_hint = ""
        elif has_chart_class_hint:
            shape_hint = "chart-class-hint"
        elif has_svg_bg:
            shape_hint = "line-fragment"
        boxes.append({
            "nodeId": node.node_id,
            "kind": kind,
            "bbox": {
                "x": round(node.abs_x, 2),
                "y": round(node.abs_y, 2),
                "w": round(float(width), 2),
                "h": round(float(height), 2),
            },
            "zIndex": int(px(style.get("z-index")) or 0),
            "background": bg,
            "backgroundImage": bg_image,
            "border": style.get("border", ""),
            "borderRadius": style.get("border-radius", ""),
            "opacity": style.get("opacity", ""),
            "tag": node.tag,
            "className": node.class_name,
            "hasText": bool(node.text),
            "shapeHint": shape_hint,
            "chartClassHint": has_chart_class_hint,
            "svgMarkup": svg_markup[:1200] if svg_markup else "",
            "realSvgAsset": real_svg_asset,
            "isLikelyIconSvg": is_likely_icon_svg,
            "isLikelyChartSvg": is_likely_chart_svg,
            "svgSignalText": svg_signal_text[:1200] if svg_signal_text else "",
        })
    boxes.sort(key=lambda item: (item["zIndex"], item["bbox"]["y"], item["bbox"]["x"]))
    return boxes[:600]


TABLE_HEADER_TERMS = {
    "参观主题", "参观展厅", "参观时间", "参观形式", "访客类型",
    "来访企业", "访客人数", "数智体验官", "申请人", "状态", "操作",
    "备案主体信息", "备案主体类型", "核验结果", "差异结果", "二级分行", "管户机构", "处理人", "期望完成时间",
}


def row_group_bbox(row_items: list[dict[str, Any]]) -> dict[str, float]:
    return combined_bbox([it["bbox"] for it in row_items])


def group_items_by_y(items: list[dict[str, Any]], tolerance: float = 8.0) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    for item in sorted(items, key=lambda it: (it["bbox"]["y"], it["bbox"]["x"])):
        if not groups:
            groups.append([item])
            continue
        last_group = groups[-1]
        ref_y = sum(member["bbox"]["y"] for member in last_group) / len(last_group)
        if abs(item["bbox"]["y"] - ref_y) <= tolerance:
            last_group.append(item)
        else:
            groups.append([item])
    return groups


def detect_table_grid(items: list[dict[str, Any]], visual_boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    header_candidates = [it for it in items if it["text"] in TABLE_HEADER_TERMS]
    if len(header_candidates) < 6:
        return []
    header_groups = group_items_by_y(header_candidates, tolerance=8.0)
    ranked_header_groups = []
    for group in header_groups:
        xs = sorted(it["bbox"]["x"] for it in group)
        distinct_x = len({round(x / 24) for x in xs})
        span = (max(xs) - min(xs)) if xs else 0
        ranked_header_groups.append((len(group), distinct_x, span, group))
    ranked_header_groups.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    headers = sorted(ranked_header_groups[0][3], key=lambda it: it["bbox"]["x"]) if ranked_header_groups else []
    if len(headers) < 6:
        return []
    header_y = min(it["bbox"]["y"] for it in headers)

    row_texts = [
        it for it in items
        if it["bbox"]["y"] > header_y + 24
        and it["bbox"]["y"] < header_y + 520
        and len(it["text"]) > 0
    ]
    rows: list[list[dict[str, Any]]] = []
    for group in group_items_by_y(row_texts, tolerance=8.0):
        row_items = sorted(group, key=lambda it: it["bbox"]["x"])
        distinct_x = len({round(it["bbox"]["x"] / 24) for it in row_items})
        if len(row_items) >= 8 and distinct_x >= 8:
            rows.append(row_items)
    if not rows:
        for group in group_items_by_y(row_texts, tolerance=10.0):
            row_items = sorted(group, key=lambda it: it["bbox"]["x"])
            if not row_items:
                continue
            if any(str(it["text"]).startswith(LIST_RECORD_PREFIXES) for it in row_items):
                continue
            distinct_x = len({round(it["bbox"]["x"] / 24) for it in row_items})
            if len(row_items) >= 4 and distinct_x >= 4:
                rows.append(row_items)
    if not rows:
        return []

    columns = []
    for idx, head in enumerate(headers):
        x0 = head["bbox"]["x"] - 16
        x1 = headers[idx + 1]["bbox"]["x"] - 16 if idx + 1 < len(headers) else head["bbox"]["x"] + 240
        columns.append({
            "title": head["text"],
            "xStart": round(x0, 2),
            "xEnd": round(x1, 2),
            "headerBbox": head["bbox"],
        })

    composite_cells = []
    row_boxes = []
    for row in rows:
        bbox = row_group_bbox(row)
        row_boxes.append(bbox)
        for col in columns:
            cell_texts = [
                it for it in row
                if col["xStart"] <= it["bbox"]["x"] <= col["xEnd"]
            ]
            nearby_boxes = [
                box for box in visual_boxes
                if bbox["y"] - 6 <= box["bbox"]["y"] <= bbox["y"] + bbox["h"] + 6
                and col["xStart"] <= box["bbox"]["x"] <= col["xEnd"]
            ]
            if not cell_texts and not nearby_boxes:
                continue
            has_blue_name = any(str(it.get("color", "")).lower() == "#1774ff" and len(it["text"]) >= 4 for it in cell_texts)
            has_small_box = any(box["kind"] in {"icon-fragment", "control"} for box in nearby_boxes)
            if has_blue_name or has_small_box:
                composite_cells.append({
                    "columnTitle": col["title"],
                    "rowBbox": bbox,
                    "cellBbox": combined_bbox([it["bbox"] for it in cell_texts] + [box["bbox"] for box in nearby_boxes]),
                    "texts": [it["text"] for it in cell_texts[:8]],
                    "hasBlueName": has_blue_name,
                    "hasAuxBox": has_small_box,
                    "type": "composite-table-cell",
                })

    return [{
        "kind": "table",
        "bbox": combined_bbox([col["headerBbox"] for col in columns] + row_boxes),
        "columns": columns,
        "rowCount": len(rows),
        "compositeCells": composite_cells,
    }]


def compact_text(value: str) -> str:
    return re.sub(r"\s+", "", value).strip().lower()


def signal_hits(texts: list[str], terms: set[str]) -> list[str]:
    compact_texts = [compact_text(text) for text in texts if text]
    hits: list[str] = []
    for term in sorted(terms):
        target = compact_text(term)
        if target and any(target in text for text in compact_texts):
            hits.append(term)
    return hits


def looks_like_axis_label(text: str) -> bool:
    value = text.strip()
    if not value or len(value) > 12:
        return False
    lower = value.lower()
    if re.fullmatch(r"\d{1,4}(?:[./-]\d{1,2}){0,2}", value):
        return True
    if re.fullmatch(r"\d+(?:\.\d+)?%?", value):
        return True
    if re.fullmatch(r"\d{1,2}:\d{2}", value):
        return True
    if re.fullmatch(r"(q[1-4]|q[1-4]\d{4})", lower):
        return True
    if re.fullmatch(r"\d{1,2}(日|月|周|年)", value):
        return True
    if re.fullmatch(r"(周一|周二|周三|周四|周五|周六|周日)", value):
        return True
    return lower in {"mon", "tue", "wed", "thu", "fri", "sat", "sun", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}


def infer_chart_type(texts: list[str], line_count: int, bar_count: int, dot_count: int, area_count: int) -> str:
    hits = set(signal_hits(texts, CHART_SIGNAL_WORDS))
    if hits & CHART_TYPE_HINTS["donut"]:
        return "donut"
    if hits & CHART_TYPE_HINTS["pie"]:
        return "pie"
    if hits & CHART_TYPE_HINTS["radar"]:
        return "radar"
    if hits & CHART_TYPE_HINTS["funnel"]:
        return "funnel"
    if hits & CHART_TYPE_HINTS["scatter"]:
        return "scatter"
    if hits & CHART_TYPE_HINTS["gauge"]:
        return "gauge"
    if hits & CHART_TYPE_HINTS["bar"] or (bar_count >= 4 and bar_count >= line_count + 1):
        return "bar-ranking" if hits & RANKING_SIGNAL_WORDS else "bar"
    if (hits & CHART_TYPE_HINTS["area"]) or (area_count >= 1 and line_count >= 1):
        return "area-line"
    if (hits & CHART_TYPE_HINTS["line"]) or line_count >= 1:
        return "line"
    if dot_count >= 6:
        return "scatter"
    if hits & RANKING_SIGNAL_WORDS:
        return "ranking-list"
    return "chart"


def chart_type_family(chart_type: str) -> str:
    low = str(chart_type or "").lower()
    if low in {"line", "area-line"}:
        return "line-family"
    if low in {"bar", "bar-ranking"}:
        return "bar-family"
    if low in {"pie", "donut"}:
        return "pie-family"
    return low or "unknown"


def bbox_center(box: dict[str, Any]) -> tuple[float, float]:
    return (
        float(box.get("x", 0) or 0) + float(box.get("w", 0) or 0) / 2,
        float(box.get("y", 0) or 0) + float(box.get("h", 0) or 0) / 2,
    )


def chart_candidates_duplicate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    bbox_a = a.get("bbox") or {}
    bbox_b = b.get("bbox") or {}
    if not bbox_a or not bbox_b:
        return False
    family_a = chart_type_family(str(a.get("chartType", "")))
    family_b = chart_type_family(str(b.get("chartType", "")))
    if family_a != family_b:
        return False
    if str(a.get("owner", "")) and str(a.get("owner", "")) == str(b.get("owner", "")):
        return True
    if overlap_ratio(bbox_a, bbox_b) >= 0.74 or overlap_ratio(bbox_b, bbox_a) >= 0.74:
        return True
    source_pair = {str(a.get("source", "")), str(b.get("source", ""))}
    if "metric-card" not in source_pair:
        return False
    ax, ay = bbox_center(bbox_a)
    bx, by = bbox_center(bbox_b)
    center_distance = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
    smaller_edge = max(
        48.0,
        min(
            float(bbox_a.get("w", 0) or 0),
            float(bbox_a.get("h", 0) or 0),
            float(bbox_b.get("w", 0) or 0),
            float(bbox_b.get("h", 0) or 0),
        ),
    )
    return center_distance <= smaller_edge * 1.25


def conservative_chart_expression(chart_type: str) -> str:
    return {
        "bar": "conservative-bar-series-block",
        "bar-ranking": "conservative-bar-ranking-block",
        "line": "conservative-line-trend-block",
        "area-line": "conservative-area-line-trend-block",
        "pie": "conservative-pie-summary-block",
        "donut": "conservative-donut-summary-block",
        "radar": "conservative-radar-summary-block",
        "funnel": "conservative-funnel-summary-block",
        "scatter": "conservative-scatter-distribution-block",
        "gauge": "conservative-gauge-summary-block",
        "ranking-list": "conservative-ranking-list-block",
    }.get(chart_type, "conservative-chart-summary-block")


def is_percent_text(text: str) -> bool:
    value = clean_text(text)
    if not value:
        return False
    compact = compact_text(value)
    if "%" not in compact and "％" not in compact:
        return False
    return bool(re.search(r"(100(?:\.0+)?)|([1-9]?\d(?:\.\d+)?)\s*[%％]", compact))


def extract_percent_value(text: str) -> float | None:
    compact = compact_text(text).replace("％", "%")
    match = re.search(r"((?:100(?:\.0+)?)|(?:[1-9]?\d(?:\.\d+)?))\s*%", compact)
    if not match:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    if 0 <= value <= 100:
        return value
    return None


def box_as_progress_fill(box: dict[str, Any]) -> bool:
    bbox = box.get("bbox") or {}
    w = float(bbox.get("w", 0) or 0)
    h = float(bbox.get("h", 0) or 0)
    if w < 24 or h <= 0:
        return False
    ratio = w / max(h, 1)
    return 3.0 <= ratio <= 40 and 4 <= h <= 18


def box_as_progress_track(box: dict[str, Any]) -> bool:
    bbox = box.get("bbox") or {}
    w = float(bbox.get("w", 0) or 0)
    h = float(bbox.get("h", 0) or 0)
    bg = str(box.get("background", "") or "").lower()
    radius = str(box.get("borderRadius", "") or "").lower()
    if w < 36 or h < 4:
        return False
    ratio = w / max(h, 1)
    if not (3.0 <= ratio <= 60 and h <= 24):
        return False
    return bool(bg or radius)


def line_progress_relation_score(text_box: dict[str, Any], box_bbox: dict[str, Any]) -> int:
    text_center_x = text_box.get("x", 0) + text_box.get("w", 0) / 2
    text_center_y = text_box.get("y", 0) + text_box.get("h", 0) / 2
    box_center_x = box_bbox.get("x", 0) + box_bbox.get("w", 0) / 2
    box_center_y = box_bbox.get("y", 0) + box_bbox.get("h", 0) / 2
    dy = abs(box_center_y - text_center_y)
    dx_left = text_box.get("x", 0) - (box_bbox.get("x", 0) + box_bbox.get("w", 0))
    dx_right = box_bbox.get("x", 0) - (text_box.get("x", 0) + text_box.get("w", 0))
    horizontal_gap = min(abs(dx_left), abs(dx_right))
    overlap_y = not (
        box_bbox.get("y", 0) + box_bbox.get("h", 0) < text_box.get("y", 0) - 14
        or text_box.get("y", 0) + text_box.get("h", 0) < box_bbox.get("y", 0) - 14
    )
    score = 0
    if dy <= 18:
        score += 3
    elif dy <= 28:
        score += 1
    if overlap_y:
        score += 2
    if -20 <= dx_left <= 180 or -20 <= dx_right <= 180:
        score += 2
    elif horizontal_gap <= 240:
        score += 1
    return score


def pick_progress_fill_and_track(candidate_boxes: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    if not candidate_boxes:
        return {}, None
    fills = [box for box in candidate_boxes if box_as_progress_fill(box)]
    fills.sort(key=lambda box: area(box.get("bbox", {})), reverse=True)
    fill_box = (fills[0] if fills else candidate_boxes[0]).get("bbox", {})
    track_box: dict[str, Any] | None = None
    for box in sorted(candidate_boxes, key=lambda box: area(box.get("bbox", {})), reverse=True):
        bbox = box.get("bbox", {})
        if bbox == fill_box:
            continue
        if not box_as_progress_track(box):
            continue
        if overlap_ratio(fill_box, bbox) >= 0.72 or overlap_ratio(bbox, fill_box) >= 0.72:
            track_box = bbox
            break
    return fill_box, track_box


def box_as_circle_progress_candidate(box: dict[str, Any]) -> bool:
    bbox = box.get("bbox") or {}
    w = float(bbox.get("w", 0) or 0)
    h = float(bbox.get("h", 0) or 0)
    if w < 28 or h < 28:
        return False
    ratio_diff = abs(w - h)
    radius = str(box.get("borderRadius", "") or "").lower()
    bg = str(box.get("background", "") or "").lower()
    return ratio_diff <= max(8.0, min(w, h) * 0.18) and (
        "50%" in radius
        or "999" in radius
        or "conic-gradient" in bg
        or "radial-gradient" in bg
    )


def looks_like_chart_region_from_boxes(local_boxes: list[dict[str, Any]]) -> bool:
    if not local_boxes:
        return False
    line_count = sum(1 for box in local_boxes if box.get("shapeHint") == "line-fragment")
    bar_count = sum(1 for box in local_boxes if box.get("shapeHint") == "bar-fragment")
    dot_count = sum(1 for box in local_boxes if box.get("shapeHint") == "dot-fragment")
    area_count = sum(1 for box in local_boxes if box.get("shapeHint") == "area-fragment")
    surface_count = sum(1 for box in local_boxes if box.get("kind") == "chart-surface")
    class_hint_count = sum(1 for box in local_boxes if box.get("chartClassHint"))
    return (
        surface_count >= 1
        or class_hint_count >= 1
        or (line_count >= 1 and area_count >= 1)
        or line_count >= 2
        or bar_count >= 3
        or dot_count >= 4
    )


def looks_like_progress_strip(bbox: dict[str, Any], local_boxes: list[dict[str, Any]]) -> bool:
    w = float(bbox.get("w", 0) or 0)
    h = float(bbox.get("h", 0) or 0)
    if w < 48 or h <= 0:
        return False
    ratio = w / max(h, 1.0)
    if ratio < 2.8 or h > 24:
        return False
    if looks_like_chart_region_from_boxes(local_boxes):
        return False
    return True


def looks_like_metric_card_region(container: dict[str, Any]) -> bool:
    texts = [str(text) for text in container.get("texts", [])]
    if len(texts) < 4:
        return False
    has_delta = any("%" in text or "pct" in text.lower() for text in texts)
    has_metric_value = any(re.search(r"\d", text) for text in texts)
    return has_delta and has_metric_value


def detect_progress_candidates(
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    table_structures: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    # Matching priority: chart > percentage progress > gradient-only decoration.
    percent_items = [item for item in items if is_percent_text(str(item.get("text", "")))]
    candidates: list[dict[str, Any]] = []
    for item in percent_items:
        text_box = item.get("bbox") or {}
        if not text_box:
            continue
        nearby_boxes = []
        for box in visual_boxes:
            bbox = box.get("bbox") or {}
            if not bbox:
                continue
            if not (box_as_progress_fill(box) or box_as_progress_track(box)):
                continue
            relation_score = line_progress_relation_score(text_box, bbox)
            if relation_score >= 4:
                nearby_boxes.append(box)
        if not nearby_boxes:
            continue
        fill_box, track_box = pick_progress_fill_and_track(nearby_boxes)
        if not fill_box:
            continue
        in_table = any(
            table.get("bbox") and (
                overlap_ratio(fill_box, table.get("bbox", {})) >= 0.7
                or overlap_ratio(table.get("bbox", {}), fill_box) >= 0.7
            )
            for table in table_structures
        )
        bg_hint = str(nearby_boxes[0].get("background", "")).lower()
        evidence = [f"percent={item.get('text', '')}", f"fill={fill_box}"]
        if track_box:
            evidence.append(f"track={track_box}")
        if "gradient" in bg_hint:
            evidence.append("gradient-fill")
        percent_value = extract_percent_value(str(item.get("text", "")))
        if percent_value is not None:
            evidence.append(f"percentValue={percent_value}")
        candidates.append({
            "owner": f"progress@{int(text_box.get('x', 0))},{int(text_box.get('y', 0))}",
            "bbox": combined_bbox([text_box, fill_box, track_box or {}]),
            "percentText": str(item.get("text", "")),
            "fillBox": fill_box,
            "trackBox": track_box or {},
            "confidence": "high" if track_box or len(nearby_boxes) >= 2 else "medium",
            "evidence": evidence,
            "componentType": "progress-line",
            "progressType": "line",
            "inTableCell": in_table,
        })
    deduped: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda item: (-area(item.get("bbox", {})), item.get("owner", ""))):
        if any(
            overlap_ratio(candidate.get("bbox", {}), kept.get("bbox", {})) >= 0.78
            or overlap_ratio(kept.get("bbox", {}), candidate.get("bbox", {})) >= 0.78
            for kept in deduped
        ):
            continue
        deduped.append(candidate)

    for item in percent_items:
        text_box = item.get("bbox") or {}
        if not text_box:
            continue
        circle_boxes = []
        for box in visual_boxes:
            bbox = box.get("bbox") or {}
            if not bbox or not box_as_circle_progress_candidate(box):
                continue
            center_x = bbox.get("x", 0) + bbox.get("w", 0) / 2
            center_y = bbox.get("y", 0) + bbox.get("h", 0) / 2
            text_center_x = text_box.get("x", 0) + text_box.get("w", 0) / 2
            text_center_y = text_box.get("y", 0) + text_box.get("h", 0) / 2
            inside_circle = (
                abs(center_x - text_center_x) <= bbox.get("w", 0) * 0.28
                and abs(center_y - text_center_y) <= bbox.get("h", 0) * 0.28
            )
            near_circle = (
                abs(center_y - text_center_y) <= bbox.get("h", 0) * 0.55
                and 0 <= text_box.get("x", 0) - (bbox.get("x", 0) + bbox.get("w", 0)) <= 80
            )
            if inside_circle or near_circle:
                circle_boxes.append(box)
        if not circle_boxes:
            continue
        circle_boxes.sort(key=lambda box: area(box.get("bbox", {})), reverse=True)
        main_box = circle_boxes[0].get("bbox", {})
        if any(
            table.get("bbox") and (
                overlap_ratio(main_box, table.get("bbox", {})) >= 0.7
                or overlap_ratio(table.get("bbox", {}), main_box) >= 0.7
            )
            for table in table_structures
        ):
            continue
        bg_hint = str(circle_boxes[0].get("background", "")).lower()
        is_dashboard = main_box.get("h", 0) < main_box.get("w", 0) * 0.82 or "dashboard" in bg_hint or "gauge" in bg_hint
        progress_type = "dashboard" if is_dashboard else "circle"
        evidence = [f"percent={item.get('text', '')}", f"ring={main_box}"]
        if "conic-gradient" in bg_hint:
            evidence.append("conic-gradient")
        deduped.append({
            "owner": f"progress@{int(text_box.get('x', 0))},{int(text_box.get('y', 0))}",
            "bbox": combined_bbox([text_box, main_box]),
            "percentText": str(item.get("text", "")),
            "fillBox": main_box,
            "trackBox": {},
            "confidence": "high" if text_box.get("x", 0) >= main_box.get("x", 0) and text_box.get("x", 0) + text_box.get("w", 0) <= main_box.get("x", 0) + main_box.get("w", 0) else "medium",
            "evidence": evidence,
            "componentType": f"progress-{progress_type}",
            "progressType": progress_type,
            "inTableCell": False,
        })

    result: list[dict[str, Any]] = []
    for candidate in sorted(deduped, key=lambda item: (-area(item.get("bbox", {})), item.get("componentType", ""))):
        if any(
            overlap_ratio(candidate.get("bbox", {}), kept.get("bbox", {})) >= 0.82
            or overlap_ratio(kept.get("bbox", {}), candidate.get("bbox", {})) >= 0.82
            for kept in result
        ):
            continue
        result.append(candidate)
    for box in visual_boxes:
        bbox = box.get("bbox") or {}
        if not bbox or bbox.get("w", 0) < 90 or bbox.get("h", 0) < 28:
            continue
        bg = str(box.get("background", "")).lower()
        shape = str(box.get("shapeHint", "")).lower()
        if "linear-gradient" not in bg and shape != "area-fragment":
            continue
        container_items = [item for item in items if center_inside(item.get("bbox", {}), bbox, 140)]
        container_texts = [item.get("text", "") for item in container_items]
        local_boxes = [other for other in visual_boxes if other.get("bbox") and center_inside(other.get("bbox", {}), bbox, 8)]
        if not looks_like_metric_card_region({"texts": container_texts}):
            continue
        if not looks_like_progress_strip(bbox, local_boxes):
            continue
        progress_text = next((text for text in container_texts if is_percent_text(str(text))), "")
        candidate = {
            "owner": f"sparkline@{int(bbox.get('x', 0))},{int(bbox.get('y', 0))}",
            "bbox": bbox,
            "percentText": str(progress_text),
            "fillBox": bbox,
            "trackBox": {},
            "confidence": "medium",
            "evidence": ["sparkline-gradient-box", f"bbox={bbox}"],
            "componentType": "progress-line",
            "progressType": "line",
            "inTableCell": False,
        }
        if any(
            overlap_ratio(candidate.get("bbox", {}), kept.get("bbox", {})) >= 0.82
            or overlap_ratio(kept.get("bbox", {}), candidate.get("bbox", {})) >= 0.82
            for kept in result
        ):
            continue
        result.append(candidate)
    return result[:24]


def detect_chart_candidates(
    items: list[dict[str, Any]],
    sections: list[dict[str, Any]],
    regions: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    table_structures: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    containers: list[dict[str, Any]] = []
    for section in sections:
        bbox = section.get("contentBbox") or section.get("containerBbox") or section.get("bbox") or {}
        if bbox:
            containers.append({
                "owner": section.get("ownerPath") or section.get("title") or "section",
                "bbox": bbox,
                "texts": section.get("texts", []),
                "source": "section",
            })
    for box in visual_boxes:
        bbox = box.get("bbox") or {}
        if not bbox or area(bbox) < 18000:
            continue
        if box.get("kind") not in {"panel", "chart-surface"} and box.get("shapeHint") not in {"chart-surface", "chart-class-hint"}:
            continue
        containers.append({
            "owner": f"panel@{int(bbox.get('x', 0))},{int(bbox.get('y', 0))}",
            "bbox": bbox,
            "texts": [],
            "source": "visual-panel",
        })
        if box.get("kind") in {"box", "control"} and 18000 <= area(bbox) <= 26000:
            local_items = [item for item in items if center_inside(item.get("bbox", {}), bbox, 10)]
            local_texts = [item.get("text", "") for item in local_items]
            if looks_like_metric_card_region({"texts": local_texts}):
                containers.append({
                    "owner": f"metric-card@{int(bbox.get('x', 0))},{int(bbox.get('y', 0))}",
                    "bbox": bbox,
                    "texts": local_texts,
                    "source": "metric-card",
                })
    if not containers:
        for region in regions:
            if region.get("name") == "main-content" and region.get("bbox"):
                containers.append({
                    "owner": "main-content",
                    "bbox": region["bbox"],
                    "texts": region.get("texts", []),
                    "source": "region",
                })
    if not containers:
        metric_panel_boxes = [
            box for box in visual_boxes
            if box.get("bbox")
            and box.get("kind") in {"panel", "box"}
            and area(box.get("bbox", {})) >= 90000
        ]
        for box in metric_panel_boxes[:12]:
            bbox = box.get("bbox") or {}
            local_items = [item for item in items if center_inside(item.get("bbox", {}), bbox, 8)]
            if looks_like_metric_card_region({"texts": [item.get("text", "") for item in local_items]}):
                containers.append({
                    "owner": f"metric-panel@{int(bbox.get('x', 0))},{int(bbox.get('y', 0))}",
                    "bbox": bbox,
                    "texts": [item.get("text", "") for item in local_items],
                    "source": "visual-panel",
                })
    if not any(container.get("source") == "metric-card" for container in containers):
        for box in visual_boxes:
            bbox = box.get("bbox") or {}
            if not bbox or not (18000 <= area(bbox) <= 26000):
                continue
            local_items = [item for item in items if center_inside(item.get("bbox", {}), bbox, 10)]
            local_boxes = [other for other in visual_boxes if other.get("bbox") and center_inside(other.get("bbox", {}), bbox, 8)]
            local_texts = [item.get("text", "") for item in local_items]
            line_count = sum(1 for other in local_boxes if other.get("shapeHint") == "line-fragment")
            area_count = sum(1 for other in local_boxes if other.get("shapeHint") == "area-fragment")
            if looks_like_metric_card_region({"texts": local_texts}) and line_count >= 1 and area_count >= 1:
                containers.append({
                    "owner": f"metric-card@{int(bbox.get('x', 0))},{int(bbox.get('y', 0))}",
                    "bbox": bbox,
                    "texts": local_texts,
                    "source": "metric-card",
                })

    candidates: list[dict[str, Any]] = []
    for container in containers:
        bbox = container.get("bbox") or {}
        if not bbox or area(bbox) < 18000:
            continue
        local_items = [item for item in items if center_inside(item.get("bbox", {}), bbox, 8)]
        local_boxes = [
            box for box in visual_boxes
            if box.get("bbox") and (
                center_inside(box.get("bbox", {}), bbox, 8)
                or overlap_ratio(box.get("bbox", {}), bbox) >= 0.55
            )
        ]
        if not local_items and not local_boxes:
            continue
        texts = list(dict.fromkeys([*container.get("texts", []), *[item["text"] for item in local_items]]))
        semantic_hits = signal_hits(texts, CHART_SIGNAL_WORDS)
        field_like_count = sum(
            1 for item in local_items
            if infer_kind(item["text"]) in {"field-label", "required-label", "placeholder", "label"}
        )
        action_count = sum(1 for item in local_items if infer_kind(item["text"]) == "action")
        table_header_count = sum(1 for item in local_items if looks_like_table_header_text(item["text"]))
        axis_label_count = sum(1 for text in texts if looks_like_axis_label(text))
        line_count = sum(1 for box in local_boxes if box.get("shapeHint") == "line-fragment")
        bar_count = sum(1 for box in local_boxes if box.get("shapeHint") == "bar-fragment")
        dot_count = sum(1 for box in local_boxes if box.get("shapeHint") == "dot-fragment")
        area_count = sum(1 for box in local_boxes if box.get("shapeHint") == "area-fragment")
        surface_count = sum(1 for box in local_boxes if box.get("kind") == "chart-surface")
        class_hint_count = sum(1 for box in local_boxes if box.get("chartClassHint"))
        compact_area_line_count = sum(
            1
            for box in local_boxes
            if box.get("shapeHint") == "area-fragment"
            and 72 <= float((box.get("bbox") or {}).get("w", 0) or 0) <= 220
            and 20 <= float((box.get("bbox") or {}).get("h", 0) or 0) <= 72
        )
        table_overlap = any(
            table.get("bbox") and (
                overlap_ratio(bbox, table.get("bbox", {})) >= 0.6
                or overlap_ratio(table.get("bbox", {}), bbox) >= 0.6
            )
            for table in table_structures
        )

        score = 0
        evidence: list[str] = []
        if semantic_hits:
            score += min(len(semantic_hits), 3) * 2
            evidence.append("semantic=" + ",".join(semantic_hits[:5]))
        if surface_count:
            score += min(surface_count, 2) * 4
            evidence.append(f"chart-surface={surface_count}")
        if class_hint_count:
            score += min(class_hint_count, 2) * 3
            evidence.append(f"class-hint={class_hint_count}")
        if bar_count >= 4:
            score += 4
            evidence.append(f"bars={bar_count}")
        elif bar_count >= 2:
            score += 2
        if line_count >= 2:
            score += 3
            evidence.append(f"lines={line_count}")
        elif line_count == 1:
            score += 1
        if dot_count >= 3:
            score += 2
            evidence.append(f"dots={dot_count}")
        if area_count >= 1 and line_count >= 1:
            score += 2
            evidence.append(f"filled-area={area_count}")
        if compact_area_line_count >= 1 and line_count >= 1:
            score += 3
            evidence.append(f"compact-area-line={compact_area_line_count}")
        if line_count >= 2 and area_count >= 2 and looks_like_metric_card_region({"texts": texts}):
            score += 4
            evidence.append("metric-sparkline-cluster")
        elif line_count >= 1 and area_count >= 1 and looks_like_metric_card_region({"texts": texts}):
            score += 2
            evidence.append("metric-sparkline")
        if axis_label_count >= 3 and (surface_count >= 1 or line_count >= 1 or bar_count >= 3):
            score += 2
            evidence.append(f"axis-labels={axis_label_count}")

        if field_like_count >= 8 and not semantic_hits:
            score -= 5
        elif field_like_count >= 5:
            score -= 2
        if action_count >= 4 and bar_count < 4 and line_count < 2:
            score -= 2
        if table_header_count >= 5:
            score -= 4
        if table_overlap:
            score -= 4

        metric_card_mode = container.get("source") == "metric-card" and looks_like_metric_card_region({"texts": texts})
        if metric_card_mode and line_count >= 1 and (area_count >= 1 or surface_count >= 1):
            score = max(score, 8)
            if "metric-sparkline-hard-match" not in evidence:
                evidence.append("metric-sparkline-hard-match")

        if score < 5:
            continue
        chart_type = "line" if metric_card_mode else infer_chart_type(texts, line_count, bar_count, dot_count, area_count)
        confidence = "high" if score >= 10 else "medium" if score >= 7 else "low"
        candidates.append({
            "owner": container.get("owner", ""),
            "source": container.get("source", ""),
            "bbox": bbox,
            "chartType": chart_type,
            "confidence": confidence,
            "score": score,
            "semanticSignals": semantic_hits[:8],
            "visualSignals": {
                "lineCount": line_count,
                "barCount": bar_count,
                "dotCount": dot_count,
                "areaCount": area_count,
                "chartSurfaceCount": surface_count,
                "axisLabelCount": axis_label_count,
            },
            "fallbackExpression": conservative_chart_expression(chart_type),
            "evidence": evidence,
        })

    source_priority = {
        "metric-card": 4,
        "visual-panel": 3,
        "section": 2,
        "region": 1,
    }
    deduped: list[dict[str, Any]] = []
    for candidate in sorted(
        candidates,
        key=lambda item: (
            -int(item.get("score", 0)),
            -source_priority.get(str(item.get("source", "")), 0),
            area(item.get("bbox", {})),
        ),
    ):
        if any(chart_candidates_duplicate(candidate, kept) for kept in deduped):
            continue
        deduped.append(candidate)
    return deduped[:20]


def detect_icon_candidates(
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
    ui_libraries: list[dict[str, Any]],
    project_root: Path | None,
) -> list[dict[str, Any]]:
    deps = package_dependencies(project_root)
    icon_library_name = "@ant-design/icons" if "@ant-design/icons" in deps else ""
    for lib in ui_libraries:
        packages = set(lib.get("packages") or [])
        if "@ant-design/icons" in packages:
            icon_library_name = "@ant-design/icons"
            break
    candidates: list[dict[str, Any]] = []
    for box in visual_boxes:
        if box.get("kind") != "icon-fragment":
            continue
        bbox = box.get("bbox") or {}
        if not bbox or area(bbox) <= 0:
            continue
        nearby_texts = [
            str(item.get("text", ""))
            for item in items
            if item.get("bbox") and intersects(item.get("bbox", {}), bbox, padding=28)
        ]
        nearby_texts = [text for text in nearby_texts if text][:6]
        joined_text = " ".join(nearby_texts)
        svg_markup = str(box.get("svgMarkup", "") or "")
        svg_signal_text = str(box.get("svgSignalText", "") or "")
        real_svg_asset = bool(box.get("realSvgAsset"))
        icon_role = "generic-icon"
        icon_nature = "semantic-placeholder"
        library_suggestion = ""
        fallback_reason = "no confirmed same-shape icon component yet"
        if "polyline" in svg_signal_text and float(bbox.get("w", 0) or 0) <= 18 and float(bbox.get("h", 0) or 0) <= 18:
            icon_role = "info-hint"
            icon_nature = "real-icon"
            library_suggestion = "InfoCircleOutlined" if icon_library_name == "@ant-design/icons" else ""
            fallback_reason = "small gray hint/info icon from source svg"
        elif "polygon" in svg_signal_text and float(bbox.get("w", 0) or 0) <= 16 and float(bbox.get("h", 0) or 0) <= 16:
            if any(token in joined_text for token in ["较同期", "%", "pct", "PCT"]):
                is_negative = any(
                    token in joined_text for token in ["-"]
                ) or "#fe2842" in str(box.get("background", "")).lower()
                icon_role = "trend-down" if is_negative else "trend-up"
                library_suggestion = "CaretDownFilled" if is_negative else "CaretUpFilled"
                if icon_library_name != "@ant-design/icons":
                    library_suggestion = ""
                fallback_reason = "small trend arrow icon paired with delta text"
            else:
                icon_role = "small-arrow"
                fallback_reason = "small source arrow icon"
        if not library_suggestion and any(token in joined_text for token in ["基本信息", "节点记录", "提交处理信息", "撤回处理信息", "审批驳回", "审批通过", "报告被退回"]):
            icon_role = "collapse-toggle"
            library_suggestion = "DownOutlined / UpOutlined" if icon_library_name == "@ant-design/icons" else ""
            fallback_reason = "section collapse/expand toggle should be inferred from nearby title/action text"
        elif not library_suggestion and any(token in joined_text for token in ["搜索关键字", "查询"]):
            icon_role = "search-affordance"
            library_suggestion = "SearchOutlined" if icon_library_name == "@ant-design/icons" else ""
            fallback_reason = "search-related placeholder vector should map to search affordance icon if shape evidence is weak"
        elif not library_suggestion and any(token in joined_text for token in ["上传文件成功", "上传", "附件"]):
            icon_role = "attachment-status"
            library_suggestion = "PaperClipOutlined / FileTextOutlined" if icon_library_name == "@ant-design/icons" else ""
            fallback_reason = "attachment/file row icon should be inferred from nearby upload/file text"
        candidates.append({
            "owner": f"icon@{int(bbox.get('x', 0))},{int(bbox.get('y', 0))}",
            "bbox": bbox,
            "iconRole": icon_role,
            "iconNature": icon_nature,
            "nearbyTexts": nearby_texts,
            "librarySuggestion": library_suggestion,
            "librarySource": icon_library_name,
            "realSvgAsset": real_svg_asset,
            "fallbackSource": "source-svg" if (real_svg_asset and svg_markup) else "semantic-remap-required",
            "fallbackReason": fallback_reason if real_svg_asset else "placeholder vector cannot be used as final icon fallback; must infer semantic content for this slot",
            "svgMarkup": svg_markup[:600] if (real_svg_asset and svg_markup) else "",
        })
    deduped: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda item: (item.get("bbox", {}).get("y", 0), item.get("bbox", {}).get("x", 0))):
        if any(
            overlap_ratio(candidate.get("bbox", {}), kept.get("bbox", {})) >= 0.82
            or overlap_ratio(kept.get("bbox", {}), candidate.get("bbox", {})) >= 0.82
            for kept in deduped
        ):
            continue
        deduped.append(candidate)
    return deduped[:24]


def detect_interaction_candidates(
    items: list[dict[str, Any]],
    visual_boxes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    text_items = [item for item in items if str(item.get("text", "")).strip()]
    for item in text_items:
        text = str(item.get("text", "")).strip()
        bbox = item.get("bbox", {})
        if text in {"查询", "搜索"}:
            candidates.append({"kind": "search-action", "label": text, "bbox": bbox, "evidence": "explicit search action text"})
        elif text == "重置":
            candidates.append({"kind": "reset-action", "label": text, "bbox": bbox, "evidence": "explicit reset action text"})
        elif text in {"展开", "收起"}:
            candidates.append({"kind": "expand-toggle", "label": text, "bbox": bbox, "evidence": "explicit expand/collapse text"})
        elif str(item.get("cursor", "")) == "pointer":
            candidates.append({"kind": "click-affordance", "label": text, "bbox": bbox, "evidence": "cursor:pointer indicates a real interaction contract, not decoration only"})
    for box in visual_boxes:
        bbox = box.get("bbox") or {}
        if not bbox:
            continue
        if box.get("kind") == "icon-fragment" and float(bbox.get("w", 0) or 0) <= 20 and float(bbox.get("h", 0) or 0) <= 20:
            nearby = [
                str(item.get("text", ""))
                for item in text_items
                if item.get("bbox") and intersects(item.get("bbox", {}), bbox, padding=40)
            ]
            nearby = [text for text in nearby if text][:6]
            if any(token in " ".join(nearby) for token in ["基本信息", "详情", "信息", "记录", "列表"]):
                candidates.append({
                    "kind": "collapse-icon",
                    "label": "",
                    "bbox": bbox,
                    "evidence": f"small toggle-like icon near section title; nearbyTexts={nearby}",
                })
    deduped: list[dict[str, Any]] = []
    for candidate in candidates:
        if any(
            candidate.get("kind") == kept.get("kind")
            and overlap_ratio(candidate.get("bbox", {}), kept.get("bbox", {})) >= 0.8
            for kept in deduped
        ):
            continue
        deduped.append(candidate)
    return deduped[:30]


def detect_filter_region(fields: list[dict[str, Any]], items: list[dict[str, Any]]) -> dict[str, Any]:
    if len(fields) < 3:
        return {}
    boxes = [field.get("bbox", {}) for field in fields if field.get("bbox")]
    if len(boxes) < 3:
        return {}
    region_box = combined_bbox(boxes)
    texts = [
        item["text"] for item in items
        if contains_bbox(region_box, item.get("bbox", {}), pad=16)
    ]
    if not any(text in {"查询", "重置"} for text in texts):
        return {}
    return {
        "bbox": region_box,
        "texts": texts,
    }


def detect_filter_region_from_table_context(items: list[dict[str, Any]], table_structures: list[dict[str, Any]]) -> dict[str, Any]:
    if not table_structures:
        return {}
    table_top = min((table.get("bbox") or {}).get("y", 10**9) for table in table_structures if table.get("bbox"))
    if table_top == 10**9:
        return {}
    candidates = [
        item for item in items
        if 120 <= item["bbox"]["y"] < table_top
        and item["bbox"]["x"] >= 220
    ]
    texts = [item["text"] for item in candidates]
    if not any(text in {"查询", "重置"} for text in texts):
        return {}
    label_like = [item for item in candidates if infer_kind(item["text"]) in {"label", "field-label", "required-label", "placeholder", "action"}]
    if len(label_like) < 8:
        return {}
    return {
        "bbox": combined_bbox([item["bbox"] for item in label_like]),
        "texts": texts,
    }


def apply_table_context_to_sections(sections: list[dict[str, Any]], table_structures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not table_structures:
        return sections
    for section in sections:
        section_box = section.get("contentBbox") or section.get("containerBbox") or section.get("bbox") or {}
        if not section_box:
            continue
        for table in table_structures:
            table_box = table.get("bbox") or {}
            if not table_box:
                continue
            if overlap_ratio(table_box, section_box) >= 0.45 or overlap_ratio(section_box, table_box) >= 0.45:
                section["containsTableStructure"] = True
                if section.get("layoutHint") in {"descriptions-vertical", "field-block-grid", ""}:
                    section["layoutHint"] = "list-table"
                contract = section.get("renderContract") or {}
                contract["kind"] = "list-table-section"
                contract["mustRenderWholeSection"] = False
                contract["contentMode"] = "table-list"
                section["renderContract"] = contract
                break
    return sections


def attach_section_title_controls(
    sections: list[dict[str, Any]],
    interaction_candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not sections or not interaction_candidates:
        return sections

    control_candidates = [
        candidate
        for candidate in interaction_candidates
        if str(candidate.get("kind", "")) in {"collapse-icon", "expand-toggle"}
        and candidate.get("bbox")
    ]
    if not control_candidates:
        return sections

    updated: list[dict[str, Any]] = []
    for section in sections:
        title_bbox = section.get("bbox") or {}
        container_bbox = section.get("containerBbox") or section.get("contentBbox") or title_bbox
        if not title_bbox or not container_bbox:
            updated.append(section)
            continue

        title_center_y = float(title_bbox.get("y", 0) or 0) + float(title_bbox.get("h", 0) or 0) / 2
        title_right = float(title_bbox.get("x", 0) or 0) + float(title_bbox.get("w", 0) or 0)
        container_right = float(container_bbox.get("x", 0) or 0) + float(container_bbox.get("w", 0) or 0)

        matched = []
        for candidate in control_candidates:
            bbox = candidate.get("bbox") or {}
            center_y = float(bbox.get("y", 0) or 0) + float(bbox.get("h", 0) or 0) / 2
            center_x = float(bbox.get("x", 0) or 0) + float(bbox.get("w", 0) or 0) / 2
            if abs(center_y - title_center_y) > max(18.0, float(title_bbox.get("h", 0) or 0) * 0.85):
                continue
            if center_x < title_right + 80:
                continue
            if center_x < container_right - 96:
                continue
            if center_x > container_right + 24:
                continue
            matched.append(candidate)

        if not matched:
            updated.append(section)
            continue

        section = dict(section)
        section["titleRightControls"] = ["collapse-toggle"]
        section["titleRightControlBboxes"] = [candidate.get("bbox", {}) for candidate in matched[:2]]
        contract = dict(section.get("renderContract") or {})
        contract["hasCollapseToggle"] = True
        contract["titleRightControls"] = ["collapse-toggle"]
        contract["interactionContract"] = (
            "section title row contains a right-side collapse/expand affordance; "
            "final implementation must provide a real expand/collapse state transition, not a static icon only"
        )
        section["renderContract"] = contract
        updated.append(section)
    return updated


def build_manifest(html_file: Path, project_root: Path | None = None) -> dict[str, Any]:
    html = ""
    encodings = ["utf-8", "utf-8-sig", "gb18030", "gbk"]
    raw = html_file.read_bytes()
    for encoding in encodings:
        try:
            decoded = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        html = decoded
        break
    if not html:
        html = raw.decode("utf-8", errors="replace")
    parser = TreeParser()
    parser.feed(html)
    nodes = parser.nodes
    compute_abs(nodes)
    flow_layout(nodes)
    items = extract_text_items(nodes)
    for item in items:
        item["kind"] = infer_kind(item["text"])
    canvas = canvas_size(nodes)
    visual_boxes = extract_visual_boxes(nodes)
    global_absolute_hint = parser.global_absolute_hint or detect_global_absolute_hint(html)
    fidelity_html = looks_like_fidelity_html(html, nodes, visual_boxes) or global_absolute_hint
    fields = infer_fields(items, visual_boxes)
    regions = infer_regions_from_containers(items, visual_boxes, canvas, fidelity_html) or infer_regions(items, canvas)
    table_structures = detect_table_grid(items, visual_boxes)
    sections = infer_sections(items, visual_boxes, canvas)
    workflow_sections = maybe_build_workflow_detail_sections(items, visual_boxes, canvas)
    usage_sections = maybe_build_usage_dashboard_sections(items, visual_boxes)
    progress_candidates = detect_progress_candidates(items, visual_boxes, table_structures)
    chart_candidates = detect_chart_candidates(items, sections, regions, visual_boxes, table_structures)
    page_archetypes = detect_page_archetypes(items, visual_boxes, chart_candidates, progress_candidates)
    archetype_names = {str(item.get("name", "")) for item in page_archetypes}
    if "workflow-detail-with-compare-panels" in archetype_names and workflow_sections:
        sections = workflow_sections
    elif "funnel-metric-dashboard" in archetype_names and usage_sections:
        sections = usage_sections
    elif len(workflow_sections) >= len(sections):
        sections = workflow_sections
    sections = refine_workflow_detail_sections(sections, items, visual_boxes)
    sections = refine_workflow_compare_columns(sections, items, visual_boxes)
    sections = split_task_processing_sections(sections, items)
    sections = apply_table_context_to_sections(sections, table_structures)
    regions = maybe_build_regions_from_sections(sections, regions, fidelity_html)
    interaction_candidates = detect_interaction_candidates(items, visual_boxes)
    sections = attach_section_title_controls(sections, interaction_candidates)
    expected_blocks = detect_expected_blocks(items, page_archetypes, sections)
    source_content_inventory = build_content_inventory(items, sections, regions)
    terms = extract_terms(items, fields, sections)
    ui_libraries = detect_ui_libraries(project_root)
    chart_libraries = detect_chart_libraries(project_root)
    components = scan_project_components(project_root)
    matches = match_components(fields, regions, components, chart_candidates, progress_candidates)
    icon_candidates = detect_icon_candidates(items, visual_boxes, ui_libraries, project_root)
    similar_pages = scan_similar_pages(project_root, terms)
    absolute_nodes = sum(1 for n in nodes if n.style.get("position", "").replace(" ", "") == "absolute")
    analysis_confidence = estimate_analysis_confidence(items, regions, chart_candidates, visual_boxes, fidelity_html)
    if expected_blocks.get("missing"):
        issues = list((analysis_confidence.get("issues") or []))
        issues.append("expected-blocks-missing:" + ",".join(expected_blocks.get("missing", [])[:8]))
        analysis_confidence["issues"] = unique_preserve_order(issues)
        analysis_confidence["level"] = "low"
    componentization_mode = infer_componentization_mode(
        is_fidelity_html=fidelity_html,
        analysis_confidence=analysis_confidence,
        page_archetypes=page_archetypes,
        table_structures=table_structures,
        chart_candidates=chart_candidates,
        progress_candidates=progress_candidates,
        sections=sections,
    )
    replacement_slots = build_replacement_slots(
        fields,
        regions,
        sections,
        items,
        visual_boxes,
        matches,
        similar_pages,
        ui_libraries,
        chart_libraries,
        table_structures,
        progress_candidates,
        chart_candidates,
        icon_candidates,
        componentization_mode,
    )
    safe_leaf_slots, deferred_block_slots = split_replacement_slots(replacement_slots, componentization_mode)
    matched_components = build_matched_components_summary(matches, replacement_slots)
    return {
        "source": str(html_file),
        "summary": {
            "nodeCount": len(nodes),
            "absoluteNodeCount": absolute_nodes,
            "absoluteRatio": round(absolute_nodes / len(nodes), 4) if nodes else 0,
            "textCount": len(items),
            "canvas": canvas,
            "classification": "absolute-position-html" if fidelity_html else "html",
            "globalAbsoluteHint": global_absolute_hint,
            "fidelityHtml": fidelity_html,
            "analysisConfidence": analysis_confidence,
            "componentizationMode": componentization_mode,
        },
        "texts": items,
        "fields": fields,
        "sections": sections,
        "sourceContentInventory": source_content_inventory,
        "semanticTerms": terms,
        "regions": regions,
        "visualBoxes": visual_boxes,
        "tableStructures": table_structures,
        "progressCandidates": progress_candidates,
        "chartCandidates": chart_candidates,
        "pageArchetypes": page_archetypes,
        "expectedBlocks": expected_blocks,
        "iconCandidates": icon_candidates,
        "interactionCandidates": interaction_candidates,
        "uiLibraries": ui_libraries,
        "chartLibraries": chart_libraries,
        "projectComponents": components[:80],
        "componentMatches": matches,
        "matchedComponents": matched_components,
        "similarPages": similar_pages,
        "replacementSlots": replacement_slots,
        "safeLeafSlots": safe_leaf_slots,
        "deferredBlockSlots": deferred_block_slots,
    }


def build_matched_components_summary(matches: list[dict[str, Any]], replacement_slots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for slot in replacement_slots:
        candidate = str(slot.get("candidate") or "")
        path = str(slot.get("componentPath") or "")
        if not candidate or not path:
            continue
        key = (candidate, path)
        if key in seen:
            continue
        seen.add(key)
        summary.append({
            "component": candidate,
            "componentPath": path,
            "slot": slot.get("slot", ""),
            "kind": slot.get("kind", ""),
            "decision": slot.get("decision", ""),
            "evidence": slot.get("evidence", ""),
        })
    for match in matches:
        for cand in match.get("candidates", []):
            name = str(cand.get("name") or "")
            path = first_component_path(cand)
            if not name:
                continue
            key = (name, path)
            if key in seen:
                continue
            seen.add(key)
            summary.append({
                "component": name,
                "componentPath": path,
                "slot": "",
                "kind": match.get("regionKind", ""),
                "decision": "candidate-match",
                "evidence": match.get("rule", ""),
            })
    return summary


def split_replacement_slots(
    replacement_slots: list[dict[str, Any]],
    componentization_mode: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if str(componentization_mode.get("mode", "")) == "conservative":
        safe_leaf_slots = [
            slot for slot in replacement_slots
            if str(slot.get("kind", "")) in {"field-control", "button", "tag"}
        ]
        deferred_block_slots = [
            slot for slot in replacement_slots
            if str(slot.get("kind", "")) not in {"field-control", "button", "tag"}
        ]
    else:
        safe_leaf_slots = [
            slot for slot in replacement_slots
            if str(slot.get("kind", "")) in {"field-control", "button", "tag", "progress"}
        ]
        deferred_block_slots = [
            slot for slot in replacement_slots
            if slot not in safe_leaf_slots
        ]
    return safe_leaf_slots, deferred_block_slots


def write_markdown(manifest: dict[str, Any], out_path: Path) -> None:
    lines: list[str] = []
    summary = manifest["summary"]
    lines.append("# HTML Stage 1 Handoff")
    lines.append("")
    lines.append(f"- Source: `{manifest['source']}`")
    lines.append(f"- Classification: `{summary['classification']}`")
    lines.append(f"- Nodes: {summary['nodeCount']} total, {summary['absoluteNodeCount']} absolute ({summary['absoluteRatio']})")
    lines.append(f"- Canvas: {summary['canvas'].get('width')} x {summary['canvas'].get('height')}")
    lines.append(f"- Fidelity HTML: `{summary.get('fidelityHtml', False)}`")
    lines.append(f"- Global Absolute Hint: `{summary.get('globalAbsoluteHint', False)}`")
    confidence = summary.get("analysisConfidence") or {}
    lines.append(f"- Analysis Confidence: `{confidence.get('level', 'unknown')}`")
    if confidence.get("issues"):
        lines.append(f"- Analysis Issues: `{', '.join(confidence.get('issues', []))}`")
    componentization_mode = summary.get("componentizationMode") or {}
    lines.append(f"- Componentization Mode: `{componentization_mode.get('mode', 'balanced')}`")
    if componentization_mode.get("reasons"):
        lines.append(f"- Conservative Reasons: `{', '.join(componentization_mode.get('reasons', []))}`")
    if componentization_mode.get("readPolicy"):
        lines.append(f"- Read Policy: {componentization_mode.get('readPolicy')}")
    if componentization_mode.get("slotPolicy"):
        lines.append(f"- Slot Policy: {componentization_mode.get('slotPolicy')}")
    lines.append("")
    lines.append("## Page Archetypes")
    archetypes = manifest.get("pageArchetypes", [])
    if archetypes:
        for archetype in archetypes[:10]:
            evidence = ", ".join(archetype.get("evidence", [])[:6])
            lines.append(f"- {archetype.get('name')} confidence={archetype.get('confidence')}; evidence={evidence}")
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Regions")
    for region in manifest["regions"][:8]:
        lines.append(f"- **{region['name']}** `{region['bbox']}`: " + " / ".join(region["texts"][:10]))
    lines.append("")
    lines.append("## Detected Tables")
    table_structures = manifest.get("tableStructures", [])
    if table_structures:
        for table in table_structures[:6]:
            column_names = ", ".join(col.get("title", "") for col in table.get("columns", [])[:12])
            lines.append(f"- bbox={table.get('bbox')} rows={table.get('rowCount')} columns=[{column_names}]")
            for cell in table.get("compositeCells", [])[:8]:
                lines.append(f"  - composite column={cell.get('columnTitle')} texts={cell.get('texts')}")
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Detected Progress")
    progress_candidates = manifest.get("progressCandidates", [])
    if progress_candidates:
        for progress in progress_candidates[:10]:
            evidence = ", ".join(progress.get("evidence", [])[:4])
            lines.append(
                f"- owner={progress.get('owner')} type={progress.get('componentType')} confidence={progress.get('confidence')} "
                f"percent={progress.get('percentText')} bbox={progress.get('bbox')}; evidence={evidence}"
            )
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Detected Charts")
    chart_candidates = manifest.get("chartCandidates", [])
    if chart_candidates:
        for chart in chart_candidates[:10]:
            evidence = ", ".join(chart.get("evidence", [])[:4])
            lines.append(
                f"- owner={chart.get('owner')} type={chart.get('chartType')} confidence={chart.get('confidence')} "
                f"fallback={chart.get('fallbackExpression')} bbox={chart.get('bbox')}; evidence={evidence}"
            )
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Detected Icons")
    icon_candidates = manifest.get("iconCandidates", [])
    if icon_candidates:
        for icon in icon_candidates[:16]:
            nearby_texts = ", ".join(icon.get("nearbyTexts", [])[:4]) or "none"
            library_suggestion = icon.get("librarySuggestion") or "none"
            lines.append(
                f"- owner={icon.get('owner')} role={icon.get('iconRole')} nature={icon.get('iconNature')} "
                f"librarySuggestion={library_suggestion} bbox={icon.get('bbox')}; nearbyTexts={nearby_texts}; "
                f"fallback={icon.get('fallbackSource')}"
            )
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Interaction Candidates")
    interaction_candidates = manifest.get("interactionCandidates", [])
    if interaction_candidates:
        for action in interaction_candidates[:16]:
            lines.append(
                f"- kind={action.get('kind')} label={action.get('label') or 'none'} "
                f"bbox={action.get('bbox')}; evidence={action.get('evidence')}"
            )
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Chart Libraries")
    chart_libraries = manifest.get("chartLibraries", [])
    if chart_libraries:
        for lib in chart_libraries[:20]:
            lines.append(
                f"- {lib.get('name')} proven={lib.get('proven')} packages={lib.get('packages')} "
                f"used={lib.get('usedPackages')} evidence={lib.get('evidence')}"
            )
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Sections")
    for section in manifest["sections"][:20]:
        owner = section.get("ownerPath") or section["title"]
        hint = f" layout={section.get('layoutHint')}" if section.get("layoutHint") else ""
        contract = section.get("renderContract") or {}
        extra = []
        if contract.get("mustRenderWholeSection"):
            extra.append("whole=true")
        if contract.get("contentMode"):
            extra.append(f"mode={contract.get('contentMode')}")
        tags_text = ", ".join(section.get("tagStripTexts", [])[:6])
        if tags_text:
            extra.append(f"tags=[{tags_text}]")
        extra_text = (" " + "; ".join(extra)) if extra else ""
        lines.append(f"- **{owner}**{hint}{extra_text}: " + " / ".join(section["texts"][:10]))
    lines.append("")
    lines.append("## Must Preserve Blocks")
    preserve_entries = [entry for entry in manifest.get("sourceContentInventory", []) if entry.get("mustPreserve")]
    for entry in preserve_entries[:20]:
        if not entry.get("mustPreserve"):
            continue
        texts = " / ".join(entry.get("visibleTexts", [])[:10])
        lines.append(
            f"- **{entry.get('owner')}** [{entry.get('kind')}] count={entry.get('textCount')} "
            f"bbox={entry.get('bbox')}: {texts}"
        )
    lines.append("")
    lines.append("## Fields")
    for field in manifest["fields"][:24]:
        req = "required" if field["required"] else "optional"
        ph = f" -> {field['placeholder']}" if field["placeholder"] else ""
        lines.append(f"- {field['label']} ({req}){ph} [labelNode={field['labelNodeId']}]")
    lines.append("")
    lines.append("## Safe Leaf Slots")
    for slot in manifest.get("safeLeafSlots", [])[:16]:
        bbox = slot.get("bbox") or {}
        candidate = slot.get("candidate") or "none"
        path = slot.get("componentPath") or ""
        path_text = f" path={path}" if path else ""
        priority = slot.get("applyPriority", "")
        priority_text = f" priority={priority}" if priority else ""
        lines.append(
            f"- {slot['slot']} [{slot['kind']}] -> {slot['decision']} candidate={candidate}{path_text}{priority_text} bbox={bbox}; "
            f"evidence={slot['evidence']}; constraint={slot['constraint']}"
        )
    lines.append("")
    lines.append("## Deferred Block Slots")
    for slot in manifest.get("deferredBlockSlots", [])[:16]:
        bbox = slot.get("bbox") or {}
        candidate = slot.get("candidate") or "none"
        priority = slot.get("applyPriority", "")
        priority_text = f" priority={priority}" if priority else ""
        lines.append(
            f"- {slot['slot']} [{slot['kind']}] -> {slot['decision']} candidate={candidate}{priority_text} bbox={bbox}; "
            f"evidence={slot['evidence']}; constraint={slot['constraint']}"
        )
    lines.append("")
    lines.append("## Matched Components")
    matched = manifest.get("matchedComponents", [])
    if matched:
        for item in matched[:20]:
            slot = item.get("slot", "")
            extra = f" slot={slot}" if slot else ""
            lines.append(
                f"- `{item.get('component', '')}`{extra} [{item.get('kind', '')}] -> {item.get('decision', '')} "
                f"path={item.get('componentPath', '')}; evidence={item.get('evidence', '')}"
            )
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Similar Project Pages")
    for page in manifest.get("similarPages", [])[:10]:
        terms = ", ".join(page.get("matchedTerms", [])[:10])
        comps = ", ".join(page.get("componentTags", [])[:10])
        lines.append(f"- `{page['path']}` score={page['score']} terms=[{terms}] components=[{comps}]")
    lines.append("")
    lines.append("## Source Actions")
    action_texts = []
    for item in manifest.get("texts", []):
        if item.get("kind") == "action":
            action_texts.append(str(item.get("text", "")))
    action_texts = list(dict.fromkeys(v for v in action_texts if v))
    if action_texts:
        for action in action_texts[:40]:
            lines.append(f"- `{action}`")
    else:
        lines.append("- none")
    lines.append("")
    lines.append("## Section HTML Slices")
    section_files = manifest.get("sectionFiles", [])
    if section_files:
        lines.append("Read the current section HTML slice when context is tight. It keeps local visual layout.")
        for entry in section_files[:120]:
            lines.append(
                f"- {entry.get('id')}: `{entry.get('path')}` owner={entry.get('owner')} "
                f"count={entry.get('textCount')}"
            )
    else:
        lines.append("- none")
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def safe_name(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._\-\u4e00-\u9fff]+", "-", value).strip("-._")
    if cleaned:
        return cleaned[:80]
    return fallback


def ensure_dir(path: Path) -> None:
    os.makedirs(path, exist_ok=True)


def center_inside(inner: dict[str, Any], outer: dict[str, Any], padding: float = 12.0) -> bool:
    if not inner or not outer:
        return False
    cx = inner.get("x", 0) + inner.get("w", 0) / 2
    cy = inner.get("y", 0) + inner.get("h", 0) / 2
    return (
        outer.get("x", 0) - padding <= cx <= outer.get("x", 0) + outer.get("w", 0) + padding
        and outer.get("y", 0) - padding <= cy <= outer.get("y", 0) + outer.get("h", 0) + padding
    )


def intersects(a: dict[str, Any], b: dict[str, Any], padding: float = 0.0) -> bool:
    if not a or not b:
        return False
    ax0, ay0 = a.get("x", 0), a.get("y", 0)
    ax1, ay1 = ax0 + a.get("w", 0), ay0 + a.get("h", 0)
    bx0, by0 = b.get("x", 0) - padding, b.get("y", 0) - padding
    bx1, by1 = b.get("x", 0) + b.get("w", 0) + padding, b.get("y", 0) + b.get("h", 0) + padding
    return ax0 <= bx1 and ax1 >= bx0 and ay0 <= by1 and ay1 >= by0


def area(box: dict[str, Any]) -> float:
    return max(float(box.get("w", 0)), 0.0) * max(float(box.get("h", 0)), 0.0)


def intersection_area(a: dict[str, Any], b: dict[str, Any]) -> float:
    if not a or not b:
        return 0.0
    ax0, ay0 = float(a.get("x", 0)), float(a.get("y", 0))
    ax1, ay1 = ax0 + float(a.get("w", 0)), ay0 + float(a.get("h", 0))
    bx0, by0 = float(b.get("x", 0)), float(b.get("y", 0))
    bx1, by1 = bx0 + float(b.get("w", 0)), by0 + float(b.get("h", 0))
    w = max(min(ax1, bx1) - max(ax0, bx0), 0.0)
    h = max(min(ay1, by1) - max(ay0, by0), 0.0)
    return w * h


def overlap_ratio(inner: dict[str, Any], outer: dict[str, Any]) -> float:
    inner_area = area(inner)
    if inner_area <= 0:
        return 0.0
    return round(intersection_area(inner, outer) / inner_area, 4)


def entry_box(entry: dict[str, Any]) -> dict[str, Any]:
    content_box = entry.get("contentBbox") or {}
    container_box = entry.get("containerBbox") or {}
    if content_box and container_box and area(content_box) > 0 and area(container_box) > 0:
        container_area = area(container_box)
        content_area = area(content_box)
        if container_area > content_area * 2.4 and content_area > 500:
            return content_box
    return container_box or content_box or entry.get("bbox") or {}


def item_key(item: dict[str, Any]) -> str:
    box = item.get("bbox", {})
    return "|".join([
        str(item.get("text", "")),
        str(round(float(box.get("x", 0)), 2)),
        str(round(float(box.get("y", 0)), 2)),
        str(round(float(box.get("w", 0)), 2)),
        str(round(float(box.get("h", 0)), 2)),
    ])


def owner_depth(entry: dict[str, Any]) -> int:
    owner = str(entry.get("owner", ""))
    return owner.count("/")


def implementation_score(entry: dict[str, Any]) -> float:
    contract = entry.get("renderContract") or {}
    score = float(entry.get("textCount", 0))
    if contract.get("mustRenderWholeSection"):
        score += 100
    if entry.get("layoutHint"):
        score += 20
    if entry.get("controlTexts"):
        score += 12
    if entry.get("tagStripTexts"):
        score += 12
    if entry.get("subsectionTitles"):
        score += 8
    score += owner_depth(entry) * 4
    return score


def select_implementation_entries(inventory: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for entry in inventory:
        if not entry.get("mustPreserve", True):
            continue
        if int(entry.get("textCount", 0)) <= 0:
            continue
        if area(entry_box(entry)) <= 0:
            continue
        contract = entry.get("renderContract") or {}
        if int(entry.get("textCount", 0)) <= 1 and not contract.get("mustRenderWholeSection"):
            continue
        item = dict(entry)
        item["implementationRole"] = "implement"
        item["referenceOnly"] = False
        item["selectionScore"] = implementation_score(entry)
        candidates.append(item)

    for parent in candidates:
        parent_contract = parent.get("renderContract") or {}
        if parent_contract.get("mustRenderWholeSection"):
            continue
        parent_box = entry_box(parent)
        child_count = 0
        child_text_count = 0
        for child in candidates:
            if child is parent:
                continue
            child_box = entry_box(child)
            if area(child_box) >= area(parent_box):
                continue
            if overlap_ratio(child_box, parent_box) < 0.82:
                continue
            if str(parent.get("owner", "")) == str(child.get("owner", "")):
                continue
            child_count += 1
            child_text_count += int(child.get("textCount", 0))
        if child_count >= 2 and child_text_count >= max(int(parent.get("textCount", 0)) * 0.55, 8):
            parent["implementationRole"] = "reference"
            parent["referenceOnly"] = True
            parent["skipReason"] = "parent-overlaps-child-slices"

    selected = [entry for entry in candidates if not entry.get("referenceOnly")]
    if not selected and candidates:
        selected = [max(candidates, key=lambda entry: entry.get("selectionScore", 0))]
        selected[0]["implementationRole"] = "implement"
        selected[0]["referenceOnly"] = False
    return sorted(
        selected,
        key=lambda entry: (entry_box(entry).get("y", 0), entry_box(entry).get("x", 0), -entry.get("selectionScore", 0)),
    )


def build_coverage_report(manifest: dict[str, Any], selected_entries: list[dict[str, Any]]) -> dict[str, Any]:
    text_items = manifest.get("texts", [])
    assignments: dict[str, list[str]] = {}
    for item in text_items:
        key = item_key(item)
        owners = []
        for entry in selected_entries:
            if center_inside(item.get("bbox", {}), entry_box(entry), padding=8):
                owners.append(str(entry.get("owner", "")))
        assignments[key] = owners

    unassigned = [
        {"text": item.get("text", ""), "kind": item.get("kind", ""), "bbox": item.get("bbox", {})}
        for item in text_items
        if not assignments.get(item_key(item))
    ]
    duplicate = [
        {
            "text": item.get("text", ""),
            "kind": item.get("kind", ""),
            "bbox": item.get("bbox", {}),
            "owners": assignments.get(item_key(item), []),
        }
        for item in text_items
        if len(assignments.get(item_key(item), [])) > 1
    ]
    slice_coverage = []
    for entry in selected_entries:
        owner = str(entry.get("owner", ""))
        owned = [item for item in text_items if owner in assignments.get(item_key(item), [])]
        slice_coverage.append({
            "owner": owner,
            "textCount": len(owned),
            "expectedTextCount": entry.get("textCount", 0),
            "path": entry.get("path", ""),
        })
    return {
        "totalTextCount": len(text_items),
        "coveredTextCount": len(text_items) - len(unassigned),
        "unassignedCount": len(unassigned),
        "duplicateCount": len(duplicate),
        "unassignedTexts": unassigned[:80],
        "duplicateTexts": duplicate[:80],
        "sliceCoverage": slice_coverage,
    }


def local_regression_targets(manifest: dict[str, Any], selected_entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    for entry in selected_entries:
        texts = [str(text) for text in entry.get("visibleTexts", [])]
        contract = entry.get("renderContract") or {}
        owner = str(entry.get("owner", ""))
        risk_flags: list[str] = []
        if any("报告编号" in text for text in texts):
            risk_flags.append("report-tab-text")
        if any("差异报告" == text for text in texts):
            risk_flags.append("report-module-title")
        if any("上传文件成功" in text for text in texts):
            risk_flags.append("upload-like-text")
        if any("报告ID" in text for text in texts):
            risk_flags.append("report-id-text")
        if any("填写报告" == text for text in texts):
            risk_flags.append("action-nearby")
        if any("报告编号" in text for text in texts) and any("上传文件成功" in text for text in texts):
            risk_flags.append("mixed-report-and-upload")
        if any("报告编号" in text for text in texts) and not contract.get("mustRenderWholeSection"):
            risk_flags.append("tab-inside-fragment-section")
        if any("差异报告" == text for text in texts) and any("报告编号" in text for text in texts):
            risk_flags.append("title-with-tab-text")
        if risk_flags:
            targets.append({
                "owner": owner,
                "path": entry.get("path", ""),
                "bbox": entry_box(entry),
                "riskFlags": risk_flags,
                "texts": texts[:20],
                "action": "revisit-source-html-locally",
            })
    return targets


def px_style(value: Any) -> str:
    try:
        return f"{round(float(value), 2)}px"
    except (TypeError, ValueError):
        return "0px"


def render_section_html(manifest: dict[str, Any], entry: dict[str, Any], section_id: str) -> str:
    bbox = entry_box(entry)
    if not bbox:
        bbox = manifest.get("summary", {}).get("canvas", {})
        bbox = {"x": 0, "y": 0, "w": bbox.get("width", 1200), "h": bbox.get("height", 800)}
    padding = 24.0
    origin_x = float(bbox.get("x", 0)) - padding
    origin_y = float(bbox.get("y", 0)) - padding
    width = max(float(bbox.get("w", 0)) + padding * 2, 320.0)
    height = max(float(bbox.get("h", 0)) + padding * 2, 160.0)

    visual_boxes = [
        box for box in manifest.get("visualBoxes", [])
        if intersects(box.get("bbox", {}), bbox, padding=8)
    ][:300]
    text_items = [
        item for item in manifest.get("texts", [])
        if center_inside(item.get("bbox", {}), bbox, padding=8)
    ][:500]

    lines = [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<head>",
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
        f"<title>{html_lib.escape(entry.get('owner') or section_id)}</title>",
        "<style>",
        "body{margin:0;background:#f5f7fa;font-family:Arial,'Microsoft YaHei',sans-serif;color:#1f2329;}",
        ".slice{position:relative;margin:0 auto;background:#fff;overflow:hidden;box-sizing:border-box;}",
        ".box,.text{position:absolute;box-sizing:border-box;}",
        ".text{white-space:pre-wrap;line-height:1.35;}",
        "</style>",
        "</head>",
        "<body>",
        f'<main class="slice" style="width:{px_style(width)};height:{px_style(height)}" '
        f'data-owner="{html_lib.escape(str(entry.get("owner", "")))}" '
        f'data-layout-hint="{html_lib.escape(str(entry.get("layoutHint", "")))}">',
    ]
    for box in visual_boxes:
        b = box.get("bbox", {})
        styles = [
            f"left:{px_style(float(b.get('x', 0)) - origin_x)}",
            f"top:{px_style(float(b.get('y', 0)) - origin_y)}",
            f"width:{px_style(b.get('w', 0))}",
            f"height:{px_style(b.get('h', 0))}",
        ]
        if box.get("background"):
            styles.append(f"background:{box['background']}")
        if box.get("border"):
            styles.append(f"border:{box['border']}")
        if box.get("borderRadius"):
            styles.append(f"border-radius:{box['borderRadius']}")
        if box.get("opacity"):
            styles.append(f"opacity:{box['opacity']}")
        lines.append(f'<div class="box" data-kind="{html_lib.escape(str(box.get("kind", "")))}" style="{";".join(styles)}"></div>')
    for item in text_items:
        b = item.get("bbox", {})
        styles = [
            f"left:{px_style(float(b.get('x', 0)) - origin_x)}",
            f"top:{px_style(float(b.get('y', 0)) - origin_y)}",
            f"width:{px_style(max(float(b.get('w', 0)), 24.0))}",
            f"min-height:{px_style(max(float(b.get('h', 0)), 18.0))}",
            f"font-size:{px_style(item.get('fontSize') or 14)}",
        ]
        if item.get("color"):
            styles.append(f"color:{item['color']}")
        text = html_lib.escape(str(item.get("text", "")))
        kind = html_lib.escape(str(item.get("kind", "")))
        lines.append(f'<div class="text" data-kind="{kind}" style="{";".join(styles)}">{text}</div>')
    lines.extend(["</main>", "</body>", "</html>"])
    return "\n".join(lines) + "\n"


def render_page_layout_html(manifest: dict[str, Any]) -> str:
    canvas = manifest.get("summary", {}).get("canvas", {})
    width = max(float(canvas.get("width", 0)), 1280.0)
    height = max(float(canvas.get("height", 0)), 900.0)
    regions = manifest.get("regions", [])
    sections = manifest.get("sections", [])

    lines = [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<head>",
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
        "<title>Page Layout Reference</title>",
        "<style>",
        "body{margin:0;background:#eef1f6;font-family:Arial,'Microsoft YaHei',sans-serif;color:#1f2329;}",
        ".canvas{position:relative;margin:0 auto;background:#f5f7fa;overflow:hidden;}",
        ".region,.section{position:absolute;box-sizing:border-box;}",
        ".region{border:1px dashed rgba(23,116,255,.35);background:rgba(23,116,255,.05);}",
        ".region > span,.section > span{position:absolute;left:8px;top:6px;font-size:12px;line-height:18px;}",
        ".section{border:1px solid rgba(38,38,38,.18);background:rgba(255,255,255,.72);border-radius:6px;}",
        ".section.whole{border-color:rgba(23,116,255,.55);box-shadow:inset 0 0 0 1px rgba(23,116,255,.15);}",
        "</style>",
        "</head>",
        "<body>",
        f'<main class="canvas" style="width:{px_style(width)};height:{px_style(height)}">',
    ]
    for region in regions:
        bbox = region.get("bbox", {})
        lines.append(
            f'<div class="region" style="left:{px_style(bbox.get("x", 0))};top:{px_style(bbox.get("y", 0))};'
            f'width:{px_style(bbox.get("w", 0))};height:{px_style(bbox.get("h", 0))}">'
            f'<span>{html_lib.escape(str(region.get("name", "")))}</span></div>'
        )
    for section in sections:
        bbox = section.get("contentBbox") or section.get("containerBbox") or section.get("bbox") or {}
        contract = section.get("renderContract") or {}
        cls = "section whole" if contract.get("mustRenderWholeSection") else "section"
        label = str(section.get("ownerPath") or section.get("title") or "")
        if section.get("layoutHint"):
            label += f" [{section.get('layoutHint')}]"
        lines.append(
            f'<div class="{cls}" style="left:{px_style(bbox.get("x", 0))};top:{px_style(bbox.get("y", 0))};'
            f'width:{px_style(bbox.get("w", 0))};height:{px_style(bbox.get("h", 0))}">'
            f'<span>{html_lib.escape(label)}</span></div>'
        )
    lines.extend(["</main>", "</body>", "</html>"])
    return "\n".join(lines) + "\n"


def page_reference_bbox(manifest: dict[str, Any]) -> dict[str, Any]:
    canvas = manifest.get("summary", {}).get("canvas", {})
    canvas_box = {"x": 0, "y": 0, "w": canvas.get("width", 1280), "h": canvas.get("height", 900)}
    boxes = [region.get("bbox", {}) for region in manifest.get("regions", [])]
    boxes += [
        section.get("containerBbox") or section.get("contentBbox") or section.get("bbox", {})
        for section in manifest.get("sections", [])
    ]
    merged = combined_bbox([box for box in boxes if box])
    if not merged:
        return canvas_box
    padding = 32.0
    x0 = max(float(merged.get("x", 0)) - padding, 0.0)
    y0 = max(float(merged.get("y", 0)) - padding, 0.0)
    x1 = min(float(merged.get("x", 0)) + float(merged.get("w", 0)) + padding, float(canvas_box["w"]))
    y1 = min(float(merged.get("y", 0)) + float(merged.get("h", 0)) + padding, float(canvas_box["h"]))
    return {"x": x0, "y": y0, "w": max(x1 - x0, 320.0), "h": max(y1 - y0, 240.0)}


def render_page_reference_html(manifest: dict[str, Any]) -> str:
    bbox = page_reference_bbox(manifest)
    origin_x = float(bbox.get("x", 0))
    origin_y = float(bbox.get("y", 0))
    width = float(bbox.get("w", 1280))
    height = float(bbox.get("h", 900))
    visual_boxes = [
        box for box in manifest.get("visualBoxes", [])
        if intersects(box.get("bbox", {}), bbox, padding=8)
    ][:700]
    text_items = [
        item for item in manifest.get("texts", [])
        if center_inside(item.get("bbox", {}), bbox, padding=8)
    ][:900]
    section_boxes: list[dict[str, Any]] = []
    for section in manifest.get("sections", []):
        section_bbox = section.get("containerBbox") or section.get("contentBbox") or section.get("bbox") or {}
        if section_bbox:
            section_boxes.append({
                "bbox": section_bbox,
                "label": section.get("ownerPath") or section.get("title") or "",
                "layoutHint": section.get("layoutHint", ""),
            })

    lines = [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<head>",
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
        "<title>Whole Page Reference</title>",
        "<style>",
        "body{margin:0;background:#eef1f6;font-family:Arial,'Microsoft YaHei',sans-serif;color:#1f2329;}",
        ".page{position:relative;margin:0 auto;background:#f5f7fa;overflow:hidden;box-sizing:border-box;}",
        ".box,.text,.section-outline{position:absolute;box-sizing:border-box;}",
        ".text{white-space:pre-wrap;line-height:1.35;}",
        ".section-outline{pointer-events:none;border:1px solid rgba(23,116,255,.32);background:rgba(23,116,255,.035);}",
        ".section-outline>span{position:absolute;left:6px;top:4px;font-size:11px;line-height:16px;color:#155bd4;background:rgba(255,255,255,.78);}",
        "</style>",
        "</head>",
        "<body>",
        f'<main class="page" style="width:{px_style(width)};height:{px_style(height)}" '
        f'data-source="{html_lib.escape(str(manifest.get("source", "")))}">',
    ]
    for box in visual_boxes:
        b = box.get("bbox", {})
        styles = [
            f"left:{px_style(float(b.get('x', 0)) - origin_x)}",
            f"top:{px_style(float(b.get('y', 0)) - origin_y)}",
            f"width:{px_style(b.get('w', 0))}",
            f"height:{px_style(b.get('h', 0))}",
        ]
        if box.get("background"):
            styles.append(f"background:{box['background']}")
        if box.get("border"):
            styles.append(f"border:{box['border']}")
        if box.get("borderRadius"):
            styles.append(f"border-radius:{box['borderRadius']}")
        if box.get("opacity"):
            styles.append(f"opacity:{box['opacity']}")
        lines.append(f'<div class="box" data-kind="{html_lib.escape(str(box.get("kind", "")))}" style="{";".join(styles)}"></div>')
    for section in section_boxes:
        b = section.get("bbox", {})
        label = str(section.get("label", ""))
        if section.get("layoutHint"):
            label += f" [{section.get('layoutHint')}]"
        styles = [
            f"left:{px_style(float(b.get('x', 0)) - origin_x)}",
            f"top:{px_style(float(b.get('y', 0)) - origin_y)}",
            f"width:{px_style(b.get('w', 0))}",
            f"height:{px_style(b.get('h', 0))}",
        ]
        lines.append(f'<div class="section-outline" style="{";".join(styles)}"><span>{html_lib.escape(label)}</span></div>')
    for item in text_items:
        b = item.get("bbox", {})
        styles = [
            f"left:{px_style(float(b.get('x', 0)) - origin_x)}",
            f"top:{px_style(float(b.get('y', 0)) - origin_y)}",
            f"width:{px_style(max(float(b.get('w', 0)), 24.0))}",
            f"min-height:{px_style(max(float(b.get('h', 0)), 18.0))}",
            f"font-size:{px_style(item.get('fontSize') or 14)}",
        ]
        if item.get("color"):
            styles.append(f"color:{item['color']}")
        text = html_lib.escape(str(item.get("text", "")))
        kind = html_lib.escape(str(item.get("kind", "")))
        lines.append(f'<div class="text" data-kind="{kind}" style="{";".join(styles)}">{text}</div>')
    lines.extend(["</main>", "</body>", "</html>"])
    return "\n".join(lines) + "\n"


def write_section_files(manifest: dict[str, Any], section_dir: Path) -> list[dict[str, Any]]:
    ensure_dir(section_dir)
    index: list[dict[str, Any]] = []
    selected_entries = select_implementation_entries(manifest.get("sourceContentInventory", []))
    for i, entry in enumerate(selected_entries, start=1):
        owner = str(entry.get("owner") or f"section-{i}")
        section_id = f"{i:03d}-{safe_name(owner, f'section-{i}')}"
        path = section_dir / f"{section_id}.html"
        path.write_text(render_section_html(manifest, entry, section_id), encoding="utf-8")
        entry["path"] = str(path)
        index.append({
            "id": section_id,
            "owner": owner,
            "kind": entry.get("kind", ""),
            "textCount": entry.get("textCount", 0),
            "layoutHint": entry.get("layoutHint", ""),
            "renderContract": entry.get("renderContract", {}),
            "implementationRole": entry.get("implementationRole", "implement"),
            "referenceOnly": bool(entry.get("referenceOnly", False)),
            "path": str(path),
        })
    manifest["coverageReport"] = build_coverage_report(manifest, selected_entries)
    manifest["localRegressionTargets"] = local_regression_targets(manifest, selected_entries)

    index_path = section_dir / "index.md"
    coverage = manifest.get("coverageReport", {})
    regression_targets = manifest.get("localRegressionTargets", [])
    lines = [
        "# Section HTML Slice Index",
        "",
        "每次读取当前区块 HTML。它保留相对布局、背景、边框、字体和文本位置。",
        "",
        "## Coverage",
        "",
        f"- totalTextCount: {coverage.get('totalTextCount', 0)}",
        f"- coveredTextCount: {coverage.get('coveredTextCount', 0)}",
        f"- unassignedCount: {coverage.get('unassignedCount', 0)}",
        f"- duplicateCount: {coverage.get('duplicateCount', 0)}",
        "",
        "## Implement Slices",
        "",
    ]
    for item in index:
        contract = item.get("renderContract") or {}
        lines.append(
            f"- {item['id']}: `{item['path']}` owner={item['owner']} "
            f"count={item['textCount']} layout={item.get('layoutHint', '')} "
            f"whole={bool(contract.get('mustRenderWholeSection'))}"
        )
    unassigned = coverage.get("unassignedTexts", [])
    if unassigned:
        lines.extend(["", "## Unassigned Texts"])
        for item in unassigned[:40]:
            lines.append(f"- `{item.get('text')}` kind={item.get('kind')} bbox={item.get('bbox')}")
    duplicates = coverage.get("duplicateTexts", [])
    if duplicates:
        lines.extend(["", "## Duplicate Texts"])
        for item in duplicates[:40]:
            owners = " / ".join(item.get("owners", []))
            lines.append(f"- `{item.get('text')}` owners={owners}")
    if regression_targets:
        lines.extend(["", "## Local Regression Targets"])
        for item in regression_targets[:40]:
            flags = ",".join(item.get("riskFlags", []))
            lines.append(f"- owner={item.get('owner')} action={item.get('action')} flags={flags} path=`{item.get('path')}`")
    index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return index


def main() -> int:
    ap = argparse.ArgumentParser(description="Analyze large absolute-position HTML exports.")
    ap.add_argument("html_file")
    ap.add_argument("--project-root", default="")
    ap.add_argument("--out-dir", default=".frontend/html-analysis")
    ap.add_argument("--output-name", default="", help="Stable ASCII output stem, e.g. task-1-create-course.")
    ap.add_argument("--emit-section-html", action="store_true", help="Optional debug mode: split source into section HTML slices.")
    ap.add_argument("--emit-reference-html", action="store_true", help="Optional debug mode: emit page-level helper HTML files.")
    args = ap.parse_args()

    html_file = Path(args.html_file).resolve()
    project_root = Path(args.project_root).resolve() if args.project_root else None
    out_dir = Path(args.out_dir)
    ensure_dir(out_dir)

    manifest = build_manifest(html_file, project_root)
    stem = args.output_name.strip() or safe_stem(html_file)
    section_dir = out_dir / f"{stem}-section-html"
    if args.emit_section_html:
        manifest["sectionFiles"] = write_section_files(manifest, section_dir)
    else:
        manifest["sectionFiles"] = []
        manifest["coverageReport"] = {
            "mode": "whole-html-source",
            "totalTextCount": len(manifest.get("texts", [])),
            "coveredTextCount": 0,
            "unassignedCount": 0,
            "duplicateCount": 0,
            "note": "Section HTML slices were not generated. Use the original HTML as the Stage 1 source and use this handoff plus targeted manifest reads for content back-check.",
        }
        manifest["localRegressionTargets"] = []
    if args.emit_reference_html:
        page_layout_path = out_dir / f"{stem}-page-layout.html"
        page_layout_path.write_text(render_page_layout_html(manifest), encoding="utf-8")
        manifest["pageLayoutFile"] = str(page_layout_path)
        page_reference_path = out_dir / f"{stem}-whole-page-reference.html"
        page_reference_path.write_text(render_page_reference_html(manifest), encoding="utf-8")
        manifest["wholePageReferenceFile"] = str(page_reference_path)
    else:
        manifest["pageLayoutFile"] = ""
        manifest["wholePageReferenceFile"] = ""
    json_path = out_dir / f"{stem}.json"
    md_path = out_dir / f"{stem}.md"
    json_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(manifest, md_path)
    print(f"[OK] wrote {json_path}")
    print(f"[OK] wrote {md_path}")
    if args.emit_section_html:
        print(f"[OK] wrote {section_dir / 'index.md'}")
    else:
        print("[OK] skipped section-html slices (default whole-html mode)")
    if args.emit_reference_html:
        print(f"[OK] wrote {page_layout_path}")
        print(f"[OK] wrote {page_reference_path}")
    else:
        print("[OK] skipped reference HTML files (default compact mode)")
    print(json.dumps(manifest["summary"], ensure_ascii=False))
    return 0


def safe_stem(path: Path) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", path.stem).strip("-._")
    if stem:
        return stem[:80]
    digest = hashlib.sha1(str(path).encode("utf-8", errors="ignore")).hexdigest()[:10]
    return f"html-{digest}"


if __name__ == "__main__":
    raise SystemExit(main())
