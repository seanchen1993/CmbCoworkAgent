"""Read exact original artifacts; stdout is an archive object, never a success receipt."""
import hashlib
import json
from pathlib import Path

archive = {}
for name in ("RequestBaseline.json", "Definition.json", "Solution.json", "Code.json"):
    raw = Path(name).read_bytes()
    archive[name] = {"text": raw.decode("utf-8", errors="strict"), "sha256": hashlib.sha256(raw).hexdigest()}
print(json.dumps(archive, ensure_ascii=False))
