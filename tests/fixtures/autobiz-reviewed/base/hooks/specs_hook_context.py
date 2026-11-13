#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal environment and checkpoint routing for dev.specs hooks."""

from __future__ import print_function

import json
import os
from pathlib import Path


def feature_dir_from_env():
    plugin_workspace = str(os.environ.get("PLUGIN_WORKSPACE", "") or "").strip()
    project_dir = str(
        os.environ.get("PROJECT_DIR", "") or os.environ.get("PROJECT_CODE", "") or ""
    ).strip()
    feature = str(os.environ.get("FEATURE_ID", "") or "").strip()
    if not plugin_workspace or not project_dir or not feature:
        raise ValueError("SPECS_HOOK_CONTEXT_MISSING: PLUGIN_WORKSPACE / PROJECT_DIR / FEATURE_ID 未设置。")
    if "/" in project_dir or "\\" in project_dir or "/" in feature or "\\" in feature:
        raise ValueError("SPECS_HOOK_CONTEXT_INVALID: PROJECT_DIR / FEATURE_ID 不能包含路径分隔符。")
    return (
        Path(plugin_workspace).expanduser()
        / project_dir
        / ".autobizdevops"
        / "features"
        / feature
    ).resolve()


def is_specs_in_progress(feature_dir):
    feature_dir = Path(feature_dir).resolve()
    try:
        workspace = feature_dir.parents[2]
        feature = feature_dir.name
        data = json.loads(
            (workspace / ".autobizdevops" / "state.json").read_text(encoding="utf-8")
        )
    except (IndexError, OSError, ValueError):
        return False
    records = data.get("features") if isinstance(data, dict) and "features" in data else data
    record = records.get(feature) if isinstance(records, dict) else None
    return isinstance(record, dict) and record.get("checkpoint") == "specs_in_progress"
