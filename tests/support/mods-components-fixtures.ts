import AdmZip from "adm-zip"

/** Native opt-in packages. An excluded entry leaves a detectable evaluation marker. */
export function componentsPlugin(side: "a" | "b") {
  const zip = new AdmZip()
  const name = `components-${side}`
  const action = (id: string) => ({
    id,
    name: id,
    command: `component-${id}`,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" }
  })
  const component = (id: string, label: string, dependencies: string[], actions: string[]) => ({
    id,
    name: label,
    kind: "module",
    entry: `./${id}.ts`,
    dependsOn: dependencies,
    actionIds: actions
  })
  const schema = {
    type: "object",
    required: ["marker"],
    additionalProperties: false,
    properties: { marker: { type: "string", minLength: 1, title: "标记" } }
  }
  zip.addFile("plugin.json", Buffer.from(JSON.stringify({ name, version: "1.0.0" })))
  zip.addFile(
    "mods/manifest.json",
    Buffer.from(
      JSON.stringify({
        id: name,
        apiVersion: "cmb.mods/v2",
        options: { shared: `package-${side}` },
        claw: {
          componentsVersion: 1,
          // Deliberately not topological: the loader must initialize core before review.
          components:
            side === "a"
              ? [
                  {
                    ...component("review", "代码检视", ["core"], ["review"]),
                    configSchema: schema
                  },
                  component("core", "基础能力", [], []),
                  component("rewrite", "自动改写", [], ["rewrite"])
                ]
              : [{ ...component("report", "生成报告", [], ["report"]), configSchema: schema }],
          actions: side === "a" ? [action("review"), action("rewrite")] : [action("report")]
        }
      })
    )
  )
  if (side === "a") {
    zip.addFile(
      "mods/core.ts",
      Buffer.from(`export function register(on, options) {
        if(options.marker !== undefined) throw Error("COMPONENT_CONFIG_LEAKED_TO_CORE")
        if(options.shared !== "package-a") throw Error("PACKAGE_OPTIONS_LOST")
        on("session.start", {}, async ($, e, next) => {
          await $.store.set("init-order", ["core"])
          return next(e)
        })
      }`)
    )
    zip.addFile(
      "mods/rewrite.ts",
      Buffer.from(`globalThis.unselectedRewriteMarker = true
        export function register(on) {
          on("session.start", {}, async ($, e, next) => {
            await $.command.register({name:"component-rewrite",description:"Must stay absent",immediate:true})
            return next(e)
          })
        }`)
    )
  }
  const id = side === "a" ? "review" : "report"
  zip.addFile(
    `mods/${id}.ts`,
    Buffer.from(`export function register(on, options) {
      on("session.start", {}, async ($, e, next) => {
        if(${side === "a"}) {
          const order = await $.store.get("init-order")
          if(JSON.stringify(order) !== '["core"]') throw Error("DEPENDENCY_INITIALIZATION_ORDER")
          await $.store.set("init-order", [...order,"review"])
        }
        await $.command.register({name:"component-${id}",description:"Selected component action",immediate:true})
        return next(e)
      })
      on("turn.start", async ($, e, next) => {
        await $.store.set("chat-count", (await $.store.get("chat-count") || 0) + 1)
        return next(e)
      })
      on("command.run", {command:"component-${id}"}, async ($, e) => {
        if(e.args === "inspect") return {text:JSON.stringify({marker:options.marker,shared:options.shared,excludedEvaluated:globalThis.unselectedRewriteMarker === true,order:await $.store.get("init-order"),chats:await $.store.get("chat-count") || 0,count:await $.store.get("count") || 0})}
        if(!options.marker) throw Error("MISSING_COMPONENT_CONFIG")
        const envelope = JSON.parse(e.args)
        if(envelope.version !== 1 || !envelope.executionId) throw Error("INVALID_ACTION_ENVELOPE")
        await $.store.set("count", (await $.store.get("count") || 0) + 1)
        return {text:"Executed ${id}",output:{...envelope.input,${id}Marker:options.marker,${id}ExcludedEvaluated:globalThis.unselectedRewriteMarker === true,owner:${JSON.stringify(name)}}}
      })
    }`)
  )
  return [...zip.toBuffer()]
}
