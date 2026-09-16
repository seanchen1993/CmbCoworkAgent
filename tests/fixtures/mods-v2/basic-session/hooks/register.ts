export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "sdk-probe", description: "SDK probe" })
    return next(e)
  })
  on("command.register", async ($, e, next) => next({ ...e, description: e.description + "!" }))
  on("session.id", async ($) => ({ value: "nested:" + (await $.session.id()) }))
  on("session.id", {}, async ($, e, next) => ({ value: "other:" + (await next(e)).value }))
  on("clock.now", () => ({ value: 123 }))
  on("clock.sleep", { ms: 17 }, () => ({ value: undefined }))
  on("clock.sleep", { ms: 18 }, ($, e, next) => next({ ...e, ms: 0 }))
  on("command.run", { command: "sdk-probe" }, async ($) => {
    const registered = await $.command.register({ name: "sdk-child", description: "Child" })
    const child = (await $.command.list()).find((c) => c.name === "sdk-child")
    return {
      text: JSON.stringify({
        registered,
        description: child.description,
        id: await $.session.id(),
        now: await $.clock.now(),
        short: typeof (await $.clock.sleep(17)),
        next: typeof (await $.clock.sleep(18))
      })
    }
  })
}
