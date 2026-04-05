"""
candidate bundle 物化与 diff 生成模块。

这个模块的定位很关键：
- LLM 只产生结构化 patch
- 这里负责把 patch 真正、安全地写回到 candidate bundle 副本

因此它承担三类职责：
1. 在 bundle 副本上应用 EditOp
2. 校验改写后的 markdown/bundle 仍然合法
3. 生成 unified diff 和结构化 diff 供审阅

V1 明确不允许模型直接生成最终文件并覆盖源 bundle。
当前主写回路径使用 exact text edit（old_string -> new_string）；
追加新 section/说明时使用 append_file_end，frontmatter 走结构化字段更新。
"""

from __future__ import annotations

import difflib
import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

import frontmatter
from markdown_it import MarkdownIt

from trace_evolver.schemas import CandidateBundle, EditOp, HypothesisPatch, SkillBundleMeta
from trace_evolver.utils import is_allowed_markdown_path, is_allowed_markdown_relative_path, json_dumps, sha256_text, slugify


@dataclass
class ApplyResult:
    candidate: CandidateBundle
    diff_patch: str
    diff_json: list[dict[str, object]]
    warnings: list[str]


class PatchEngine:
    def apply(
        self,
        candidate_id: str,
        patch_group: list[HypothesisPatch],
        bundle: SkillBundleMeta | None,
        run_candidate_dir: Path,
    ) -> ApplyResult:
        # patch engine 的职责很单一：
        # - 接收结构化 EditOp
        # - 在 bundle 副本上应用
        # - 校验结果合法
        # - 输出新的 candidate bundle 和可审阅 diff
        staging_dir = run_candidate_dir / "bundle"
        if staging_dir.exists():
            shutil.rmtree(staging_dir)
        warnings: list[str] = []

        if bundle:
            shutil.copytree(bundle.root_path, staging_dir)
        else:
            staging_dir.mkdir(parents=True, exist_ok=True)

        # Snapshot only markdown files; non-markdown files are pass-through bundle artifacts.
        before_texts = self._snapshot_markdown(staging_dir)

        unresolved_ops: list[str] = []
        files_changed: set[str] = set()
        for patch in patch_group:
            for op in patch.ops:
                try:
                    changed_file = self._apply_op(staging_dir, op)
                    files_changed.add(changed_file)
                except Exception as exc:
                    unresolved_ops.append(f"{op.file_path}:{exc}")

        # 每次导出 candidate bundle 时，都统一提升 SKILL.md 的小版本号。
        if self._bump_skill_version(staging_dir):
            files_changed.add("SKILL.md")

        warnings.extend(unresolved_ops)
        self._validate_bundle(staging_dir)
        after_texts = self._snapshot_markdown(staging_dir)
        diff_patch, diff_json = self._diff_markdown(before_texts, after_texts)

        candidate = CandidateBundle(
            candidate_id=candidate_id,
            base_skill_id=bundle.skill_id if bundle else None,
            full_bundle_path=str(staging_dir),
            files_changed=sorted(files_changed),
            patch_ids=[patch.patch_id for patch in patch_group],
            family_id=patch_group[0].family_id if patch_group else "",
            source_trace_ids=sorted({trace_id for patch in patch_group for trace_id in patch.source_trace_ids}),
            source_thread_ids=sorted({thread_id for patch in patch_group for thread_id in patch.source_thread_ids}),
            unresolved_ops=unresolved_ops,
            conflicts=[],
        )
        return ApplyResult(candidate=candidate, diff_patch=diff_patch, diff_json=diff_json, warnings=warnings)

    def _apply_op(self, staging_dir: Path, op: EditOp) -> str:
        # 所有写入都必须被限制在 candidate bundle 根目录内，避免路径逃逸。
        if not is_allowed_markdown_relative_path(op.file_path):
            raise ValueError("target file is outside markdown whitelist")
        target = (staging_dir / op.file_path).resolve()
        try:
            target.relative_to(staging_dir.resolve())
        except ValueError as exc:
            raise ValueError("path escapes bundle root") from exc

        if op.action == "create_file":
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(op.content.rstrip() + "\n", encoding="utf-8")
            return op.file_path

        if not target.exists():
            raise FileNotFoundError("target file does not exist")

        current = target.read_text(encoding="utf-8")
        updated = self._apply_to_text(current, op)
        target.write_text(updated, encoding="utf-8")
        return op.file_path

    def _apply_to_text(self, text: str, op: EditOp) -> str:
        if op.action == "frontmatter_field":
            field_name = op.field_name
            if not field_name:
                raise ValueError("frontmatter_field missing field_name")
            return self._apply_frontmatter(text, field_name, op.content)

        if op.action == "edit":
            return self._apply_exact_edit(text, op)

        if op.action == "append_file_end":
            return self._append_file_end(text, op.content)
        raise ValueError(f"unsupported op: {op.action}")

    def _apply_exact_edit(self, text: str, op: EditOp) -> str:
        if not op.old_string:
            raise ValueError("edit op missing old_string")
        if op.new_string is None:
            raise ValueError("edit op missing new_string")

        matches = text.count(op.old_string)
        if matches == 0:
            raise ValueError("edit old_string unresolved")
        if matches > 1:
            raise ValueError("edit old_string is not unique")
        return text.replace(op.old_string, op.new_string, 1)

    def _append_file_end(self, text: str, content: str) -> str:
        base = text.rstrip("\n")
        addition = content.strip("\n")
        if not addition:
            raise ValueError("append_file_end content is empty")
        if not base:
            return addition + "\n"
        return f"{base}\n\n{addition}\n"

    def _apply_frontmatter(self, text: str, field_name: str, content: str) -> str:
        post = frontmatter.loads(text)
        post.metadata[field_name] = content
        return frontmatter.dumps(post)

    def _bump_skill_version(self, bundle_dir: Path) -> bool:
        """
        调整 candidate 的 SKILL.md frontmatter version。

        规则：
        - 原来没有 version：视为 v1.0.0，导出时写成 v1.0.1
        - 原来有标准语义版本：只增加 patch 位，例如 v1.2.3 -> v1.2.4
        - 原来版本格式不标准：保守回退到 v1.0.1
        """
        skill_md = bundle_dir / "SKILL.md"
        post = frontmatter.load(skill_md)
        next_version = self._next_version(post.metadata.get("version"))
        if post.metadata.get("version") == next_version:
            return False
        post.metadata["version"] = next_version
        skill_md.write_text(frontmatter.dumps(post), encoding="utf-8")
        return True

    def _next_version(self, current_version: object) -> str:
        if isinstance(current_version, str):
            match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", current_version.strip())
            if match:
                major, minor, patch = (int(part) for part in match.groups())
                return f"v{major}.{minor}.{patch + 1}"
        return "v1.0.1"

    def _validate_bundle(self, bundle_dir: Path) -> None:
        skill_md = bundle_dir / "SKILL.md"
        if not skill_md.exists():
            raise ValueError("SKILL.md missing from candidate bundle")
        post = frontmatter.load(skill_md)
        if not post.metadata.get("name") or not post.metadata.get("description"):
            raise ValueError("SKILL.md frontmatter must include name and description")
        parser = MarkdownIt()
        # Parsing every markdown file catches broken candidate output before anything is exported.
        for path in sorted(bundle_dir.rglob("*.md")):
            if is_allowed_markdown_path(bundle_dir, path):
                parser.parse(path.read_text(encoding="utf-8"))

    def _snapshot_markdown(self, bundle_dir: Path) -> dict[str, str]:
        # diff 只关注 markdown 文件；其他文件会保留在 bundle 中，但不进入 diff 计算。
        snapshot: dict[str, str] = {}
        if not bundle_dir.exists():
            return snapshot
        for path in sorted(bundle_dir.rglob("*.md")):
            if is_allowed_markdown_path(bundle_dir, path):
                snapshot[str(path.relative_to(bundle_dir))] = path.read_text(encoding="utf-8")
        return snapshot

    def _diff_markdown(
        self,
        before: dict[str, str],
        after: dict[str, str],
    ) -> tuple[str, list[dict[str, object]]]:
        patch_parts: list[str] = []
        diff_rows: list[dict[str, object]] = []
        for relative_path in sorted(set(before) | set(after)):
            before_text = before.get(relative_path, "")
            after_text = after.get(relative_path, "")
            if before_text == after_text:
                continue
            patch = "\n".join(
                difflib.unified_diff(
                    before_text.splitlines(),
                    after_text.splitlines(),
                    fromfile=f"a/{relative_path}",
                    tofile=f"b/{relative_path}",
                    lineterm="",
                )
            )
            patch_parts.append(patch)
            diff_rows.append(
                {
                    "file": relative_path,
                    "before_hash": sha256_text(before_text),
                    "after_hash": sha256_text(after_text),
                    "before_lines": len(before_text.splitlines()),
                    "after_lines": len(after_text.splitlines()),
                }
            )
        return ("\n\n".join(patch_parts).rstrip() + "\n") if patch_parts else "", diff_rows


def generate_summary_markdown(candidate: CandidateBundle, report_recommendation: str, report_notes: list[str]) -> str:
    changed = "\n".join(f"- `{file_path}`" for file_path in candidate.files_changed) or "- `(none)`"
    notes = "\n".join(f"- {note}" for note in report_notes) or "- `(none)`"
    return (
        f"# Candidate {candidate.candidate_id}\n\n"
        f"## Recommendation\n\n- `{report_recommendation}`\n\n"
        "## Changed Files\n\n"
        f"{changed}\n\n"
        "## Source Traces\n\n"
        + "\n".join(f"- `{trace_id}`" for trace_id in candidate.source_trace_ids)
        + "\n\n## Notes\n\n"
        + notes
        + "\n"
    )
