"""Validate a local knowledge draft against actual Feature artifacts, without publishing."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys


def digest(path):
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 5 * 1024 * 1024:
        raise ValueError("知识来源文件不存在或超过检查范围")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(feature):
    feature = feature.resolve(strict=True)
    descriptor = feature / "KNOWLEDGE_DRAFT.json"
    if descriptor.is_symlink() or descriptor.stat().st_size > 65536:
        raise ValueError("知识草稿清单无效")
    data = json.loads(descriptor.read_text(encoding="utf-8"))
    if (not isinstance(data, dict) or data.get("schemaVersion") != "autobiz.knowledge-draft/v1"
            or not isinstance(data.get("title"), str) or not data["title"].strip()
            or not isinstance(data.get("summary"), str) or not data["summary"].strip()
            or data.get("securityReview") != "pending"):
        raise ValueError("知识草稿必须包含主题、摘要和待审状态")
    sources = data.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 32:
        raise ValueError("知识草稿缺少有界真实来源")
    seen = set()
    for item in sources:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("知识来源格式无效")
        path = item["path"]
        if (not path or "\\" in path or ":" in path or path.startswith("/")
                or any(part in ("", ".", "..") for part in path.split("/"))
                or path.startswith("KNOWLEDGE_DRAFT") or path in seen):
            raise ValueError("知识来源必须属于当前 Feature 且不能自证")
        candidate = feature / path
        if not candidate.resolve(strict=True).is_relative_to(feature):
            raise ValueError("知识来源越过当前 Feature")
        if digest(candidate) != item.get("digest"):
            raise ValueError("知识来源已变化，重新读取后更新草稿")
        seen.add(path)
    markdown = feature / "KNOWLEDGE_DRAFT.md"
    if digest(markdown) != data.get("markdownDigest"):
        raise ValueError("知识正文摘要不匹配")
    if not markdown.read_text(encoding="utf-8").strip():
        raise ValueError("知识正文为空")
    return {"ok": True, "state": "awaiting-review", "reviewed": False,
            "sourcesChecked": len(seen), "draft": str(markdown)}


def main():
    workspace = os.environ.get("PLUGIN_WORKSPACE", "")
    project = os.environ.get("PROJECT_DIR", "")
    feature = os.environ.get("FEATURE_ID", "")
    if not workspace or not all(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", value)
                                and value not in (".", "..") for value in (project, feature)):
        raise ValueError("缺少平台绑定的项目或 Feature")
    root = Path(workspace).resolve(strict=True)
    target = root / project / ".autobizdevops" / "features" / feature
    if not target.resolve(strict=True).is_relative_to(root):
        raise ValueError("Feature 目录越界")
    print(json.dumps(validate(target), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "message": str(error)}, ensure_ascii=False))
        sys.exit(1)
