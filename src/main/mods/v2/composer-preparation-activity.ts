import { AsyncLocalStorage } from "node:async_hooks"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

interface Activity {
  sealed: boolean
  closed: boolean
  failed: boolean
  error: unknown
  pending: Set<Promise<unknown>>
}
const scopes = new AsyncLocalStorage<Activity>()
const setAdd = Set.prototype.add, setDelete = Set.prototype.delete, setValues = Set.prototype.values
const iteratorNext = Object.getPrototypeOf(new Set().values()).next
const promiseThen = Promise.prototype.then, promiseResolve = Promise.resolve
const OriginalPromise = Promise
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!
export function hasComposerPreparationActivity(): boolean { return scopes.getStore() !== undefined }

function fail(activity: Activity, error: unknown): void {
  if (!activity.failed) { activity.failed = true; activity.error = error }
}
function assertActivity(activity: Activity): void {
  if (activity.failed) throw activity.error
  if (activity.closed) throw new ModFunctionError("MODS_COMPOSER_PREPARATION_CLOSED")
  if (activity.sealed && Reflect.apply(setSize, activity.pending, []) !== 0)
    throw new ModFunctionError("MODS_COMPOSER_PREPARATION_PENDING")
}
function allowedCapability(method: string): boolean {
  return method === "fs.read" || method === "fs.list" || method === "fs.exists" ||
    method === "fs.stat" || method === "fs.ancestors" || method === "state.get" ||
    method === "state.set" || method === "store.get" || method === "store.set" ||
    method === "store.delete" || method === "store.keys" || method === "clock.now" ||
    method === "clock.sleep" || method === "tool.check" || method === "settings.read" ||
    method === "env.get" || method === "session.id" || method === "session.cwd" ||
    method === "session.root" || method === "session.version" || method === "session.surface" ||
    method === "session.surfaces" || method === "session.repo" || method === "session.model" ||
    method === "session.messages" || method === "session.turns" || method === "session.usage" ||
    method === "prompt.context" || method === "prompt.attachment"
}

/** This tracks real host work only. It never certifies a runtime, file, message or callback. */
export function createComposerPreparationActivity(): Readonly<{
  run<T>(operation: () => Promise<T>): Promise<T>
  assertDataCurrent(): void
  sealAndDrain(): Promise<void>
  close(): Promise<void>
}> {
  const activity: Activity = { sealed: false, closed: false, failed: false,
    error: undefined, pending: new Set() }
  const drain = () => {
    const pending: Promise<unknown>[] = []
    const iterator = Reflect.apply(setValues, activity.pending, [])
    for (;;) {
      const item: IteratorResult<Promise<unknown>> = Reflect.apply(iteratorNext, iterator, [])
      if (item.done) break
      pending[pending.length] = item.value
    }
    return new OriginalPromise<void>(resolve => {
      let remaining = pending.length
      if (!remaining) { resolve(); return }
      const settled = () => { if (--remaining === 0) resolve() }
      for (let index = 0; index < pending.length; index++)
        Reflect.apply(promiseThen, pending[index], [settled, settled])
    })
  }
  return Object.freeze({
    run: <T>(operation: () => Promise<T>): Promise<T> => {
      assertActivity(activity)
      return scopes.run(activity, operation)
    },
    assertDataCurrent: () => assertActivity(activity),
    sealAndDrain: async () => {
      activity.sealed = true
      await drain()
      assertActivity(activity)
    },
    close: async () => {
      activity.sealed = true
      activity.closed = true
      await drain()
    }
  })
}

/** Register before calling the real host function, outside any deadline/result waiting shell. */
export function retainComposerPreparationWork<T>(operation: () => Promise<T>, method?: string): Promise<T> {
  const activity = scopes.getStore()
  if (!activity) return operation()
  assertActivity(activity)
  if (activity.sealed) {
    const error = new ModFunctionError("MODS_COMPOSER_PREPARATION_SEALED")
    fail(activity, error)
    throw error
  }
  // No actual work has started. Optional-hook recovery may keep its original next result.
  if (method !== undefined && !allowedCapability(method))
    throw new ModFunctionError("MODS_COMPOSER_CAPABILITY_UNAVAILABLE")
  const initial: Promise<void> = Reflect.apply(promiseResolve, OriginalPromise, [])
  const actual: Promise<T> = Reflect.apply(promiseThen, initial, [operation])
  Reflect.apply(setAdd, activity.pending, [actual])
  // Observe the real host finally even when the guest or dispatcher has already stopped waiting.
  Reflect.apply(promiseThen, actual, [
    () => { Reflect.apply(setDelete, activity.pending, [actual]) },
    (error: unknown) => { fail(activity, error); Reflect.apply(setDelete, activity.pending, [actual]) }
  ])
  return actual
}
