# 编写可组合的 Claw 插件动作

本文对应 2026-09-29 开发版。动作是插件显式导出的能力，仍使用现有 Function Mods
隔离运行时与授权链；不是任意 JavaScript 函数反射，也不是把所有 Hook 自动变成流程节点。
`claw.actions` 是本工程的组合协议扩展，不是声称 Claude 官方已经定义了同名清单或可视化流程协议。

## 1. 在清单中声明

完整插件的 `plugin.json`（也支持 `.claude-plugin/plugin.json`）可加入：

```json
{
  "name": "example-review",
  "version": "1.0.0",
  "claw": {
    "actions": [{
      "id": "summarize",
      "name": "整理上一步信息",
      "command": "example-summarize",
      "inputSchema": {
        "type": "object",
        "required": ["path"],
        "properties": { "path": { "type": "string", "maxLength": 240 } }
      },
      "outputSchema": {
        "type": "object",
        "required": ["path", "note"],
        "properties": { "path": { "type": "string" }, "note": { "type": "string" } }
      }
    }]
  }
}
```

原生 `mods/manifest.json` 也可提供 `claw`，但不能与包装清单同时声明。
一个插件最多 32 个导出，action ID 必须唯一。输入和输出的根均是 JSON 对象。
Schema 复用宿主受限 JSON Schema：类型、properties、required、长度/范围、组合等受支持；
外部 `$ref`、正则和未知关键字会拒绝。不要依赖 schema 自动填默认值或强制转换类型。
包装清单最大 32 KiB；整个 `claw` 声明也受 28000 字节限制。

### 可选配置 schema 与参数表单

动作现在可以增加 `configSchema`，约束 envelope 中的 `config`，例如：

```json
{
  "configSchema": {
    "type": "object",
    "properties": {
      "strict": { "type": "boolean", "title": "严格检查", "description": "开启后检查更多边界。" }
    }
  }
}
```

把该字段放在具体 action 内，与 inputSchema/outputSchema 同级。宿主在 Flow 准备阶段及动作调用前
验证 config（缺省为 `{}`）；即使 input 来自前一步，config 也必须通过。省略 configSchema 的旧包
保留原行为，作者仍负责自行校验配置。添加、修改、删除 schema 都会改变清单摘要，需要重新批准。

常见对象属性可在编辑器显示为表单；`title` 是用户看到的名称，`description` 是填写说明。
字符串、数字/整数、布尔和同类型基础枚举可直接编辑；复杂约束和嵌套值保留高级 JSON。
UI 不自动填 schema.default、不转换旧值类型、不删未知字段，最终校验仍在宿主。
输入绑定前一步时可不填写将由前步提供的必填项；填写的固定值会覆盖同名字段。
参考 Review 1.2.0 的实际 configSchema 和 Autobiz 的输入字段说明。

`hooks/hooks.json` 注册模块：

```json
{ "modules": ["./actions.ts"] }
```

## 2. 注册真实 command 并等待完成

`hooks/actions.ts`：

```ts
export function register(on) {
  on("session.start", {}, async ($, event, next) => {
    await $.command.register({
      name: "example-summarize",
      description: "整理前一步信息",
      isHidden: true
    })
    return next(event)
  })
  on("command.run", { command: "example-summarize" }, async ($, event) => {
    const request = JSON.parse(event.args)
    if (request.version !== 1) throw Error("Unsupported action envelope")
    return {
      text: `已整理 ${request.input.path}`,
      output: { path: request.input.path, note: "准备完毕" }
    }
  })
}
```

多模块中使用 `on("session.start", {}, handler)`，避免多个无 matcher 的同名注册冲突。
动作只能绑定**该插件自己注册的 command**，指向其他插件或不存在的 command 会失败。

宿主传入的 `event.args` 是 JSON 字符串：

```ts
{
  version: 1,
  input: {},         // 经 schema 验证的实际输入
  config: {},        // 用户配置；插件自行检查业务含义
  task: "本次目标",
  runId: "宿主运行 ID",
  stepId: "步骤 ID",
  executionId: "本次执行 ID"
}
```

返回值仅支持 `{text?: string, output?: object}`，text 最多 8000 字符。
输入 envelope 与返回对象分别最多 28000 UTF-8 字节，JSON 深度最多 32 层。
若声明 outputSchema，必须返回 output。不要返回 Promise 之外的后台“已启动”作为完成结果；
业务需要等待检视/模型结束时，必须 await 真正的操作。
当前动作协议以正常返回代表本动作完成；失败抛错，取消、越权、基础设施错误都会停止，
不允许用未约定的 `passed:false` 字段把失败藏进成功。

动作提供者的异常不会像普通可选 Hook 那样跳过。其他插件提前截断链路、使该提供者未真正执行，
也不能生成成功记录。不要依赖普通命令的错误恢复行为来实现动作协议。

## 3. 跨插件传递结果

第二个 `plugin-action` 节点可以选择前面的已启用插件动作作为 `inputFrom.stepId`。
`path` 是 JSON Pointer：空字符串代表完整 output；`/context` 取对象属性，`/files/0` 可取数组元素。
最终选中的值必须是对象，不执行表达式，不允许 `__proto__` 等危险属性。
宿主将其与当前节点的 `input` 常量合并，**显式常量同名字段优先**。

只有已完成且有效的通过结果可引用；未来节点、未执行、失败、被重试失效的结果均不可使用。
运行记录中 `attempt.result.output` 保存保护后的输出，`provider` 保存宿主核实的真实提供者身份。
文件内容、模型结果仍经过内容保护，输出被过滤后也必须满足声明的 schema。

## 4. 模型与权限

Flow 的 `agent.modelRole` 引用 Claw 中的角色模型绑定，仅适用于 Agent 步骤。
`plugin-action.config` 是插件自己的业务参数；例如交付的 Review 插件约定 `config.model`
传给 `$.model.complete`，这不是所有动作自动支持的保留字段。
若 Claw 配置了模型策略，显式模型须位于其允许集合；示例中应同时将 Review 模型加入 Claw 角色绑定。
`default` 使用 Claw 默认模型，否则使用宿主默认。

模型引用不包含密钥。宿主负责解析凭据、预算、取消、模型允许范围和配置变化检查。
`modelId`/示例 output.model 是请求或绑定模型；发生 Mod 模型路由时最终提供商以宿主请求记录为准。
流程会冻结所用模型配置指纹及隐式默认指针；配置改变后需要重新运行。

声明与源码一起进入授权摘要。升级导出、输入输出 schema 或实现都需要核对新摘要并重新授权。
每个节点只能调用当前 Claw 已选择且已授权的提供者；能力库里能看见一个动作不代表它已获得执行权限。
快照不抵消撤权，旧页面、旧 command 描述或旧授权不能继续调用。

选择一个动作不会卸载同插件中的其他 Hooks：插件仍整体加载，事件 Hooks 依原规则触发。
要获得互不干扰的可选组件，作者应拆成独立插件或显式配置其事件行为。

## 5. 可安装参考

- `examples/autobiz-kanban-mods` 是上游业务插件的覆盖模板，须用
  `scripts/package-autobiz-mods.mjs` 打包。`prepare-review` 读取真实阶段和指定文件，仅准备输入。
- `examples/mods-review-agent` 是完整独立插件，可目录安装或压 ZIP；`review-input` 真正等待模型检视。

建议组合 `Autobiz prepare-review → 独立 Review review-input → 内置测试 → 人工确认`。
示例不是完整业务验收器，不自动推进 Autobiz 阶段；模型意见和实际测试结果分开查看。
