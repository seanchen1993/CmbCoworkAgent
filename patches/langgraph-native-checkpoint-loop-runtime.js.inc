// Native checkpoint call facts only. No application Source or ready state is produced.
const nativeLoopApply = Reflect.apply
const nativeLoopGetOwn = Object.getOwnPropertyDescriptor
const nativeLoopGetProto = Object.getPrototypeOf
const nativeLoopOwnKeys = Reflect.ownKeys
const nativeLoopFreeze = Object.freeze
const nativeLoopWeakGet = WeakMap.prototype.get
const nativeLoopWeakSet = WeakMap.prototype.set
const nativeLoopThen = Promise.prototype.then
const nativeLoopResolve = Promise.resolve
const nativeLoopPromise = Promise
const nativeLoopExecutions = new WeakMap()
const nativeLoopCalls = new WeakMap()
let nativeLoopBoundary = undefined
var nativeLoopInitialized = false

function nativeLoopGet(map, key) {
  "use strict"
  return nativeLoopApply(nativeLoopWeakGet, map, [key])
}
function nativeLoopSet(map, key, value) {
  "use strict"
  nativeLoopApply(nativeLoopWeakSet, map, [key, value])
}
function nativeLoopInvalid(record) {
  "use strict"
  if (record) { record.failed = true; record.facts.invalidate() }
  throw new Error("LANGCHAIN_NATIVE_PREGEL_CHECKPOINT_INVALID")
}
function nativeLoopField(value, key, record) {
  "use strict"
  const field = nativeLoopGetOwn(value, key)
  if (!field || !nativeLoopGetOwn(field, "value")) nativeLoopInvalid(record)
  return field
}
function nativeLoopSameField(current, expected) {
  "use strict"
  return !!current && !!expected && !!nativeLoopGetOwn(current, "value") &&
    !!nativeLoopGetOwn(expected, "value") && current.value === expected.value &&
    current.writable === expected.writable && current.enumerable === expected.enumerable &&
    current.configurable === expected.configurable
}
function assertNativePregelLoopInitializeOrigin() {
  "use strict"
  if (!nativeLoopInitialized || nativeLoopGetProto(PregelLoop) !== originalNativeLoopPrototype ||
    !nativeLoopSameField(nativeLoopGetOwn(PregelLoop, "initialize"), originalNativeLoopInitializeField))
    nativeLoopInvalid(undefined)
}
function nativeLoopAssert(record) {
  "use strict"
  if (!record || record.failed || nativeLoopGet(nativeLoopExecutions, record.request) !== record)
    nativeLoopInvalid(record)
  try {
    assertNativePregelLoopInitializeOrigin()
    record.facts.assertDataCurrent()
  } catch (reason) { record.failed = true; record.facts.invalidate(); throw reason }
}
function nativeLoopAssertCall(call) {
  "use strict"
  const record = call.record
  try {
    nativeLoopAssert(record); call.checkConfig()
    if (record.call !== call || nativeLoopGet(nativeLoopCalls, call.token) !== call)
      nativeLoopInvalid(record)
  } catch (reason) { record.failed = true; record.facts.invalidate(); throw reason }
}
function nativeLoopCapture(value, record) {
  "use strict"
  const prototype = nativeLoopGetProto(value), keys = nativeLoopOwnKeys(value), fields = []
  for (let index = 0; index < keys.length; index++) fields[index] = nativeLoopField(value, keys[index], record)
  return function assertNativeLoopObject() {
    "use strict"
    if (nativeLoopGetProto(value) !== prototype) nativeLoopInvalid(record)
    const current = nativeLoopOwnKeys(value)
    if (current.length !== keys.length) nativeLoopInvalid(record)
    for (let index = 0; index < keys.length; index++)
      if (current[index] !== keys[index] ||
        !nativeLoopSameField(nativeLoopGetOwn(value, keys[index]), fields[index])) nativeLoopInvalid(record)
  }
}
function nativeLoopCaptureConfig(config, record) {
  "use strict"
  const root = nativeLoopCapture(config, record)
  const configurable = nativeLoopField(config, "configurable", record).value
  const nested = nativeLoopCapture(configurable, record)
  const mapField = nativeLoopGetOwn(configurable, "checkpoint_map")
  if (mapField && !nativeLoopGetOwn(mapField, "value")) nativeLoopInvalid(record)
  const checkMap = mapField?.value === undefined ? undefined : nativeLoopCapture(mapField.value, record)
  return function assertNativeLoopConfig() {
    "use strict"
    root(); nested()
    if (checkMap) checkMap()
    nested(); root()
  }
}
function consumeNativePregelLoopInitialization(receiver, params, request) {
  "use strict"
  if (request === undefined) return undefined
  if (!nativeLoopInitialized) nativeLoopInvalid(undefined)
  const record = nativeLoopGet(nativeLoopExecutions, request)
  if (!record) return undefined
  if (record.receiver !== receiver || record.params !== params ||
    !record.executing || record.consumed) nativeLoopInvalid(record)
  record.consumed = true
  nativeLoopAssert(record)
  record.facts.enter()
  return record
}
function invokeNativePregelLoopInitialization(request, params) {
  "use strict"
  if (!nativeLoopInitialized) nativeLoopInvalid(undefined)
  const facts = readNativePregelCheckpointLoopRequest(request, params)
  if (!facts) nativeLoopInvalid(undefined)
  assertNativePregelLoopInitializeOrigin()
  if (nativeLoopGet(nativeLoopExecutions, request)) { facts.invalidate(); nativeLoopInvalid(undefined) }
  const record = { request, params, facts, receiver: PregelLoop, executing: true,
    consumed: false, failed: false, checkpointStarted: false, call: undefined,
    actualPromise: undefined, pending: true, status: undefined, value: undefined, reason: undefined }
  nativeLoopSet(nativeLoopExecutions, request, record)
  let observed
  try {
    const actual = nativeLoopApply(originalNativeLoopInitializeField.value, PregelLoop, [params, request])
    record.actualPromise = actual
    observed = nativeLoopApply(nativeLoopThen, actual, [function initialized(value) {
      "use strict"
      record.pending = false; record.status = "fulfilled"; record.value = value
      nativeLoopAssert(record)
      return value
    }, function initializationRejected(reason) {
      "use strict"
      record.pending = false; record.status = "rejected"; record.reason = reason
      record.failed = true; facts.invalidate()
      throw reason
    }])
    if (!record.consumed) nativeLoopInvalid(record)
  } catch (reason) {
    record.failed = true; facts.invalidate()
    if (observed === undefined) {
      record.pending = false; record.status = "rejected"; record.reason = reason
      throw reason
    }
  } finally { record.executing = false }
  return observed
}
function invokeNativePregelCheckpointCall(record, checkpointConfig) {
  "use strict"
  nativeLoopAssert(record)
  if (!record.consumed || record.checkpointStarted) nativeLoopInvalid(record)
  record.checkpointStarted = true
  // Occupied before any receiver/member evaluation. Params itself is the SDK's private literal.
  const receiver = nativeLoopField(record.params, "checkpointer", record).value
  if (receiver !== record.facts.checkpointer) nativeLoopInvalid(record)
  let selected
  try { selected = receiver.getTuple }
  catch (reason) { record.failed = true; record.facts.invalidate(); throw reason }
  let checkConfig
  try { checkConfig = nativeLoopCaptureConfig(checkpointConfig, record) }
  catch (reason) { record.failed = true; record.facts.invalidate(); throw reason }
  const token = nativeLoopFreeze({})
  const call = { token, record, receiver, selected, checkpointConfig, checkConfig,
    claimed: false, actualReturn: undefined, actualPromise: undefined,
    pending: true, status: undefined, value: undefined, reason: undefined }
  nativeLoopSet(nativeLoopCalls, token, call)
  record.call = call
  const previous = nativeLoopBoundary
  nativeLoopBoundary = call
  let actual, observed
  try {
    nativeLoopAssertCall(call)
    actual = nativeLoopApply(selected, receiver, [checkpointConfig])
    call.actualReturn = actual
  } catch (reason) {
    call.pending = false; call.status = "rejected"; call.reason = reason
    record.failed = true; record.facts.invalidate()
    throw reason
  } finally { nativeLoopBoundary = previous }
  try {
    // Native Promises keep their identity; plain/null/undefined retain the original await semantics.
    const promise = nativeLoopApply(nativeLoopResolve, nativeLoopPromise, [actual])
    call.actualPromise = promise
    observed = nativeLoopApply(nativeLoopThen, promise, [function checkpointFulfilled(value) {
      "use strict"
      call.pending = false; call.status = "fulfilled"; call.value = value
      nativeLoopAssertCall(call)
      return value
    }, function checkpointRejected(reason) {
      "use strict"
      call.pending = false; call.status = "rejected"; call.reason = reason
      record.failed = true; record.facts.invalidate()
      throw reason
    }])
    nativeLoopAssertCall(call)
  } catch (reason) {
    record.failed = true; record.facts.invalidate()
    if (observed === undefined) {
      call.pending = false; call.status = "rejected"; call.reason = reason
      throw reason
    }
  }
  return observed
}
function claimNativePregelCheckpointCall(receiver, checkpointConfig, selected) {
  "use strict"
  if (!nativeLoopInitialized) return undefined
  const call = nativeLoopBoundary
  if (!call || call.receiver !== receiver || call.checkpointConfig !== checkpointConfig ||
    call.selected !== selected) return undefined
  if (call.claimed) nativeLoopInvalid(call.record)
  call.claimed = true
  nativeLoopAssertCall(call)
  return call.token
}
function readNativePregelCheckpointCall(token) {
  "use strict"
  if (!nativeLoopInitialized) return undefined
  const call = nativeLoopGet(nativeLoopCalls, token)
  if (!call) return undefined
  const record = call.record, facts = record.facts
  const assertDataCurrent = function assertNativeCheckpointCall() {
    "use strict"
    nativeLoopAssertCall(call)
    if (!call.claimed)
      nativeLoopInvalid(record)
  }
  assertDataCurrent()
  return nativeLoopFreeze({ operation: facts.operation, coreOperation: facts.coreOperation,
    graph: facts.graph, input: facts.input, iteratorConfig: facts.iteratorConfig,
    initializeParams: record.params, initializeReceiver: record.receiver,
    checkpointer: call.receiver, checkpointConfig: call.checkpointConfig,
    selectedGetTuple: call.selected, assertDataCurrent })
}
function readNativePregelCheckpointSettlement(operation) {
  "use strict"
  if (!nativeLoopInitialized) return undefined
  const record = readNativePregelCheckpointExecution(operation)
  if (!record) return undefined
  const loop = nativeLoopGet(nativeLoopExecutions, record.request), call = loop?.call
  if (!call || call.pending || call.status === undefined) return undefined
  return nativeLoopFreeze({ operation, coreOperation: loop.facts.coreOperation,
    graph: loop.facts.graph, input: loop.facts.input, iteratorConfig: loop.facts.iteratorConfig,
    initializeParams: loop.params, initializeReceiver: loop.receiver,
    checkpointer: call.receiver, checkpointConfig: call.checkpointConfig,
    selectedGetTuple: call.selected, status: call.status, value: call.value, reason: call.reason,
    claimed: call.claimed })
}
