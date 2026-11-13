#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Compute the code candidate digest bound to verification decisions."""

from __future__ import print_function

import hashlib
import json
import subprocess
from pathlib import Path


def _git_bytes(root, args):
    process = subprocess.run(
        ["git", "-C", str(root)] + list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode != 0:
        raise ValueError(
            "CANDIDATE_DIGEST_UNRESOLVED: git {} failed at {}: {}".format(
                " ".join(args), root, process.stderr.decode("utf-8", errors="replace").strip()
            )
        )
    return process.stdout


def _git_bytes_optional(root, args):
    process = subprocess.run(
        ["git", "-C", str(root)] + list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return process.stdout if process.returncode == 0 else None


def _git_root(path):
    result = _git_bytes_optional(path, ["rev-parse", "--show-toplevel"])
    if result is None:
        return None
    value = result.decode("utf-8", errors="replace").strip()
    return Path(value).resolve() if value else None


def _plan_repositories(workspace, feature):
    plan_path = Path(workspace) / ".autobizdevops" / "features" / feature / "plan.json"
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(
            "CANDIDATE_DIGEST_UNRESOLVED: 无法读取 Plan {}: {}".format(plan_path, exc)
        )
    except ValueError as exc:
        raise ValueError(
            "CANDIDATE_DIGEST_UNRESOLVED: Plan 不是合法 JSON {}: {}".format(plan_path, exc)
        )
    bindings = plan.get("codeWorkspaces") if isinstance(plan, dict) else None
    if not isinstance(bindings, dict) or not bindings:
        raise ValueError(
            "CANDIDATE_DIGEST_UNRESOLVED: Plan 缺少非空 codeWorkspaces: {}".format(plan_path)
        )

    repositories = {}
    for workspace_ref, raw_path in sorted(bindings.items()):
        if not isinstance(workspace_ref, str) or not workspace_ref.strip() or not isinstance(raw_path, str) or not raw_path.strip():
            raise ValueError(
                "CANDIDATE_DIGEST_UNRESOLVED: Plan codeWorkspaces 包含无效绑定 {}".format(workspace_ref)
            )
        root = _git_root(Path(raw_path).expanduser().resolve())
        if root is None:
            raise ValueError(
                "CANDIDATE_DIGEST_UNRESOLVED: Plan workspaceRef={} 不是有效 Git 仓库: {}".format(
                    workspace_ref, raw_path
                )
            )
        repositories.setdefault(root, []).append(workspace_ref)
    return [(root, sorted(refs)) for root, refs in sorted(repositories.items(), key=lambda item: str(item[0]))]


def compute(workspace, feature):
    digest = hashlib.sha256()
    for root, workspace_refs in _plan_repositories(workspace, feature):
        digest.update("\0".join(workspace_refs).encode("utf-8"))
        digest.update(str(root).encode("utf-8"))
        head = _git_bytes_optional(root, ["rev-parse", "--verify", "HEAD"])
        if head is None:
            digest.update(b"UNBORN\n")
            digest.update(_git_bytes(root, ["diff", "--binary", "--cached", "--", "."]))
            digest.update(_git_bytes(root, ["diff", "--binary", "--", "."]))
        else:
            digest.update(head)
            digest.update(_git_bytes(root, ["diff", "--binary", "HEAD", "--", "."]))
        untracked = _git_bytes(
            root, ["ls-files", "--others", "--exclude-standard", "-z"]
        ).split(b"\0")
        for raw_path in sorted(value for value in untracked if value):
            relative = raw_path.decode("utf-8", errors="surrogateescape")
            if ".autobizdevops" in Path(relative).parts:
                continue
            path = root / relative
            digest.update(raw_path)
            if path.is_file():
                digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()
