export function register(on) {
  async function append($, id, event) {
    const key = "compaction-probe:" + id
    const events = (await $.store.get(key)) || []
    if (events.length >= 32) throw Error("COMPACTION_PROBE_EVENT_LIMIT")
    await $.store.set(key, [...events, event])
  }
  on("session.start", async ($, e, next) => {
    for (const [name, description] of [
      ["compact-probe-mode", "Set compaction probe block or allow and clear observations"],
      ["compact-probe-run", "Compact the real idle main session"],
      ["compact-probe-status", "Read persisted compaction observations"]
    ])
      await $.command.register({ name, description, immediate: true })
    return next(e)
  })
  on("classic.PreCompact", async ($, e, next) => {
    await append($, e.session_id, {
      kind: "pre",
      trigger: e.trigger,
      instructions: e.custom_instructions
    })
    if ((await $.store.get("compaction-mode:" + e.session_id)) === "block")
      return { block: "COMPACTION_PROBE_BLOCK" }
    return next(e)
  })
  on("classic.PostCompact", async ($, e, next) => {
    const messages = await $.session.messages()
    await append($, e.session_id, {
      kind: "post",
      trigger: e.trigger,
      summary: e.compact_summary,
      summaryVisible: JSON.stringify(messages).includes("COMPACTION_SUMMARY_SENTINEL")
    })
    return next(e)
  })
  on("command.run", { command: "compact-probe-mode" }, async ($, e) => {
    const mode = e.args.trim()
    if (mode !== "block" && mode !== "allow") throw Error("COMPACTION_PROBE_MODE")
    const id = await $.session.id()
    await $.store.set("compaction-mode:" + id, mode)
    await $.store.set("compaction-probe:" + id, [])
    return { text: JSON.stringify({ mode }) }
  })
  on("command.run", { command: "compact-probe-status" }, async ($) => ({
    text: JSON.stringify({
      events: (await $.store.get("compaction-probe:" + (await $.session.id()))) || []
    })
  }))
  on("command.run", { command: "compact-probe-run" }, async ($) => {
    const id = await $.session.id()
    try {
      const result = await $.session.compact({
        instructions:
          "COMPACTION_PROBE: preserve requirements, exact paths and COMPACTION_SUMMARY_SENTINEL."
      })
      await append($, id, { kind: "returned", messages: result.messages.length })
      return { text: JSON.stringify({ ok: true, result }) }
    } catch (error) {
      await append($, id, { kind: "failed", message: String(error.message) })
      return { text: JSON.stringify({ ok: false, error: String(error.message) }) }
    }
  })
}
