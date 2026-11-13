# 外部资料索引

原件或快照写入 `sources/SRC-NNN/`，再运行脚本生成 `source-context.json`，不手写该文件：

```bash
python -X utf8 "${pluginPath}/hooks/source_context.py" sync --feature-dir "${pluginWorkspace}/${projectDir}/.autobizdevops/features/${feature}"
```

脚本以 PRD 来源表为准建立来源集合，扫 `sources/SRC-NNN/` 写入快照路径；报告某个 `SRC-NNN` 未找到快照时，补齐原件后重跑，或从 PRD 来源表移除该依赖。

记录单位是文件：一份资料对应一个 `SRC-NNN` 和一个快照文件。

```json
{
  "version": 1,
  "sources": [
    {
      "id": "SRC-001",
      "name": "支付网关接口文档",
      "path": "sources/SRC-001/payment-api.docx",
      "availability": "snapshot_only",
      "readStatus": "complete",
      "freshness": "unknown"
    }
  ]
}
```

`availability` 取 `live`、`snapshot_only`、`never_provided`；`readStatus` 取 `complete`、`partial`、`unreadable`；`freshness` 取 `current`、`stale`、`unknown`。

`never_provided` 写 `path: null`、`readStatus: "unreadable"`；只有该状态允许向用户索取资料。已有快照但原地址失联时写 `snapshot_only`。

已有 `SRC-NNN` 不重编号、不复用。
