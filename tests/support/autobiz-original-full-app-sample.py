"""Deterministic authoring only; all receipts and gates remain original AutoBiz APIs."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


def load_sample(filename: str, name: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    if spec is None or spec.loader is None:
        raise ValueError("sample_module_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prd", "specs", "design", "plan", "cicd", "archive"])
    parser.add_argument("--plugin-root", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--feature", required=True)
    parser.add_argument("--knowledge-text-file", type=Path)
    args = parser.parse_args()
    plugin = args.plugin_root.resolve(strict=True)
    workspace = args.workspace.resolve(strict=True)
    if not args.feature.replace("-", "").isalnum():
        raise ValueError("explicit_sample_feature_required")
    sys.path.insert(0, str(plugin))
    app = load_sample("autobiz-full-app-sample.py", "autobiz_original_app_lifecycle")
    if args.action == "plan":
        if args.knowledge_text_file is None:
            raise ValueError("explicit_knowledge_required")
        knowledge = args.knowledge_text_file.read_text("utf-8")
        if not knowledge.strip():
            raise ValueError("actual_nonempty_knowledge_context_required")
        creator = load_sample("autobiz-creator-code-sample.py", "autobiz_original_app_plan")
        result = creator.prepare(workspace, args.feature, knowledge, "maven-java")
    elif args.action == "archive":
        result = app.archive(workspace, args.feature)
    else:
        result = app.lifecycle(plugin, workspace, args.feature, args.action)
    print("APP_SAMPLE_RESULT=" + json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
