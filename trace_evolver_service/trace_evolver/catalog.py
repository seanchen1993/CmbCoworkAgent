"""
skill catalog 与 markdown catalog 构建模块。

这个模块解决两个问题：
1. 当前本地有哪些可作为"基线 bundle"的 skill
2. 每个 bundle 里有哪些 markdown 文件可供 bounded markdown ReAct 选择

注意：
- 这里不会一次性把所有 markdown 全文塞进上下文
- 这里只抽取轻量元信息，如标题树、摘要、链接关系、hash
- 真正需要全文时，后续 analyst 再按需打开
"""

from __future__ import annotations

import re
from pathlib import Path

import frontmatter

from trace_evolver.schemas import MarkdownFileMeta, SkillBundleMeta
from trace_evolver.utils import is_allowed_markdown_path, sha256_file, sha256_tree, trim_snippet


HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$")
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+\.md)\)")


def _extract_heading_tree(text: str) -> list[str]:
    headings: list[str] = []
    for line in text.splitlines():
        match = HEADING_RE.match(line)
        if match:
            headings.append(match.group(2).strip())
    return headings


def _extract_summary(text: str) -> str:
    lines = [line.strip() for line in text.splitlines()]
    buffer: list[str] = []
    for line in lines:
        if not line or line.startswith("---") or HEADING_RE.match(line):
            if buffer:
                break
            continue
        buffer.append(line)
    return trim_snippet(" ".join(buffer), 240)


def _extract_links(text: str) -> list[str]:
    return sorted({match.group(1) for match in LINK_RE.finditer(text)})


def _estimate_tokens(text: str) -> int:
    """Rough token estimate supporting CJK text."""
    if not text:
        return 1
    cjk_chars = sum(1 for ch in text if '\u4e00' <= ch <= '\u9fff' or '\u3400' <= ch <= '\u4dbf')
    word_count = len(text.split())
    if cjk_chars > word_count:
        non_cjk_words = max(0, word_count - cjk_chars // 4)
        return max(1, int(cjk_chars * 1.5) + non_cjk_words)
    return max(1, word_count)


def collect_markdown_files(bundle_root: Path) -> list[Path]:
    markdown_files: list[Path] = []
    for path in sorted(bundle_root.rglob("*.md")):
        if path.is_file() and is_allowed_markdown_path(bundle_root, path):
            markdown_files.append(path)
    return markdown_files


def build_markdown_meta(bundle_root: Path, file_path: Path) -> MarkdownFileMeta:
    text = file_path.read_text(encoding="utf-8")
    relative = str(file_path.relative_to(bundle_root))
    return MarkdownFileMeta(
        file_path=relative,
        heading_tree=_extract_heading_tree(text),
        first_paragraph_summary=_extract_summary(text),
        linked_markdown_paths=_extract_links(text),
        token_estimate=_estimate_tokens(text),
        content_hash=sha256_file(file_path),
    )


def scan_skill_roots(skill_roots: list[str]) -> list[SkillBundleMeta]:
    bundles: list[SkillBundleMeta] = []
    for root_str in skill_roots:
        root = Path(root_str).resolve()
        if not root.exists() or not root.is_dir():
            continue
        for candidate in sorted(path for path in root.iterdir() if path.is_dir()):
            skill_md = candidate / "SKILL.md"
            if not skill_md.exists():
                continue
            try:
                post = frontmatter.load(skill_md)
                display_name = str(post.metadata.get("name") or candidate.name)
            except Exception:
                display_name = candidate.name

            # catalog 只抽取后续 markdown 选择需要的轻量信息，不在这里加载整包全文。
            markdown_files = [build_markdown_meta(candidate, file_path) for file_path in collect_markdown_files(candidate)]
            bundles.append(
                SkillBundleMeta(
                    skill_id=candidate.name,
                    display_name=display_name,
                    root_path=str(candidate),
                    bundle_hash=sha256_tree(candidate),
                    markdown_files=markdown_files,
                )
            )
    return bundles


def match_skill_bundle(used_skills: list[str], bundles: list[SkillBundleMeta]) -> SkillBundleMeta | None:
    """Match episode's used_skills against available bundles.

    Matching strategy (by priority):
    1. Exact match on skill_id or display_name (case-insensitive)
    2. Substring/contains match (e.g. "cowork-excel-skill" matches "excel-skill")
    3. Token overlap (Jaccard ≥ 0.5 on slugified tokens)
    """
    normalized = {skill.strip().lower() for skill in used_skills if skill.strip()}
    if not normalized:
        return None

    # Pass 1: exact match
    by_id = {bundle.skill_id.lower(): bundle for bundle in bundles}
    by_name = {bundle.display_name.strip().lower(): bundle for bundle in bundles}
    for value in normalized:
        if value in by_id:
            return by_id[value]
        if value in by_name:
            return by_name[value]

    # Pass 2: substring containment
    for value in normalized:
        for bundle in bundles:
            bid = bundle.skill_id.lower()
            bname = bundle.display_name.strip().lower()
            if bid in value or value in bid or bname in value or value in bname:
                return bundle

    # Pass 3: token overlap
    from trace_evolver.utils import tokenize
    query_tokens = set()
    for value in normalized:
        query_tokens |= tokenize(value)
    if query_tokens:
        best_bundle: SkillBundleMeta | None = None
        best_score = 0.0
        for bundle in bundles:
            bundle_tokens = tokenize(bundle.skill_id) | tokenize(bundle.display_name)
            if not bundle_tokens:
                continue
            overlap = len(query_tokens & bundle_tokens) / len(query_tokens | bundle_tokens)
            if overlap > best_score:
                best_score = overlap
                best_bundle = bundle
        if best_score >= 0.5:
            return best_bundle

    return None
