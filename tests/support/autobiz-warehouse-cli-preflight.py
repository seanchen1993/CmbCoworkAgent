"""Private original-CLI preflight only. Does not substitute for Electron A12 acceptance."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    args = parser.parse_args()
    archive = args.archive.resolve(strict=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="run-", dir=args.artifacts.resolve()))
    source = root / "plugin"
    source.mkdir()
    before = hashlib.sha256(archive.read_bytes()).hexdigest()
    evidence: dict = {"passed": False, "scope": "original CLI input preflight, not app acceptance",
                      "archiveSha256": before, "source": str(source), "commands": []}
    try:
        with zipfile.ZipFile(archive) as package:
            for entry in package.infolist():
                target = (source / entry.filename).resolve()
                if not target.is_relative_to(source.resolve()):
                    raise ValueError("unsafe_archive_entry")
            package.extractall(source)
        parent = root / "workspace"
        parent.mkdir()
        workspace = parent / "project"
        workspace.mkdir()
        feature = "warehouse-positive"
        feature_dir = workspace / ".autobizdevops/features" / feature
        environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
                       "PYTHONIOENCODING": "utf-8", "PLUGIN_WORKSPACE": str(parent),
                       "PROJECT_DIR": "project", "FEATURE_ID": feature,
                       "SESSION_WORKSPACE_PATH": str(workspace)}

        def run(script: Path, *arguments: str, success: bool = True) -> dict:
            command = [sys.executable, "-I", "-B", "-X", "utf8", str(script), *arguments]
            process = subprocess.run(command, cwd=source, env=environment, capture_output=True,
                                     text=True, encoding="utf-8", timeout=90)
            result = {"command": command, "exitCode": process.returncode,
                      "stdout": process.stdout, "stderr": process.stderr}
            evidence["commands"].append(result)
            if (process.returncode == 0) != success:
                raise ValueError("unexpected_original_cli_result: " + json.dumps(result, ensure_ascii=False))
            return result

        for mode, extra in [("createProject", []), ("createFeature", ["--feature", feature])]:
            run(source / "hooks/init_workspace.py", "--mode", mode, "--workspace", str(parent),
                "--project", "project", *extra)
        sample = Path(__file__).with_name("autobiz-warehouse-input-sample.py").resolve()

        def checkpoint(name: str) -> None:
            run(source / "hooks/update_checkpoint.py", "--feature", feature,
                "--checkpoint", name, "--json")

        run(sample, "--plugin-root", str(source), "--workspace", str(workspace),
            "--feature", feature, "--step", "prd")
        checkpoint("prd_done")
        checkpoint("specs_in_progress")
        run(sample, "--plugin-root", str(source), "--workspace", str(workspace),
            "--feature", feature, "--step", "specs")
        checkpoint("specs_done")
        checkpoint("warehouse_model_in_progress")
        run(source / "mods/business/warehouse.model/check.py", "init-demo", "--feature-dir", str(feature_dir))
        run(source / "mods/business/warehouse.model/check.py", "build", "--feature-dir", str(feature_dir))
        checkpoint("warehouse_model_done")
        checkpoint("warehouse_sql_in_progress")
        run(source / "mods/business/warehouse.sql/check.py", "run", "--feature-dir", str(feature_dir))
        checkpoint("warehouse_sql_done")
        checkpoint("warehouse_quality_in_progress")
        run(source / "mods/business/warehouse.quality/check.py", "check", "--feature-dir", str(feature_dir))
        checkpoint("warehouse_quality_done")
        evidence["passed"] = True
        evidence["finalState"] = json.loads((workspace / ".autobizdevops/state.json").read_text("utf-8"))
        evidence["quality"] = json.loads((feature_dir / "warehouse/QUALITY.json").read_text("utf-8"))
    finally:
        evidence["archiveUnchanged"] = hashlib.sha256(archive.read_bytes()).hexdigest() == before
        (root / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"passed": evidence["passed"], "evidence": str(root / "evidence.json")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
