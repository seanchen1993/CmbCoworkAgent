export function register(on) {
  let active
  let last
  let starts = 0
  let completions = 0
  let lastChild
  let childCompletions = 0
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({
      name: "claw-turn",
      description: "查看轮次状态，或停止当前轮次",
      argumentHint: "[abort]",
      immediate: true
    })
    return next(e)
  })
  on("turn.start", async ($, e, next) => {
    active = e.turnId
    starts++
    return next(e)
  })
  on("turn.complete", async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      lastChild = {
        agentId: e.agentId,
        turnId: e.turnId,
        reason: e.reason,
        refusal: e.refusal,
        answer: e.answer,
        durationMs: e.durationMs,
        usage: e.usage
      }
      childCompletions++
      return result
    }
    if (active === e.turnId) active = undefined
    last = {
      turnId: e.turnId,
      reason: e.reason,
      refusal: e.refusal,
      answer: e.answer,
      durationMs: e.durationMs,
      usage: e.usage
    }
    completions++
    const state =
      e.reason === "answer"
        ? "完成"
        : e.reason === "aborted"
          ? "已停止"
          : e.reason === "refusal"
            ? "模型拒绝"
            : "未完成"
    return { ...result, text: `本轮${state} · ${(e.durationMs / 1000).toFixed(1)} 秒` }
  })
  on("command.run", { command: "claw-turn" }, async ($, e) => {
    if (e.args.trim() !== "abort")
      return {
        text: JSON.stringify(
          {
            active: active ?? null,
            last: last ?? null,
            starts,
            completions,
            lastChild: lastChild ?? null,
            childCompletions
          },
          null,
          2
        )
      }
    if (!active) return { text: "当前没有运行中的轮次。" }
    await $.turn.abort({ turnId: active })
    return { text: "已请求停止当前轮次。" }
  })
}
