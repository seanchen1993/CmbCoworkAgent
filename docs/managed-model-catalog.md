# 内置模型后台配置

内置模型目录放在热更新清单 `cmbdevclaw-latest.json` 的顶层，与 `featureGates` 同级：

```json
{
  "version": "1.4.8",
  "featureGates": {},
  "modelCatalog": {
    "schemaVersion": 1,
    "revision": "2026-07-16-01",
    "models": [
      {
        "id": "minimax-m2p5-229b-w8a8",
        "name": "MiniMax M2.5",
        "baseUrl": "https://llm.example.test/v1",
        "model": "minimax-m2p5-229b-w8a8",
        "tier": "premium"
      },
      {
        "id": "deepseek-v4-flash-284b-a13b-w8a8",
        "name": "DeepSeek V4 Flash",
        "baseUrl": "https://llm.example.test/v1",
        "model": "deepseek-v4-flash-284b-a13b-w8a8",
        "tier": "economy"
      }
    ]
  }
}
```

每个模型只有 `baseUrl` 和 `model` 必填。`id` 省略时由 `model` 生成；`apiKey` 省略或为空时，依次读取进程环境变量 `CMB_BUILTIN_MODEL_API_KEY`、`~/.cmbcoworkagent/.env`。以上两种本机显式配置可供所有内置模型使用；如果仍未取得密钥，则仅 `minimax-m2p5-229b-w8a8` 使用客户端内置的加密兜底凭据：

```dotenv
CMB_BUILTIN_MODEL_API_KEY=<由凭据管理系统注入，不要提交到 Git>
```

源码和安装产物不包含默认密钥字面量，但内置密文及其本地解密逻辑仍可被有能力分析客户端的人还原，因此这只是防止明文泄漏，不是安全边界。DeepSeek 等其他内置模型未由后台、环境变量或本机配置提供密钥时会显示为不可用，不会获得该兜底凭据。进程环境变量和本机配置可随时覆盖内置值，用于密钥轮换。其余可选字段为：`name`、`maxTokens`、`maxOutputTokens`、`temperature`、`topP`、`topK`、`interleavedThinking`、`enableThinking`、`enableThinkingEffort`、`thinkingEffort`、`tier` 和 `enabled`。

建议后台清单不下发 `apiKey`，生产密钥通过凭据管理系统注入并定期轮换；只有配置通道具备完整访问控制时，才考虑在后台清单提供密钥。

生效优先级为：用户在本机对可编辑参数的覆盖值 > 后台字段 > 客户端模型预设 > 通用默认值。`baseUrl`、`model` 和 `apiKey` 始终由系统管理，渲染进程只能看到前两项，不能读取或修改密钥。

清单没有 `modelCatalog`、目录为空或首次拉取失败时，客户端只使用内置的 MiniMax 作为本地兜底模型，不会额外注入 DeepSeek。成功加载过后台目录后，后续刷新失败会继续保留上一次内存中的有效目录。客户端启动时拉取一次，并等待首次请求完成后才启动调度器、心跳和 ChatX，之后每 30 分钟刷新。

模型列表将用户保存的默认模型放在首位；固定模型被后台撤下或失去密钥时，ChatX 会回退到保存的默认可用模型。

## 闲时模型（生产 / UAT）

在仓库 `.env` 中配置以下变量，沿用 `envcrypt` Git 过滤器加密保存的流程（见 [环境变量加密说明](env-encryption-guide.md)）：

```dotenv
MAIN_VITE_IDLE_MODEL_PROD_BASE_URL=<生产转发网关的完整 Base URL，不含 /chat/completions>
MAIN_VITE_IDLE_MODEL_PROD_API_KEY=<独立团队提供的生产网关凭据>
MAIN_VITE_IDLE_MODEL_UAT_BASE_URL=<UAT 网关地址，路径截至 /pattern/llm/v1>
MAIN_VITE_IDLE_MODEL_UAT_API_KEY=<独立团队提供的 UAT 网关凭据>
```

这四个变量只注入主进程，不下发到渲染进程。原有 `MAIN_VITE_IDLE_MODEL_BASE_URL` / `MAIN_VITE_IDLE_MODEL_API_KEY` 已迁移至对应的 UAT 变量。配置所选环境的地址后，客户端会独立加入 `builtin:idle-ultra`，不受远端目录替换影响，也不复用其他内置模型的密钥。

生产环境经网关转发时，Base URL 需包含网关要求的完整路由前缀；客户端在其后追加 `/chat/completions`。修改仓库 `.env` 后需重新构建应用。

当前闲时模型生产 Base URL 为 `http://pmsgateway.paasoa.cmbchina.cn/devagent/pattern/llm/v1`，最终请求路径为 `/devagent/pattern/llm/v1/chat/completions`。

默认使用生产环境。在应用数据目录的 `settings.json`（默认 `~/.cmbcoworkagent/settings.json`；使用 `CMB_COWORK_AGENT_HOME` 时位于该目录）中合并以下配置，可切换到 UAT：

```json
{
  "idleModelUseUat": true
}
```

修改后重启应用生效。设为 `false` 或删除该字段即使用生产环境；只有布尔值 `true` 启用 UAT。地址和密钥成对切换，任一环境配置缺失时不会借用另一环境的地址或密钥。该开关仅影响闲时模型，固定的模型引用、用户参数覆盖和历史会话保持沿用。

- 默认显示为“闲时模型 Ultra”，请求模式固定 `ultra`，上下文窗口固定 128,000 Tokens；连接信息、模式和上下文窗口不可由用户修改。最大输出 Tokens 等其他参数沿用现有设置。
- 生产环境按北京时间 `22:00`（含）至次日 `07:00`（不含）开放。主进程在每次出站请求和每次 HTTP 重试前检查服务时段，覆盖主对话、子代理、上下文压缩、后台辅助调用及连接测试；使用 UTC+8 计算，不受本机时区设置影响。UAT 测试环境全天可用，不受此时段限制，界面提示当前使用测试环境；仍需配置密钥及八位 SAP 工号。时段策略随地址、密钥绑定在模型连接配置中，避免切换设置影响已创建连接的限制。
- 生产环境到 `07:00` 后，已发出的请求和 SSE 回复允许正常完成；新请求、重试、后续工具轮次和压缩请求均被本地拦截。时段外返回带 `idle_model_outside_service_hours` 的本地 HTTP 400 错误，不进行自动重试、压缩恢复或故障换模。手动固定的闲时模型不会静默改成其他模型；自动路由和备用模型链排除时段外的生产闲时模型。
- 生产闲时模型在时段外显示“非服务时段”，但配置完整时仍可提前选择并保存到会话，便于开放后从招乎触发执行；缺少密钥或八位 SAP 工号时仍禁止选择。选择不代表立即调用，发送消息和连接测试继续按服务时段拦截，自动路由和备用模型链仍排除时段外的生产闲时模型。保留默认配置及历史会话，开放/关闭边界和电脑唤醒时刷新可用性，配置弹窗更新可用状态时保留未保存的参数。判断依据为本机当前时间；需要防止系统时间被修改时，还应由网关按服务器时间校验。
- 每次请求从当前登录用户信息读取八位 `sapId`，作为 `x-spaid`；缺少或格式不正确时禁止调用，并提示完善用户信息。
- 网关凭据使用 `x-gateway-key`，会话使用 `x-session-id`，每次调用携带 `x-request-id`。客户端将 `x-session-id` 控制在 36 位以内，为网关的 40 位上限预留余量：不超过 36 位的 Thread ID 保持原值，超长 ID 对完整内容计算 SHA-256 并取前 36 位十六进制摘要。主对话与上下文压缩使用相同的会话标识；独立子会话使用自身 Thread ID 映射，无 Thread 的辅助调用使用模型实例生命周期内稳定的独立 UUID。映射仅用于闲时模型请求头，内部 Thread ID 保持原值。
- 复用 OpenAI 聊天、SSE 与工具调用协议。界面始终显示配置名称，响应中的实际模型名仅用于诊断。
- 沿用现有重试等待策略，不读取 `retry_after_ms` 或 `Retry-After`；`434` 显示“码豆余额不足”，不进行自动重试或模型故障切换。保留其他网关错误的 `errorMsg` 和请求追踪 ID。
- `485/580` 的错误文案包含“任务上下文超过最大限度”时，优先进入现有上下文压缩恢复；`580` 不再先原样重复请求。恢复复用摘要生成、完整轮次裁剪及最近消息保留逻辑，摘要模型调用共享最多 4 次的预算，仍无法恢复时返回错误。不包含该文案的内部异常继续沿用原有错误处理。
- 此网关提供 OpenAI 接口，暂不用于要求 Anthropic 接口的 Claude Code 终端。
