#!/usr/bin/env python3
"""Compatibility entrypoint; implementation belongs to the artifact sync skill."""

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "autobizdevops-artifact-sync" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import artifact_sync as _implementation  # noqa: E402

sys.modules[__name__] = _implementation
