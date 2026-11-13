#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""session_context_inject 动态提示词注入（createFeature 选中部署单元 -> sessionContext）。

board_config.json 注册（样例，附件约定）::

    "session_context_inject": "python ${pluginPath}/hooks/render_session_context.py --platform darwin --plugin-workspace ${pluginWorkspace} --project ${projectDir} --feature ${feature} --selected-deployUnit ${selectedDeployUnits} --session-workspace-path ${sessionWorkspacePath}"

入参：
  · ``--platform`` 是目标平台键（``darwin`` / ``linux`` / ``win32``），用于把输出中的
    ``sys`` 路径按目标平台分隔符拼接；缺省时使用当前 Python 运行平台。

  · ``--selected-deployUnit`` 是一个 JSON 数组字符串（deployUnitId = 后端单元 id）::

        --selected-deployUnit '[{"deployUnitId":"LF39.18_Outservice","localRepoPath":"/repo/out"}]'

  · ``--session-workspace-path`` 是会话工作区目录的路径字符串（可空）；脚本读取该目录下的
    ``AGENTS.md`` 作为「会话工作区指令」、``CONTEXT.md`` 作为「领域词汇表」（④）。
    路径为空 / 对应文件缺失 / 全空白 → 不生成对应段。

  · 当前 workflow 节点通过 ``--plugin-workspace``、``--project``、``--feature``
    显式定位，并复用 Feature Status 的 ``run.currentNodeId``。``--node-id`` 仅作为本地调试覆盖入口
    （显式给出时直接用该节点自身策略，绕过下面的 nextAction 解析）。
    节点、参数、配置或单个字段缺失时分别使用默认值：``agentMode = \"multi\"``、
    ``toolConfig.task.enabled = true``。

``agentConfig`` 取哪个节点的 ``runtimePolicy``——**跟宿主路由同源**：宿主按当前节点状态的
``states[nodeStatus].nextAction.slashSkill`` 拉起下一个 skill，运行时策略就取该 skill 所属节点的
``runtimePolicy``，而不是 ``currentNodeId`` 自身的。这条规则无需区分状态：``not_started`` /
``in_progress`` / ``archived`` 的 nextAction 恒等于节点自己的 skill，会自然退化回当前节点；只有
``done`` 指向下一个节点。它修掉的是「会话策略滞后一个节点」——例如 ``prd_done`` 时宿主已经拉起
``/autodev-specs``（需要 multi + 子代理）；策略必须始终跟随实际拉起的下一个节点。

策略解析必须用该 Feature **编译后**的 workflow（``build_run_context`` 的第二个返回值），基线
``board_config.json`` 里查不到 profile 与动态阶段插入的节点。反查落空时按三级阶梯降级：
nextAction 目标节点 → ``currentNodeId`` 自身节点 → 全局默认（``multi`` + task 开启）。
``needs_fix`` 走第二级：它映射的 ``blocked`` 状态没有任何节点定义，退回 ``needsFixFromCheckpoint``
定位到的回流目标节点，拿到的正是修复所需能力。

输出（固定形状，注入项目模式系统提示词）::

    { "ok": true, "message": "...", "sessionContext": "...",
      "agentmdLoadStatus": [ {deployUnitId, path, loaded, source, message} ],
      "agentConfig": {
        "agentMode": "multi",
        "toolConfig": {"task": {"enabled": true}},
        "subagentConfig": {
          "disabledBuiltinSubagents": [],
          "customSubagentFiles": []
        }
      } }

``sessionContext`` 分段拼接（见 docs/agents-loading-remote-local.md），各层次各用一对
**裸 XML 风格标签**外包（不再用反引号包成 inline code——那会让标签变字面量、id 不成锚点）：
  ① 适用范围 ``<SCOPE>``：清单 description（引用范围）+ UI localRepoPath（代码地址）。每行
     ``deployUnitId`` 用 ``[id](#slug)`` 跳到 ③ 里对应单元的 ``## 标题``（slug 见 _heading_slug）。
  ② 系统级 AGENTS.md ``<SYSTEM>``：选中单元所属系统 agentsPath 全文，按 systemId 去重；标签
     ``id="sys-<systemId>"`` 供 ① 表里无独立 md 的单元回退锚点。
  ③ 单元级 ``<UNIT>``：整段**只用一对** ``<UNIT id="unit-section">`` 外包，内部顺序拼接：
     先「会话工作区指令」（``<sessionWorkspacePath>/AGENTS.md`` 全文，排第一），再各选中单元
     description.md 全文（按选择顺序）。每段前置一行 ``## deployUnitId（描述）`` 标题作为锚点目标。
     工作区指令独立于部署单元选择——
     即使未选任何单元，只要其存在也会注入；整段为空则跳过。注入工作区指令时，``agentmdLoadStatus``
     首条即为它（``deployUnitId`` = ``本地工作区``、``source:"local"``、``loaded:true``），不计入
     单元级的 remote/local/缺 摘要。**去重**：若会话工作区的 ``AGENTS.md`` 与某选中单元实际加载的
     本地 ``AGENTS.md`` 是同一文件（按 resolve 比对），则不重复注入——丢掉会话工作区段（连同其
     ``本地工作区`` 状态条目与 ① 表行），由带 deployUnitId 身份的单元段承载该文件。
  ④ 领域词汇表 ``<DOMAIN_CONTEXT>``：``<sessionWorkspacePath>/CONTEXT.md`` 全文，排在最后作
     参考层（项目级领域术语与代码锚点，由 specs/plan 阶段回写维护，见
     skills/references/domain-context.md）。独立于部署单元选择；文件名与 AGENTS.md 不同，
     不参与 ③ 的同文件去重，也不进 ① 适用范围表（它不是代码库映射）。注入时在
     ``agentmdLoadStatus`` 中占一条（``deployUnitId`` = ``领域词汇表``、``source:"local"``、
     ``loaded:true``，排在「本地工作区」之后、各单元之前），不计入单元级 remote/local/缺 摘要。

加载策略按层次不同：
  · 系统级（②）只认 remote：本机不知道用户把系统级文件放在哪，**不走 local 兜底**（否则会拿
    单元级的 ``<localRepoPath>/AGENTS.md`` 冒名顶替）。找到就生成 ``<SYSTEM>`` 段，
    找不到就不生成。**系统级结果不进 agentmdLoadStatus**——状态只反映单元级（③）的加载结果。
  · 单元级（③）remote 优先 → local 兜底（``<localRepoPath>/AGENTS.md``）→ 都无则 ``loaded:false``，
    每个选中单元产出一条 agentmdLoadStatus。

系统级（②）与命中清单的单元级（③）正文里的 ``{plugin_root}`` 占位符在拼接前替换为
知识库根目录绝对路径（``<pluginPath>/sys``）。

当前节点 ``runtimePolicy.subagentConfig.customSubagentFiles`` 保存插件内相对路径；返回前直接
拼接插件根目录绝对路径，并按目标平台规范化路径分隔符。

设计原则：除入参 JSON 非法外，任何情况都返回 ok:true，绝不抛异常中断会话；
缺清单 / 未匹配单元 / 缺 AGENTS.md 都降级为「少注入一点」并在 message 说明。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.agents_repo import (  # noqa: E402
    AgentsManifestError,
    Manifest,
    display_path_join,
    get_agents_root,
    get_manifest_path,
    index_unit_pairs,
    load_manifest,
    sys_abspath,
    sys_abs_display,
)
from hooks.paths import get_plugin_output_workspace_from_args  # noqa: E402
from inspect_state import build_run_context  # noqa: E402

PLUGIN_ROOT_PLACEHOLDER = "{plugin_root}"  # md 正文里的占位符，替换为知识库根目录 <pluginPath>/sys
PLUGIN_ROOT_WIN32_PATH_RE = re.compile(
    re.escape(PLUGIN_ROOT_PLACEHOLDER) + r"((?:[/\\][^\s`\"'<>|\]\)）》，，。；;：:]*)?)"
)

LOCAL_AGENTS_MD = "AGENTS.md"  # local 兜底文件名（§8 #1：直接读用户仓库既有 AGENTS.md）

WORKSPACE_AGENTS_MD = "AGENTS.md"  # 工程级「会话工作区指令」文件名（sessionWorkspacePath 下）

WORKSPACE_CONTEXT_MD = "CONTEXT.md"  # 项目级「领域词汇表」文件名（sessionWorkspacePath 下，④ 层）

BOARD_CONFIG_PATH = ROOT / "board_core" / "board_config.json"
# Auto 托管会话默认采用 Multi；代码实现节点通过 board_config 的显式
# runtimePolicy 切换到 Workflow。缺失节点配置时仍保持可执行的 Multi 回退。
DEFAULT_AGENT_MODE = "multi"
DEFAULT_TASK_ENABLED = True


def _find_workflow_node(value: object, node_id: str) -> Optional[dict]:
    """在 workflow 的主节点、profile 节点和 dynamic stage 节点中查找 id。"""
    if isinstance(value, dict):
        nodes = value.get("nodes")
        if isinstance(nodes, list):
            for item in nodes:
                if isinstance(item, dict) and item.get("id") == node_id:
                    return item
        for nested in value.values():
            found = _find_workflow_node(nested, node_id)
            if found is not None:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _find_workflow_node(nested, node_id)
            if found is not None:
                return found
    return None


def _find_node_by_skill(value: object, skill: str) -> Optional[dict]:
    """按 ``skill`` 反查节点，查找范围与 :func:`_find_workflow_node` 一致。

    每层先扫本层 ``nodes`` 再下钻，故主节点表优先于 profile / dynamic stage 里的原始声明。
    """
    if isinstance(value, dict):
        nodes = value.get("nodes")
        if isinstance(nodes, list):
            for item in nodes:
                if isinstance(item, dict) and item.get("skill") == skill:
                    return item
        for nested in value.values():
            found = _find_node_by_skill(nested, skill)
            if found is not None:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _find_node_by_skill(nested, skill)
            if found is not None:
                return found
    return None


def _state_next_skill(node: dict, node_status: str) -> str:
    """取节点在该状态下 ``nextAction.slashSkill``——即宿主接下来会拉起的 skill。"""
    if not node_status:
        return ""
    for state in node.get("states", []):
        if not isinstance(state, dict):
            continue
        if state.get("nodeStatus", state.get("id")) != node_status:
            continue
        action = state.get("nextAction")
        skill = action.get("slashSkill") if isinstance(action, dict) else None
        return skill.strip() if isinstance(skill, str) else ""
    return ""


def _policy_target_node_id(
    config: object,
    node_id: str,
    node_status: str,
) -> str:
    """把「当前节点 + 状态」解析成「运行时策略该取哪个节点」。

    与宿主路由同源：走 ``states[nodeStatus].nextAction.slashSkill`` 反查节点，所以 ``*_done`` 会
    落到下一个节点，其余状态自然退化回当前节点。任一环节落空（节点查不到、无该状态、slashSkill
    为空、该 skill 无对应节点）都退回 ``node_id``，即保持旧口径。
    """
    workflow = config.get("workflow") if isinstance(config, dict) else None
    if not isinstance(workflow, dict):
        return node_id
    node = _find_workflow_node(workflow, node_id)
    if not isinstance(node, dict):
        return node_id
    skill = _state_next_skill(node, node_status)
    if not skill:
        return node_id
    target = _find_node_by_skill(workflow, skill)
    target_id = target.get("id") if isinstance(target, dict) else None
    if not isinstance(target_id, str) or not target_id.strip():
        return node_id
    return target_id.strip()


def _runtime_policy(
    node_id: Optional[str],
    *,
    board_config_path: Optional[Path] = None,
    config: Optional[dict] = None,
) -> dict:
    """读取指定 workflow 节点的 ``runtimePolicy``，并补齐稳定默认值。

    ``config`` 传入已编译的有效配置时直接使用（session context 走这条路，基线配置里查不到
    profile 与动态阶段插入的节点）；未传入时按 ``board_config_path`` 读基线配置。

    session context 是会话启动链路；节点 id 缺失、配置文件不可用或字段类型错误时
    都不应阻断会话，而是逐字段回退到 ``multi`` / ``task.enabled=true``。
    """
    agent_mode = DEFAULT_AGENT_MODE
    task_enabled = DEFAULT_TASK_ENABLED
    subagent_config: dict = {}
    current_node_id = (node_id or "").strip()

    if current_node_id:
        if config is None:
            path = board_config_path or BOARD_CONFIG_PATH
            try:
                config = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                config = {}

        workflow = config.get("workflow") if isinstance(config, dict) else None
        if isinstance(workflow, dict):
            node = _find_workflow_node(workflow, current_node_id)
            policy = node.get("runtimePolicy") if isinstance(node, dict) else None
            if isinstance(policy, dict):
                configured_agent_mode = policy.get("agentMode")
                if isinstance(configured_agent_mode, str) and configured_agent_mode.strip():
                    agent_mode = configured_agent_mode.strip()

                tool_config = policy.get("toolCustomConfig")
                task_config = tool_config.get("task") if isinstance(tool_config, dict) else None
                configured_task_enabled = (
                    task_config.get("enabled") if isinstance(task_config, dict) else None
                )
                if isinstance(configured_task_enabled, bool):
                    task_enabled = configured_task_enabled

                configured_subagents = policy.get("subagentConfig")
                if isinstance(configured_subagents, dict):
                    for field in ("disabledBuiltinSubagents", "customSubagentFiles"):
                        configured_values = configured_subagents.get(field)
                        if isinstance(configured_values, list) and all(
                            isinstance(value, str) for value in configured_values
                        ):
                            subagent_config[field] = list(configured_values)

    result = {
        "agentMode": agent_mode,
        "toolCustomConfig": {
            "task": {
                "enabled": task_enabled,
            }
        },
    }
    if subagent_config:
        result["subagentConfig"] = subagent_config
    return result


def _run_node_status(run: object, node_id: str) -> str:
    """从 Feature Status 的 ``run.nodes`` 里取该节点的 ``nodeStatus``。"""
    nodes = run.get("nodes") if isinstance(run, dict) else None
    if not isinstance(nodes, list):
        return ""
    for node in nodes:
        if not isinstance(node, dict) or node.get("id") != node_id:
            continue
        status = node.get("nodeStatus")
        return status.strip() if isinstance(status, str) else ""
    return ""


def _session_policy_node(
    node_id: Optional[str] = None,
    *,
    plugin_workspace: Optional[str] = None,
    project: Optional[str] = None,
    feature: Optional[str] = None,
    board_config_path: Optional[Path] = None,
) -> Tuple[str, Optional[dict]]:
    """解析运行时策略该取哪个节点，并带回解析所用的有效配置。

    显式 ``--node-id`` 是调试覆盖入口：直接用该节点自身策略，不做 nextAction 解析。否则复用
    Feature Status 的 ``run.currentNodeId`` 与该节点的 ``nodeStatus``，按
    :func:`_policy_target_node_id` 解析到宿主接下来实际会拉起的那个节点。

    session context 不应因参数、状态或配置异常中断；任何失败均返回空节点，由 runtime policy
    使用 ``multi`` / ``task.enabled=true`` 默认值。
    """
    explicit = (node_id or "").strip()
    if explicit:
        return explicit, None

    try:
        workspace = get_plugin_output_workspace_from_args(plugin_workspace, project)
        current_feature = (feature or "").strip()
        if not current_feature:
            raise ValueError("--feature 不能为空")
        path = board_config_path or BOARD_CONFIG_PATH
        base_config = json.loads(path.read_text(encoding="utf-8"))
        payload, config = build_run_context(workspace, current_feature, base_config)
        run = payload.get("run") if isinstance(payload, dict) else None
        current_node_id = run.get("currentNodeId") if isinstance(run, dict) else None
    except Exception:
        return "", None

    if not isinstance(current_node_id, str):
        return "", None
    current_node_id = current_node_id.strip()
    if not current_node_id or current_node_id == "unknown":
        return "", None
    node_status = _run_node_status(run, current_node_id)
    return _policy_target_node_id(config, current_node_id, node_status), config


def _session_runtime_policy(
    node_id: Optional[str] = None,
    *,
    plugin_workspace: Optional[str] = None,
    project: Optional[str] = None,
    feature: Optional[str] = None,
    board_config_path: Optional[Path] = None,
) -> dict:
    policy_node_id, config = _session_policy_node(
        node_id,
        plugin_workspace=plugin_workspace,
        project=project,
        feature=feature,
        board_config_path=board_config_path,
    )
    return _runtime_policy(
        policy_node_id,
        board_config_path=board_config_path,
        config=config,
    )


def _prepend_plugin_root_path(
    value: str,
    *,
    plugin_root: Optional[Path] = None,
    platform: Optional[str] = None,
) -> str:
    """在 custom subagent 的插件内相对路径前拼接真实插件根目录。"""
    root = Path(plugin_root).resolve() if plugin_root is not None else ROOT
    return display_path_join(root, value, platform=platform)


def _agent_config(
    runtime_policy: dict,
    *,
    plugin_root: Optional[Path] = None,
    platform: Optional[str] = None,
) -> dict:
    """将 workflow 的 runtimePolicy 转为 session_context_inject 对外格式。"""
    tool_custom_config = runtime_policy.get("toolCustomConfig")
    task_config = (
        tool_custom_config.get("task") if isinstance(tool_custom_config, dict) else None
    )
    task_enabled = task_config.get("enabled") if isinstance(task_config, dict) else None
    subagent_config = runtime_policy.get("subagentConfig")
    disabled_builtin_subagents = (
        subagent_config.get("disabledBuiltinSubagents")
        if isinstance(subagent_config, dict)
        else None
    )
    custom_subagent_files = (
        subagent_config.get("customSubagentFiles")
        if isinstance(subagent_config, dict)
        else None
    )
    expanded_custom_subagent_files = (
        [
            _prepend_plugin_root_path(
                path,
                plugin_root=plugin_root,
                platform=platform,
            )
            for path in custom_subagent_files
        ]
        if isinstance(custom_subagent_files, list)
        else []
    )
    return {
        "agentMode": runtime_policy.get("agentMode", DEFAULT_AGENT_MODE),
        "toolConfig": {
            "task": {
                "enabled": (
                    task_enabled if isinstance(task_enabled, bool) else DEFAULT_TASK_ENABLED
                ),
            }
        },
        "subagentConfig": {
            "disabledBuiltinSubagents": (
                disabled_builtin_subagents
                if isinstance(disabled_builtin_subagents, list)
                else []
            ),
            "customSubagentFiles": expanded_custom_subagent_files,
        },
    }


def _parse_selected(raw: Optional[str]) -> List[dict]:
    """解析 --selected-deployUnit。空/缺省 -> []；非法 -> ValueError。"""
    text = (raw or "").strip()
    if not text:
        return []
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"--selected-deployUnit 不是合法 JSON: {exc}") from exc
    if not isinstance(value, list):
        raise ValueError("--selected-deployUnit 必须是 JSON 数组")
    selected: List[dict] = []
    for idx, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError(f"--selected-deployUnit[{idx}] 必须是对象")
        # 新字段 deployUnitId 优先，兼容宿主灰度期仍回传旧 serviceUnitId。
        unit_id = item.get("deployUnitId", item.get("serviceUnitId"))
        if not isinstance(unit_id, str) or not unit_id.strip():
            raise ValueError(f"--selected-deployUnit[{idx}].deployUnitId 必须是非空字符串")
        local_repo = item.get("localRepoPath", "")
        # UI 传入的 description：未命中清单（remote 无配置、走 local 兜底）时用作「引用范围」展示名，
        # 顶替旧的「(未匹配知识库)」占位。其余字段（如 deployUnitIdMapping）脚本不关心、原样忽略。
        description = item.get("description", "")
        selected.append(
            {
                "deployUnitId": unit_id.strip(),
                "localRepoPath": local_repo if isinstance(local_repo, str) else "",
                "description": description if isinstance(description, str) else "",
            }
        )
    return selected


def _read_nonempty(path: Path) -> Optional[str]:
    """读取文本；不存在或全空白时返回 None。"""
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8", errors="ignore")
    return text if text.strip() else None


def _norm_path(path: Path) -> Path:
    """规范化路径用于去重：resolve 消除 symlink、``..``、尾斜杠等差异，让会话工作区与单元
    本地 AGENTS.md 指向同一文件时能比相等。失败则原样返回（绝不抛，符合「不中断会话」原则）。"""
    try:
        return path.resolve()
    except (OSError, RuntimeError):
        return path


def _fill_plugin_root(
    content: str,
    *,
    plugin_root: Optional[Path],
    platform: Optional[str] = None,
) -> str:
    """把正文里的 ``{plugin_root}`` 占位符替换为知识库根目录绝对路径。

    无占位符时原样返回。
    """
    if PLUGIN_ROOT_PLACEHOLDER not in content:
        return content
    root_dir = display_path_join(get_agents_root(plugin_root), platform=platform)
    platform_text = (platform or sys.platform).strip().lower()
    if not platform_text.startswith("win"):
        return content.replace(PLUGIN_ROOT_PLACEHOLDER, root_dir)

    def _replace_win32(match: re.Match[str]) -> str:
        suffix = match.group(1) or ""
        if not suffix:
            return root_dir
        trailing_sep = suffix.endswith(("/", "\\"))
        suffix_parts = [part for part in re.split(r"[/\\]+", suffix.strip("/\\")) if part]
        expanded = display_path_join(root_dir, *suffix_parts, platform="win32")
        if trailing_sep and not expanded.endswith("\\"):
            expanded += "\\"
        return expanded

    return PLUGIN_ROOT_WIN32_PATH_RE.sub(_replace_win32, content)


def _resolve_one(
    owner_uid: str,
    rel_in_manifest: str,
    local_repo: str,
    *,
    plugin_root: Optional[Path],
    platform: Optional[str] = None,
    allow_local_fallback: bool = True,
) -> Tuple[dict, Optional[Path], Optional[str]]:
    """一个 md 文件：remote 优先 →（可选）local 兜底 → 都无则 loaded:false。

    ``allow_local_fallback=False`` 时只认 remote：系统级 AGENTS.md 用此模式——本机不知道用户
    把系统级文件放在哪，不能拿 ``<localRepoPath>/AGENTS.md``（那是单元级兜底）冒名顶替，
    remote 缺失就直接报 remote 未命中，不走 local。

    返回 (status, abs_path, content)；content 非 None 表示成功加载、可进正文。
    """
    # ① remote：清单里有该路径 且 sys/ 下文件存在 → 用 remote，忽略 local。
    if rel_in_manifest:
        try:
            abs_path = sys_abspath(rel_in_manifest, plugin_root)
        except AgentsManifestError:
            abs_path = None  # 路径非法（穿越/绝对）：当作 remote 取不到，转 local 兜底。
        if abs_path is not None:
            content = _read_nonempty(abs_path)
            if content is not None:
                status = {
                    "deployUnitId": owner_uid,
                    "path": sys_abs_display(rel_in_manifest, plugin_root, platform=platform),
                    "loaded": True,
                    "source": "remote",
                    "message": "",
                }
                return status, abs_path, content

    # 不允许 local 兜底（系统级）：remote 缺失即报 remote 未命中，不去碰 <localRepoPath>/AGENTS.md。
    if not allow_local_fallback:
        status = {
            "deployUnitId": owner_uid,
            "path": (
                sys_abs_display(rel_in_manifest, plugin_root, platform=platform)
                if rel_in_manifest
                else ""
            ),
            "loaded": False,
            "source": "remote",
            "message": "file not exist",
        }
        return status, None, None

    # ② local 兜底：未命中清单 或 remote 文件缺失 → 读 <localRepoPath>/AGENTS.md。
    local_abs = (Path(local_repo) / LOCAL_AGENTS_MD) if local_repo else None
    local_display = (
        display_path_join(local_repo, LOCAL_AGENTS_MD, platform=platform) if local_repo else ""
    )
    if local_abs is not None:
        content = _read_nonempty(local_abs)
        if content is not None:
            status = {
                "deployUnitId": owner_uid,
                "path": local_display,
                "loaded": True,
                "source": "local",
                "message": "",
            }
            return status, local_abs, content

    # ③ remote 与 local 都没有。
    status = {
        "deployUnitId": owner_uid,
        "path": local_display,
        "loaded": False,
        "source": "local",
        "message": "未找到知识库 AGENTS.md 和本地 AGENTS.md",
    }
    return status, None, None


def _md_cell(text: str) -> str:
    """转义表格单元里的 `|` 与换行，避免用户值（description/localRepoPath）撑破表格。"""
    return text.replace("|", "\\|").replace("\r", " ").replace("\n", " ")


# 三个层次各用一对 XML 风格标签外包（**裸标签**，不再用反引号包成 inline code）：
# 反引号会把标签变成「行内代码」字面量，其 id 属性不是真 HTML 锚点、Markdown 的
# ``[文字](#anchor)`` 跳不过去；改为裸标签后 ``<SYSTEM id="sys-…">`` 的 id 成为可跳转锚点。
# 每个标签独占一行、前后留空行：空行让裸标签各自成 HTML 块（CommonMark 遇空行结束 HTML 块），
# 紧随其后的 ``#``/``##`` 标题照常按 Markdown 渲染，不被折进 HTML 块。
SCOPE_TAG = "SCOPE"   # ① 适用范围
SYSTEM_TAG = "SYSTEM"     # ② 系统级 AGENTS.md
UNIT_TAG = "UNIT"    # ③ 单元级：整段只用一对 <UNIT> 外包（工作区指令 + 各单元正文）
UNIT_SECTION_ANCHOR = "unit-section"  # <UNIT> 标签 id（语义/结构边界）；单元锚点改为各自 ## 标题 slug
DOMAIN_CONTEXT_TAG = "DOMAIN_CONTEXT"  # ④ 领域词汇表：整段只用一对 <DOMAIN_CONTEXT> 外包


def _heading_slug(text: str) -> str:
    """把 ``## 标题`` 文本转成 GitHub 风格锚点 slug，供 ① 适用范围表的
    ``[deployUnitId](#slug)`` 跳转到 ③ 单元级里对应的 ``## 标题``。

    规则对齐 github-slugger（GitHub / 多数 Markdown 渲染器采用）：转小写、去首尾空白、
    删除非「单词字符/空格/连字符」的标点（``.``、全角 ``（）`` 等被删，``_`` 保留，CJK 保留）、
    空格转连字符。
    """
    s = text.strip().lower()
    s = re.sub(r"[^\w \-]", "", s, flags=re.UNICODE)
    return s.replace(" ", "-")


def _unit_heading_label(uid: str, ref: str) -> str:
    """单元级 ``## 标题`` 文本：``deployUnitId（描述）``，无描述时仅 deployUnitId。
    标题与 ① 表锚点 slug 同源于此函数，避免两边算偏。"""
    return f"{uid}（{ref}）" if ref else uid


def _ref_for(pair: Optional[Tuple], sel: dict) -> str:
    """单元的「引用范围」展示名（① 表 + ③ 标题 + 锚点 slug 三处同源）：
    优先用清单 description（pair 命中知识库），否则回退到 UI 传入的 ``description``——
    即「远端无配置、本地兜底」时不再显示「(未匹配知识库)」，而是 UI 给的名字。两者都空才为空串。"""
    manifest_name = pair[1].name if pair is not None else ""
    return manifest_name or sel.get("description", "")


def _build_workspace_content(session_workspace_path: Optional[str]) -> Optional[str]:
    """读取 ``<sessionWorkspacePath>/AGENTS.md`` 作为「会话工作区指令」正文。

    路径为空 / 该目录下无 AGENTS.md / 文件全空白 → 返回 None（不生成该段）。
    与部署单元选择无关：独立判断、独立注入。
    """
    path = (session_workspace_path or "").strip()
    if not path:
        return None
    return _read_nonempty(Path(path) / WORKSPACE_AGENTS_MD)


# 适用范围表里「会话工作区指令」那一行：deployUnitId 列用此展示文本（链接指向单元级整段）。
WORKSPACE_SCOPE_ID = "会话工作区"
WORKSPACE_SCOPE_REF = "会话工作区指令"

# 「会话工作区指令」进 agentmdLoadStatus 时的 deployUnitId（= 本地工作区），
# 与各部署单元的加载状态同列，让宿主能据此渲染工作区 AGENTS.md 的加载情况。
WORKSPACE_STATUS_ID = "本地工作区"


def _workspace_status(session_workspace_path: Optional[str], *, platform: Optional[str] = None) -> dict:
    """工作区 AGENTS.md 进 agentmdLoadStatus 的一条。仅在已确认工作区有正文时调用，
    故 ``loaded:True``、``source:"local"``（工作区指令始终读本地文件，无 remote）。"""
    path = (session_workspace_path or "").strip()
    return {
        "deployUnitId": WORKSPACE_STATUS_ID,
        "path": display_path_join(path, WORKSPACE_AGENTS_MD, platform=platform) if path else "",
        "loaded": True,
        "source": "local",
        "message": "",
    }


def _workspace_binding(session_workspace_path: Optional[str]) -> dict:
    """工作区指令在适用范围表里的一行：引用范围=「会话工作区指令」、代码地址=工作区路径、
    锚点指向单元级里工作区指令那条 ``## 标题``。仅在已确认工作区有正文时调用。"""
    return {
        "deployUnitId": WORKSPACE_SCOPE_ID,
        "ref": WORKSPACE_SCOPE_REF,
        "localRepoPath": (session_workspace_path or "").strip(),
        "anchor": _heading_slug(WORKSPACE_SCOPE_REF),
    }


# 领域词汇表（④）进 agentmdLoadStatus 时的 deployUnitId，与「本地工作区」同为会话级条目。
DOMAIN_CONTEXT_STATUS_ID = "领域词汇表"


def _build_domain_context(session_workspace_path: Optional[str]) -> Optional[str]:
    """读取 ``<sessionWorkspacePath>/CONTEXT.md`` 作为「领域词汇表」正文（④ 层）。

    路径为空 / 该目录下无 CONTEXT.md / 文件全空白 → 返回 None（不生成该段）。
    独立于部署单元选择；文件名与 AGENTS.md 不同，不参与单元级同文件去重。
    """
    path = (session_workspace_path or "").strip()
    if not path:
        return None
    return _read_nonempty(Path(path) / WORKSPACE_CONTEXT_MD)


def _domain_context_status(
    session_workspace_path: Optional[str], *, platform: Optional[str] = None
) -> dict:
    """领域词汇表进 agentmdLoadStatus 的一条。仅在已确认有正文时调用，
    故 ``loaded:True``、``source:"local"``（词汇表始终读本地文件，无 remote）。"""
    path = (session_workspace_path or "").strip()
    return {
        "deployUnitId": DOMAIN_CONTEXT_STATUS_ID,
        "path": display_path_join(path, WORKSPACE_CONTEXT_MD, platform=platform) if path else "",
        "loaded": True,
        "source": "local",
        "message": "",
    }


def _attr(text: str) -> str:
    """转义 XML 属性值里的 & < > "，避免 description 等自由文本撑破标签。"""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _compose_prompt(
    bindings: List[dict],
    system_sections: List[dict],
    workspace_content: Optional[str],
    unit_sections: List[dict],
    domain_context: Optional[str] = None,
) -> str:
    """① 适用范围（绑定表，deployUnitId 为锚点链接）→ ② 系统级 AGENTS.md → ③ 各单元 description.md
    → ④ 领域词汇表。

    三个层次各用一对 XML 风格标签外包（``<SCOPE>`` / ``<SYSTEM>`` /
    ``<UNIT>``）；被嵌入 md 自带的 ``#``/``##`` 标题被包在标签内，不再与结构
    标记同级交错。单元锚点改为各单元自己的 ``## deployUnitId（描述）`` 标题 slug；适用范围表里
    的 deployUnitId 以 ``[id](#slug)`` 指向该标题（有单元段指向单元标题，否则指向所属系统段的
    ``<SYSTEM id="sys-…">``；无内容则不加链接）。

    标签为**裸标签**（不再用反引号包成 inline code）并前后留空行：
      · 裸标签使 ``id`` 属性成为真 HTML 锚点；反引号会让标签变字面量、id 跳不过去。
      · 前后空行让每个裸标签各自成 HTML 块（CommonMark 遇空行结束 HTML 块），紧随其后的
        ``#``/``##`` 标题照常按 Markdown 渲染，不被折进 HTML 块。
    """
    lines: List[str] = []
    lines.append("# 统一 Agent 指令")
    lines.append("")
    lines.append("""## 必须执行的启动协议

1. 判断本次任务涉及哪些 deployUnit（见 <SCOPE> 映射表）。
2. 用文件读取、搜索或 shell 工具打开对应 <SYSTEM>、<UNIT> 段落的架构、领域、API、编码规范文档，以及 <SCOPE>「代码地址」下的相关代码，不凭包名、记忆路径、相似命名判断。
3. 任务跨多个 deployUnit 时，各单元规则同时适用，并分别说明验证结果。

本协议按「任务」生效，覆盖需求澄清、需求分析、向用户提问、设计、编码；不得因当前不是代码阶段而跳过。

## 指令反模式

- <SCOPE>、<SYSTEM>、<UNIT> 不表示任何文件已被读取；复述不算读取。
- 未用工具实际打开前，不得声称已读取，也不得据此开始实质分析、提问或答复。
- 路径不存在或无法访问时，说明未读取及原因，不得猜测内容。

## 必读门禁

- 不得把“任务”缩义为代码修改。本门禁覆盖需求澄清、需求分析、向用户提问、设计、编码全部环节。
- 上游文档中标注“必须读取”“先读取”“必读”文件必须逐个通过文件读取、搜索或 shell 工具实际打开，不得只凭内联正文作答。
- 明确的必读指令高于模型对文件相关性的主观判断；认为某文件与当前问题无关不构成跳过理由。
- 不得以“当前不是代码阶段”“需求澄清不需要”“先讨论再读”为由推迟必读项。
- 每个必读文件都要在该阶段首次分析、提问或答复前用工具打开该文件。
- 未取得工具读取证据前，不得声称已读、不得继续实质分析。

## 指令优先级
skill 的工作步骤不构成跳过本协议的理由。冲突时按此顺序：当前用户请求 → 本启动协议 → <UNIT> 单元级约束 → <SYSTEM> 系统级约束 → 实际工程中的既有代码行为 → 通用框架或语言默认实践。

## 最终回复清单

- 本轮通过工具实际打开了哪些<SYSTEM><UNIT>索引的文件路径，仅限sys目录（<SYSTEM> 和 <UNIT> 段落所指向的架构/领域知识文档目录）下的md文件，未打开的不得列入，不列举代码文件，不列举skills目录下的文件。
- 影响哪些 deployUnit，修改了哪些文件。
- 执行了哪些验证命令，或为什么跳过。
  """)
    lines.append("")
    # ① 适用范围：绑定表（deployUnitId 锚点链接指向下方 ②/③ 段的 id 属性）。
    # 无绑定（未选任何单元、仅注入工作区指令时）则整段跳过。
    if bindings:
        lines.append(f"<{SCOPE_TAG}>")
        lines.append("")
        lines.append("## 适用范围")
        lines.append(
            "本文件是 产品的前端、后端工程工作的统一入口，执行任务前必须先确认下面的工程映射，避免把前端、后端或文档索引路径识别错。"
            "开发、排查与代码修改时优先在这些路径内进行（deployUnitId 链接指向下方对应知识库段）："
        )
        lines.append("")
        lines.append("| 引用范围 | deployUnitId | 代码地址（localRepoPath） |")
        lines.append("| --- | --- | --- |")
        for binding in bindings:
            ref = _md_cell(binding.get("ref") or "(未匹配知识库)")
            repo = _md_cell(binding.get("localRepoPath") or "(未提供)")
            uid_text = _md_cell(binding["deployUnitId"])
            cell = f"[{uid_text}](#{binding['anchor']})" if binding.get("anchor") else uid_text
            lines.append(f"| {ref} | {cell} | {repo} |")
        lines.append("")
        lines.append(f"</{SCOPE_TAG}>")


    # ② 系统级 AGENTS.md：每段外包 <SYSTEM>（裸标签），id 供 ① 表里无独立 md 的单元回退锚点定位。
    for section in system_sections:
        lines.append("")
        lines.append(
            f'<{SYSTEM_TAG} id="sys-{section["systemId"]}" system="{_attr(section["title"])}">'
        )
        lines.append("")
        lines.append(section["content"].strip())
        lines.append("")
        lines.append(f"</{SYSTEM_TAG}>")

    # ③ 单元级：整段只用一对 <UNIT> 外包（裸标签，作语义/结构边界）。
    # 会话工作区指令排在最前，其后接各选中单元正文；每段前置一行 ``## 标题`` 作为 ① 表锚点目标
    # （标题 slug 由 _heading_slug 生成，与 ① 表里的 [deployUnitId](#slug) 同源）。空段跳过整对标签。
    unit_blocks: List[str] = []
    if workspace_content is not None:
        unit_blocks.append(f"## {WORKSPACE_SCOPE_REF}\n\n{workspace_content.strip()}")
    for section in unit_sections:
        label = _unit_heading_label(section["deployUnitId"], section.get("ref") or "")
        unit_blocks.append(f"## {label}\n\n{section['content'].strip()}")
    if unit_blocks:
        lines.append("")
        lines.append(f'<{UNIT_TAG} id="{UNIT_SECTION_ANCHOR}" unit="单元级">')
        lines.append("")
        lines.append("\n\n".join(unit_blocks))
        lines.append("")
        lines.append(f"</{UNIT_TAG}>")

    # ④ 领域词汇表：项目级术语与代码锚点，整段只用一对 <DOMAIN_CONTEXT> 外包，排最后作参考层。
    if domain_context is not None:
        lines.append("")
        lines.append(f'<{DOMAIN_CONTEXT_TAG} id="domain-context" scope="项目级领域词汇表">')
        lines.append("")
        lines.append(domain_context.strip())
        lines.append("")
        lines.append(f"</{DOMAIN_CONTEXT_TAG}>")

    return "\n".join(lines)


def render(
    selected: List[dict],
    *,
    plugin_root: Optional[Path] = None,
    session_workspace_path: Optional[str] = None,
    platform: Optional[str] = None,
    node_id: Optional[str] = None,
    plugin_workspace: Optional[str] = None,
    project: Optional[str] = None,
    feature: Optional[str] = None,
    board_config_path: Optional[Path] = None,
) -> dict:
    """核心逻辑（无 I/O 边界外副作用），便于单测。"""
    agent_config = _agent_config(
        _session_runtime_policy(
            node_id,
            plugin_workspace=plugin_workspace,
            project=project,
            feature=feature,
            board_config_path=board_config_path,
        ),
        plugin_root=plugin_root,
        platform=platform,
    )
    # 「会话工作区指令」独立于部署单元选择：先行构建，未选单元也可单独注入。
    workspace_content = _build_workspace_content(session_workspace_path)
    # 「领域词汇表」（④）同样独立于部署单元选择；文件名与 AGENTS.md 不同，不参与其去重。
    domain_context = _build_domain_context(session_workspace_path)

    if not selected:
        if workspace_content is None and domain_context is None:
            return {
                "ok": True,
                "message": "未选择部署单元，无需注入",
                "sessionContext": "",
                "agentmdLoadStatus": [],
                "agentConfig": agent_config,
            }
        # 即便未选单元，工作区指令也在适用范围表里占一行映射；词汇表不进适用范围表（非代码库映射）。
        bindings = (
            [_workspace_binding(session_workspace_path)] if workspace_content is not None else []
        )
        prompt = _compose_prompt(bindings, [], workspace_content, [], domain_context)
        parts: List[str] = []
        session_status: List[dict] = []
        if workspace_content is not None:
            parts.append("会话工作区指令")
            session_status.append(_workspace_status(session_workspace_path, platform=platform))
        if domain_context is not None:
            parts.append("领域词汇表")
            session_status.append(_domain_context_status(session_workspace_path, platform=platform))
        return {
            "ok": True,
            "message": "未选择部署单元，仅注入" + "、".join(parts),
            "sessionContext": prompt,
            "agentmdLoadStatus": session_status,
            "agentConfig": agent_config,
        }

    # 重复的 deployUnitId 只影响该 ID；清单其余条目仍可供会话加载。
    duplicate_unit_ids: set[str] = set()
    # 清单不可用（缺失/其他非法结构）时降级：所有单元当作未命中，直接走 local 兜底。
    manifest: Optional[Manifest]
    try:
        manifest = load_manifest(plugin_root, duplicate_unit_ids=duplicate_unit_ids)
    except AgentsManifestError:
        manifest = None
        duplicate_unit_ids.clear()
    pairs = index_unit_pairs(manifest) if manifest is not None else {}
    for uid in duplicate_unit_ids:
        pairs.pop(uid, None)

    load_status: List[dict] = []
    system_sections: List[dict] = []  # ② 按 systemId 去重，首次出现顺序
    unit_sections: List[dict] = []    # ③ 按选择顺序
    seen_systems: set[str] = set()
    seen_paths: set[Path] = set()     # 正文按规范化后绝对路径去重（resolve 消除 symlink/.. 差异）
    system_loaded: set[str] = set()   # 实际产出系统段的 systemId（供锚点回退）
    unit_has_section: set[str] = set()  # 实际产出单元段的 deployUnitId（供锚点指向）

    def _append_body(abs_path: Optional[Path], bucket: List[dict], section: dict) -> bool:
        if abs_path is None:
            return False
        key = _norm_path(abs_path)
        if key in seen_paths:
            return False
        seen_paths.add(key)
        bucket.append(section)
        return True

    for sel in selected:
        uid = sel["deployUnitId"]
        local = sel["localRepoPath"]
        if uid in duplicate_unit_ids:
            load_status.append({
                "deployUnitId": uid,
                "path": display_path_join(get_manifest_path(plugin_root), platform=platform),
                "loaded": False,
                "source": "remote",
                "message": f"agents.manifest.json 中 deployUnitId 重复: {uid}",
            })
            continue
        pair = pairs.get(uid)
        if pair is not None:
            system, unit = pair
            # ② 系统级 AGENTS.md —— 每个系统一次（归属首个被选中单元）。
            if system.system_id not in seen_systems:
                seen_systems.add(system.system_id)
                # 系统级只查 remote；不进 agentmdLoadStatus（状态只反映单元级结果）。
                # 找到就生成 <SYSTEM> 段，找不到就不生成（status 丢弃，仅取 content）。
                _status, abs_path, content = _resolve_one(
                    uid, system.agents_relpath(), local,
                    plugin_root=plugin_root, platform=platform, allow_local_fallback=False,
                )
                if content is not None:
                    content = _fill_plugin_root(
                        content,
                        plugin_root=plugin_root,
                        platform=platform,
                    )
                    title = system.system_id
                    if system.system_name:
                        title += f"（{system.system_name}）"
                    if _append_body(
                        abs_path, system_sections,
                        {"systemId": system.system_id, "title": title, "content": content},
                    ):
                        system_loaded.add(system.system_id)
            # ③ 单元级 description.md —— 仅当单元自带 agentsPath。
            if unit.agents_rel:
                status, abs_path, content = _resolve_one(
                    uid,
                    unit.agents_rel,
                    local,
                    plugin_root=plugin_root,
                    platform=platform,
                )
                load_status.append(status)
                if content is not None:
                    content = _fill_plugin_root(
                        content,
                        plugin_root=plugin_root,
                        platform=platform,
                    )
                    if _append_body(
                        abs_path,
                        unit_sections,
                        {"deployUnitId": uid, "ref": _ref_for(pair, sel), "content": content},
                    ):
                        unit_has_section.add(uid)
        else:
            # 未命中清单：只走 local 兜底（rel 为空）；引用范围用 UI 传入的 description。
            status, abs_path, content = _resolve_one(
                uid, "", local, plugin_root=plugin_root, platform=platform
            )
            load_status.append(status)
            if content is not None and _append_body(
                abs_path, unit_sections,
                {"deployUnitId": uid, "ref": _ref_for(pair, sel), "content": content},
            ):
                unit_has_section.add(uid)

    # 会话工作区指令与已选单元去重：若 <sessionWorkspacePath>/AGENTS.md 与某个选中单元实际
    # 加载的本地 AGENTS.md 是同一文件（会话工作区即该单元的 localRepoPath 且单元走了 local 兜底），
    # 同一文件不重复注入——丢掉会话工作区段，由带 deployUnitId 身份的单元段承载（它已在 seen_paths）。
    # 注意：单元若命中 remote，加载的是 sys/ 下的文件、与本地 AGENTS.md 非同一路径，不触发去重。
    if workspace_content is not None:
        ws_md = Path((session_workspace_path or "").strip()) / WORKSPACE_AGENTS_MD
        if _norm_path(ws_md) in seen_paths:
            workspace_content = None

    # 适用范围：工作区指令（若有）占首行，其后每个选中单元一行（引用范围 = 清单 description；
    # 代码地址 = localRepoPath）；deployUnitId 锚点：有单元段→指向该单元 ## 标题 slug，否则→
    # 指向所属系统段的 <SYSTEM id="sys-…">，再否则→无链接。
    bindings: List[dict] = []
    if workspace_content is not None:
        bindings.append(_workspace_binding(session_workspace_path))
    for sel in selected:
        uid = sel["deployUnitId"]
        pair = pairs.get(uid)
        ref = _ref_for(pair, sel)
        if uid in unit_has_section:
            anchor = _heading_slug(_unit_heading_label(uid, ref))
        elif pair is not None and pair[0].system_id in system_loaded:
            anchor = f"sys-{pair[0].system_id}"
        else:
            anchor = ""
        bindings.append(
            {
                "deployUnitId": uid,
                "ref": ref,
                "localRepoPath": sel["localRepoPath"],
                "anchor": anchor,
            }
        )

    prompt = _compose_prompt(bindings, system_sections, workspace_content, unit_sections, domain_context)
    remote_n = sum(1 for s in load_status if s["loaded"] and s["source"] == "remote")
    local_n = sum(1 for s in load_status if s["loaded"] and s["source"] == "local")
    miss_n = sum(1 for s in load_status if not s["loaded"])
    message = f"remote {remote_n} / local {local_n} / 缺 {miss_n}"
    selected_duplicates = sorted({
        sel["deployUnitId"] for sel in selected
        if sel["deployUnitId"] in duplicate_unit_ids
    })
    if selected_duplicates:
        message += "；清单中重复的 deployUnitId: " + ", ".join(selected_duplicates)
    # 会话级条目（工作区指令、领域词汇表，若有正文注入）在 agentmdLoadStatus 里排前；其加载
    # 结果不计入上面的 remote/local/缺 单元摘要（那行只反映部署单元），避免混进单元统计。
    session_entries: List[dict] = []
    if workspace_content is not None:
        session_entries.append(_workspace_status(session_workspace_path, platform=platform))
    if domain_context is not None:
        session_entries.append(_domain_context_status(session_workspace_path, platform=platform))
    result_status = [*session_entries, *load_status]
    return {
        "ok": True,
        "message": message,
        "sessionContext": prompt,
        "agentmdLoadStatus": result_status,
        "agentConfig": agent_config,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="session_context_inject: 选中部署单元 -> 注入 sessionContext（适用范围+系统级+各单元）",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--platform",
        dest="platform",
        default=None,
        help="目标平台：darwin/linux/win32；用于输出中的 sys 路径拼接展示",
    )
    parser.add_argument(
        "--selected-deployUnit",
        dest="selected",
        default="",
        help="JSON 数组字符串：[{\"deployUnitId\":\"...\",\"localRepoPath\":\"...\"}]",
    )
    parser.add_argument(
        "--node-id",
        dest="node_id",
        default="",
        help="本地调试覆盖：显式指定 workflow 节点 id；宿主运行时从项目与 Feature 参数自动解析",
    )
    parser.add_argument(
        "--plugin-workspace",
        dest="plugin_workspace",
        default="",
        help="项目集合工作区路径；与 --project 组合定位项目插件目录",
    )
    parser.add_argument(
        "--project",
        dest="project",
        default="",
        help="项目插件目录名",
    )
    parser.add_argument(
        "--feature",
        dest="feature",
        default="",
        help="当前 Feature 标识",
    )
    parser.add_argument(
        "--session-workspace-path",
        dest="session_workspace_path",
        default="",
        help="会话工作区目录路径；读取其下 AGENTS.md 作为「会话工作区指令」，缺失则不注入该段",
    )
    args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))

    try:
        selected = _parse_selected(args.selected)
    except ValueError as exc:
        result = {
            "ok": False,
            "message": str(exc),
            "sessionContext": "",
            "agentmdLoadStatus": [],
            "agentConfig": _agent_config(
                _session_runtime_policy(
                    args.node_id,
                    plugin_workspace=args.plugin_workspace,
                    project=args.project,
                    feature=args.feature,
                ),
                platform=args.platform,
            ),
        }
    else:
        result = render(
            selected,
            session_workspace_path=args.session_workspace_path,
            platform=args.platform,
            node_id=args.node_id,
            plugin_workspace=args.plugin_workspace,
            project=args.project,
            feature=args.feature,
        )

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
