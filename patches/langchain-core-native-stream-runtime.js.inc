// Lexical Runnable execution facts only; no application Source or resource authority.
const nativeRunnableApply = Reflect.apply
const nativeRunnableGetOwn = Object.getOwnPropertyDescriptor
const nativeRunnableGetProto = Object.getPrototypeOf
const nativeRunnableFreeze = Object.freeze
const nativeRunnableWeakGet = WeakMap.prototype.get
const nativeRunnableWeakSet = WeakMap.prototype.set
const nativeRunnableWeakDelete = WeakMap.prototype.delete
const nativeRunnableThen = Promise.prototype.then
const nativeRunnableOperations = new WeakMap()
const nativeRunnableRequests = new WeakMap()
const nativeRunnableStarting = new WeakMap()
let nativeRunnableBoundary = undefined
let nativeRunnableInitialized = false

function nativeRunnableGet(map, key) {
  return nativeRunnableApply(nativeRunnableWeakGet, map, [key])
}
function nativeRunnableSet(map, key, value) {
  nativeRunnableApply(nativeRunnableWeakSet, map, [key, value])
}
function nativeRunnableDelete(map, key) {
  nativeRunnableApply(nativeRunnableWeakDelete, map, [key])
}
function nativeRunnableInvalid(record) {
  if (record) record.failed = true
  throw new Error("LANGCHAIN_NATIVE_RUNNABLE_STREAM_INVALID")
}
function nativeRunnableSameField(current, original) {
  return current === undefined ? original === undefined : original !== undefined &&
    "value" in current && "value" in original && current.value === original.value &&
    current.writable === original.writable && current.enumerable === original.enumerable &&
    current.configurable === original.configurable
}
function nativeRunnableCaptureIterator(receiver) {
  if (!receiver || (typeof receiver !== "object" && typeof receiver !== "function"))
    nativeRunnableInvalid(undefined)
  const path = []
  let current = receiver
  while (current !== null) {
    const field = nativeRunnableGetOwn(current, "_streamIterator")
    const prototype = nativeRunnableGetProto(current)
    path[path.length] = { current, prototype, field }
    if (field !== undefined) {
      if (!("value" in field) || typeof field.value !== "function")
        nativeRunnableInvalid(undefined)
      return { path, selected: field.value, field, owner: current }
    }
    current = prototype
  }
  nativeRunnableInvalid(undefined)
}
function nativeRunnableCheckIterator(record) {
  const selection = record.selection
  for (let index = 0; index < selection.path.length; index++) {
    const step = selection.path[index]
    if (nativeRunnableGetProto(step.current) !== step.prototype ||
      !nativeRunnableSameField(nativeRunnableGetOwn(step.current, "_streamIterator"), step.field))
      nativeRunnableInvalid(record)
  }
}
function nativeRunnableAssert(record) {
  if (!nativeRunnableInitialized || !record || record.failed ||
    nativeRunnableGet(nativeRunnableOperations, record.operation) !== record)
    nativeRunnableInvalid(record)
  nativeRunnableCheckIterator(record)
}
function createNativeRunnableStreamOperation(receiver, input, options) {
  if (!nativeRunnableInitialized) nativeRunnableInvalid(undefined)
  const selection = nativeRunnableCaptureIterator(receiver)
  const operation = nativeRunnableFreeze({})
  nativeRunnableSet(nativeRunnableOperations, operation, {
    operation, receiver, input, options, selection, phase: "new", failed: false,
    consumed: false, actualConfig: undefined, signalField: undefined, actualSignal: undefined,
    boundary: undefined, iterator: undefined, actualPromise: undefined, outerPending: false,
    status: undefined, value: undefined, reason: undefined
  })
  return operation
}
function consumeNativeRunnableStreamOperation(receiver, input, options) {
  const record = nativeRunnableGet(nativeRunnableRequests, receiver)
  if (!record) return undefined
  nativeRunnableAssert(record)
  if (record.receiver !== receiver || record.input !== input || record.options !== options ||
    record.phase !== "entering" || record.consumed)
    nativeRunnableInvalid(record)
  nativeRunnableDelete(nativeRunnableRequests, receiver)
  record.consumed = true
  record.phase = "entered"
  return record
}
function initializeNativeRunnableStreamOperation(record, config) {
  if (!record) return
  nativeRunnableAssert(record)
  if (record.phase !== "entered" || record.actualConfig !== undefined ||
    !config || typeof config !== "object") nativeRunnableInvalid(record)
  const field = nativeRunnableGetOwn(config, "signal")
  if (field !== undefined && !("value" in field)) nativeRunnableInvalid(record)
  record.actualConfig = config
  record.signalField = field
  record.actualSignal = field === undefined ? undefined : field.value
  record.phase = "normalized"
}
function invokeNativeRunnableStreamIterator(record, receiver, input, config) {
  nativeRunnableAssert(record)
  if (record.phase !== "normalized" || record.receiver !== receiver || record.input !== input ||
    record.actualConfig !== config || record.boundary !== undefined ||
    !nativeRunnableSameField(nativeRunnableGetOwn(config, "signal"), record.signalField))
    nativeRunnableInvalid(record)
  record.phase = "iterator-entered"
  const boundary = nativeRunnableFreeze({ record, receiver, config })
  record.boundary = boundary
  const previous = nativeRunnableBoundary
  nativeRunnableBoundary = boundary
  try {
    const iterator = nativeRunnableApply(record.selection.selected, receiver, [input, config])
    nativeRunnableAssert(record)
    record.iterator = iterator
    return iterator
  } finally {
    nativeRunnableBoundary = previous
  }
}
function readNativeRunnableStreamBoundary(receiver, config) {
  const boundary = nativeRunnableBoundary
  if (!boundary || boundary.receiver !== receiver || boundary.config !== config) return undefined
  const record = boundary.record
  nativeRunnableAssert(record)
  if (record.phase !== "iterator-entered" || record.boundary !== boundary)
    nativeRunnableInvalid(record)
  const assertDataCurrent = () => {
    nativeRunnableAssert(record)
    if (record.boundary !== boundary || record.actualConfig !== config ||
      !nativeRunnableSameField(nativeRunnableGetOwn(config, "signal"), record.signalField))
      nativeRunnableInvalid(record)
  }
  assertDataCurrent()
  return nativeRunnableFreeze({ operation: record.operation, receiver,
    input: record.input, options: record.options, actualConfig: config,
    actualSignal: record.actualSignal, selectedIterator: record.selection.selected,
    iteratorOwner: record.selection.owner,
    iteratorDescriptor: nativeRunnableFreeze({ ...record.selection.field }), assertDataCurrent })
}
function readNativeRunnableStreamSettlement(operation) {
  const record = nativeRunnableGet(nativeRunnableOperations, operation)
  if (!record || record.outerPending || record.status === undefined) return undefined
  // Failure reporting never restores a failed boundary or makes the operation executable again.
  return nativeRunnableFreeze({ operation, receiver: record.receiver,
    input: record.input, options: record.options, actualConfig: record.actualConfig,
    actualSignal: record.actualSignal, selectedIterator: record.selection.selected,
    iteratorOwner: record.selection.owner,
    iteratorDescriptor: nativeRunnableFreeze({ ...record.selection.field }),
    status: record.status, value: record.value, reason: record.reason,
    entered: record.consumed, iteratorEntered: record.boundary !== undefined })
}
function executeNativeRunnableStreamOperation(operation) {
  const record = nativeRunnableGet(nativeRunnableOperations, operation)
  nativeRunnableAssert(record)
  if (record.phase !== "new") nativeRunnableInvalid(record)
  const previous = nativeRunnableGet(nativeRunnableStarting, record.receiver)
  if (previous) { previous.failed = true; nativeRunnableInvalid(record) }
  record.phase = "entering"
  record.outerPending = true
  nativeRunnableSet(nativeRunnableStarting, record.receiver, record)
  nativeRunnableSet(nativeRunnableRequests, record.receiver, record)
  let result, observed
  try {
    result = nativeRunnableApply(originalNativeRunnableStream, record.receiver,
      [record.input, record.options])
    record.actualPromise = result
    observed = nativeRunnableApply(nativeRunnableThen, result, [value => {
      record.outerPending = false
      record.status = "fulfilled"
      record.value = value
      nativeRunnableAssert(record)
      if (record.phase !== "iterator-entered") nativeRunnableInvalid(record)
      record.phase = "dispatched"
      return value
    }, reason => {
      record.outerPending = false
      record.status = "rejected"
      record.reason = reason
      record.failed = true
      throw reason
    }])
    if (!record.consumed || nativeRunnableGet(nativeRunnableRequests, record.receiver) === record)
      nativeRunnableInvalid(record)
  } catch (reason) {
    record.failed = true
    if (observed === undefined) {
      record.outerPending = false
      record.status = "rejected"
      record.reason = reason
      throw reason
    }
    // A post-entry gate cannot retire an already obtained original async Promise.
  } finally {
    if (nativeRunnableGet(nativeRunnableRequests, record.receiver) === record)
      nativeRunnableDelete(nativeRunnableRequests, record.receiver)
    if (nativeRunnableGet(nativeRunnableStarting, record.receiver) === record)
      nativeRunnableDelete(nativeRunnableStarting, record.receiver)
  }
  return observed
}
