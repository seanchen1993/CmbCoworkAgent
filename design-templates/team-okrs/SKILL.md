---
name: 团队 OKR
description: 团队 OKR 追踪页模板，包含季度总览、目标、关键结果、进度条、负责人和风险状态。
triggers:
  - "okr"
  - "okrs"
  - "key results"
  - "objectives"
  - "目标"
od:
  mode: prototype
  platform: desktop
  scenario: product
  preview:
    type: html
    entry: index.html
  design_system:
    requires: true
    sections: [color, typography, layout, components]
  example_prompt: "Build an OKR tracker for Q4 — three objectives, three key results each, progress bars, owners, status pills."
---

# Team OKRs Skill

Produce a single-screen OKR tracker.

## Workflow

1. Read DESIGN.md.
2. Layout:
   - Quarter banner: Q4 FY25, dates, overall progress chip.
   - Three objective cards. Each has:
     - Objective title + owner avatar + status pill (On track / At risk / Off track)
     - 3 key results, each a row with metric / current → target / progress bar
   - Right sidebar: at-a-glance KPIs, top movers, blockers callout.
3. Clear progress visualisation, calm palette, one accent.

## Output contract

```
<artifact identifier="okr-q4" type="text/html" title="OKRs Q4">
<!doctype html>...</artifact>
```
