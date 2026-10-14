"""Initialize only a new archived copy, using the selected branch's own initializer."""

import contextlib
import io
import json
import subprocess
import sys
from pathlib import Path


project = Path(sys.argv[1]).resolve(strict=True)
if (project / ".git").exists() or (project / ".autobizdevops").exists():
    raise RuntimeError("Demo preparation requires a new source archive without business state")
sys.path.insert(0, str(project))

from hooks.init_workspace import create_feature, init_workspace


with contextlib.redirect_stdout(io.StringIO()):
    init_workspace(project)
    create_feature(
        project,
        "mods-demo",
        workflow_template="lean",
        workflow_nodes=["dev.specs", "dev.code", "ops.archive"],
    )

import os

environment = {
    **os.environ,
    "PLUGIN_WORKSPACE": str(project.parent),
    "PROJECT_DIR": project.name,
    "PYTHONIOENCODING": "utf-8",
    "PYTHONDONTWRITEBYTECODE": "1",
}
result = subprocess.run(
    [sys.executable, "-B", "-X", "utf8", str(project / "read_state_json.py")],
    cwd=project,
    env=environment,
    capture_output=True,
    text=True,
    encoding="utf-8",
    timeout=30,
    check=True,
)
payload = json.loads(result.stdout)
if payload.get("ok") is not True or payload.get("recordErrors"):
    raise RuntimeError("The original state reader rejected the initialized demo")
record = payload["records"]["mods-demo"]
if record["checkpoint"] in {"code_in_progress", "requirements_eval_in_progress"}:
    raise RuntimeError("Demo initialization must not skip to Code or Review")
print(json.dumps({"feature": "mods-demo", "record": record}, ensure_ascii=False))
