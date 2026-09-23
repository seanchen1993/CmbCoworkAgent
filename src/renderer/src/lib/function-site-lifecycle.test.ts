import { expect, it } from "vitest"
import { FunctionSiteLifetime } from "./function-site-lifecycle"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each([
  "configuration reset",
  "runtime cards-changed",
  "unmount",
  "virtualized message recycled"
])("refuses late render, placeholder and focus publication after %s", async (reason) => {
  const lifetime = new FunctionSiteLifetime()
  const ticket = lifetime.capture()
  const render = deferred<string>()
  const action = deferred<boolean>()
  const ui = { tree: "default", placeholder: "original", focused: false }
  const rendered = render.promise.then((tree) =>
    ticket.commit(() => {
      ui.tree = tree
      ui.placeholder = "old plugin hint"
    })
  )
  const acted = action.promise.then((focused) =>
    ticket.commit(() => {
      ui.focused = focused
    })
  )
  if (reason === "unmount" || reason === "virtualized message recycled") lifetime.close()
  else lifetime.invalidate()
  render.resolve("old plugin tree")
  action.resolve(true)
  expect(await rendered).toBe(false)
  expect(await acted).toBe(false)
  expect(ui).toEqual({ tree: "default", placeholder: "original", focused: false })
  const next = lifetime.capture()
  expect(
    next.commit(() => {
      ui.tree = "current plugin tree"
    })
  ).toBe(reason !== "unmount" && reason !== "virtualized message recycled")
})
