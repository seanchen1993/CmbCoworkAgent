import hashlib
import json
import re
import sys


def derive_design_lock(payload):
    text = payload["design"]
    if not isinstance(text, str) or not text or "\r" in text:
        raise ValueError("DESIGN_REQUIRES_NONEMPTY_LF_TEXT")
    if not all(isinstance(payload[key], str) and payload[key].strip()
               for key in ("feature", "lockedAt")):
        raise ValueError("DESIGN_LOCK_IDENTITY_REQUIRED")

    def marker(name):
        for raw in text.splitlines():
            line = raw.strip()
            if len(line) >= 2 and line[0] in "-*+" and line[1].isspace():
                line = line[2:].strip()
            line = line.replace("**", "")
            match = re.fullmatch(re.escape(name) + r"\s*:\s*(true|false)", line, re.I)
            if match:
                return match.group(1).lower() == "true"
        raise ValueError("DESIGN_BOOLEAN_MARKER_REQUIRED:" + name)

    def ids(prefix):
        values = re.findall(r"^\|\s*(" + prefix + r"-\d{3})\s*\|", text, re.M)
        if len(values) != len(set(values)):
            raise ValueError("DESIGN_DUPLICATE_ID:" + prefix)
        return sorted(values)

    contract = {
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "apiIds": ids("API"), "dataIds": ids("DATA"), "decisionIds": ids("D"),
        "noHttpApi": marker("x-auto-no-http-api"), "noSql": marker("x-auto-no-sql"),
    }
    if (contract["noHttpApi"] and contract["apiIds"]
            or contract["noSql"] and contract["dataIds"]):
        raise ValueError("DESIGN_MARKER_CONFLICTS_WITH_IDS")
    return {"version": 1, "featureId": payload["feature"], "lockOwner": "dev.design",
            "lockedAt": payload["lockedAt"], "designContract": contract}


if __name__ == "__main__":
    print(json.dumps(derive_design_lock(json.load(sys.stdin)), ensure_ascii=False))
