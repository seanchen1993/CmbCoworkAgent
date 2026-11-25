#!/usr/bin/env python3
"""Copy selected Harness artifacts into a knowledge base write workspace.

board_config.json command template:
    python3 "${pluginPath}/scripts/archive-feature-artifacts.py"
    --artifact-paths '${artifactPaths}'
    --knowledge-write-path "${knowledgeWritePath}"
    --project-code "${projectCode}"
    --project-name "${projectName}"
    --sap-id "${sapId}"
    --feature "${feature}"
    --selected-deployUnit '${selectedDeployUnits}'

Configure the template as one line and use the platform's Python command.
The selectedDeployUnits placeholder is a JSON array of mapping objects with
deployUnitId; it may be omitted.
Other input placeholders:
    artifactPaths: JSON array of validated absolute source paths.
    knowledgeWritePath: absolute path to the selected knowledge base's write root.
    projectCode: the Harness project code.
    projectName: the Harness project's display name.
    sapId: the current DevClaw user's SAP ID.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
from tempfile import NamedTemporaryFile


ARCHIVE_INPUT_FILENAME = "archive-input.json"


def parse_array(value, flag):
    items = json.loads(value)
    if not isinstance(items, list):
        raise ValueError(f"{flag} 必须是 JSON 数组")
    return items


def directory_name(value, label):
    if (
        not isinstance(value, str)
        or not value
        or value in {".", ".."}
        or value.casefold() == ".git"
        or re.search(r'[<>:"/\\|?*\x00-\x1f]', value)
        or value.endswith((".", " "))
        or re.fullmatch(r"(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?", value, re.I)
    ):
        raise ValueError(f"{label}不能作为目录或文件名：{value!r}")
    return value


def absolute_path(value, label):
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError(f"{label}必须是绝对路径：{value!r}")
    return Path(value)


def raise_walk_error(error):
    raise error


def check_source(path):
    if path.is_symlink() or path.resolve() != path:
        raise ValueError(f"产物路径必须是校验后的实际路径：{path}")
    if path.is_file():
        return
    if not path.is_dir():
        raise ValueError(f"产物不存在或不是普通文件或目录：{path}")
    for root, directories, files in os.walk(path, onerror=raise_walk_error):
        for name in directories + files:
            directory_name(name, "目录产物中的名称")
            entry = Path(root) / name
            if entry.is_symlink() or entry.resolve() != entry:
                raise ValueError(f"目录产物中存在链接：{entry}")
            if not (entry.is_file() or entry.is_dir()):
                raise ValueError(f"目录产物中存在无法复制的条目：{entry}")


def archive_plan(args, write_root, paths, mappings):
    if not args.project_code.strip() or not args.project_name.strip() or not args.sap_id.strip():
        raise ValueError("项目编号、项目名称和 sapId 均不能为空")
    project = directory_name(
        f"{args.project_code}_{args.project_name}_{args.sap_id}", "归档项目目录名"
    )
    feature = directory_name(args.feature, "特性标识")
    units = []
    for mapping in mappings:
        if not isinstance(mapping, dict):
            raise ValueError("发布单元必须是包含 deployUnitId 的对象")
        unit = directory_name(mapping.get("deployUnitId"), "发布单元 ID")
        if unit.casefold() == ARCHIVE_INPUT_FILENAME:
            raise ValueError(f"发布单元 ID 与归档记录文件名冲突：{unit}")
        units.append(unit)

    if not paths:
        raise ValueError("请至少选择一个产物")
    sources = list(dict.fromkeys(absolute_path(path, "产物路径") for path in paths))
    for source in sources:
        directory_name(source.name, "产物名称")
        check_source(source)

    plan = []
    seen_targets = set()
    for unit in dict.fromkeys(units or ["common"]):
        parent = write_root
        for name in (unit, project):
            parent /= name
            if parent.is_symlink() or parent.resolve() != parent:
                raise ValueError(f"目标目录含有链接：{parent}")
            if parent.exists() and not parent.is_dir():
                raise FileExistsError(f"目标目录已被文件占用：{parent}")
        parent /= feature
        if parent.exists() or parent.is_symlink():
            raise FileExistsError(f"该特性已归档或归档目录已被占用：{parent}")
        for source in sources:
            target = parent / source.name
            # A knowledge checkout can later be opened on a case-insensitive filesystem.
            key = str(target).casefold()
            if key in seen_targets:
                raise FileExistsError(f"归档目标同名冲突：{target}")
            if source.is_dir() and source in target.parents:
                raise ValueError(f"不能将目录产物复制到其自身内部：{target}")
            seen_targets.add(key)
            plan.append((source, target))
    return plan


def copy_file(source, target):
    # Exclusive creation also prevents overwriting a file created after preflight.
    with open(source, "rb") as source_file, open(target, "xb") as target_file:
        shutil.copyfileobj(source_file, target_file)
    shutil.copystat(source, target)


def check_metadata_path(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError(f"归档记录路径必须是普通文件：{path}")


def read_archive_history(path):
    check_metadata_path(path)
    if not path.exists():
        return []
    records = parse_array(path.read_text(encoding="utf-8"), path.name)
    if any(not isinstance(record, dict) for record in records):
        raise ValueError(f"归档记录必须是对象数组：{path}")
    return records


def write_archive_history(path, records):
    with NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as temporary:
        temporary_path = Path(temporary.name)
        try:
            json.dump(records, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            # Windows requires closing the temporary file before replacing the history.
            temporary.close()
            temporary_path.replace(path)
        finally:
            temporary.close()
            if temporary_path.exists():
                temporary_path.unlink()


def append_agents_entries(agents_path, write_root, project_name, destinations):
    entries = "".join(
        f"- {target.relative_to(write_root).as_posix()}: {project_name}_的文档\n"
        for target in destinations
    )
    with agents_path.open("a+b") as agents:
        if agents.seek(0, os.SEEK_END):
            agents.seek(-1, os.SEEK_END)
            if agents.read(1) != b"\n":
                agents.write(b"\n")
        agents.write(entries.encode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--artifact-paths", required=True, help="JSON array of absolute paths")
    parser.add_argument("--knowledge-write-path", required=True)
    parser.add_argument("--project-code", required=True)
    parser.add_argument("--project-name", required=True)
    parser.add_argument("--sap-id", required=True)
    parser.add_argument("--feature", required=True)
    parser.add_argument("--selected-deployUnit", default="[]", help="JSON array of mappings")
    args = parser.parse_args()

    copied = []
    target = None
    try:
        write_root = absolute_path(args.knowledge_write_path, "知识库写入路径").resolve(strict=True)
        if not write_root.is_dir():
            raise ValueError(f"知识库写入路径不是目录：{write_root}")
        paths = parse_array(args.artifact_paths, "--artifact-paths")
        mappings = parse_array(args.selected_deployUnit, "--selected-deployUnit")
        archive_input = {
            "artifactPaths": paths,
            "knowledgeWritePath": args.knowledge_write_path,
            "projectCode": args.project_code,
            "projectName": args.project_name,
            "sapId": args.sap_id,
            "feature": args.feature,
            "selectedDeployUnits": mappings,
        }
        history_path = write_root / ARCHIVE_INPUT_FILENAME
        target = history_path
        history = read_archive_history(history_path)
        identity_fields = ("projectName", "sapId", "feature")
        if any(
            all(record.get(field) == archive_input[field] for field in identity_fields)
            for record in history
        ):
            raise ValueError(f"该特性已归档：{args.project_code}/{args.feature}")

        target = None
        plan = archive_plan(args, write_root, paths, mappings)
        entries_by_file = {}
        for _, destination in plan:
            agents_path = destination.parents[2] / "Agents.md"
            entries_by_file.setdefault(agents_path, []).append(destination)
        for target in entries_by_file:
            check_metadata_path(target)
        for target in dict.fromkeys(destination.parent for _, destination in plan):
            target.mkdir(parents=True)
        for source, target in plan:
            if source.is_dir():
                shutil.copytree(source, target, copy_function=copy_file)
            else:
                copy_file(source, target)
            copied.append(str(target))
        for target, destinations in entries_by_file.items():
            append_agents_entries(target, write_root, args.project_name, destinations)
        target = history_path
        write_archive_history(history_path, [*history, archive_input])
    except (OSError, RuntimeError, ValueError) as error:
        result = {"success": False, "error": str(error), "copiedPaths": copied}
        if target is not None:
            result["failedPath"] = str(target)
        print(json.dumps(result, ensure_ascii=False))
        return 1

    result = {"success": True, "writePath": str(write_root), "copiedPaths": copied}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
