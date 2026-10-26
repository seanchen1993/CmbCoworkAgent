"""Apply the original seven rules to bounded, actual changed Git blobs.

Only immutable blob bytes enter the rule engine. Diagnostics expose rule IDs and
line numbers, never source snippets, URLs, or exception details.
"""
import hashlib
import re
import subprocess
from pathlib import PurePosixPath
from hooks.performance_rules import FRONTEND_EXTENSIONS, run_check

MAX_FILES = 64
MAX_FILE_BYTES = 64 * 1024
MAX_TOTAL_BYTES = 256 * 1024


def git(*args):
    result = subprocess.run(["git", *args], capture_output=True, timeout=20)
    if result.returncode != 0:
        raise ValueError("PERFORMANCE_GIT_READ_FAILED")
    return result.stdout


def check(command):
    try:
        baseline, commit = command.get("baselineCommit"), command.get("expectedCommit")
        if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40,64}", value)
               for value in (baseline, commit)):
            raise ValueError("PERFORMANCE_COMMIT_REQUIRED")
        if git("rev-parse", "HEAD").decode("ascii").strip() != commit:
            raise ValueError("PERFORMANCE_HEAD_CHANGED")
        diff = git("diff", "--no-ext-diff", "--name-only", "--diff-filter=ACMR", "-z", baseline, commit)
        if len(diff) > 64000:
            raise ValueError("PERFORMANCE_DIFF_LIMIT")
        paths = [item.decode("utf-8", errors="strict") for item in diff.split(b"\0") if item]
        selected = [path for path in paths if PurePosixPath(path).suffix in FRONTEND_EXTENSIONS]
        if len(selected) > MAX_FILES:
            raise ValueError("PERFORMANCE_FILE_COUNT_LIMIT")
        files, errors, total = [], [], 0
        for path in selected:
            # Reject symlinks/gitlinks instead of checking their target spelling as source code.
            tree = git("ls-tree", "-z", commit, "--", path).split(b"\0")
            if len(tree) != 2 or tree[1] or tree[0].split(b" ", 1)[0] not in {b"100644", b"100755"}:
                raise ValueError("PERFORMANCE_REGULAR_BLOB_REQUIRED")
            size = int(git("cat-file", "-s", commit + ":" + path))
            total += size
            if size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
                raise ValueError("PERFORMANCE_SOURCE_LIMIT")
            content = git("show", "--no-ext-diff", "--no-textconv", commit + ":" + path)
            if len(content) != size:
                raise ValueError("PERFORMANCE_BLOB_CHANGED")
            text = content.decode("utf-8", errors="strict")
            findings = run_check(text)
            files.append({"path": path, "sha256": hashlib.sha256(content).hexdigest(), "bytes": size})
            errors.extend({"code": item["rule_id"], "path": path, "line": item["line"]}
                          for item in findings)
            if len(errors) > 128:
                raise ValueError("PERFORMANCE_FINDINGS_LIMIT")
        if git("rev-parse", "HEAD").decode("ascii").strip() != commit:
            raise ValueError("PERFORMANCE_HEAD_CHANGED")
        return {"passed": not errors, "errors": errors, "warnings": [],
                "baselineCommit": baseline, "headCommit": commit, "files": files}
    except Exception as error:
        # Never serialize raw Git/Python exceptions: they can contain source or local paths.
        allowed = {"PERFORMANCE_GIT_READ_FAILED", "PERFORMANCE_COMMIT_REQUIRED",
                   "PERFORMANCE_HEAD_CHANGED", "PERFORMANCE_DIFF_LIMIT", "PERFORMANCE_FILE_COUNT_LIMIT",
                   "PERFORMANCE_REGULAR_BLOB_REQUIRED", "PERFORMANCE_SOURCE_LIMIT",
                   "PERFORMANCE_BLOB_CHANGED", "PERFORMANCE_FINDINGS_LIMIT"}
        code = str(error) if isinstance(error, ValueError) and str(error) in allowed else "PERFORMANCE_READ_INVALID"
        return {"passed": False, "errors": [{"code": code}], "warnings": []}
