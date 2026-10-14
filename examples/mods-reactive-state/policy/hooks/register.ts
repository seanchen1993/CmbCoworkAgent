export function register(on) {
  on("state.set", { plugin: "state-owner", key: "count" }, (_, e, next) =>
    next({ ...e, value: e.value * 2 })
  )
}
