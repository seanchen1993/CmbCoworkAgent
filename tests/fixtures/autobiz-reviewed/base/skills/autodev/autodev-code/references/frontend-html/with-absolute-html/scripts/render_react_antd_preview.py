#!/usr/bin/env python3
"""Render a manifest-backed React + AntD CDN preview HTML."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


def ensure_dir(path: Path) -> None:
    os.makedirs(path, exist_ok=True)


def combined_bbox(boxes: list[dict[str, Any]]) -> dict[str, float]:
    valid = []
    for box in boxes:
        if not isinstance(box, dict):
            continue
        try:
            x = float(box.get("x", 0) or 0)
            y = float(box.get("y", 0) or 0)
            w = float(box.get("w", 0) or 0)
            h = float(box.get("h", 0) or 0)
        except (TypeError, ValueError):
            continue
        if w <= 0 or h <= 0:
            continue
        valid.append({"x": x, "y": y, "w": w, "h": h})
    if not valid:
        return {}
    x0 = min(item["x"] for item in valid)
    y0 = min(item["y"] for item in valid)
    x1 = max(item["x"] + item["w"] for item in valid)
    y1 = max(item["y"] + item["h"] for item in valid)
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def page_reference_bbox(manifest: dict[str, Any]) -> dict[str, float]:
    summary = manifest.get("summary", {}) or {}
    canvas = summary.get("canvas", {}) or {}
    canvas_box = {
        "x": 0.0,
        "y": 0.0,
        "w": float(canvas.get("width", 1280) or 1280),
        "h": float(canvas.get("height", 900) or 900),
    }
    boxes: list[dict[str, Any]] = []
    for region in manifest.get("regions", []) or []:
        bbox = region.get("bbox") or {}
        if bbox:
            boxes.append(bbox)
    for section in manifest.get("sections", []) or []:
        bbox = section.get("containerBbox") or section.get("contentBbox") or section.get("bbox") or {}
        if bbox:
            boxes.append(bbox)
    merged = combined_bbox(boxes)
    if not merged:
        return canvas_box
    padding = 32.0
    x0 = max(float(merged.get("x", 0) or 0) - padding, 0.0)
    y0 = max(float(merged.get("y", 0) or 0) - padding, 0.0)
    x1 = min(float(merged.get("x", 0) or 0) + float(merged.get("w", 0) or 0) + padding, canvas_box["w"])
    y1 = min(float(merged.get("y", 0) or 0) + float(merged.get("h", 0) or 0) + padding, canvas_box["h"])
    return {
        "x": x0,
        "y": y0,
        "w": max(x1 - x0, 320.0),
        "h": max(y1 - y0, 240.0),
    }


def trim_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    bbox = page_reference_bbox(manifest)
    origin_x = float(bbox.get("x", 0) or 0)
    origin_y = float(bbox.get("y", 0) or 0)

    visual_boxes = []
    for box in manifest.get("visualBoxes", []) or []:
        raw = box.get("bbox") or {}
        if not raw:
            continue
        try:
            x = float(raw.get("x", 0) or 0)
            y = float(raw.get("y", 0) or 0)
            w = float(raw.get("w", 0) or 0)
            h = float(raw.get("h", 0) or 0)
        except (TypeError, ValueError):
            continue
        if w <= 0 or h <= 0:
            continue
        if x + w < bbox["x"] - 8 or y + h < bbox["y"] - 8 or x > bbox["x"] + bbox["w"] + 8 or y > bbox["y"] + bbox["h"] + 8:
            continue
        visual_boxes.append(
            {
                "kind": str(box.get("kind", "")),
                "background": str(box.get("background", "")),
                "border": str(box.get("border", "")),
                "borderRadius": str(box.get("borderRadius", "")),
                "opacity": str(box.get("opacity", "")),
                "bbox": {"x": x - origin_x, "y": y - origin_y, "w": w, "h": h},
            }
        )

    texts = []
    for item in manifest.get("texts", []) or []:
        raw = item.get("bbox") or {}
        if not raw:
            continue
        try:
            x = float(raw.get("x", 0) or 0)
            y = float(raw.get("y", 0) or 0)
            w = float(raw.get("w", 0) or 0)
            h = float(raw.get("h", 0) or 0)
        except (TypeError, ValueError):
            continue
        cx = x + w / 2
        cy = y + h / 2
        if not (bbox["x"] - 8 <= cx <= bbox["x"] + bbox["w"] + 8 and bbox["y"] - 8 <= cy <= bbox["y"] + bbox["h"] + 8):
            continue
        texts.append(
            {
                "text": str(item.get("text", "")),
                "kind": str(item.get("kind", "")),
                "color": str(item.get("color", "")),
                "fontSize": float(item.get("fontSize", 14) or 14),
                "bbox": {"x": x - origin_x, "y": y - origin_y, "w": max(w, 24.0), "h": max(h, 18.0)},
            }
        )

    sections = []
    for section in manifest.get("sections", []) or []:
        raw = section.get("containerBbox") or section.get("contentBbox") or section.get("bbox") or {}
        if not raw:
            continue
        try:
            x = float(raw.get("x", 0) or 0)
            y = float(raw.get("y", 0) or 0)
            w = float(raw.get("w", 0) or 0)
            h = float(raw.get("h", 0) or 0)
        except (TypeError, ValueError):
            continue
        if w <= 0 or h <= 0:
            continue
        if x + w < bbox["x"] - 8 or y + h < bbox["y"] - 8 or x > bbox["x"] + bbox["w"] + 8 or y > bbox["y"] + bbox["h"] + 8:
            continue
        label = str(section.get("ownerPath") or section.get("title") or "")
        layout_hint = str(section.get("layoutHint", ""))
        if layout_hint:
            label = f"{label} [{layout_hint}]"
        contract = section.get("renderContract") or {}
        sections.append(
            {
                "label": label,
                "whole": bool(contract.get("mustRenderWholeSection")),
                "bbox": {"x": x - origin_x, "y": y - origin_y, "w": w, "h": h},
            }
        )

    summary = manifest.get("summary", {}) or {}
    confidence = summary.get("analysisConfidence", {}) or {}
    return {
        "source": str(manifest.get("source", "")),
        "classification": str(summary.get("classification", "")),
        "fidelityHtml": bool(summary.get("fidelityHtml", False)),
        "analysisConfidence": {
            "level": str(confidence.get("level", "unknown")),
            "issues": [str(item) for item in (confidence.get("issues", []) or [])[:12]],
        },
        "bbox": bbox,
        "visualBoxes": visual_boxes[:900],
        "texts": texts[:1200],
        "sections": sections[:120],
    }


def build_html(data: dict[str, Any], title: str) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    safe_title = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return (
        """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__TITLE__</title>
  <link rel="stylesheet" href="./cdn/reset.css" />
  <style>
    body {{
      margin: 0;
      background: #eef2f7;
      color: #1f2329;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    #root {{
      min-height: 100vh;
    }}
    .preview-shell {{
      min-height: 100vh;
      padding: 24px;
      box-sizing: border-box;
    }}
    .preview-stage {{
      overflow: auto;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.74);
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.12);
      padding: 24px;
    }}
    .preview-page {{
      position: relative;
      margin: 0 auto;
      background: #f5f7fa;
      overflow: hidden;
      box-sizing: border-box;
      box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.06);
    }}
    .preview-box,
    .preview-text,
    .preview-section {{
      position: absolute;
      box-sizing: border-box;
    }}
    .preview-text {{
      white-space: pre-wrap;
      line-height: 1.35;
    }}
    .preview-section {{
      pointer-events: none;
      border: 1px solid rgba(23, 116, 255, 0.26);
      background: rgba(23, 116, 255, 0.03);
    }}
    .preview-section.preview-section-whole {{
      border-color: rgba(23, 116, 255, 0.56);
      background: rgba(23, 116, 255, 0.06);
    }}
    .preview-section-label {{
      position: absolute;
      left: 6px;
      top: 4px;
      font-size: 11px;
      line-height: 16px;
      color: #155bd4;
      background: rgba(255, 255, 255, 0.82);
      padding: 0 4px;
      border-radius: 4px;
    }}
    .preview-toolbar {{
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }}
    .preview-meta {{
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }}
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="./cdn/react.production.min.js"></script>
  <script src="./cdn/react-dom.production.min.js"></script>
  <script src="./cdn/dayjs.min.js"></script>
  <script src="./cdn/antd5.min.js"></script>
  <script src="./cdn/babel.min.js"></script>
  <script>
    window.__PREVIEW_DATA__ = __PAYLOAD__;
  </script>
  <script type="text/babel">
    const {{ useMemo, useState }} = React;
    const {{ App, Card, ConfigProvider, Space, Switch, Tag, Typography }} = antd;

    function px(value) {{
      return `${{Number(value || 0).toFixed(2)}}px`;
    }}

    function PreviewApp() {{
      const data = window.__PREVIEW_DATA__;
      const [showBoxes, setShowBoxes] = useState(true);
      const [showSections, setShowSections] = useState(true);
      const [showTextKinds, setShowTextKinds] = useState(false);

      const title = useMemo(() => {{
        const source = data.source || "";
        const parts = source.split(/[\\\\/]/);
        return parts[parts.length - 1] || "Manifest Preview";
      }}, [data.source]);

      return (
        <div className="preview-shell">
          <Card bordered={false} style={{{{ marginBottom: 16, borderRadius: 18 }}}}>
            <div className="preview-toolbar">
              <div>
                <Typography.Title level={4} style={{{{ margin: 0 }}}}>{title}</Typography.Title>
                <Typography.Text type="secondary">
                  React + AntD5 CDN preview rendered from current manifest
                </Typography.Text>
              </div>
              <Space size="middle" wrap>
                <Space>
                  <Typography.Text>背景盒</Typography.Text>
                  <Switch checked={showBoxes} onChange={setShowBoxes} />
                </Space>
                <Space>
                  <Typography.Text>分区框</Typography.Text>
                  <Switch checked={showSections} onChange={setShowSections} />
                </Space>
                <Space>
                  <Typography.Text>文本类型</Typography.Text>
                  <Switch checked={showTextKinds} onChange={setShowTextKinds} />
                </Space>
              </Space>
            </div>
            <div className="preview-meta">
              <Tag color="blue">{{data.classification || "unknown"}}</Tag>
              <Tag color={{data.fidelityHtml ? "geekblue" : "default"}}>{{data.fidelityHtml ? "fidelity-html" : "normal-html"}}</Tag>
              <Tag color={{data.analysisConfidence.level === "high" ? "success" : data.analysisConfidence.level === "low" ? "warning" : "processing"}}>
                confidence: {{data.analysisConfidence.level}}
              </Tag>
              {{(data.analysisConfidence.issues || []).map((issue) => (
                <Tag key={issue}>{{issue}}</Tag>
              ))}}
            </div>
          </Card>

          <div className="preview-stage">
            <div
              className="preview-page"
              style={{{{
                width: px(data.bbox.w),
                height: px(data.bbox.h),
              }}}}
            >
              {{showBoxes && data.visualBoxes.map((box, index) => (
                <div
                  key={`box-${{index}}`}
                  className="preview-box"
                  title={{box.kind || "box"}}
                  style={{{{
                    left: px(box.bbox.x),
                    top: px(box.bbox.y),
                    width: px(box.bbox.w),
                    height: px(box.bbox.h),
                    background: box.background || undefined,
                    border: box.border || undefined,
                    borderRadius: box.borderRadius || undefined,
                    opacity: box.opacity || undefined,
                  }}}}
                />
              ))}}

              {{showSections && data.sections.map((section, index) => (
                <div
                  key={`section-${{index}}`}
                  className={{`preview-section ${{section.whole ? "preview-section-whole" : ""}}`}}
                  style={{{{
                    left: px(section.bbox.x),
                    top: px(section.bbox.y),
                    width: px(section.bbox.w),
                    height: px(section.bbox.h),
                  }}}}
                >
                  <span className="preview-section-label">{{section.label}}</span>
                </div>
              ))}}

              {{data.texts.map((item, index) => (
                <div
                  key={`text-${{index}}`}
                  className="preview-text"
                  title={{showTextKinds ? item.kind || "text" : undefined}}
                  style={{{{
                    left: px(item.bbox.x),
                    top: px(item.bbox.y),
                    width: px(item.bbox.w),
                    minHeight: px(item.bbox.h),
                    fontSize: px(item.fontSize || 14),
                    color: item.color || undefined,
                  }}}}
                >
                  {{item.text}}
                </div>
              ))}}
            </div>
          </div>
        </div>
      );
    }}

    const root = ReactDOM.createRoot(document.getElementById("root"));
    root.render(
      <ConfigProvider theme={{{ token: {{ borderRadius: 12 }} }}}>
        <App>
          <PreviewApp />
        </App>
      </ConfigProvider>
    );
  </script>
</body>
</html>
"""
        .replace("{{", "{")
        .replace("}}", "}")
        .replace("__TITLE__", safe_title)
        .replace("__PAYLOAD__", payload)
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a React + AntD CDN HTML preview from a manifest.")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out-html", required=True)
    parser.add_argument("--title", default="")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    out_html = Path(args.out_html).resolve()
    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")

    ensure_dir(out_html.parent)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    data = trim_manifest(manifest)
    title = args.title or out_html.stem
    out_html.write_text(build_html(data, title), encoding="utf-8")
    print(str(out_html))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
