"""
trace 输入层。

V1 只支持本地文件系统输入，因此这里的职责很明确：
- 接收一个本地绝对路径
- 识别它是单个 jsonl 文件还是目录
- 收集所有 trace jsonl
- 复制到当前 run 的 staging 目录
- 解析为 ImportedTrace

这一层不做任何语义分析，只负责把原始输入变成干净、可复用的本地快照。
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from trace_evolver.artifacts import build_artifact_index
from trace_evolver.schemas import AgentTrace, ImportedTrace
from trace_evolver.utils import ensure_absolute, utc_now

logger = logging.getLogger(__name__)


class LocalTraceSource:
    def materialize(self, input_path: str, target_dir: Path) -> list[Path]:
        # 输入层只接受本地绝对路径。这里不直接在原目录上工作，而是先复制到 run 的 staging 目录中。
        source = ensure_absolute(input_path)
        if not source.exists():
            raise FileNotFoundError(f"input path does not exist: {source}")

        logger.info("Materializing trace input from %s into %s", source, target_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        jsonl_files: list[Path] = []
        if source.is_file():
            if source.suffix.lower() != ".jsonl":
                raise ValueError(f"input file must be .jsonl: {source}")
            destination = target_dir / source.name
            shutil.copy2(source, destination)
            jsonl_files.append(destination)
        else:
            for file_path in sorted(source.rglob("*.jsonl")):
                relative = file_path.relative_to(source)
                destination = target_dir / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file_path, destination)
                jsonl_files.append(destination)

        if not jsonl_files:
            raise ValueError(f"no .jsonl files found under: {source}")
        logger.info("Materialized %d jsonl files from %s", len(jsonl_files), source)
        return jsonl_files


def load_imported_traces(jsonl_files: list[Path]) -> list[ImportedTrace]:
    """
    把 staging 目录中的 jsonl 文件解析成 ImportedTrace 列表。

    这里的关键策略是：
    - 同一 traceId 去重
    - 坏行跳过，不让整次 run 因单行脏数据失败
    - 最终按 threadId / startedAt 排序，方便后续组装 thread 和 episode
    """
    imported: list[ImportedTrace] = []
    seen_trace_ids: set[str] = set()
    ingested_at = utc_now()
    total_lines = 0
    skipped_lines = 0
    duplicate_count = 0

    for local_file in sorted(jsonl_files):
        with local_file.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                total_lines += 1
                try:
                    payload = json.loads(line)
                    trace = AgentTrace.model_validate(payload)
                except Exception:
                    skipped_lines += 1
                    continue
                if trace.traceId in seen_trace_ids:
                    duplicate_count += 1
                    continue
                seen_trace_ids.add(trace.traceId)
                it = ImportedTrace(
                    **trace.model_dump(),
                    source_path=str(local_file),
                    local_path=str(local_file),
                    ingested_at=ingested_at,
                )
                it.artifact_index = build_artifact_index(it)
                imported.append(it)

    logger.info(
        "Trace ingestion: %d lines read, %d traces imported, %d skipped (bad format), %d duplicates",
        total_lines, len(imported), skipped_lines, duplicate_count,
    )
    if skipped_lines > 0:
        logger.warning("%d trace lines were skipped due to parse errors", skipped_lines)

    imported.sort(key=lambda item: (item.threadId, item.startedAt, item.traceId))
    return imported
