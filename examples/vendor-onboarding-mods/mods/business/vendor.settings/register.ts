/** Ordinary extension: native user configuration is resolved by the existing Mods host. */
export function register(on, options) {
  let registered
  on("session.start", async ($, event, next) => {
    registered = await $.tool.register({
      name: "settings",
      description: "读取本插件原生配置的供应商准入策略，不提供业务审批结论",
      isDeferred: false,
      inputSchema: { type: "object", additionalProperties: false, properties: {} }
    })
    return next(event)
  })
  on("tool.call", async ($, event, next) => {
    if (event.tool !== registered.tool) return next(event)
    return { result: { policyTier: options.policyTier, source: "native-user-config" } }
  })
}
