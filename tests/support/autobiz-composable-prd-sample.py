"""Controlled author reads the real upstream output, retaining the original PRD writer/checks."""
import importlib.util
import contextlib
import json
from pathlib import Path
import sys

source, workspace, feature = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
path = Path(__file__).with_name("autobiz-creator-lifecycle-sample.py")
spec = importlib.util.spec_from_file_location("original_controlled_prd_author", path)
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)
upstream = workspace / ".autobizdevops/features" / feature / "NORMALIZED_REQUIREMENTS.json"
requirements = json.loads(upstream.read_text(encoding="utf-8"))
assert requirements["feature"] == feature
with contextlib.redirect_stdout(sys.stderr):
    sample.prepare(source, workspace, feature, "prd")
prd = workspace / ".autobizdevops/features" / feature / "PRD.md"
with prd.open("a", encoding="utf-8") as file:
    file.write("\n## 上游需求转换输入\n来源：NORMALIZED_REQUIREMENTS.json\n")
    for requirement in requirements["requirements"]:
        file.write("- " + requirement + "\n")
print(json.dumps({"read": "NORMALIZED_REQUIREMENTS.json", "requirements": requirements["requirements"]}, ensure_ascii=False))
