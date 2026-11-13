#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拉取 agents 知识库仓库（UI 触发），产出 service units 供宿主合并进 board.json。

board_config.json 注册::

    "pull_knowledge": "python ${pluginPath}/hooks/sync_agents.py --write-board-config"

仓库地址来自 board_config.json 顶层 ``agentsRepo``（可被 --repo-url/--ssh-url/--ref 覆盖）::

    "agentsRepo": {
      "url": "https://git.example.com/agents-kb.git",
      "sshUrl": "git@git.example.com:agents-kb.git",
      "ref": "main"
    }

行为：每次都删掉旧 ``<pluginPath>/sys/``（已 .gitignore）再重新克隆，始终拿到远端
最新内容；HTTPS 的两种 clone 方式都失败时，以 ``sshUrl`` 兜底重试相同 ref。同步完成后
优先调用 ``collect-knowledge.js --listDeployUnits`` 获取部署单元；调用失败时回退解析
``agents.manifest.json``。清单仍用于补充系统信息。

输出（stdout，宿主据此把 supported_deploy_units 合并进 board.json）::

    { "ok": true, "schemaVersion": "...", "message": "...",
      "repo": {"url","sshUrl","ref","commit","transport"},
      "knowledge_path": "<pluginPath>/sys",  # 克隆落盘路径，与 repo 同级；写进 board.json 的
                                             # inspectCommands.<platform>.knowledge_path
      "supported_deploy_units": [...],
      "systems": [ {"systemId","systemName","agentsReady","agentsPath","deployUnits":[...]} ] }

``--write-board-config``（已写进注册的 pull_knowledge 命令，UI 每次拉取即触发）：同步成功后
把 ``supported_deploy_units`` 定点写回 board_config.json 顶层同名字段，并把克隆落盘路径写回
``inspectCommands.<当前平台>.knowledge_path``（把预置的 ``${pluginPath}/sys`` 静态模板改写成解析出的
绝对路径，只改当前 OS 那一处）。两处都正则定点替换、不重排整份文件；写前校验仍为合法 JSON，
否则放弃写入并在结果里给出 boardConfigWriteError。
只读安装环境可从命令里去掉该参数、改为打包前手动 bake 一次。

``--prefer-manifest``：克隆完成后仅从 agents.manifest.json 解析部署单元，
不运行 collect-knowledge.js；清单不可用时直接返回失败。

UI 直调约定：逻辑失败也输出 ok:false 的 JSON 并 exit 0，绝不让 UI 收到非 JSON。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional, Tuple
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.agents_repo import (  # noqa: E402
    SYNC_SCHEMA_VERSION,
    AgentsManifestError,
    build_sync_payload,
    get_agents_root,
    platform_key,
)
from board_core.contracts import BoardConfigError, load_board_config  # noqa: E402
from hooks.render_collected_session_context import (  # noqa: E402
    KnowledgeCollectorError,
    list_supported_deploy_units,
)

BOARD_CONFIG_PATH = ROOT / "board_core" / "board_config.json"
KNOWLEDGE_COLLECTOR_PATH = ROOT / "hooks" / "collect-knowledge.js"
DEFAULT_REF = "main"
HTTPS_CLONE_TIMEOUT_SECONDS = 20
# 超时杀掉进程树后，最多再等这么久收尾读取输出，避免被残留进程的管道拖住。
KILL_REAP_SECONDS = 5
# 同步在后台运行，不能停在凭据输入/GCM 弹窗上：无凭据时直接失败。
GIT_NONINTERACTIVE_ENV = {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
# 连续 15 秒低于 1 B/s 时由 git 自行中止，作为进程级超时之外的兜底。
GIT_CONFIG_ARGS = ["-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=15"]


def _log(message: str) -> None:
    """排查日志只写 stderr：stdout 留给同步协议 JSON。"""
    line = f"[sync_agents {time.strftime('%Y-%m-%d %H:%M:%S')} pid={os.getpid()}] {message}"
    try:
        print(line, file=sys.stderr, flush=True)
    except (OSError, UnicodeEncodeError):
        pass


def _mask_url(url: str) -> str:
    """隐藏 https://user:token@host 里的凭据，避免写进日志。"""
    try:
        parts = urlsplit(url)
        if not parts.username and not parts.password:
            return url
        host = parts.hostname or ""
        if parts.port:
            host = f"{host}:{parts.port}"
    except ValueError:
        return url
    return urlunsplit((parts.scheme, f"***@{host}", parts.path, parts.query, parts.fragment))


def _describe_args(args: List[str]) -> str:
    return " ".join(_mask_url(arg) if "://" in arg else arg for arg in args)


def _kill_process_tree(proc: subprocess.Popen) -> None:
    """结束 git 及其派生进程。

    Windows 的 ``cmd\\git.exe`` 只是外壳，真正干活的 git.exe、git-remote-https.exe
    继承了输出管道；只 kill 外壳时它们继续运行，读取输出会一直阻塞到它们自己退出。
    """
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            _log(f"taskkill 失败 pid={proc.pid} {exc!r}")
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        proc.kill()
    except OSError:
        pass


class _CloneUnavailableError(RuntimeError):
    """同一 URL 的两种 clone 方式均失败，允许上层尝试备用传输地址。"""


def _fail(message: str, errors: Optional[List[str]] = None) -> dict:
    _log(f"同步失败: {message}")
    return {
        "ok": False,
        "schemaVersion": SYNC_SCHEMA_VERSION,
        "message": message,
        "errors": errors or [message],
    }


def _resolve_repo(
    repo_url: Optional[str],
    ref: Optional[str],
    ssh_url: Optional[str] = None,
) -> Tuple[str, str, str]:
    """合并 CLI 覆盖与 agentsRepo；返回 (url, ref, ssh_url)。

    显式覆盖主 URL 时不继承配置中的 sshUrl，避免两个地址落到不同仓库；此时只有
    同时显式传入 ssh_url 才启用 SSH 兜底。未覆盖主 URL 时，ssh_url 为 None 才
    回退到 agentsRepo.sshUrl；显式空字符串可禁用配置中的 SSH 兜底。
    """
    url = (repo_url or "").strip()
    resolved_ref = (ref or "").strip()
    repo_overridden = repo_url is not None
    resolved_ssh_url = (ssh_url or "").strip()
    if not url or not resolved_ref or (not repo_overridden and ssh_url is None):
        config = load_board_config(BOARD_CONFIG_PATH)
        agents_repo = config.get("agentsRepo") if isinstance(config, dict) else None
        if isinstance(agents_repo, dict):
            url = url or str(agents_repo.get("url", "") or "").strip()
            resolved_ref = resolved_ref or str(agents_repo.get("ref", "") or "").strip()
            if not repo_overridden and ssh_url is None:
                resolved_ssh_url = str(agents_repo.get("sshUrl", "") or "").strip()
    return url, (resolved_ref or DEFAULT_REF), resolved_ssh_url


def _run_git(
    args: List[str],
    *,
    cwd: Optional[Path] = None,
    timeout: Optional[float] = None,
) -> subprocess.CompletedProcess:
    described = _describe_args(args)
    _log(f"git {described} 开始 timeout={timeout}")
    started = time.monotonic()
    command = ["git", *GIT_CONFIG_ARGS, *args]
    # 不用 subprocess.run：它在 Windows 超时后只 kill 外壳进程，再无限期等管道关闭。
    proc = subprocess.Popen(
        command,
        cwd=str(cwd) if cwd else None,
        env={**os.environ, **GIT_NONINTERACTIVE_ENV},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        # git 输出 UTF-8，中文 Windows 默认按 GBK 解码会乱码；坏字节替换，不抛异常。
        encoding="utf-8",
        errors="replace",
        # POSIX 上放进独立进程组，超时可整组结束。
        start_new_session=os.name != "nt",
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_process_tree(proc)
        try:
            proc.communicate(timeout=KILL_REAP_SECONDS)
        except subprocess.TimeoutExpired:
            _log(f"git {described} 结束进程树后管道仍未关闭，放弃读取剩余输出")
        _log(f"git {described} 超时 elapsed={time.monotonic() - started:.1f}s timeout={timeout}")
        raise
    except BaseException as exc:
        _kill_process_tree(proc)
        _log(f"git {described} 异常 elapsed={time.monotonic() - started:.1f}s {exc!r}")
        raise
    _log(f"git {described} 结束 rc={proc.returncode} elapsed={time.monotonic() - started:.1f}s")
    if proc.returncode != 0:
        for item in (stderr or "").strip().splitlines()[-5:]:
            _log(f"  stderr: {item}")
    return subprocess.CompletedProcess(command, proc.returncode, stdout, stderr)


def _git_error(proc: subprocess.CompletedProcess, action: str) -> str:
    """保留 git 的全部输出：真正原因（如 ``Permission denied (publickey).``、
    ``Host key verification failed.``）常在中间行，最后一行只是通用提示。"""
    detail = "\n".join(
        text.strip() for text in (proc.stderr, proc.stdout) if text and text.strip()
    ) or f"git 返回码 {proc.returncode}"
    return f"{action} 失败: {detail}"


def _git_timeout_error(action: str, timeout: float) -> str:
    return f"{action} 超时（{timeout:g} 秒）"


def _rmtree(path: Path) -> None:
    """删除目录树；Windows 上 git 会给 ``.git/objects/pack`` 等文件加只读位，
    直接 rmtree 抛 PermissionError——去掉只读位后重试删除。"""

    def _clear_readonly(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)

    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_clear_readonly)
    else:
        shutil.rmtree(path, onerror=_clear_readonly)


def _transport_for_url(url: str) -> str:
    """返回用于同步结果展示的传输类型；兼容测试/CLI 的本地路径等旧输入。"""
    return "https" if url.strip().lower().startswith("https://") else "other"


def _clone_from_url(
    url: str,
    ref: str,
    dest: Path,
    clone_timeout: Optional[float] = None,
) -> str:
    """用单个 URL 克隆 ref，返回 commit。

    两种 clone 都失败时抛 _CloneUnavailableError；普通 clone 已成功但 checkout
    失败时抛普通 RuntimeError，让上层不要把 ref 错误误判为传输失败。任一
    clone 超时时立即抛 _CloneUnavailableError，不再尝试同 URL 的另一种方式。
    """
    if dest.exists():
        _rmtree(dest)
    try:
        clone = _run_git(
            ["clone", "--depth", "1", "--branch", ref, url, str(dest)],
            timeout=clone_timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise _CloneUnavailableError(
            _git_timeout_error("克隆", clone_timeout or 0)
        ) from exc
    if clone.returncode != 0:
        # ref 可能是 commit/tag，--branch 不适用：退回普通 clone 再切换。
        if dest.exists():
            _rmtree(dest)
        try:
            fallback = _run_git(
                ["clone", "--depth", "1", url, str(dest)],
                timeout=clone_timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise _CloneUnavailableError(
                _git_timeout_error("克隆", clone_timeout or 0)
            ) from exc
        if fallback.returncode != 0:
            raise _CloneUnavailableError(_git_error(fallback, "克隆"))
        checkout = _run_git(["checkout", ref], cwd=dest)
        if checkout.returncode != 0:
            raise RuntimeError(_git_error(checkout, f"切换到 {ref}"))

    rev = _run_git(["rev-parse", "HEAD"], cwd=dest)
    return rev.stdout.strip() if rev.returncode == 0 else ""


def sync_repo(url: str, ref: str, dest: Path, ssh_url: Optional[str] = None) -> dict:
    """每次删掉旧 ``sys/`` 后重克隆，返回 {commit, transport}。

    不做增量 fetch：无论 dest 之前是 git 仓库、残留的非 git 目录、还是不存在，
    都先整目录删除再 clone。仅当 https:// 主地址的两种 clone 均失败且 ssh_url
    非空时，才清理残留并通过 SSH 重试同一 ref；checkout/ref 等错误不会触发兜底。
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    fallback_url = (ssh_url or "").strip()
    _log(f"同步开始 url={_mask_url(url)} ref={ref} ssh_url={fallback_url or '-'}")
    try:
        commit = _clone_from_url(
            url,
            ref,
            dest,
            (
                HTTPS_CLONE_TIMEOUT_SECONDS
                if url.strip().lower().startswith("https://")
                else None
            ),
        )
    except _CloneUnavailableError as https_error:
        _log(f"主地址克隆不可用: {https_error}")
        if not url.strip().lower().startswith("https://") or not fallback_url:
            raise
        _log(f"进入 SSH 兜底（无超时） url={fallback_url}")
        try:
            commit = _clone_from_url(fallback_url, ref, dest)
        except RuntimeError as ssh_error:
            raise RuntimeError(
                f"HTTPS 克隆失败: {https_error}\nSSH 兜底失败: {ssh_error}"
            ) from ssh_error
        _log(f"SSH 兜底成功 commit={commit}")
        return {"commit": commit, "transport": "ssh"}
    _log(f"克隆成功 commit={commit}")
    return {"commit": commit, "transport": _transport_for_url(url)}


def _collector_supported_units(knowledge_path: Path) -> List[str]:
    return list_supported_deploy_units(
        str(KNOWLEDGE_COLLECTOR_PATH),
        knowledge_path=str(knowledge_path),
    )


def _collector_payload(
    units: List[str],
    *,
    repo_info: dict,
    knowledge_path: Path,
) -> dict:
    return {
        "ok": True,
        "schemaVersion": SYNC_SCHEMA_VERSION,
        "message": f"agents 仓库已同步：collect-knowledge.js 识别 {len(units)} 个部署单元",
        "repo": repo_info,
        "knowledge_path": str(knowledge_path),
        "supported_deploy_units": units,
        "supported_deploy_units_source": "collect-knowledge.js",
        "systems": [],
    }


def _log_environment() -> None:
    try:
        git_version = subprocess.run(
            ["git", "--version"], capture_output=True, text=True, check=False, timeout=10
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        git_version = f"获取失败 {exc!r}"
    _log(
        f"环境 platform={sys.platform} python={sys.version.split()[0]} "
        f"git={git_version} git_path={shutil.which('git') or '-'}"
    )


def run(
    repo_url: Optional[str],
    ref: Optional[str],
    ssh_url: Optional[str] = None,
    prefer_manifest: bool = False,
) -> dict:
    _log_environment()
    try:
        url, resolved_ref, resolved_ssh_url = _resolve_repo(repo_url, ref, ssh_url)
    except BoardConfigError as exc:
        return _fail(f"读取 board_config.json 失败: {exc}")

    if not url:
        return _fail(
            "未配置 agents 仓库地址：请在 board_core/board_config.json 顶层补充 "
            'agentsRepo.url（或用 --repo-url 传入）'
        )

    dest = get_agents_root()
    try:
        repo_info = sync_repo(url, resolved_ref, dest, resolved_ssh_url)
    except FileNotFoundError:
        return _fail("未找到 git 可执行文件，请确认运行环境已安装 git")
    except RuntimeError as exc:
        return _fail(str(exc))
    except OSError as exc:
        # 如清理旧 sys/ 时文件仍被占用（杀毒软件/编辑器锁定）：保持 UI 只收 JSON 的契约。
        return _fail(f"同步 agents 仓库失败: {exc}")

    repo_info = {
        "url": url,
        "sshUrl": resolved_ssh_url,
        "ref": resolved_ref,
        **repo_info,
    }
    if prefer_manifest:
        try:
            manifest_payload = build_sync_payload(repo_info=repo_info)
        except AgentsManifestError as exc:
            result = _fail(f"仓库已拉取但 agents.manifest.json 不可用: {exc}")
            result["repo"] = repo_info
            result["knowledge_path"] = str(dest)
            return result
        manifest_payload["supported_deploy_units_source"] = "agents.manifest.json"
        return manifest_payload

    collector_units: Optional[List[str]] = None
    collector_error = ""
    try:
        collector_units = _collector_supported_units(dest)
    except KnowledgeCollectorError as exc:
        collector_error = str(exc)

    manifest_payload: Optional[dict] = None
    manifest_error = ""
    try:
        manifest_payload = build_sync_payload(repo_info=repo_info)
    except AgentsManifestError as exc:
        manifest_error = str(exc)

    if collector_units is not None:
        manifest_units = (
            manifest_payload.get("supported_deploy_units", [])
            if isinstance(manifest_payload, dict)
            else []
        )
        if collector_units or not manifest_units:
            payload = manifest_payload or _collector_payload(
                collector_units,
                repo_info=repo_info,
                knowledge_path=dest,
            )
            payload["supported_deploy_units"] = collector_units
            payload["supported_deploy_units_source"] = "collect-knowledge.js"
            collector_message = (
                f"collect-knowledge.js 识别 {len(collector_units)} 个支持的部署单元"
            )
            base_message = str(payload.get("message", "") or "")
            payload["message"] = (
                f"{base_message}；{collector_message}"
                if base_message
                else collector_message
            )
            return payload
        collector_error = "collect-knowledge.js 未识别到部署单元"

    if manifest_payload is not None:
        manifest_payload["supported_deploy_units_source"] = "agents.manifest.json"
        manifest_payload["collectorWarning"] = collector_error
        fallback_message = (
            f"collect-knowledge.js 不可用，已回退清单解析: {collector_error}"
        )
        base_message = str(manifest_payload.get("message", "") or "")
        manifest_payload["message"] = (
            f"{base_message}；{fallback_message}"
            if base_message
            else fallback_message
        )
        return manifest_payload

    detail = f"collect-knowledge.js: {collector_error}；agents.manifest.json: {manifest_error}"
    result = _fail(f"仓库已拉取但部署单元不可用: {detail}")
    result["repo"] = repo_info
    result["knowledge_path"] = str(dest)
    return result


def merge_supported_units_into_board_config(
    units: List[str], config_path: Path = BOARD_CONFIG_PATH
) -> None:
    """把同步得到的 supported_deploy_units 定点写回 board_config.json（打包前 bake）。

    只替换顶层 ``"supported_deploy_units": [...]`` 这一处的数组值（正则定点替换、
    不重排整份文件，保留其余手写格式）；该键不存在时插到 ``agentsRepo`` 块之后。
    写盘前用 ``json.loads`` 校验结果仍是合法 JSON 且该字段已等于 units，否则抛
    RuntimeError 不落盘——确保任何情况下都不会写坏 board_config.json。
    """
    text = config_path.read_text(encoding="utf-8")
    serialized = json.dumps(units, ensure_ascii=False)  # 形如 ["a", "b"]，与手写风格一致
    array_pat = re.compile(r'("supported_deploy_units"\s*:\s*)\[[^\]]*\]')
    if array_pat.search(text):
        new_text = array_pat.sub(lambda m: m.group(1) + serialized, text, count=1)
    else:
        # 键缺失：插到 agentsRepo 对象（含其后逗号）之后，沿用顶层两空格缩进。
        anchor = re.search(r'"agentsRepo"\s*:\s*\{[^}]*\}\s*,', text)
        if not anchor:
            raise RuntimeError("board_config.json 缺少 agentsRepo 锚点，无法插入 supported_deploy_units")
        insertion = anchor.group(0) + f'\n  "supported_deploy_units": {serialized},'
        new_text = text[: anchor.start()] + insertion + text[anchor.end() :]

    try:
        parsed = json.loads(new_text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"写回后 board_config.json 非合法 JSON，已放弃写入: {exc}") from exc
    if parsed.get("supported_deploy_units") != units:
        raise RuntimeError("写回校验失败：supported_deploy_units 未按预期更新，已放弃写入")
    config_path.write_text(new_text, encoding="utf-8")


def _platform_key(platform: Optional[str] = None) -> str:
    """把 ``sys.platform`` 归一到 board_config.json inspectCommands 的三平台键。"""
    return platform_key(platform)


def merge_knowledge_path_into_board_config(
    knowledge_path: str,
    config_path: Path = BOARD_CONFIG_PATH,
    platform: Optional[str] = None,
) -> None:
    """把克隆落盘路径定点写回 board_config.json 的
    ``inspectCommands.<platform>.knowledge_path``（仅当前运行平台那一处）。

    knowledge_path 在三平台块里都以 ``${pluginPath}/sys`` 静态模板预置；本机拉取后把它
    改写成解析出的绝对路径（machine-specific，只对当前 OS 有效，故只改当前平台块、不动另外
    两个平台的模板）。``knowledge_path`` 是各平台块的首个键，正则以「平台名 + 首键」定位，
    只替换那一处字符串值、不重排整份文件。写盘前用 ``json.loads`` 校验结果仍合法且该字段已
    等于 knowledge_path，否则抛 RuntimeError 不落盘。
    """
    key = _platform_key(platform)
    text = config_path.read_text(encoding="utf-8")
    serialized = json.dumps(knowledge_path, ensure_ascii=False)  # JSON 字符串字面量（转义反斜杠等）
    # 以「"<platform>": { "knowledge_path":」为锚（knowledge_path 是平台块首键），只命中本平台那处。
    value_pat = re.compile(
        r'("' + re.escape(key) + r'"\s*:\s*\{\s*"knowledge_path"\s*:\s*)"(?:[^"\\]|\\.)*"'
    )
    if not value_pat.search(text):
        raise RuntimeError(
            f"board_config.json 的 inspectCommands.{key} 缺少 knowledge_path 首键，无法写回"
        )
    new_text = value_pat.sub(lambda m: m.group(1) + serialized, text, count=1)

    try:
        parsed = json.loads(new_text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"写回后 board_config.json 非合法 JSON，已放弃写入: {exc}") from exc
    commands = parsed.get("inspectCommands")
    block = commands.get(key) if isinstance(commands, dict) else None
    if not isinstance(block, dict) or block.get("knowledge_path") != knowledge_path:
        raise RuntimeError("写回校验失败：knowledge_path 未按预期更新，已放弃写入")
    config_path.write_text(new_text, encoding="utf-8")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="拉取 agents 知识库仓库并产出 service units（UI 触发）",
        allow_abbrev=False,
    )
    parser.add_argument("--repo-url", dest="repo_url", default=None, help="覆盖 board_config.json 的 agentsRepo.url")
    parser.add_argument(
        "--ssh-url",
        dest="ssh_url",
        default=None,
        help="覆盖 agentsRepo.sshUrl；与 --repo-url 一起使用时显式启用 SSH 兜底",
    )
    parser.add_argument("--ref", dest="ref", default=None, help="覆盖 agentsRepo.ref（分支/标签/commit，默认 main）")
    parser.add_argument(
        "--prefer-manifest",
        action="store_true",
        help="仅从 agents.manifest.json 读取部署单元，不运行 collect-knowledge.js",
    )
    parser.add_argument(
        "--write-board-config",
        dest="write_board_config",
        action="store_true",
        help="同步成功后把 supported_deploy_units 定点写回 board_config.json（pull_knowledge 已带此参数）",
    )
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))

    result = run(args.repo_url, args.ref, args.ssh_url, prefer_manifest=args.prefer_manifest)
    if args.write_board_config and result.get("ok") and isinstance(result.get("supported_deploy_units"), list):
        try:
            merge_supported_units_into_board_config(result["supported_deploy_units"])
            # 知识库落盘路径写回 inspectCommands.<当前平台>.knowledge_path（把静态模板改写成绝对路径）。
            if isinstance(result.get("knowledge_path"), str) and result["knowledge_path"]:
                merge_knowledge_path_into_board_config(result["knowledge_path"])
            result["boardConfigWritten"] = True
        except (OSError, RuntimeError) as exc:
            result["boardConfigWritten"] = False
            result["boardConfigWriteError"] = str(exc)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
