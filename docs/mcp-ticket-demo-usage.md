# 工单列表 MCP 裁剪测试示例

这个示例用于验证“懒加载 MCP + 大结果裁剪”是否真的生效。

## 1. 示例文件

已新增本地 stdio MCP：

```text
examples/mcp-ticket-demo-server.mjs
```

它提供两个工具：

1. `ticket_list`
   - 返回模拟工单列表。
   - 每条工单都带很长的 `description`、`comments`、`attachments`。
   - 用来测试列表结果裁剪。

2. `ticket_detail`
   - 按 `id` 返回单条工单完整详情。
   - 用来测试“先裁剪列表，再按 ID 展开详情”。

## 2. 先验证 MCP 能启动

在仓库根目录运行：

```powershell
node examples/mcp-ticket-demo-smoke.mjs
```

预期输出里应包含：

```text
tools: ticket_list, ticket_detail
ticket_list raw JSON bytes: ...
OK: demo MCP is ready for app testing.
```

## 3. 在应用里添加 MCP 连接器

入口：

```text
自定义 -> MCP 连接器 -> 点击 +
```

表单填写：

```text
名称：工单裁剪测试 MCP
连接方式：Local stdio command
启动命令：node
命令参数：
<你的仓库目录>\examples\mcp-ticket-demo-server.mjs
懒加载：勾选
```

保存后点击“测试连接”，预期看到：

```text
ticket_list
ticket_detail
```

## 4. 对话里直接复制这句话测试

```text
用工单裁剪测试 MCP 查最近 20 条未关闭工单，只保留 id、title、status、owner；正文、评论、附件先不要展开。
```

预期工具调用过程：

1. Agent 先调用 `inspect_tool(caller="invoke_deferred_tool")` 查看 `ticket_list` 的 schema。
2. Agent 再调用 `invoke_deferred_tool` 执行 `ticket_list`。
3. `invoke_deferred_tool` 参数里应出现类似：

```json
{
  "tool_args": {
    "status": "not_closed",
    "limit": 20
  },
  "required_fields": ["items[].id", "items[].title", "items[].status", "items[].owner"],
  "max_array_items": 20,
  "max_result_chars": 4000
}
```

预期返回结果里只保留列表必要字段，并带 `_projection`：

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "INC-1001",
        "title": "支付回调延迟",
        "status": "pending",
        "owner": "李四"
      }
    ]
  },
  "_projection": {
    "projected": true,
    "truncated": false
  }
}
```

重点观察：返回给模型的数据里不应包含大字段 `description`、`comments`、`attachments`。

## 5. 再测按需展开详情

拿上一步返回的某个工单 ID，例如 `INC-1001`，继续问：

```text
展开 INC-1001 的完整详情，这次可以返回 description、comments 和 attachments。
```

预期 Agent 会调用 `ticket_detail`，这次可以拿完整详情。

这个流程验证的是目标体验：列表阶段只拿摘要字段，真正需要排查某一条时再展开大字段。
