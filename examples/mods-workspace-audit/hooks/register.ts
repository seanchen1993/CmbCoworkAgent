const checks = {
  status: ["git", "status", "--short"],
  whitespace: ["git", "diff", "--check"],
  summary: ["git", "diff", "--stat"]
}

let active

export function register(on) {
  on("session.start", async ($, event, next) => {
    await $.command.register({
      name: "claw-audit",
      description: "Run the selected repository checks in your order",
      argumentHint: "status,whitespace,summary",
      immediate: true
    })
    await $.command.register({
      name: "claw-audit-stop",
      description: "Stop this plugin's running checks",
      immediate: true
    })
    return next(event)
  })

  on("command.run", { command: "claw-audit-stop" }, async () => {
    const current = active
    if (!current) return { text: "No audit is running." }
    current.cancelled = true
    current.timer?.cancel()
    await current.stream?.return()
    return { text: "The audit has been stopped." }
  })

  on("command.run", { command: "claw-audit" }, async ($, event) => {
    if (active) return { text: "An audit is running. Use /claw-audit-stop first." }
    const selected = (event.args.trim() || "status,whitespace,summary")
      .split(",")
      .map((name) => name.trim())
    if (selected.some((name) => !Object.hasOwn(checks, name)))
      return { text: "Choose status, whitespace and/or summary, separated by commas." }
    const root = await $.session.root()
    const current = { cancelled: false, timer: undefined, stream: undefined }
    active = current
    const results = []
    let seconds = 0
    try {
      current.timer = $.clock.every(1000, () => $.ui.status(`Audit running: ${++seconds}s`))
      for (const name of selected) {
        if (current.cancelled) break
        $.ui.log(`Starting ${name} in ${root}`)
        const stream = $.process.spawn({ argv: checks[name], cwd: root })
        current.stream = stream
        for await (const chunk of stream) {
          if (chunk.text) $.ui.log(`[${name}/${chunk.stream}] ${chunk.text}`)
        }
        const result = await stream.result
        results.push({ step: name, code: result.code })
        $.ui.log(`${name}: exit ${result.code}`)
        // The user's step order is an actual execution order; a failing gate stops later steps.
        if (result.code !== 0) break
      }
      return { text: JSON.stringify({ selected, results, cancelled: current.cancelled }, null, 2) }
    } catch (error) {
      return {
        text: JSON.stringify(
          { selected, results, cancelled: current.cancelled, error: error.code || "AUDIT_FAILED" },
          null,
          2
        )
      }
    } finally {
      current.timer?.cancel()
      active = undefined
      $.ui.status()
    }
  })
}
