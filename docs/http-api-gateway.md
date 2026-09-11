# CMBDevClaw 远端 HTTP API 网关 · 接口文档

远端通过 HTTP 驱动本机已启动的 CMBDevClaw agent:创建会话(thread)、发送消息、接收流式回复(SSE)。行为与在 app 输入框里操作**完全一致**(实时流式、落库、界面同步渲染)。

> 版本对应分支 `feature/cmbdevclaw-security-test`。

---

## 1. 快速开始(零配置)

**默认就是"启动 app → 直接调接口",不需要任何配置。** 网关随 app 自动开启,监听 `0.0.0.0:8765`,默认无鉴权。

```bash
# 1) 正常启动 app(不用设任何环境变量)
npm run start            # 或 npm run dev
#    主进程日志出现这行即就绪:
#    [ApiGateway] listening on http://0.0.0.0:8765 — NO AUTH ...

# 2) 建会话 → 发消息(SSE),就这么用
BASE=http://<机器IP>:8765          # 同机可用 127.0.0.1
TID=$(curl -s -H "Content-Type: application/json" \
  -d '{"workspacePath":"/abs/path/to/project"}' $BASE/v1/threads \
  | sed -n 's/.*"thread_id":"\([^"]*\)".*/\1/p')

curl -sN -H "Content-Type: application/json" \
  -d '{"message":"你好"}' $BASE/v1/threads/$TID/messages
```

就这样。**下面第 2 节的配置全部是可选的**,不改也能用;不想细看可以直接跳到 [§4 端点](#4-端点总览)。

---

## 2. 可选配置(不配也能用)

网关是 app 的一部分,**app 运行时它就在**。以下环境变量**都是可选的**,只在你想改端口/绑定地址/加鉴权时才需要(启动 app 前设置;别用 `VITE_` 前缀,那会被打进前端包)。

| 环境变量 | 默认 | 什么时候需要改 |
|---|---|---|
| `CMB_API_ENABLED` | 开启 | 想**关掉**网关时设 `0` |
| `CMB_API_HOST` | `0.0.0.0`(所有网卡) | 想**只让本机访问**时设 `127.0.0.1` |
| `CMB_API_PORT` | `8765` | 端口冲突时改 |
| `CMB_API_TOKEN` | 空(无鉴权) | 想**加鉴权**时设,设了之后每个请求要带 token |

```bash
# 例:加鉴权 + 换端口(需要时才这样)
CMB_API_TOKEN=your-secret CMB_API_PORT=9000 npm run start
```

> **安全提示**:默认无鉴权。若在 create 时设 `yolo:true`(工具全自动放行)又无鉴权对外网开放,等于任意人可驱动本机执行任意代码。对外暴露时请配 `CMB_API_TOKEN`,或仅在受信网络内使用。

---

## 3. 基础约定

- **Base URL**:`http://<host>:<port>`(默认 `http://<机器IP>:8765`)
- **请求体**:JSON,`Content-Type: application/json`
- **字符编码**:UTF-8(中文可直接放进 JSON 字符串)
- **鉴权**(仅当设了 `CMB_API_TOKEN`):以下任一 header
  - `Authorization: Bearer <token>`
  - `X-API-Token: <token>`
- **网络**:远端设备须与本机同一局域网,且能访问 `CMB_API_HOST:PORT`。macOS 防火墙若开启需放行该端口。

### 通用错误响应

| HTTP | body | 含义 |
|---|---|---|
| 401 | `{"error":"unauthorized"}` | 设了 token 但请求未带/带错 |
| 404 | `{"error":"thread_not_found"}` | 线程不存在 |
| 404 | `{"error":"not_found"}` | 路由不存在 |
| 400 | `{"error":"message_required"}` | 发消息时 message 为空 |
| 500 | `{"error":"internal_error"}` | 服务端异常 |

---

## 4. 端点总览

| Method | Path | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/healthz` | 健康检查 | 否 |
| POST | `/v1/threads` | 创建普通或特性会话，项目模式见 §13 | 是 |
| POST | `/v1/projects` | 新建项目 | 是 |
| PUT | `/v1/projects/:projectId` | 部分更新项目 | 是 |
| POST | `/v1/projects/:projectId/features` | 新建特性 | 是 |
| GET | `/v1/threads/:id` | 查询会话 | 是 |
| GET | `/v1/threads/:id/messages` | 查询历史消息 | 是 |
| POST | `/v1/threads/:id/messages` | 发送消息(SSE 流式回复) | 是 |
| POST | `/v1/threads/:id/cancel` | 取消正在运行的回合 | 是 |

---

## 5. 端点详解

### 5.1 GET /healthz

存活探针,无需鉴权。

**响应 200**
```json
{ "ok": true }
```

---

### 5.2 POST /v1/threads — 创建会话

**普通会话请求体**(原有字段可选,也可放进 `metadata` 对象)。`threadType` 省略或为 `normal` 时创建普通会话；`threadType: "feature"` 的参数限制与默认值见 §13。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `workspacePath` | string | 继承 app 最近工作区 | 会话的工作目录(绝对路径),agent 的文件/命令操作以此为根 |
| `model` | string | app 默认模型 | 模型引用,见 [§7 模型](#7-模型-id) |
| `agentMode` | string | `normal` | 执行模式:`normal`/`coordinator`/`workflow`,见 [§6](#6-执行模式) |
| `yolo` | boolean | `false` | `true`=自动放行所有工具;`false`=高危工具在 app 弹审批,见 [§8](#8-yolo--sandbox) |
| `sandbox` | boolean | Windows 上 `false` | 是否启用沙箱(**仅 Windows 有效**),见 [§8](#8-yolo--sandbox) |
| `title` | string | `Thread <日期>` | 会话标题 |
| `metadata` | object | — | 以上字段的另一种传法;顶层字段优先 |

**请求示例**
```bash
curl -X POST http://192.168.43.16:8765/v1/threads \
  -H "Content-Type: application/json" \
  -d '{
    "workspacePath": "/Users/me/project",
    "model": "custom:deepseek-v4-flash",
    "agentMode": "normal",
    "yolo": false,
    "title": "对接测试"
  }'
```

**响应 201**
```json
{
  "thread_id": "de9ae4bd-b1cf-4ccf-bda5-56b716929cbe",
  "created_at": "2026-07-17T06:00:00.000Z",
  "updated_at": "2026-07-17T06:00:00.000Z",
  "status": "idle",
  "title": "对接测试",
  "metadata": {
    "workspacePath": "/Users/me/project",
    "model": "custom:deepseek-v4-flash",
    "agentMode": "normal",
    "yolo": false,
    "title": "对接测试"
  }
}
```
> 保存返回的 `thread_id`,后续所有操作都用它。

---

### 5.3 GET /v1/threads/:id — 查询会话

**响应 200**:同创建返回的 Thread 对象(含 `metadata`、`status`)。
**响应 404**:`{"error":"thread_not_found"}`

```bash
curl http://192.168.43.16:8765/v1/threads/<thread_id>
```

---

### 5.4 GET /v1/threads/:id/messages — 查询历史消息

返回该会话**所有回合**的消息,**按 `created_at` 升序**(真实对话时间线)。

**响应 200**
```json
{
  "messages": [
    {
      "id": "87f7412c-...",
      "role": "user",
      "content": "新建文件 a.txt ...",
      "created_at": "2026-07-17T07:33:26.569Z"
    },
    {
      "id": "2026...adcef",
      "role": "assistant",
      "content": "",
      "tool_calls": [
        { "name": "write_file", "args": { "file_path": "...", "content": "..." },
          "id": "tool-1b93...", "type": "tool_call" }
      ],
      "created_at": "2026-07-17T07:33:40.832Z"
    },
    {
      "id": "run-...-tool-tool-1b93...",
      "role": "tool",
      "name": "write_file",
      "tool_call_id": "tool-1b93...",
      "content": "Successfully wrote to '.../a.txt'",
      "created_at": "2026-07-17T07:33:41.009Z"
    }
  ]
}
```

**消息字段**

| 字段 | 出现于 | 说明 |
|---|---|---|
| `id` | 全部 | 消息 id |
| `role` | 全部 | `user` / `assistant` / `tool` |
| `content` | 全部 | 文本内容(assistant 纯工具调用时可能为空串) |
| `tool_calls` | assistant | 该回合发起的工具调用:`{name, args, id, type:"tool_call"}` |
| `tool_call_id` / `name` | tool | 工具返回对应的调用 id 与工具名 |
| `created_at` | 全部 | 创建时间(排序依据) |

> **配对工具调用与返回**:用 `assistant.tool_calls[].id` ↔ `tool.tool_call_id`,靠 id 不靠顺序。

---

### 5.5 POST /v1/threads/:id/messages — 发送消息(SSE)

向会话发一条消息,以 **Server-Sent Events** 实时返回回复。

**Query 参数**

| 参数 | 默认 | 说明 |
|---|---|---|
| `format` | `openai` | `openai`=OpenAI 兼容 chat.completion.chunk 流(推荐);`raw`=内部原始流(调试用) |

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `message` | string | 是 | 用户消息文本 |
| `modelId` | string | 否 | **仅无头兜底时生效**(app 无窗口时);正常经 app 时模型由建会话的 `model` 决定,此字段忽略 |

**请求示例**
```bash
curl -sN -X POST "http://192.168.43.16:8765/v1/threads/<thread_id>/messages" \
  -H "Content-Type: application/json" \
  -d '{"message":"用一句话介绍你自己"}'
```
> `-N`(--no-buffer)必加,否则 curl 会缓冲、看不到流式效果。

**响应**:`Content-Type: text/event-stream`。格式详见 [§9 SSE 流格式](#9-sse-流格式)。

---

### 5.6 POST /v1/threads/:id/cancel — 取消

中断该会话**正在运行**的回合(同时会清掉 app 输入框的 loading)。

**响应 200**
```json
{ "aborted": true }
```
`aborted`:`true`=当时有回合在跑并已中断;`false`=当时没有正在运行的回合。

```bash
curl -X POST http://192.168.43.16:8765/v1/threads/<thread_id>/cancel
```

---

## 6. 执行模式

建会话时用 `agentMode` 指定,对应 app 输入框的模式切换:

| agentMode | app 名称 | 行为 |
|---|---|---|
| `normal` | Solo | 单 agent 直接执行(文本 + 工具),最常用 |
| `coordinator` | Agent Team | 协调者把任务拆给多个 worker 分头执行,再汇总。SSE/历史里会出现 worker 的工具调用与结果 |
| `workflow` | Ultra Workflow | agent 调用 workflow 工具,把编排**丢到后台**并行跑。见下方注意 |

**⚠️ workflow 模式的特殊行为**:workflow 是**后台编排**。发消息后 SSE 很快返回一条"workflow 已启动"的确认就 `[DONE]` 了;**真正的编排结果在后台跑完后,通过一条单独的"通知回合"追加到会话**。对接方获取最终结果的方式:
- 隔一段时间轮询 `GET /v1/threads/:id/messages` 查看后台追加的结果;
- 或保持关注该会话(app 内会有 `/workflows` 进度与通知)。

---

## 7. 模型 ID

`model` 字段接受模型引用,格式 `<来源>:<id>`:

- `custom:<id>` —— 用户自定义模型(最常用)
- `builtin:<id>` —— 系统内置模型
- `<id>` —— **裸 id 也可**(会优先按 custom 解析,再按任意来源)

**查看本机可用模型**:`~/.cmbcoworkagent/custom-models.json`(每项的 `id` 字段即模型 id,`name` 是显示名)。

> **命名坑**:显示名 ≠ id。例如本机配置里 id `deepseek-chat` 的**显示名恰好叫 "glm-4.7"**;真正的 deepseek 是 id `deepseek-v4-flash`(显示名 "deepseek-chat")。对接时以 **id** 为准,别被显示名误导。

不指定 `model` 时用 app 默认模型。

---

## 8. yolo / sandbox

两者都是**该会话专属**的运行开关,不影响全局设置和其他会话。

### yolo(工具审批)
| 值 | 行为 |
|---|---|
| `false`(默认) | 高危工具(改文件、跑命令等)在 **app 界面弹出审批**,由本机用户手动批准/拒绝。此时 SSE 会流到工具调用处**暂停**,用户在 app 批准后继续、拒绝则该工具失败 |
| `true` | **自动放行**所有工具,无需审批(适合全自动化场景,但风险高) |

### sandbox(沙箱,仅 Windows)
| 值 | 行为 |
|---|---|
| 不传 | Windows 上**默认关闭**沙箱(Windows 沙箱在部分环境不稳);mac/Linux 无此层,不受影响 |
| `true` | 保留(启用)Windows 沙箱 |
| `false` | 关闭 Windows 沙箱 |

> mac/Linux 上传 `sandbox` 字段无实际效果(仅 Windows 有 windows-sandbox 这一层)。

---

## 9. SSE 流格式

### 9.1 默认:OpenAI 兼容(`format=openai`)

每个事件是一行 `data: <json>`,`json` 是 OpenAI `chat.completion.chunk` 结构。以 `data: [DONE]` 结束。期间可能夹带 `: ping` 心跳注释行(标准 SSE,客户端应忽略 `:` 开头的行)。

**chunk 通用结构**
```json
{
  "id": "chatcmpl-<threadId前缀>",
  "object": "chat.completion.chunk",
  "created": 1784273606,
  "model": "deepseek-chat",
  "choices": [{ "index": 0, "delta": { /* 见下 */ }, "finish_reason": null }]
}
```

**delta 的几种形态**

| 类型 | delta 内容 | 含义 |
|---|---|---|
| 起始 | `{"role":"assistant"}` | 助手开始(整轮第一条) |
| 文本增量 | `{"content":"你好"}` | 助手回复的一小段文本(逐段拼接即完整回复) |
| 工具调用 | `{"tool_calls":[{"index":0,"id":"...","type":"function","function":{"name":"write_file","arguments":"{...}"}}]}` | agent 发起工具调用(`arguments` 可能分多个 chunk 逐段拼) |
| 工具返回 | `{"role":"tool","tool_call_id":"...","name":"write_file","content":"Successfully wrote ..."}` | 工具执行结果(服务端执行,故会回传结果) |
| 结束 | `{}` + `"finish_reason":"stop"` | 本回合结束,随后 `data: [DONE]` |

**完整示例(一次含工具的回合)**
```
data: {"id":"chatcmpl-de9ae4bd","object":"chat.completion.chunk","created":1784273606,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tool-1","type":"function","function":{"name":"write_file","arguments":"{\"file_path\":\"a.txt\",\"content\":\"hi\"}"}}]},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{"role":"tool","tool_call_id":"tool-1","name":"write_file","content":"Successfully wrote to '.../a.txt'"}},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{"content":"已创建文件 a.txt。"},"finish_reason":null}]}

data: {...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**如何拿到最终文本**:把所有 `delta.content` 按顺序拼接。

> 注:这是 OpenAI **兼容**格式,含了标准 OpenAI 流没有的"工具返回"(`role:"tool"` chunk),因为工具在服务端执行。若你的 OpenAI SDK 严格校验,遇到 `role:"tool"` 的 chunk 按"忽略或作为工具结果展示"处理即可。

### 9.2 原始流(`format=raw`)

追加 `?format=raw`,返回**内部原始事件流**(含 `type:"stream"` / `mode:"values"` 全量状态快照、`mode:"messages"` 逐 token、routing 等),体积大、字段多,仅用于**调试**。日常对接用默认 openai 即可。

---

## 10. 完整对接示例(bash)

```bash
BASE=http://192.168.43.16:8765
TOKEN=""   # 若设了 CMB_API_TOKEN 就填,并给每条请求加 -H "Authorization: Bearer $TOKEN"

# 1) 健康检查
curl -s $BASE/healthz

# 2) 建会话(normal 模式、deepseek、需审批)
TID=$(curl -s -H "Content-Type: application/json" \
  -d '{"workspacePath":"/Users/me/project","model":"custom:deepseek-v4-flash","agentMode":"normal","yolo":true}' \
  $BASE/v1/threads | sed -n 's/.*"thread_id":"\([^"]*\)".*/\1/p')
echo "thread=$TID"

# 3) 发消息,消费 SSE
curl -sN -H "Content-Type: application/json" \
  -d '{"message":"在工作区新建 hello.txt 写一行 hi"}' \
  $BASE/v1/threads/$TID/messages

# 4)(可选)中途取消
# curl -s -X POST $BASE/v1/threads/$TID/cancel

# 5) 事后查历史(时间序)
curl -s $BASE/v1/threads/$TID/messages
```

---

## 11. 注意事项 / 已知行为

1. **网关依赖 app 运行**:app 未启动则网关不存在;app 退出网关随之关闭。它是"给已启动的 app 开的 HTTP 入口",不是独立后台服务。
2. **一次一回合**:同一会话同一时刻只跑一个回合。会话有运行锁,重复发送会按现有并发逻辑处理。
3. **界面联动**:发消息时 app 会自动切到该会话并实时渲染(与手动输入完全一致);模型/YOLO 徽标也会反映该会话的设置。
4. **重启后**:消息与会话状态都持久化(重启不丢);但重启后 app 不会自动打开这个会话,需在列表里点开——数据仍在。
5. **超时**:单个 SSE 回合最长约 15 分钟(含等待审批的暂停);超时会自动关闭连接。
6. **客户端断开**:SSE 连接断开会自动取消该回合的运行。
7. **workflow 结果异步**:见 [§6](#6-执行模式),最终结果需轮询 `GET .../messages`。

---

## 12. 各端消费 SSE 提示

- **curl**:必加 `-N`。
- **Postman**:新版对 `text/event-stream` 有原生流式视图,发消息那条会实时逐条显示;老版会在结束后一次性给全。
- **浏览器/JS**:`EventSource` 只支持 GET,发消息是 POST,请用 `fetch` + `ReadableStream` 手动解析 `data:` 行(遇 `data: [DONE]` 结束,忽略 `:` 开头的心跳行)。
- **Node/Python**:按 SSE 规范逐行读,`data:` 后是 JSON;`[DONE]` 为终止标记。

---

如对接中遇到与本文不符的行为,请附上:请求 URL/body、返回内容、以及主进程日志里 `[ApiGateway]` / `[Agent]` 相关行。


## 13. 项目模式 HTTP 接口与设计决策

项目模式复用 UI/IPC 的项目服务、插件命令和会话持久化，不建立独立数据模型。时间格式沿用现有项目 metadata 和 Thread 序列化，不迁移历史数据。

| Method | Path | 成功结果 |
|---|---|---|
| POST | `/v1/projects` | 201，完整项目对象，包含 `projectId` |
| PUT | `/v1/projects/:projectId` | 200，更新后的完整项目对象 |
| POST | `/v1/projects/:projectId/features` | 201，`{projectId, featureId}` |
| POST | `/v1/threads` | 201，原有 Thread 对象，可附带 `warnings` |

### 13.1 新建和编辑项目

创建请求示例（所有路径均属于运行 App 的机器）：

```json
{
  "harness-adapter": { "name": "已安装的插件名称" },
  "name": "支付平台改造",
  "projectCode": "PAY202609",
  "projectFromLean": false,
  "projectDir": "payment-upgrade",
  "description": "支付平台功能升级",
  "systemId": "PAY",
  "systemName": "支付平台",
  "workspacePath": "/Users/me/projects",
  "sessionWorkspacePath": "/Users/me/repos/payment"
}
```

除 `sessionWorkspacePath` 外，上述字段必填。仅接受适配器 `name`，按去除首尾空格后的名称精确匹配已安装插件，校验 board 配置及兼容性，服务端生成完整 id/name/version/type 快照。未安装报错，同名多候选报错，不自动安装或选择版本。

编辑使用 `PUT /v1/projects/:projectId`，按部分更新处理，只需提交要修改的字段：

```json
{
  "name": "支付平台改造-已编辑",
  "description": "更新后的项目描述"
}
```

| 编辑字段 | 类型 | 不传时 |
|---|---|---|
| `name` | string | 保留原值 |
| `description` | string | 保留原值 |
| `projectCode` | string | 保留原值 |
| `projectFromLean` | boolean | 保留原值；显式 false 正常更新 |
| `systemId` | string | 保留原值 |
| `systemName` | string | 保留原值 |
| `sessionWorkspacePath` | string | 保留原值；显式空字符串表示清除 |
| `harness-adapter` | `{ "name": "插件名称" }` | 使用原适配器绑定；传入时按名称解析 |

所有编辑字段均可选，显式 null 不表示保留或清除，而是参数错误。空对象不修改业务字段，仍遵循现有更新服务更新时间和快照上报的行为。项目存放目录由服务端从原 metadata 读取，不属于编辑入参；传入不可编辑字段返回 400。编辑仅更新现有元数据，不移动目录或重新初始化项目。

### 13.2 新建特性

```json
{ "feature": "支付重试" }
```

可选 `selectedDeployUnits` 沿用 IPC 的发布单元映射结构及校验；未传时采用 UI 默认选择（当前为空）。不修改全局发布单元配置。调用方不传 `workflowTemplate`、`workflowNodes`、`workflowConfig`，服务端复用 UI 默认模板及必选节点规则。注入来源按 UI 的插件能力判定规则生成。

返回 `{ "projectId": "项目UUID", "featureId": "支付重试" }`。`featureId` 对应内部 slug，按 `(projectId, featureId)` 联合定位；不新增 UUID，不自动创建会话。

### 13.3 扩展已有会话接口

```json
{
  "threadType": "feature",
  "projectId": "项目UUID",
  "featureId": "支付重试",
  "workspacePath": "/Users/me/repos/payment",
  "title": "支付重试方案讨论"
}
```

- `threadType` 支持 `normal`、`feature`；省略按普通会话处理。
- feature 请求必须提供两个 ID，校验存在及归属，禁止出现整个 `metadata` 字段（包括空对象/null）。内部 harnessFeature 由服务端生成，与 UI 数据结构一致；threadType 不持久化。
- 保留 `title`、`model`、`agentMode`、`yolo`、`sandbox`；显式参数优先，feature 缺省采用 UI/插件规则，后续 HTTP 发消息沿用这些设置。
- 目录优先级：显式有效绝对目录 `workspacePath` → 项目 sessionWorkspacePath → UI 规则下该特性历史会话目录 → null。显式非法路径报错，不静默回退。
- 共用创建服务按现有条件执行 session_context_inject，应用插件初始模式和 requestUserInput 策略，完成招乎授权。运行消息时仍走现有上下文构建流程。
- 核心创建失败返回错误；会话已保存但注入降级或授权失败，返回 201 和 thread_id，附加字符串数组 warnings；warnings 不写入 metadata。
- 创建后刷新列表，不抢占页面；消息发送沿用既有 HTTP 导航。下一步仅复用预填机制，不自动发送。
- 后续继续使用 `/v1/threads/:id/messages`（SSE/历史）和 `/cancel`。

### 13.4 实施与验证

依次完成：共用默认规则及创建入口、HTTP 参数和错误映射、UI 变更通知、运行设置对齐。仅运行修改文件 lint、类型检查及已有相关测试，不运行生产构建，不新增或改写单元测试。验证业务字段、初始化副作用和持久化结构；ID、时间等生成值不要求逐字相同。

### 13.5 错误与部分成功

项目模式错误响应为 `{ "error": "错误码", "message": "具体说明" }`。

| HTTP | error | 含义 |
|---|---|---|
| 400 | invalid_json / invalid_request | JSON 或字段类型、必填项错误 |
| 400 | invalid_thread_type / metadata_not_allowed | 会话类型无效或特性请求传入 metadata |
| 400 | feature_requires_thread_type | 普通请求携带特性绑定，应使用 feature 类型 |
| 400 | invalid_workspace_path | 显式会话工作目录不是有效绝对目录 |
| 404 | project_not_found / feature_not_found | 目标项目或项目下特性不存在 |
| 404 | adapter_not_installed | 本机未安装指定名称的适配器 |
| 409 | adapter_name_ambiguous / resource_conflict | 同名适配器或项目/特性重复 |
| 422 | adapter_unavailable | 插件项目模式配置不可用或不兼容 |
| 500 | internal_error | 插件命令、存储等核心操作失败 |

部分成功示例（省略其余 Thread 字段）：

```json
{
  "thread_id": "会话UUID",
  "status": "idle",
  "warnings": ["会话已创建，但未能接入招乎"]
}
```

收到上述 201 时保留 thread_id，不要因 warning 重复创建会话。warnings 仅属于创建响应，不保存在项目或会话 metadata 中。

特性会话未指定 YOLO/沙箱时继承 UI 全局设置；普通会话保留原 HTTP 默认值。`sandbox: false` 禁用 Windows 沙箱，`sandbox: true` 保留本机已配置的沙箱模式，与原接口一致，不修改全局设置。
