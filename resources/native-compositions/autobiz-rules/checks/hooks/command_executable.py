"""Read-only rules extracted from hooks/code_shell_analysis.py. See provenance.json."""
from __future__ import annotations
import re
import posixpath

def executable(token: str) -> str:
    return token.replace("\\", "/").rsplit("/", 1)[-1].lower().removesuffix(".cmd").removesuffix(".bat")
