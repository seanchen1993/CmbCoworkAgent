// CMB native stream origin foundation. Included lexically in the pinned ReactAgent module.
// No application authority, Source, message, checkpoint or drain permission is minted here.
const nativeStreamApply = Reflect.apply
const nativeStreamWeakGet = WeakMap.prototype.get
const nativeStreamWeakSet = WeakMap.prototype.set
const nativeStreamWeakDelete = WeakMap.prototype.delete
const nativeStreamFreeze = Object.freeze
const nativeStreamInstances = new WeakMap()
const nativeStreamOperations = new WeakMap()
const nativeStreamRequests = new WeakMap()
let nativeStreamBoundary = undefined

function nativeStreamGet(map, key) {
  return nativeStreamApply(nativeStreamWeakGet, map, [key])
}
function nativeStreamSet(map, key, value) {
  nativeStreamApply(nativeStreamWeakSet, map, [key, value])
}
function nativeStreamDelete(map, key) {
  nativeStreamApply(nativeStreamWeakDelete, map, [key])
}
function nativeStreamInvalid(record) {
  if (record) record.failed = true
  throw new Error("LANGCHAIN_NATIVE_STREAM_ORIGIN_INVALID")
}
function nativeStreamAssert(record) {
  if (!record || record.failed ||
    nativeStreamGet(nativeStreamInstances, record.agent) !== record.instance ||
    nativeStreamGet(nativeStreamOperations, record.operation) !== record ||
    record.instance.agent !== record.agent || record.instance.graph !== record.graph ||
    record.instance.stream !== originalNativeReactAgentStream) nativeStreamInvalid(record)
}
function registerNativeStreamInstance(agent, graph) {
  nativeStreamSet(nativeStreamInstances, agent, nativeStreamFreeze({
    agent, graph, stream: originalNativeReactAgentStream
  }))
}

function createNativeStreamOperation(agent, state, config) {
  const instance = nativeStreamGet(nativeStreamInstances, agent)
  if (!instance) nativeStreamInvalid(undefined)
  const operation = nativeStreamFreeze({})
  nativeStreamSet(nativeStreamOperations, operation, {
    operation, instance, agent, graph: instance.graph, state, config,
    phase: "new", failed: false, consumed: false, actualConfig: undefined,
    skipped: false, preflight: undefined, dispatch: undefined
  })
  return operation
}

function consumeNativeStreamOperation(agent, graph, state, config) {
  const record = nativeStreamGet(nativeStreamRequests, agent)
  if (!record) return undefined
  nativeStreamAssert(record)
  if (record.agent !== agent || record.graph !== graph || record.state !== state ||
    record.config !== config || record.phase !== "executing" || record.consumed)
    nativeStreamInvalid(record)
  nativeStreamDelete(nativeStreamRequests, agent)
  record.consumed = true
  record.phase = "entered"
  return record
}

function initializeNativeStreamOperation(record, config) {
  nativeStreamAssert(record)
  if (record.phase !== "entered" || record.actualConfig !== undefined)
    nativeStreamInvalid(record)
  record.actualConfig = config
  record.phase = "initializing"
}
function skipNativeStreamInitialization(record) {
  if (!record) return
  nativeStreamAssert(record)
  if (record.phase !== "initializing") nativeStreamInvalid(record)
  record.skipped = true
  record.phase = "initialization-skipped"
}

function runNativeStreamPreflight(record, graph, config, state, call) {
  nativeStreamAssert(record)
  if (record.phase !== "initializing" || record.graph !== graph ||
    record.actualConfig !== config || record.preflight !== undefined)
    nativeStreamInvalid(record)
  record.phase = "preflight"
  const boundary = nativeStreamFreeze({ record, kind: "preflight", graph, config, state })
  record.preflight = boundary
  const previous = nativeStreamBoundary
  nativeStreamBoundary = boundary
  try {
    return call()
  } finally {
    nativeStreamBoundary = previous
    // Settlement remains the original SDK await/catch, not this synchronous return.
  }
}
function finishNativeStreamPreflight(record) {
  if (!record) return
  nativeStreamAssert(record)
  if (record.phase !== "preflight") nativeStreamInvalid(record)
  record.phase = "preflight-settled"
}

function runNativeStreamDispatch(record, graph, config, state, call) {
  nativeStreamAssert(record)
  if ((record.phase !== "preflight-settled" && record.phase !== "initialization-skipped") ||
    record.graph !== graph || record.actualConfig !== config || record.dispatch !== undefined)
    nativeStreamInvalid(record)
  record.phase = "dispatch"
  const boundary = nativeStreamFreeze({ record, kind: "dispatch", graph, config, state })
  record.dispatch = boundary
  const previous = nativeStreamBoundary
  nativeStreamBoundary = boundary
  try {
    return call()
  } finally {
    nativeStreamBoundary = previous
  }
}

function readNativeStreamBoundary(graph, config, kind) {
  const boundary = nativeStreamBoundary
  if (!boundary || boundary.graph !== graph || boundary.config !== config || boundary.kind !== kind)
    return undefined
  const record = boundary.record
  nativeStreamAssert(record)
  if (record.phase !== kind || record[kind] !== boundary) nativeStreamInvalid(record)
  const check = () => {
    nativeStreamAssert(record)
    if (record.graph !== graph || record.actualConfig !== config || record[kind] !== boundary)
      nativeStreamInvalid(record)
  }
  return nativeStreamFreeze({
    operation: record.operation, agent: record.agent, graph,
    actualConfig: config, actualState: boundary.state,
    initializationSkipped: record.skipped, kind, assertDataCurrent: check
  })
}

function executeNativeStreamOperation(operation) {
  const record = nativeStreamGet(nativeStreamOperations, operation)
  nativeStreamAssert(record)
  if (record.phase !== "new") nativeStreamInvalid(record)
  record.phase = "executing"
  const previous = nativeStreamGet(nativeStreamRequests, record.agent)
  if (previous) {
    previous.failed = true
    nativeStreamInvalid(record)
  }
  nativeStreamSet(nativeStreamRequests, record.agent, record)
  let result
  try {
    result = nativeStreamApply(originalNativeReactAgentStream, record.agent,
      [record.state, record.config])
    if (!record.consumed || nativeStreamGet(nativeStreamRequests, record.agent) === record)
      nativeStreamInvalid(record)
  } catch (error) {
    record.failed = true
    throw error
  } finally {
    if (nativeStreamGet(nativeStreamRequests, record.agent) === record)
      nativeStreamDelete(nativeStreamRequests, record.agent)
  }
  return nativeStreamApply(nativeStreamPromiseThen, result, [value => {
    nativeStreamAssert(record)
    if (record.phase !== "dispatch") nativeStreamInvalid(record)
    record.phase = "dispatched"
    // This is the original iterable shell. Its iterator/runLoop has not drained.
    return value
  }, error => {
    record.failed = true
    throw error
  }])
}
const nativeStreamPromiseThen = Promise.prototype.then
