// Business policy lives in this ordinary Function Mod. No new platform SDK is required.
export function register(on, options) {
  const name = "mods-release-review"
  const capability = { provider: name, id: "release-review", version: "1.0.0" }
  const query = { ref: capability, target: { kind: "current" } }
  const graph = {
    draft: { submit: { to: "review", check: "metadata" } },
    review: { approve: { to: "approved", check: "approval" } },
    approved: {}
  }
  const object = { type: "object", additionalProperties: true }
  let requestSequence = 0
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "release-review",
      description: "发布审核：status 查看实际状态，submit 校验发布说明，approve 校验审核结论",
      immediate: true
    })
    return next(event)
  })
  on("command.run", { command: "release-review" }, async ($, event) => {
    const operation = event.args.trim() || "status"
    if (!["status", "submit", "approve"].includes(operation))
      return { text: "用法：/release-review status | submit | approve" }
    const current = await $.platform.read(query)
    if (operation === "status") return { text: JSON.stringify(current) }
    const result = await $.platform.act({
      ...query,
      action: "transition",
      input: { event: operation, expectedRevision: current.revision },
      requestKey: "release:" + (await $.clock.now()) + ":" + ++requestSequence
    })
    return { text: JSON.stringify(result) }
  })
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: capability.id,
      version: capability.version,
      title: "发布审核状态机",
      scope: "workspace",
      stateSchema: object,
      presentation: { kind: "release-review", initialState: "draft", graph },
      actions: [
        {
          id: "inspect",
          title: "查看实际状态",
          inputSchema: object,
          outputSchema: object,
          requiredPermissions: ["platform.read"],
          cancellable: true,
          idempotency: "keyed"
        },
        {
          id: "transition",
          title: "校验并推进发布审核",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              event: { type: "string", enum: ["submit", "approve"] },
              expectedRevision: { type: "integer", minimum: 0 }
            },
            required: ["event", "expectedRevision"]
          },
          outputSchema: object,
          requiredPermissions: [
            "platform.read",
            "platform.publish",
            "state.get",
            "state.set",
            "process.run",
            "tool.call"
          ],
          cancellable: true,
          idempotency: "keyed"
        }
      ]
    },
    {
      async act($, event) {
        const previous = await $.platform.read(query)
        if (previous.status !== "ready" && previous.revision !== 0)
          throw Error("RELEASE_REVIEW_SOURCE_REQUIRES_RECONCILIATION")
        const stage = previous.value?.stage ?? "draft"
        if (event.action === "inspect") return { stage, revision: previous.revision }
        if (event.input.expectedRevision !== previous.revision)
          return { status: "conflict", stage, revision: previous.revision }
        const edge = graph[stage]?.[event.input.event]
        if (!edge) return { status: "blocked", stage, reason: "该状态不允许此操作" }

        // This is only a session concurrency lock. Persisted capability state owns the business value.
        const ref = { plugin: name, key: "transition-lock" }
        const held = await $.state.get(ref)
        if (held.value?.busy) return { status: "busy", stage }
        const acquired = await $.state.set(ref, { busy: true }, { ifVersion: held.version })
        if (!acquired.isSet) return { status: "busy", stage }
        const releaseLock = async () => {
          const released = await $.state.set(ref, { busy: false }, { ifVersion: acquired.version })
          if (!released.isSet) throw Error("RELEASE_REVIEW_LOCK_CHANGED")
        }
        try {
          // Neither caller-provided passed:true nor model text can satisfy the validator.
          const preview = await $.tool.call({ tool: "read_file", file_path: "release-review.json" })
          if (preview.isError || typeof preview.result !== "string")
            throw Error("RELEASE_REVIEW_ARTIFACT_UNREADABLE")
          const checked = await $.process.run([
            options.nodeExecutable ?? "node",
            $.plugin.root + "/scripts/validate.mjs",
            edge.check
          ])
          if (checked.exitCode !== 0)
            return { status: "blocked", stage, reason: checked.stderr || "产物校验未通过" }
          const evidence = JSON.parse(checked.stdout)
          if (
            evidence.passed !== true ||
            evidence.check !== edge.check ||
            typeof evidence.artifactDigest !== "string"
          )
            throw Error("RELEASE_REVIEW_INVALID_EVIDENCE")
          const saved = await $.platform.publish({
            id: capability.id,
            version: capability.version,
            target: { kind: "current" },
            expectedRevision: previous.revision,
            value: { stage: edge.to, evidence, requestKey: event.requestKey }
          })
          return { status: "advanced", stage: edge.to, revision: saved.revision }
        } finally {
          await releaseLock()
        }
      }
    }
  )
}
