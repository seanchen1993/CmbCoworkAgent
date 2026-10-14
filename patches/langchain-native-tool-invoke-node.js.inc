// Actual selected invoke settlement only. This does not certify Core callbacks or resources.
const nativeToolApply = Reflect.apply
const nativeToolFreeze = Object.freeze
const nativeToolGetOwn = Object.getOwnPropertyDescriptor
const nativeToolGetProto = Object.getPrototypeOf
const nativeToolWeakGet = WeakMap.prototype.get
const nativeToolWeakSet = WeakMap.prototype.set
const nativeToolWeakDelete = WeakMap.prototype.delete
const nativeToolPromise = Promise
const nativeToolPromiseThen = Promise.prototype.then
const nativeToolNodes = new WeakMap()
const nativeToolOperations = new WeakMap()
const nativeToolRequests = new WeakMap()
const nativeToolSelections = new WeakMap()
const nativeToolOutcomes = new WeakMap()

function nativeToolGet(map, key) {
  return nativeToolApply(nativeToolWeakGet, map, [key])
}
function nativeToolSet(map, key, value) {
  nativeToolApply(nativeToolWeakSet, map, [key, value])
}
function nativeToolDelete(map, key) {
  nativeToolApply(nativeToolWeakDelete, map, [key])
}
function nativeToolInvalid(record) {
  if (record) record.failed = true
  throw new Error("LANGCHAIN_NATIVE_TOOL_INVOKE_ORIGIN_INVALID")
}
function constructNativeToolNode(tools, options, construction, agent) {
  if (nativeToolNodeInitialized !== true) nativeToolInvalid(undefined)
  return new originalNativeToolNodeConstructor(tools, options, construction, agent)
}
function registerNativeToolNode(node, tools, options, construction, agent) {
  if (construction === undefined) return
  const declaration = readNativeToolConstruction(construction, agent, tools)
  if (!declaration) nativeToolInvalid(undefined)
  const fields = []
  for (const key of ["tools", "options", "signal", "wrapToolCall", "handleToolErrors"]) {
    const descriptor = nativeToolGetOwn(node, key)
    if (!descriptor || !("value" in descriptor)) nativeToolInvalid(undefined)
    fields[fields.length] = { key, descriptor }
  }
  const toolsFields = []
  for (let index = 0; index < tools.length; index++)
    toolsFields[index] = nativeToolGetOwn(tools, String(index))
  nativeToolSet(nativeToolNodes, node, {
    node, agent, tools, options, construction, declaration, fields,
    prototype: nativeToolGetProto(node), toolsPrototype: nativeToolGetProto(tools),
    toolsLength: nativeToolGetOwn(tools, "length"), toolsFields
  })
}
function readNativeToolNodeInstance(node, agent, construction) {
  if (nativeToolNodeInitialized !== true) return undefined
  const record = nativeToolGet(nativeToolNodes, node)
  if (!record || record.agent !== agent || record.construction !== construction) return undefined
  return record
}
function nativeToolAssertOperation(record) {
  if (!record || record.failed || nativeToolGet(nativeToolOperations, record.operation) !== record ||
    nativeToolGet(nativeToolNodes, record.node) !== record.instance)
    nativeToolInvalid(record)
  let agentInstance
  try {
    agentInstance = readNativeToolAgentInstance(record.agent, record.node, record.instance.construction)
  } catch (reason) {
    record.failed = true
    throw reason
  }
  if (!agentInstance) nativeToolInvalid(record)
  const instance = record.instance
  const length = nativeToolGetOwn(instance.tools, "length")
  if (nativeToolGetProto(record.node) !== instance.prototype ||
    nativeToolGetProto(instance.tools) !== instance.toolsPrototype || !length ||
    !("value" in length) || length.value !== instance.toolsLength.value ||
    length.writable !== instance.toolsLength.writable ||
    length.enumerable !== instance.toolsLength.enumerable ||
    length.configurable !== instance.toolsLength.configurable) nativeToolInvalid(record)
  for (let index = 0; index < instance.fields.length; index++) {
    const field = instance.fields[index]
    const current = nativeToolGetOwn(record.node, field.key)
    const original = field.descriptor
    if (!current || !("value" in current) || current.value !== original.value ||
      current.writable !== original.writable || current.enumerable !== original.enumerable ||
      current.configurable !== original.configurable) nativeToolInvalid(record)
  }
  for (let index = 0; index < instance.toolsFields.length; index++) {
    const current = nativeToolGetOwn(instance.tools, String(index))
    const original = instance.toolsFields[index]
    if (!current || !("value" in current) || current.value !== original.value ||
      current.writable !== original.writable || current.enumerable !== original.enumerable ||
      current.configurable !== original.configurable) nativeToolInvalid(record)
  }
}
function createNativeToolInvokeOperationForAgent(agent, node, construction, call, config, state) {
  if (nativeToolNodeInitialized !== true) nativeToolInvalid(undefined)
  const instance = readNativeToolNodeInstance(node, agent, construction)
  if (!instance || !readNativeToolAgentInstance(agent, node, construction)) nativeToolInvalid(undefined)
  const operation = nativeToolFreeze({})
  const record = {
    operation, instance, agent, node, call, config, state, phase: "new", failed: false,
    consumed: false, closing: false, tickets: [], selections: [], drain: undefined
  }
  nativeToolSet(nativeToolOperations, operation, record)
  nativeToolAssertOperation(record)
  return operation
}
function nativeToolStartTicket(record, kind) {
  if (record.closing) nativeToolInvalid(record)
  let resolve
  const pending = new nativeToolPromise(done => { resolve = done })
  const ticket = { kind, pending, resolve, promise: undefined, settled: false, status: undefined, reason: undefined }
  record.tickets[record.tickets.length] = ticket
  return ticket
}
function nativeToolSettleTicket(ticket, status, reason) {
  if (ticket.settled) return
  ticket.status = status
  ticket.reason = reason
  ticket.settled = true
  ticket.resolve()
}
function nativeToolObserveTicket(ticket, promise) {
  ticket.promise = promise
  try {
    nativeToolApply(nativeToolPromiseThen, promise, [
      () => { nativeToolSettleTicket(ticket, "fulfilled", undefined) },
      reason => { nativeToolSettleTicket(ticket, "rejected", reason) }
    ])
  } catch (reason) {
    nativeToolSettleTicket(ticket, "rejected", reason)
    throw reason
  }
}
function consumeNativeToolInvokeOperation(node, call, config, state) {
  const record = nativeToolGet(nativeToolRequests, node)
  if (!record) return undefined
  nativeToolAssertOperation(record)
  if (record.node !== node || record.call !== call || record.config !== config ||
    record.state !== state || record.phase !== "executing" || record.consumed)
    nativeToolInvalid(record)
  nativeToolDelete(nativeToolRequests, node)
  record.phase = "entered"
  record.consumed = true
  return record
}
function wrapNativeToolBaseHandler(record, handler) {
  return function(request) {
    const ticket = nativeToolStartTicket(record, "handler")
    let promise
    try {
      nativeToolAssertOperation(record)
      promise = nativeToolApply(handler, this, [request])
      nativeToolObserveTicket(ticket, promise)
    } catch (reason) {
      nativeToolSettleTicket(ticket, "rejected", reason)
      throw reason
    }
    return promise
  }
}
function selectNativeToolInvoke(record, tool, request, call) {
  nativeToolAssertOperation(record)
  if (record.closing) nativeToolInvalid(record)
  let declaration
  for (let index = 0; index < record.instance.declaration.declarations.length; index++) {
    const candidate = record.instance.declaration.declarations[index]
    if (candidate.tool === tool) { declaration = candidate; break }
  }
  if (!declaration) nativeToolInvalid(record)
  const selection = nativeToolFreeze({})
  const current = {
    selection, record, tool, receiver: tool, invoke: declaration.invoke, request, call,
    input: undefined, config: undefined, status: "selected", outcome: undefined,
    index: record.selections.length + 1
  }
  nativeToolSet(nativeToolSelections, selection, current)
  record.selections[record.selections.length] = selection
  return current
}
async function invokeSelectedNativeTool(selection, input, config) {
  const record = selection.record
  nativeToolAssertOperation(record)
  if (record.closing || selection.status !== "selected" ||
    nativeToolGet(nativeToolSelections, selection.selection) !== selection) nativeToolInvalid(record)
  selection.input = input
  selection.config = config
  selection.status = "invoking"
  let facts
  try {
    const value = await nativeToolApply(selection.invoke, selection.receiver, [input, config])
    facts = nativeToolFreeze({ status: "fulfilled", value })
    return value
  } catch (reason) {
    facts = nativeToolFreeze({ status: "rejected", reason })
    throw reason
  } finally {
    if (facts) {
      const outcome = nativeToolFreeze({})
      nativeToolSet(nativeToolOutcomes, outcome, { selection, record, facts })
      selection.outcome = outcome
      selection.status = "settled"
    }
  }
}
function executeNativeToolInvokeOperation(operation) {
  if (nativeToolNodeInitialized !== true) nativeToolInvalid(undefined)
  const record = nativeToolGet(nativeToolOperations, operation)
  if (!record || record.failed || record.phase !== "new") nativeToolInvalid(record)
  record.phase = "executing"
  const ticket = nativeToolStartTicket(record, "outer")
  let promise
  try {
    nativeToolAssertOperation(record)
    const previous = nativeToolGet(nativeToolRequests, record.node)
    if (previous) { previous.failed = true; nativeToolInvalid(record) }
    nativeToolSet(nativeToolRequests, record.node, record)
    promise = nativeToolApply(originalNativeToolRunTool, record.node,
      [record.call, record.config, record.state])
    // Even a failed synchronous entry gate must retain the actual async runTool settlement.
    nativeToolObserveTicket(ticket, promise)
    if (!record.consumed || nativeToolGet(nativeToolRequests, record.node) === record)
      nativeToolInvalid(record)
  } catch (reason) {
    if (promise === undefined) nativeToolSettleTicket(ticket, "rejected", reason)
    record.failed = true
    throw reason
  } finally {
    if (nativeToolGet(nativeToolRequests, record.node) === record)
      nativeToolDelete(nativeToolRequests, record.node)
  }
  return nativeToolApply(nativeToolPromiseThen, promise, [
    value => { record.phase = "settled"; if (record.failed) nativeToolInvalid(record); return value },
    reason => { record.phase = "settled"; throw reason }
  ])
}
function readNativeToolInvokeSelections(operation) {
  if (nativeToolNodeInitialized !== true) return undefined
  const record = nativeToolGet(nativeToolOperations, operation)
  if (!record) return nativeToolFreeze([])
  const result = []
  for (let index = 0; index < record.selections.length; index++) result[index] = record.selections[index]
  return nativeToolFreeze(result)
}
function readNativeToolInvokeSelection(selection, operation) {
  if (nativeToolNodeInitialized !== true) return undefined
  const record = nativeToolGet(nativeToolOperations, operation)
  const current = nativeToolGet(nativeToolSelections, selection)
  if (!record || !current || current.record !== record) return undefined
  return nativeToolFreeze({
    tool: current.tool, receiver: current.receiver, invoke: current.invoke,
    request: current.request, call: current.call, input: current.input, config: current.config,
    index: current.index, status: current.status, outcome: current.outcome
  })
}
function readNativeToolInvokeOutcome(outcome, selection, operation) {
  if (nativeToolNodeInitialized !== true) return undefined
  const record = nativeToolGet(nativeToolOperations, operation)
  const current = nativeToolGet(nativeToolSelections, selection)
  const settled = nativeToolGet(nativeToolOutcomes, outcome)
  if (!record || !current || !settled || current.record !== record || settled.record !== record ||
    settled.selection !== current || current.outcome !== outcome) return undefined
  return settled.facts
}
function closeAndDrainNativeToolInvokeOperation(operation) {
  if (nativeToolNodeInitialized !== true) nativeToolInvalid(undefined)
  const record = nativeToolGet(nativeToolOperations, operation)
  if (!record) nativeToolInvalid(undefined)
  if (record.drain) return record.drain
  record.closing = true
  record.drain = (async () => {
    const failures = []
    for (let index = 0; index < record.tickets.length; index++) {
      const ticket = record.tickets[index]
      await ticket.pending
      if (ticket.status === "rejected") failures[failures.length] = ticket.reason
    }
    if (failures.length > 1) throw new AggregateError(failures, "LANGCHAIN_NATIVE_TOOL_INVOKE_FAILED")
    if (failures.length === 1) throw failures[0]
  })()
  return record.drain
}
