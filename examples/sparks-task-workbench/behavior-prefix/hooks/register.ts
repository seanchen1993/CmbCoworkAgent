export function register(on, options) {
  for (const point of ["prompt.suggest", "ui.toast"]) {
    const id = point === "ui.toast" ? "toast-prefix" : "suggest-prefix"
    on.capability(
      {
        apiVersion: "devclaw.capability/v1",
        id,
        version: "1.0.0",
        title: "添加清楚的提醒前缀",
        scope: "conversation",
        stateSchema: { type: "object", additionalProperties: true },
        actions: [
          {
            id: "format",
            title: "委托宿主显示",
            inputSchema: { type: "object", additionalProperties: true },
            outputSchema: { type: "object", additionalProperties: true },
            requiredPermissions: [],
            cancellable: true,
            idempotency: "keyed"
          }
        ],
        presentation: {
          type: "behavior",
          apiVersion: "devclaw.behavior/v1",
          id,
          title: "前缀提醒：" + point,
          point,
          phase: "replace",
          action: "format"
        }
      },
      {
        act: async ($, event, next) => {
          const input = event.input
          const prefix = String(options.prefix || "提醒：")
          // Attribution, approval and publication remain in the native delegate. Call exactly once.
          return await next({
            ...input,
            text: input.text.startsWith(prefix) ? input.text : prefix + input.text
          })
        }
      }
    )
  }
}
