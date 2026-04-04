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

from trace_evolver.schemas import AnchorSpec, CandidateBundle, EditOp, HypothesisPatch, SkillBundleMeta
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
        if op.anchor and op.anchor.anchor_type == "frontmatter_field":
            return self._apply_frontmatter(text, op.anchor, op.content)

        # V1 对 markdown 的修改统一落在“整文件重写”上，避免做脆弱的原地局部写入。
        lines = text.splitlines()
        anchor_index = self._resolve_anchor(lines, op.anchor)
        content_lines = op.content.rstrip("\n").splitlines()

        if op.action == "insert_after":
            new_lines = lines[: anchor_index + 1] + [""] + content_lines + lines[anchor_index + 1 :]
            return "\n".join(new_lines).rstrip() + "\n"
        if op.action == "insert_before":
            new_lines = lines[:anchor_index] + content_lines + [""] + lines[anchor_index:]
            return "\n".join(new_lines).rstrip() + "\n"
        if op.action == "replace_range":
            start, end = self._resolve_replace_range(lines, anchor_index)
            new_lines = lines[:start] + content_lines + lines[end:]
            return "\n".join(new_lines).rstrip() + "\n"
        raise ValueError(f"unsupported op: {op.action}")

    def _apply_frontmatter(self, text: str, anchor: AnchorSpec, content: str) -> str:
        post = frontmatter.loads(text)
        if not anchor.field_name:
            raise ValueError("frontmatter_field anchor missing field_name")
        post.metadata[anchor.field_name] = content
        return frontmatter.dumps(post)

    def _resolve_anchor(self, lines: list[str], anchor: AnchorSpec | None) -> int:
        # anchor 解析按”从强到弱”顺序进行；越弱的 anchor，误命中的风险越高。
        if anchor is None or anchor.anchor_type == "file_end":
            return len(lines) - 1 if lines else 0
        if anchor.anchor_type == "heading":
            targets = [segment.lower() for segment in (anchor.heading_path or []) if segment]
            text_hint = (anchor.text_hint or "").lower()

            # Pass 1: exact match (heading text == target or hint)
            for index, line in enumerate(lines):
                stripped = line.strip()
                if not stripped.startswith("#"):
                    continue
                lowered = stripped.lstrip("#").strip().lower()
                if targets and lowered == targets[-1]:
                    return index
                if text_hint and lowered == text_hint:
                    return index

            # Pass 2: substring fallback (only if exact match failed)
            if text_hint:
                for index, line in enumerate(lines):
                    stripped = line.strip()
                    if not stripped.startswith("#"):
                        continue
                    lowered = stripped.lstrip("#").strip().lower()
                    if text_hint in lowered:
                        return index

            # Pass 3: fallback to file end rather than losing the edit entirely
            logger.warning("heading anchor unresolved (targets=%s, hint=%s), falling back to file end", targets, text_hint)
            return len(lines) - 1 if lines else 0
        if anchor.anchor_type in {"paragraph", "list_item"}:
            hint = (anchor.text_hint or anchor.fingerprint or "").strip().lower()
            for index, line in enumerate(lines):
                if hint and hint in line.lower():
                    return index
            raise ValueError("paragraph/list anchor unresolved")
        raise ValueError("unsupported anchor type")

    def _resolve_replace_range(self, lines: list[str], anchor_index: int) -> tuple[int, int]:
        # replace_range 的策略是“替换锚点所在的连续文本块”，适合 markdown 段落级 patch。
        start = anchor_index
        end = anchor_index + 1
        while start > 0 and lines[start - 1].strip():
            start -= 1
        while end < len(lines) and lines[end].strip():
            end += 1
        return start, end

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
