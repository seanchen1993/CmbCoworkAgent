// Original Pregel/Partial/Runnable dispatch facts. No application authority is granted.
const nativePregelApply = Reflect.apply
const nativePregelGetOwn = Object.getOwnPropertyDescriptor
const nativePregelGetProto = Object.getPrototypeOf
const nativePregelFreeze = Object.freeze
const nativePregelWeakGet = WeakMap.prototype.get
const nativePregelWeakSet = WeakMap.prototype.set
const nativePregelWeakDelete = WeakMap.prototype.delete
const nativePregelThen = Promise.prototype.then
const nativePregelOwnKeys = Reflect.ownKeys
const nativePregelBirths = new WeakMap()
const nativePregelOperations = new WeakMap()
const nativePregelRequests = new WeakMap()
const nativePregelPartialRequests = new WeakMap()
const nativePregelStarting = new WeakMap()
const nativePregelCheckpointBodies = new WeakMap()
const nativePregelCheckpointLoops = new WeakMap()
var nativePregelInitialized = false

function nativePregelGet(map, key) {
  return nativePregelApply(nativePregelWeakGet, map, [key])
}
function nativePregelSet(map, key, value) {
  nativePregelApply(nativePregelWeakSet, map, [key, value])
}
function nativePregelDelete(map, key) {
  nativePregelApply(nativePregelWeakDelete, map, [key])
}
function nativePregelInvalid(record) {
  "use strict"
  if (record) record.failed = true
  throw new Error("LANGCHAIN_NATIVE_PREGEL_STREAM_INVALID")
}
function nativePregelSameField(current, original) {
  return current === undefined ? original === undefined : original !== undefined &&
    "value" in current && "value" in original && current.value === original.value &&
    current.writable === original.writable && current.enumerable === original.enumerable &&
    current.configurable === original.configurable
}
function registerNativePregelBirth(graph) {
  if (!nativePregelInitialized) return
  nativePregelSet(nativePregelBirths, graph, nativePregelFreeze({ graph }))
}
function nativePregelCaptureIterator(graph) {
  const path = []
  let current = graph
  while (current !== null) {
    const field = nativePregelGetOwn(current, "_streamIterator")
    const prototype = nativePregelGetProto(current)
    path[path.length] = { current, prototype, field }
    if (field !== undefined) {
      if (!("value" in field) || typeof field.value !== "function")
        nativePregelInvalid(undefined)
      if (current === graph) {
        if (field.writable !== false || field.configurable !== false)
          nativePregelInvalid(undefined)
      } else if (current !== originalNativePregelIteratorOwner ||
        !nativePregelSameField(field, originalNativePregelIteratorField))
        nativePregelInvalid(undefined)
      return { path, field, selected: field.value, owner: current }
    }
    current = prototype
  }
  nativePregelInvalid(undefined)
}
function nativePregelCheckIterator(record) {
  "use strict"
  for (let index = 0; index < record.selection.path.length; index++) {
    const step = record.selection.path[index]
    if (nativePregelGetProto(step.current) !== step.prototype ||
      !nativePregelSameField(nativePregelGetOwn(step.current, "_streamIterator"), step.field))
      nativePregelInvalid(record)
  }
}
function nativePregelAssert(record) {
  "use strict"
  if (!nativePregelInitialized || !record || record.failed ||
    nativePregelGet(nativePregelOperations, record.operation) !== record ||
    nativePregelGet(nativePregelBirths, record.graph) !== record.birth)
    nativePregelInvalid(record)
  nativePregelCheckIterator(record)
}
function createNativePregelStreamOperation(graph, input, options) {
  const birth = nativePregelGet(nativePregelBirths, graph)
  if (!nativePregelInitialized || !birth) nativePregelInvalid(undefined)
  const selection = nativePregelCaptureIterator(graph)
  const operation = nativePregelFreeze({})
  nativePregelSet(nativePregelOperations, operation, {
    operation, graph, birth, input, options, selection, phase: "new", failed: false,
    consumed: false, actualConfig: undefined, partialConsumed: false, coreOperation: undefined,
    actualPromise: undefined, outerPending: false, status: undefined, value: undefined, reason: undefined,
    checkpointStarted: false, checkpointBody: undefined, checkpointIterator: undefined
  })
  return operation
}
function consumeNativePregelStreamOperation(graph, input, options) {
  const record = nativePregelGet(nativePregelRequests, graph)
  if (!record) return undefined
  nativePregelAssert(record)
  if (record.graph !== graph || record.input !== input || record.options !== options ||
    record.phase !== "entering" || record.consumed) nativePregelInvalid(record)
  nativePregelDelete(nativePregelRequests, graph)
  record.consumed = true
  record.phase = "entered"
  return record
}
function invokeNativePregelPartialStream(record, graph, input, config) {
  nativePregelAssert(record)
  if (record.graph !== graph || record.input !== input || record.phase !== "entered" ||
    record.actualConfig !== undefined || nativePregelGet(nativePregelPartialRequests, graph))
    nativePregelInvalid(record)
  record.actualConfig = config
  nativePregelSet(nativePregelPartialRequests, graph, record)
  try {
    const result = nativePregelApply(originalNativePartialStream, graph, [input, config])
    if (!record.partialConsumed || nativePregelGet(nativePregelPartialRequests, graph) === record)
      nativePregelInvalid(record)
    return result
  } finally {
    if (nativePregelGet(nativePregelPartialRequests, graph) === record)
      nativePregelDelete(nativePregelPartialRequests, graph)
  }
}
function consumeNativePregelPartialStream(graph, input, config) {
  const record = nativePregelGet(nativePregelPartialRequests, graph)
  if (!record) return undefined
  nativePregelAssert(record)
  if (record.graph !== graph || record.input !== input || record.actualConfig !== config ||
    record.phase !== "entered" || record.partialConsumed) nativePregelInvalid(record)
  nativePregelDelete(nativePregelPartialRequests, graph)
  record.partialConsumed = true
  record.phase = "partial-entered"
  return record
}
function invokeNativePregelRunnableStream(record, graph, input, config) {
  nativePregelAssert(record)
  if (record.graph !== graph || record.input !== input || record.actualConfig !== config ||
    record.phase !== "partial-entered" || record.coreOperation !== undefined)
    nativePregelInvalid(record)
  const coreOperation = createNativeRunnableStreamOperation(graph, input, config)
  nativePregelAssert(record)
  record.coreOperation = coreOperation
  record.phase = "core-created"
  return executeNativeRunnableStreamOperation(coreOperation)
}
function readNativePregelStreamOperation(operation, graph, input, options) {
  const record = nativePregelGet(nativePregelOperations, operation)
  if (!record || record.graph !== graph || record.input !== input || record.options !== options)
    return undefined
  nativePregelAssert(record)
  const assertDataCurrent = () => {
    nativePregelAssert(record)
    if (record.graph !== graph || record.input !== input || record.options !== options)
      nativePregelInvalid(record)
  }
  return nativePregelFreeze({ operation, graph, input, options,
    actualConfig: record.actualConfig, coreOperation: record.coreOperation,
    selectedIterator: record.selection.selected, iteratorOwner: record.selection.owner,
    iteratorDescriptor: nativePregelFreeze({ ...record.selection.field }), assertDataCurrent })
}
function readNativePregelStreamSettlement(operation) {
  const record = nativePregelGet(nativePregelOperations, operation)
  if (!record || record.outerPending || record.status === undefined) return undefined
  return nativePregelFreeze({ operation, graph: record.graph, input: record.input,
    options: record.options, actualConfig: record.actualConfig, coreOperation: record.coreOperation,
    selectedIterator: record.selection.selected, iteratorOwner: record.selection.owner,
    iteratorDescriptor: nativePregelFreeze({ ...record.selection.field }),
    status: record.status, value: record.value, reason: record.reason,
    entered: record.consumed, partialEntered: record.partialConsumed })
}
function executeNativePregelStreamOperation(operation) {
  const record = nativePregelGet(nativePregelOperations, operation)
  nativePregelAssert(record)
  if (record.phase !== "new") nativePregelInvalid(record)
  const previous = nativePregelGet(nativePregelStarting, record.graph)
  if (previous) { previous.failed = true; nativePregelInvalid(record) }
  record.phase = "entering"
  record.outerPending = true
  nativePregelSet(nativePregelStarting, record.graph, record)
  nativePregelSet(nativePregelRequests, record.graph, record)
  let result, observed
  try {
    result = nativePregelApply(originalNativePregelStream, record.graph,
      [record.input, record.options])
    record.actualPromise = result
    observed = nativePregelApply(nativePregelThen, result, [value => {
      record.outerPending = false
      record.status = "fulfilled"
      record.value = value
      nativePregelAssert(record)
      if (record.phase !== "core-created") nativePregelInvalid(record)
      record.phase = "dispatched"
      return value
    }, reason => {
      record.outerPending = false
      record.status = "rejected"
      record.reason = reason
      record.failed = true
      throw reason
    }])
    if (!record.consumed || nativePregelGet(nativePregelRequests, record.graph) === record)
      nativePregelInvalid(record)
  } catch (reason) {
    record.failed = true
    if (observed === undefined) {
      record.outerPending = false
      record.status = "rejected"
      record.reason = reason
      throw reason
    }
    // Original Promise settlement remains distinct from the failed private entry gate.
  } finally {
    if (nativePregelGet(nativePregelRequests, record.graph) === record)
      nativePregelDelete(nativePregelRequests, record.graph)
    if (nativePregelGet(nativePregelStarting, record.graph) === record)
      nativePregelDelete(nativePregelStarting, record.graph)
  }
  return observed
}

// These functions keep their private arguments inaccessible in CommonJS callback stacks.
function nativePregelCheckpointDataField(value, key, body) {
  "use strict"
  const field = nativePregelGetOwn(value, key)
  if (!field || !nativePregelGetOwn(field, "value")) nativePregelInvalid(body?.record)
  return field
}
function nativePregelCheckpointSameField(current, expected) {
  "use strict"
  return !!current && !!expected && !!nativePregelGetOwn(current, "value") &&
    !!nativePregelGetOwn(expected, "value") && current.value === expected.value &&
    current.writable === expected.writable && current.enumerable === expected.enumerable &&
    current.configurable === expected.configurable
}
function nativePregelCheckpointCapture(value, body) {
  "use strict"
  const prototype = nativePregelGetProto(value)
  const keys = nativePregelOwnKeys(value), fields = []
  for (let index = 0; index < keys.length; index++)
    fields[index] = nativePregelCheckpointDataField(value, keys[index], body)
  return function assertCheckpointObject() {
    "use strict"
    if (nativePregelGetProto(value) !== prototype) nativePregelInvalid(body?.record)
    const current = nativePregelOwnKeys(value)
    if (current.length !== keys.length) nativePregelInvalid(body?.record)
    for (let index = 0; index < keys.length; index++) {
      const field = nativePregelCheckpointDataField(value, keys[index], body)
      if (current[index] !== keys[index] || !nativePregelCheckpointSameField(field, fields[index]))
        nativePregelInvalid(body?.record)
    }
  }
}
function nativePregelCheckpointCaptureConfig(config, body) {
  "use strict"
  const root = nativePregelCheckpointCapture(config, body)
  const configurable = nativePregelCheckpointDataField(config, "configurable", body).value
  if (!configurable || typeof configurable !== "object") nativePregelInvalid(body?.record)
  const nested = nativePregelCheckpointCapture(configurable, body)
  const mapField = nativePregelGetOwn(configurable, "checkpoint_map")
  if (mapField && !nativePregelGetOwn(mapField, "value")) nativePregelInvalid(body?.record)
  const map = mapField?.value
  const checkMap = map === undefined ? undefined : nativePregelCheckpointCapture(map, body)
  return function assertCheckpointConfig() {
    "use strict"
    root(); nested()
    if (checkMap) checkMap()
    nested(); root()
  }
}
function nativePregelCheckpointAssertBody(body) {
  "use strict"
  try {
    nativePregelAssert(body?.record)
    if (!body || nativePregelGet(nativePregelCheckpointBodies, body.ticket) !== body ||
      body.record.checkpointBody !== body || body.failed) nativePregelInvalid(body?.record)
    body.checkConfig()
    if (!nativePregelCheckpointSameField(nativePregelGetOwn(originalNativePregelIteratorOwner,
      "_streamIterator"), originalNativePregelIteratorField)) nativePregelInvalid(body.record)
  } catch (reason) {
    if (body) { body.failed = true; body.record.failed = true }
    throw reason
  }
}
function readNativePregelCheckpointIteratorOrigin(operation) {
  "use strict"
  if (!nativePregelInitialized) return undefined
  const record = nativePregelGet(nativePregelOperations, operation)
  if (!record) return undefined
  try { nativePregelAssert(record) }
  catch (reason) { record.failed = true; throw reason }
  const assertDataCurrent = function assertCheckpointOrigin() {
    "use strict"
    try {
      nativePregelAssert(record)
      if (!nativePregelCheckpointSameField(nativePregelGetOwn(originalNativePregelIteratorOwner,
        "_streamIterator"), originalNativePregelIteratorField)) nativePregelInvalid(record)
    } catch (reason) { record.failed = true; throw reason }
  }
  assertDataCurrent()
  return nativePregelFreeze({ graph: record.graph,
    originalIterator: originalNativePregelIteratorField.value,
    receiver: record.graph, descriptor: nativePregelFreeze({ ...originalNativePregelIteratorField }),
    assertDataCurrent })
}
function createNativePregelCheckpointIterator(operation, graph, input, config) {
  "use strict"
  if (!nativePregelInitialized) nativePregelInvalid(undefined)
  const record = nativePregelGet(nativePregelOperations, operation)
  try { nativePregelAssert(record) }
  catch (reason) { if (record) record.failed = true; throw reason }
  if (record.checkpointStarted) nativePregelInvalid(record)
  record.checkpointStarted = true
  try {
    const boundary = readNativeRunnableStreamBoundary(graph, config)
    if (!boundary || record.graph !== graph || record.input !== input ||
      record.coreOperation !== boundary.operation || boundary.receiver !== graph ||
      boundary.input !== input || boundary.options !== record.actualConfig ||
      boundary.actualConfig !== config || boundary.selectedIterator !== record.selection.selected ||
      boundary.iteratorOwner !== record.selection.owner ||
      !nativePregelCheckpointSameField(boundary.iteratorDescriptor, record.selection.field))
      nativePregelInvalid(record)
    const ticket = nativePregelFreeze({})
    const body = { ticket, record, graph, input, config, coreOperation: boundary.operation,
      checkConfig: undefined, checkpointer: undefined, consumed: false, failed: false,
      loopRequest: undefined, actualIterator: undefined }
    body.checkConfig = nativePregelCheckpointCaptureConfig(config, body)
    const configurable = nativePregelCheckpointDataField(config, "configurable", body).value
    body.checkpointer = nativePregelCheckpointDataField(configurable,
      "__pregel_checkpointer", body).value
    if (!body.checkpointer || typeof body.checkpointer !== "object") nativePregelInvalid(record)
    nativePregelSet(nativePregelCheckpointBodies, ticket, body)
    record.checkpointBody = body
    const origin = readNativePregelCheckpointIteratorOrigin(operation)
    origin.assertDataCurrent(); boundary.assertDataCurrent()
    nativePregelCheckpointAssertBody(body)
    const iterator = nativePregelApply(originalNativePregelIteratorField.value, graph,
      [input, config, ticket])
    body.actualIterator = iterator
    record.checkpointIterator = iterator
    nativePregelCheckpointAssertBody(body)
    return iterator
  } catch (reason) { record.failed = true; throw reason }
}
function consumeNativePregelCheckpointBody(ticket, graph, input, config) {
  "use strict"
  if (!nativePregelInitialized) nativePregelInvalid(undefined)
  const body = nativePregelGet(nativePregelCheckpointBodies, ticket)
  // Ordinary extra arguments remain ignored, as in the original two-argument method.
  if (!body) return undefined
  if (body.consumed || body.graph !== graph || body.input !== input || body.config !== config)
    nativePregelInvalid(body.record)
  body.consumed = true
  nativePregelCheckpointAssertBody(body)
  return body
}
function beginNativePregelCheckpointLoop(body) {
  "use strict"
  nativePregelCheckpointAssertBody(body)
  if (!body.consumed || body.loopRequest !== undefined) nativePregelInvalid(body.record)
  const request = nativePregelFreeze({})
  const loop = { request, body, params: undefined, checkParams: undefined,
    entered: false, failed: false }
  body.loopRequest = request
  nativePregelSet(nativePregelCheckpointLoops, request, loop)
  return request
}
function invokeNativePregelCheckpointLoop(request, params) {
  "use strict"
  const loop = nativePregelGet(nativePregelCheckpointLoops, request)
  if (!loop || loop.params !== undefined) nativePregelInvalid(loop?.body.record)
  nativePregelCheckpointAssertBody(loop.body)
  loop.params = params
  loop.checkParams = nativePregelCheckpointCapture(params, loop.body)
  if (nativePregelCheckpointDataField(params, "checkpointer", loop.body).value !==
    loop.body.checkpointer) nativePregelInvalid(loop.body.record)
  return invokeNativePregelLoopInitialization(request, params)
}
function readNativePregelCheckpointLoopRequest(request, params) {
  "use strict"
  if (!nativePregelInitialized) return undefined
  const loop = nativePregelGet(nativePregelCheckpointLoops, request)
  if (!loop || loop.params !== params) return undefined
  const assertDataCurrent = function assertCheckpointLoop() {
    "use strict"
    try {
      nativePregelCheckpointAssertBody(loop.body)
      if (loop.failed || nativePregelGet(nativePregelCheckpointLoops, request) !== loop ||
        loop.params !== params || loop.body.loopRequest !== request) nativePregelInvalid(loop.body.record)
      loop.checkParams()
    } catch (reason) {
      loop.failed = true; loop.body.failed = true; loop.body.record.failed = true
      throw reason
    }
  }
  assertDataCurrent()
  const enter = function enterCheckpointLoop() {
    "use strict"
    if (loop.entered) nativePregelInvalid(loop.body.record)
    loop.entered = true
    assertDataCurrent()
  }
  const invalidate = function invalidateCheckpointLoop() {
    "use strict"
    loop.failed = true; loop.body.failed = true; loop.body.record.failed = true
  }
  return nativePregelFreeze({ request, params, operation: loop.body.record.operation,
    coreOperation: loop.body.coreOperation, graph: loop.body.graph, input: loop.body.input,
    iteratorConfig: loop.body.config, checkpointer: loop.body.checkpointer,
    assertDataCurrent, enter, invalidate })
}
function readNativePregelCheckpointExecution(operation) {
  "use strict"
  if (!nativePregelInitialized) return undefined
  // Reporting a used initialization is distinct from refreshing a failed capability.
  const record = nativePregelGet(nativePregelOperations, operation), body = record?.checkpointBody
  const loop = body && nativePregelGet(nativePregelCheckpointLoops, body.loopRequest)
  if (!loop || !loop.entered || loop.body !== body || body.record !== record) return undefined
  return nativePregelFreeze({ request: loop.request })
}
function invalidateNativePregelCheckpointBody(body) {
  "use strict"
  if (body) { body.failed = true; body.record.failed = true }
}
