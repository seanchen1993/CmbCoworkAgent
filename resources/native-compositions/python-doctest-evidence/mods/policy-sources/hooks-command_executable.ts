// Retained execution policy source; see provenance.json.
export default "\"\"\"Read-only rules extracted from hooks/code_shell_analysis.py. See provenance.json.\"\"\"\nfrom __future__ import annotations\nimport re\nimport posixpath\n\ndef executable(token: str) -> str:\n    return token.replace(\"\\\\\", \"/\").rsplit(\"/\", 1)[-1].lower().removesuffix(\".cmd\").removesuffix(\".bat\")\n"
