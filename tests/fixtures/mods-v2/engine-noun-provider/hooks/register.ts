export function register(on) {
  let calls = 0
  on("engine.create", async ($, e, next) => {
    const built = await next(e)
    return {
      ...built,
      company: {
        identify: async (input) => ({
          label: input.label,
          thread: await built.session.id(),
          calls: ++calls
        })
      }
    }
  })
}
