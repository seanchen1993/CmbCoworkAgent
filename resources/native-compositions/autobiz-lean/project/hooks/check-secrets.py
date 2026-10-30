"""Synchronous retained PreToolUse guard. Never echoes candidate content or values."""
import json
import sys
from pathlib import Path

# -I deliberately excludes cwd and user site packages. Only the retained sibling is loaded.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from secret_rules import check_line


def main():
    raw = sys.stdin.read(1000001)
    if len(raw.encode("utf-8")) > 1000000:
        raise ValueError("WRITE_INPUT_LIMIT")
    payload = json.loads(raw)
    value = payload.get("tool_input")
    if not isinstance(value, dict):
        raise ValueError("WRITE_INPUT_INVALID")
    path = value.get("filePath", value.get("file_path", value.get("path")))
    if not isinstance(path, str) or not path:
        raise ValueError("WRITE_PATH_REQUIRED")
    # The retained profiles expose write_file/edit_file. Unsupported patch representations
    # fail closed instead of silently bypassing a content scan.
    parts = [value[key] for key in ("content", "newString", "new_string") if key in value]
    if not parts or any(not isinstance(part, str) for part in parts):
        raise ValueError("WRITE_CONTENT_REQUIRED")
    if Path(path.lower()).suffix not in {".yaml", ".yml", ".properties"}:
        return
    for part in parts:
        for line in part.splitlines():
            if check_line(line):
                raise ValueError("PLAINTEXT_SECRET_WRITE_DENIED_USE_APPROVED_ENCRYPTION_OR_REFERENCE")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Stable diagnosis only: malformed input and scanner errors must also block.
        print("AUTOBIZ_SECRET_WRITE_GUARD_BLOCKED")
        sys.exit(2)
