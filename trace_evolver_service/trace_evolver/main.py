"""
FastAPI 入口模块。

这个文件只做两件事：
1. 组装 Settings、数据库 session factory 和 TraceEvolutionService
2. 暴露本地调试所需的 HTTP API

真正的业务主流程不在这里展开，而是在 service.py 中统一编排。
"""

from __future__ import annotations

import logging
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from trace_evolver.config import Settings, get_settings
from trace_evolver.db import create_session_factory
from trace_evolver.schemas import RunCreateRequest, RunResponse
from trace_evolver.service import TraceEvolutionService


def _configure_logging(settings: Settings) -> None:
    """Ensure trace_evolver package logs are visible under both uvicorn CLI and uvicorn.run."""
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    package_logger = logging.getLogger("trace_evolver")
    package_logger.setLevel(level)

    if not package_logger.handlers:
        handler = logging.StreamHandler()
        handler.setLevel(level)
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s [%(name)s] %(message)s",
                "%Y-%m-%d %H:%M:%S",
            )
        )
        package_logger.addHandler(handler)
        package_logger.propagate = False


def create_app(settings: Settings | None = None) -> FastAPI:
    # FastAPI 只负责暴露本地调试接口；真正的离线编排逻辑都在 TraceEvolutionService 里。
    resolved = settings or get_settings()
    _configure_logging(resolved)
    service = TraceEvolutionService(resolved, create_session_factory(resolved))
    app = FastAPI(title="Trace Evolver Service", version="0.1.0")
    app.state.service = service

    @app.post("/runs", response_model=RunResponse)
    def create_run(request: RunCreateRequest) -> RunResponse:
        # 这里是整个系统的唯一“启动点”：
        # 1. 校验请求
        # 2. 创建 run
        # 3. 同步执行完整离线流程
        # 4. 返回 run_id 供后续查询
        try:
            return app.state.service.create_run(request)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/runs/{run_id}")
    def get_run(run_id: str):
        try:
            return app.state.service.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"run not found: {run_id}") from exc

    @app.get("/runs/{run_id}/status")
    def get_run_status(run_id: str):
        try:
            detail = app.state.service.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"run not found: {run_id}") from exc
        return {"run_id": detail.run_id, "status": detail.status, "error": detail.error}

    @app.get("/runs/{run_id}/candidates")
    def list_candidates(run_id: str):
        return app.state.service.list_candidates(run_id)

    @app.get("/runs/{run_id}/candidates/{candidate_id}")
    def get_candidate(run_id: str, candidate_id: str):
        try:
            return app.state.service.get_candidate(run_id, candidate_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"candidate not found: {candidate_id}") from exc

    @app.get("/runs/{run_id}/candidates/{candidate_id}/diff")
    def get_candidate_diff(run_id: str, candidate_id: str):
        try:
            candidate = app.state.service.get_candidate(run_id, candidate_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"candidate not found: {candidate_id}") from exc
        diff_path = Path(candidate.full_bundle_path).parent / "diff.patch"
        if not diff_path.exists():
            raise HTTPException(status_code=404, detail="diff not found")
        return PlainTextResponse(diff_path.read_text(encoding="utf-8"))

    @app.get("/runs/{run_id}/candidates/{candidate_id}/bundle/{path:path}")
    def get_candidate_bundle_file(run_id: str, candidate_id: str, path: str):
        try:
            candidate = app.state.service.get_candidate(run_id, candidate_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"candidate not found: {candidate_id}") from exc
        bundle_root = Path(candidate.full_bundle_path).resolve()
        target = (bundle_root / path).resolve()
        try:
            target.relative_to(bundle_root)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="path escapes candidate bundle") from exc
        if not target.exists() or not target.is_file():
            raise HTTPException(status_code=404, detail="bundle file not found")
        return FileResponse(target)

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/version")
    def version():
        return {"version": "0.1.0"}

    return app


app = create_app()


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "trace_evolver.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        reload=False,
    )
