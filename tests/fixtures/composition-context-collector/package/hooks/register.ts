export function register(on) {
  on("turn.complete", (_$, event, next) => next(event))
}
