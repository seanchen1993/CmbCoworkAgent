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
