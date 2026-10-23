"""AutoBiz plugin-side context adapter; original scripts retain business semantics.

Package this file and the pinned offline parser as selected Mod resources. Mutable files
belong to host-assigned data, while original package files remain read-only. Session reads
never install packages; every collector call shares one bounded request budget.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


SESSION_COLLECTOR_BUDGET_SECONDS = 8.0
COLLECTOR_CALL_TIMEOUT_SECONDS = 3.0
COLLECTOR_HTTP_TIMEOUT_MS = 1250


def private_copy(directory: Path, filename: str, content: bytes) -> Path:
    destination = directory / filename
    if destination.is_symlink() or destination.resolve().parent != directory.resolve():
        raise RuntimeError("AUTOBIZ_CONTEXT_COLLECTOR_SCOPE_CHANGED")
    if not destination.exists() or destination.read_bytes() != content:
        descriptor, temporary = tempfile.mkstemp(prefix=".collector-", dir=directory)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return destination


def configure_offline_collector(collected, tools: Path, collector: str):
    """Keep the original collector/parser semantics without a runtime package manager."""
    source = Path(__file__).resolve().parent / "collector-gray-matter.cjs"
    if source.is_symlink() or not source.is_file():
        raise RuntimeError("AUTOBIZ_CONTEXT_OFFLINE_PARSER_MISSING: 请重新安装完整知识扩展插件")
    parser = private_copy(tools, source.name, source.read_bytes())
    preload = private_copy(tools, "collector-runtime.cjs", ("""
const Module = require('node:module');
const http = require('node:http');
const load = Module._load;
const collector = %s, parser = %s;
Module._load = function(name, parent, main) {
  if (name === 'gray-matter' && parent && parent.filename === collector)
    return load.call(this, parser, parent, false);
  return load.call(this, name, parent, main);
};
const request = http.request;
http.request = function(...args) {
  const req = request.apply(this, args);
  const timeout = Math.min(%s, Number(process.env.DEVCLAW_COLLECTOR_HTTP_TIMEOUT_MS));
  const timer = setTimeout(() => req.destroy(new Error('AUTOBIZ_CONTEXT_METADATA_TIMEOUT')), timeout);
  timer.unref();
  req.once('close', () => clearTimeout(timer));
  return req;
};
""" % (json.dumps(collector), json.dumps(str(parser)), COLLECTOR_HTTP_TIMEOUT_MS)).encode("utf-8"))
    deadline = time.monotonic() + SESSION_COLLECTOR_BUDGET_SECONDS

    def no_install(*_args, **_kwargs):
        collected._timing_log("dependencies.offline", "ready", "bundled gray-matter; npm disabled")
        return ""

    def run_collector(collector_script, collector_args, *, knowledge_path, node_command="node"):
        if Path(collector_script).resolve() != Path(collector).resolve():
            raise collected.KnowledgeCollectorError("AUTOBIZ_CONTEXT_COLLECTOR_SCOPE_CHANGED")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise collected.KnowledgeCollectorError("AUTOBIZ_CONTEXT_COLLECTOR_BUDGET_EXHAUSTED")
        timeout = min(COLLECTOR_CALL_TIMEOUT_SECONDS, remaining)
        env = dict(os.environ)
        env["DEVCLAW_COLLECTOR_HTTP_TIMEOUT_MS"] = str(max(1, min(
            COLLECTOR_HTTP_TIMEOUT_MS, int(timeout * 1000) - 100)))
        try:
            result = subprocess.run(
                [node_command, "--require", str(preload), collector, *collector_args,
                 "--knowledgePath", knowledge_path],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                check=False, timeout=timeout, env=env,
            )
        except subprocess.TimeoutExpired as error:
            raise collected.KnowledgeCollectorError(
                "AUTOBIZ_CONTEXT_COLLECTOR_TIMEOUT: 本次知识读取总预算8秒，请检查知识规模或网络后重试"
            ) from error
        except OSError as error:
            raise collected.KnowledgeCollectorError(
                "AUTOBIZ_CONTEXT_COLLECTOR_UNAVAILABLE: 请安装或指定可用的Node.js；不会自动安装依赖"
            ) from error
        if result.returncode != 0:
            raise collected.KnowledgeCollectorError(
                "AUTOBIZ_CONTEXT_COLLECTOR_FAILED: " + collected._short_error(result.stderr))
        try:
            return json.loads(result.stdout)
        except (ValueError, TypeError) as error:
            raise collected.KnowledgeCollectorError("AUTOBIZ_CONTEXT_COLLECTOR_INVALID_JSON") from error

    def refuse_partial_legacy(*_args, **_kwargs):
        # A manifest-only legacy success can omit collector-derived Product/Service
        # Knowledge. A configured per-unit local AGENTS fallback still runs in the
        # original _resolve_unit; whole-request substitution must fail closed.
        raise collected.KnowledgeCollectorError(
            "AUTOBIZ_CONTEXT_SELECTED_KNOWLEDGE_UNAVAILABLE: " + str(_args[1]))

    collected._npm_install = no_install
    collected._run_collector = run_collector
    collected._legacy_result = refuse_partial_legacy


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
        private_copy(tools, filename, original.read_bytes())
    collector = str(tools / "collect-knowledge.js")
    configure_offline_collector(collected, tools, collector)
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
        result = original_render(*render_args, **kwargs)
        selected = render_args[0] if render_args else kwargs.get("selected", [])
        statuses = result.get("agentmdLoadStatus", [])
        missing = [item["deployUnitId"] for item in selected if not any(
            status.get("deployUnitId") == item["deployUnitId"] and status.get("loaded") is True
            for status in statuses)]
        if missing:
            result["ok"] = False
            result["sessionContext"] = ""
            result["message"] = "必需项目知识未完整装载，已阻止本次任务：" + ", ".join(missing)
        return result

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
