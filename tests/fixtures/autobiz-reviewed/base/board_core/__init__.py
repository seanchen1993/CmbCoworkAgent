"""board_core — AutoBizDevOps shared core logic.

Hook 与 inspect_state.py 都通过此包读取状态、推导节点、检查产物。
状态读取会按 state.json 修复生成视图 STATE.md；其他逻辑保持确定性。
"""
