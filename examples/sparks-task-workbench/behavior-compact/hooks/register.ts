export function register(on) {
  for (const point of ["prompt.suggest", "ui.toast"]) {
    const id = point === "ui.toast" ? "toast-compact" : "suggest-compact"
    on.capability(
      {
        apiVersion: "devclaw.capability/v1",
        id,
        version: "1.0.0",
        title: "精简提醒",
        scope: "conversation",
        stateSchema: { type: "object", additionalProperties: true },
        actions: [
          {
            id: "format",
            title: "精简并委托宿主",
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
          title: "精简提醒：" + point,
          point,
          phase: "replace",
          action: "format"
        }
      },
      {
        act: async ($, event, next) => {
          const input = event.input
          const words = input.text.replace(/\s+/g, " ").trim()
          return await next({
            ...input,
            text: words.length > 120 ? words.slice(0, 117) + "..." : words
          })
        }
      }
    )
  }
}
