import assert from "node:assert/strict"
import { applyThreadStateRegistryChanges } from "../src/renderer/src/lib/thread-state-registry"

function main(): void {
  const targetId = "thread-777"
  const backing = Object.fromEntries(
    Array.from({ length: 1_000 }, (_, index) => [`thread-${index}`, { value: index }])
  )
  let targetReads = 0
  const registry = new Proxy(backing, {
    ownKeys(): never {
      throw new Error("single-thread updates must not enumerate the registry")
    },
    get(target, property, receiver) {
      if (typeof property === "string" && property.startsWith("thread-")) {
        if (property !== targetId) throw new Error(`unexpected registry read: ${property}`)
        targetReads += 1
      }
      return Reflect.get(target, property, receiver)
    }
  })
  const previousState = backing[targetId]
  const nextState = { value: 2_000 }

  const applied = applyThreadStateRegistryChanges(registry, [
    { threadId: targetId, state: nextState }
  ])

  assert.equal(targetReads, 1)
  assert.deepEqual(applied, [
    { threadId: targetId, previous: previousState, state: nextState }
  ])
  assert.equal(registry[targetId], nextState)
  targetReads = 0
  const deleted = applyThreadStateRegistryChanges(registry, [
    { threadId: targetId, state: undefined }
  ])
  assert.equal(targetReads, 1)
  assert.deepEqual(deleted, [
    { threadId: targetId, previous: nextState, state: undefined }
  ])
  assert.equal(Object.prototype.hasOwnProperty.call(backing, targetId), false)
  console.log("thread state registry performance contract passed")
}

main()
