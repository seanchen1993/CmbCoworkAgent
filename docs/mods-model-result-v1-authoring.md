# 在插件中启用新版模型结果

未声明模型协议的插件使用 Claude 官方结构化结果协议 `result-v1`。依赖本工程旧字符串/旧 fork 对象的插件必须显式声明 `legacy-v1`；不会自动改写安装包。默认协议改变会改变未声明包的编译摘要，已有授权不能沿用，需要重新核对批准并更新 Claw 中固定的摘要。

结构化结果无需专用清单字段，也可以显式声明：

```json
{
  "cmbCompatibility": {
    "modelProtocol": "result-v1"
  }
}
```

原生 Mods 放在 `mods/manifest.json`，Claude 格式插件放在插件清单中；两个位置不能重复声明。这是本工程的兼容选项，不是 Claude 官方清单字段。改变该选项会改变源码摘要，需要重新批准并更新引用旧摘要的 Claw 配置。

```ts
const reply = await $.model.complete({
  model: "default",
  prompt: "检查这段代码的主要风险",
  maxTokens: 512,
  timeoutMs: 8000
})
if (reply.isAnswered) {
  await $.ui.log(reply.text)
} else {
  await $.ui.log(`模型未给出答案：${reply.reason}`)
}
```

`model` 使用本工程已配置的模型引用或 `default`。成功结果包含 `text` 和四项 `usage`；失败原因包括 `api-error`、`empty-reply`、独立请求超时的 `aborted`。API 错误只返回安全分类和状态码，不返回服务端错误正文。

`$.model.fork({prompt})` 使用当前宿主保存的对话快照；还没有快照时返回 `nothing-to-fork`，不会发模型请求。它仍使用本工程经过清理的文本快照，不等同于 Claude 的完整内部会话与缓存实现。

使用同一模型调用的观察器也要选择相同协议。旧协议观察器与新协议调用冲突时，系统在执行观察器和模型请求之前拒绝调用，并指出冲突插件。不能通过跳过观察器规避这个检查。不同模式的插件只要不互相拦截模型操作，仍可一起使用。

模型操作的 `next` 返回操作封装，新协议示例如下：

```ts
on("model.complete", async ($, input, next) => {
  const result = await next(input)
  if ("value" in result && result.value.isAnswered) {
    await $.ui.log(`输出 tokens：${result.value.usage.output_tokens}`)
  }
  return result
})
```

`plugin check/inspect` 的报告显示可信 `modelProtocol`，`plugin types` 根据清单导出对应类型。不要根据代码里是否读取 `isAnswered` 来猜测运行模式。

目前仍保留这些边界：

- 默认最多输出 256 tokens，显式上限 4096，还受模型配置和实际预算约束；单次宿主调用最多 60 秒。
- 新协议支持 `timeoutMs`；`effort` 明确报不支持，2.1.284 新增的第二参数 `options.signal` 尚不支持。
- 父任务取消、撤权、授权/预算失败及内容保护拒绝仍抛错，不作为普通模型失败返回。禁止在失去权限后发布迟到结果。
- `usage` 未报告的字段在兼容结果里显示零；实际预算与审计保留未知状态，不能把展示零当成免费调用或真实零成本。

因此这是新版模型结果协议的有界适配，并非 Claude 2.1.284 全量模型 API 兼容。
