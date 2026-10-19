"""AutoBiz plugin-side context adapter; original scripts retain business semantics.

Package this file as a selected Mod resource. Mutable files and collector dependencies
belong to host-assigned data, while original package files remain read-only.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


def source_root() -> Path:
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "board_core" / "board_config.json").is_file():
            return candidate
    raise RuntimeError("AUTOBIZ_CONTEXT_SOURCE_MISSING")


def assigned_path(name: str, directory: bool = True) -> Path:
    value = os.environ.get(name, "")
    if not value or not Path(value).is_absolute():
        raise RuntimeError("AUTOBIZ_CONTEXT_BINDING_MISSING")
    path = Path(value)
    if path.is_symlink() or not (path.is_dir() if directory else path.is_file()):
        raise RuntimeError("AUTOBIZ_CONTEXT_BINDING_INVALID")
    return path.resolve()


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    separator = args.index("--") if "--" in args else len(args)
    parser = argparse.ArgumentParser()
    parser.add_argument("--devclaw-operation", choices=["session-context", "sync-knowledge"], required=True)
    options = parser.parse_args(args[:separator])
    original_args = args[separator + 1:] if separator < len(args) else []
    root = source_root()
    data = assigned_path("DEVCLAW_PLUGIN_DATA_ROOT")
    knowledge = assigned_path("DEVCLAW_KNOWLEDGE_ROOT")
    config = assigned_path("DEVCLAW_RUNTIME_CONFIG_PATH", directory=False)
    if data == root or root in data.parents or config.parent != data:
        raise RuntimeError("AUTOBIZ_CONTEXT_DATA_INSIDE_SOURCE")
    if options.devclaw_operation == "sync-knowledge":
        # Old sync_repo recursively replaces its destination. Native directory selection is
        # read-only binding consent, never permission to clear that external folder.
        if (os.environ.get("DEVCLAW_KNOWLEDGE_READONLY") != "0"
                or knowledge.parent != data or knowledge.name != "knowledge"):
            raise RuntimeError("AUTOBIZ_CONTEXT_KNOWLEDGE_READONLY")
    sys.path.insert(0, str(root))
    import hooks.agents_repo as repo
    import hooks.render_session_context as legacy
    import hooks.render_collected_session_context as collected
    import hooks.sync_agents as sync

    # Old helpers import get_agents_root by value; bind all original consumers to the same root.
    for module in (repo, legacy, collected, sync):
        module.get_agents_root = lambda *_args, **_kwargs: knowledge
    sync.BOARD_CONFIG_PATH = config

    tools = data / "collector"
    if tools.is_symlink():
        raise RuntimeError("AUTOBIZ_CONTEXT_COLLECTOR_SCOPE_CHANGED")
    tools.mkdir(exist_ok=True)
    if tools.resolve().parent != data:
        raise RuntimeError("AUTOBIZ_CONTEXT_COLLECTOR_SCOPE_CHANGED")
    for filename in ("collect-knowledge.js", "package.json"):
        original = root / "hooks" / filename
        destination = tools / filename
        if destination.is_symlink():
            raise RuntimeError("AUTOBIZ_CONTEXT_COLLECTOR_SCOPE_CHANGED")
        content = original.read_bytes()
        if not destination.exists() or destination.read_bytes() != content:
            destination.write_bytes(content)
    collector = str(tools / "collect-knowledge.js")
    sync.KNOWLEDGE_COLLECTOR_PATH = Path(collector)

    if options.devclaw_operation == "sync-knowledge":
        sync_parser = argparse.ArgumentParser()
        sync_parser.add_argument("--repo-url", default=None)
        sync_parser.add_argument("--ssh-url", default=None)
        sync_parser.add_argument("--ref", default=None)
        sync_parser.add_argument("--prefer-manifest", action="store_true")
        sync_parser.add_argument("--write-board-config", action="store_true")
        selected = sync_parser.parse_args(original_args)
        result = sync.run(selected.repo_url, selected.ref, selected.ssh_url,
                          prefer_manifest=selected.prefer_manifest)
        if result.get("ok"):
            units = result.get("supported_deploy_units")
            if not isinstance(units, list):
                raise RuntimeError("AUTOBIZ_CONTEXT_SYNC_RESULT_INVALID")
            sync.merge_supported_units_into_board_config(units, config_path=config)
            sync.merge_knowledge_path_into_board_config(str(knowledge), config_path=config)
            result["boardConfigWritten"] = False
            result["runtimeConfigWritten"] = True
            result["knowledge_path"] = str(knowledge)
            result["path"] = str(knowledge)
        json.dump(result, sys.stdout, ensure_ascii=False)
        print()
        return 0

    original_render = collected.render

    def render(*render_args, **kwargs):
        kwargs["board_config_path"] = config
        kwargs["knowledge_path"] = str(knowledge)
        kwargs["collector_script"] = collector
        return original_render(*render_args, **kwargs)

    collected.render = render
    # CLI list mode bypasses render(). Pin both paths there as well, while retaining every
    # other original argument, including platform, stage, selected units and node/npm commands.
    selected_args = []
    index = 0
    while index < len(original_args):
        argument = original_args[index]
        if argument in ("--knowledge-path", "--knowledgePath", "--knowledge-collector"):
            index += 2
            continue
        if any(argument.startswith(flag + "=") for flag in
               ("--knowledge-path", "--knowledgePath", "--knowledge-collector")):
            index += 1
            continue
        selected_args.append(argument)
        index += 1
    selected_args.extend(["--knowledge-path", str(knowledge), "--knowledge-collector", collector])
    return collected.main(selected_args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "message": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
