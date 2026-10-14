import AdmZip from "adm-zip"

/** Real independently installed guests; no host callback stands in for action execution. */
export function flowFormsPlugin(producer: boolean) {
  const name = producer ? "forms-producer" : "forms-reviewer"
  const configSchema = {
    type: "object",
    required: ["strict", "retries", "note"],
    properties: {
      strict: { type: "boolean", title: "严格检查" },
      retries: { type: "integer", minimum: 0, title: "重试次数" },
      note: { type: "string", title: "备注" }
    }
  }
  const inputSchema = {
    type: "object",
    required: ["feature", "path"],
    properties: {
      feature: { type: "string", title: "Feature" },
      path: { type: "string", title: "文件路径", minLength: 1 }
    }
  }
  const actions = [
    {
      id: producer ? "prepare-review" : "review",
      name: producer ? "准备检视" : "接收检视",
      command: name,
      inputSchema,
      configSchema,
      outputSchema: { type: "object", properties: { payload: inputSchema } }
    },
    ...(!producer
      ? [{ id: "legacy", name: "旧配置动作", command: name, inputSchema: { type: "object" } }]
      : [])
  ]
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name, version: "1.0.0", claw: { actions } }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on) {
      on("session.start", async ($, e, next) => {
        await $.command.register({name:${JSON.stringify(name)},description:"Flow forms fixture",immediate:true})
        return next(e)
      })
      on("command.run", {command:${JSON.stringify(name)}}, async ($, e) => {
        if(e.args === "inspect-count") return {text:String(await $.store.get("count") || 0)}
        const envelope = JSON.parse(e.args)
        if(envelope.version !== 1 || !envelope.executionId) throw Error("INVALID_ENVELOPE")
        await $.store.set("count", (await $.store.get("count") || 0) + 1)
        return {text:"Executed real forms action",output:{...envelope.input,...(envelope.input.emitInvalid ? {feature:17} : {}),config:envelope.config,payload:envelope.input}}
      })
    }`)
  )
  return [...zip.toBuffer()]
}
