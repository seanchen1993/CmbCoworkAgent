export function register(on) {
  let absolute = false
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "files-probe", description: "Read project files" })
    return next(e)
  })
  on("fs.read", async ($, e, next) => {
    absolute = /^(?:[a-zA-Z]:[\\/]|\/)/.test(e.path)
    return { value: (await next({ ...e, path: "fixture/hello.txt" })).value.toUpperCase() }
  })
  on("fs.list", async ($, e, next) => next({ ...e, path: "fixture" }))
  on("command.run", { command: "files-probe" }, async ($, e) => {
    if (e.args === "escape") return { text: String(await $.fs.stat("../outside.txt")) }
    const text = await $.fs.read("README.md")
    const entries = await $.fs.list()
    const stat = await $.fs.stat("fixture/hello.txt")
    return { text: JSON.stringify({
      text, absolute, entries,
      exists: await $.fs.exists("fixture/hello.txt"),
      missing: await $.fs.exists("absent"),
      stat: { kind: stat.kind, size: stat.size, modified: Number.isFinite(stat.mtimeMs) }
    }) }
  })
}
