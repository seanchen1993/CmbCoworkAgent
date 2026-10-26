"""Read-only adapter for extracted business checks; no outer workflow state API."""
from pathlib import Path


class HookContext:
    def __init__(self, directory: Path, feature: str, stage: str):
        self.feature_dir = directory
        self.slug = feature
        self.skill = "autobiz-requirement-discuss" if stage == "prd" else "autodev-" + stage
        self.errors = []
        self.warnings = []

    def file(self, name):
        return self.feature_dir / name

    def requires_artifact(self, name):
        return name in {"UI_CONTEXT.json", "plan.json"}


def fail_line(ctx, reason, detail="", **kwargs):
    ctx.errors.append({"code": reason, "detail": detail, **kwargs})
    return 1


def info(ctx, reason, detail="", **kwargs):
    ctx.warnings.append({"code": reason, "detail": detail, **kwargs})


def is_nonempty(path):
    return path.is_file() and path.stat().st_size > 0


def read_text(path):
    return path.read_text(encoding="utf-8")
