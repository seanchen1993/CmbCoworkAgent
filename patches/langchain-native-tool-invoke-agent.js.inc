// Pinned SDK input provenance only. No application Source or event permission.
const nativeToolAgentApply = Reflect.apply
const nativeToolAgentGetOwn = Object.getOwnPropertyDescriptor
const nativeToolAgentGetProto = Object.getPrototypeOf
const nativeToolAgentFreeze = Object.freeze
const nativeToolAgentWeakGet = WeakMap.prototype.get
const nativeToolAgentWeakSet = WeakMap.prototype.set
const nativeToolConstructions = new WeakMap()
const nativeToolAgents = new WeakMap()

function nativeToolAgentGet(map, key) {
  return nativeToolAgentApply(nativeToolAgentWeakGet, map, [key])
}
function nativeToolAgentSet(map, key, value) {
  nativeToolAgentApply(nativeToolAgentWeakSet, map, [key, value])
}
function nativeToolAgentInvalid(record) {
  if (record) record.failed = true
  throw new Error("LANGCHAIN_NATIVE_TOOL_INVOKE_ORIGIN_INVALID")
}
function nativeToolSameDescriptor(before, current) {
  return !!before && !!current && "value" in before && "value" in current &&
    before.value === current.value && before.writable === current.writable &&
    before.enumerable === current.enumerable && before.configurable === current.configurable
}
function nativeToolOwnData(value, key, optional = false) {
  const field = nativeToolAgentGetOwn(value, key)
  if (!field && optional) return undefined
  if (!field || !("value" in field)) nativeToolAgentInvalid(undefined)
  return field
}
function nativeToolCaptureList(value) {
  if (!Array.isArray(value)) nativeToolAgentInvalid(undefined)
  const length = nativeToolOwnData(value, "length")
  const fields = []
  for (let index = 0; index < length.value; index++)
    fields[index] = nativeToolOwnData(value, String(index))
  return { value, prototype: nativeToolAgentGetProto(value), length, fields }
}
function nativeToolAssertList(record, list) {
  if (nativeToolAgentGetProto(list.value) !== list.prototype ||
    !nativeToolSameDescriptor(list.length, nativeToolAgentGetOwn(list.value, "length")))
    nativeToolAgentInvalid(record)
  for (let index = 0; index < list.fields.length; index++)
    if (!nativeToolSameDescriptor(list.fields[index], nativeToolAgentGetOwn(list.value, String(index))))
      nativeToolAgentInvalid(record)
}
function nativeToolCaptureInvoke(tool) {
  if (!tool || (typeof tool !== "object" && typeof tool !== "function")) return undefined
  const path = []
  let current = tool
  for (let depth = 0; current !== null && depth < 64; depth++) {
    const descriptor = nativeToolAgentGetOwn(current, "invoke")
    const prototype = nativeToolAgentGetProto(current)
    path[path.length] = { current, prototype, descriptor }
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") return undefined
      return { tool, invoke: descriptor.value, path }
    }
    current = prototype
  }
  return undefined
}
function nativeToolAssertInvoke(record, declaration) {
  for (let index = 0; index < declaration.path.length; index++) {
    const step = declaration.path[index]
    const descriptor = nativeToolAgentGetOwn(step.current, "invoke")
    if (nativeToolAgentGetProto(step.current) !== step.prototype ||
      (step.descriptor === undefined ? descriptor !== undefined :
        !nativeToolSameDescriptor(step.descriptor, descriptor))) nativeToolAgentInvalid(record)
  }
}
function nativeToolAssertConstruction(record) {
  if (!record || record.failed ||
    nativeToolAgentGet(nativeToolConstructions, record.request) !== record ||
    nativeToolAgentGetProto(record.options) !== record.optionsPrototype)
    nativeToolAgentInvalid(record)
  for (let index = 0; index < record.optionFields.length; index++) {
    const field = record.optionFields[index]
    const current = nativeToolAgentGetOwn(field.owner, field.key)
    if (field.descriptor === undefined ? current !== undefined :
      !nativeToolSameDescriptor(field.descriptor, current)) nativeToolAgentInvalid(record)
  }
  for (let index = 0; index < record.lists.length; index++)
    nativeToolAssertList(record, record.lists[index])
  for (let index = 0; index < record.declarations.length; index++)
    nativeToolAssertInvoke(record, record.declarations[index])
}
function nativeToolCreateConstruction(options) {
  if (!options || typeof options !== "object") nativeToolAgentInvalid(undefined)
  const request = nativeToolAgentFreeze({})
  const record = {
    request, options, optionsPrototype: nativeToolAgentGetProto(options),
    optionFields: [], lists: [], declarations: [], failed: false,
    phase: "new", agent: undefined, node: undefined, clientTools: undefined,
    graph: undefined
  }
  const addField = (owner, key) => {
    const descriptor = nativeToolOwnData(owner, key, true)
    record.optionFields[record.optionFields.length] = { owner, key, descriptor }
    return descriptor?.value
  }
  const addTools = value => {
    if (value === undefined) return
    const list = nativeToolCaptureList(value)
    record.lists[record.lists.length] = list
    for (let index = 0; index < list.fields.length; index++) {
      const declaration = nativeToolCaptureInvoke(list.fields[index].value)
      if (declaration) record.declarations[record.declarations.length] = declaration
    }
  }
  addTools(addField(options, "tools"))
  const middleware = addField(options, "middleware")
  if (middleware !== undefined) {
    const list = nativeToolCaptureList(middleware)
    record.lists[record.lists.length] = list
    for (let index = 0; index < list.fields.length; index++) {
      const item = list.fields[index].value
      if (!item || typeof item !== "object") nativeToolAgentInvalid(record)
      addTools(addField(item, "tools"))
    }
  }
  nativeToolAgentSet(nativeToolConstructions, request, record)
  return record
}
function consumeNativeToolConstruction(request, options, agent) {
  if (request === undefined) return undefined
  const record = nativeToolAgentGet(nativeToolConstructions, request)
  nativeToolAssertConstruction(record)
  if (record.options !== options || record.phase !== "executing" || record.agent !== undefined)
    nativeToolAgentInvalid(record)
  record.agent = agent
  record.phase = "entered"
  return record
}
function readNativeToolConstruction(request, agent, tools) {
  if (nativeToolAgentInitialized !== true) return undefined
  const record = nativeToolAgentGet(nativeToolConstructions, request)
  if (!record || record.agent !== agent || record.clientTools !== tools) return undefined
  nativeToolAssertConstruction(record)
  if (record.phase !== "node" && record.phase !== "published") nativeToolAgentInvalid(record)
  return record
}
function prepareNativeToolNode(record, tools) {
  if (!record) return undefined
  nativeToolAssertConstruction(record)
  if (record.phase !== "entered" || record.clientTools !== undefined) nativeToolAgentInvalid(record)
  for (let index = 0; index < tools.length; index++) {
    let found = false
    for (let candidate = 0; candidate < record.declarations.length; candidate++)
      if (record.declarations[candidate].tool === tools[index]) found = true
    if (!found) nativeToolAgentInvalid(record)
  }
  record.clientTools = tools
  record.phase = "node"
  return record.request
}
function finishNativeToolNode(record, node) {
  if (!record) return
  nativeToolAssertConstruction(record)
  if (record.phase !== "node" || record.node !== undefined ||
    !readNativeToolNodeInstance(node, record.agent, record.request)) nativeToolAgentInvalid(record)
  record.node = node
}
function publishNativeToolAgent(record, agent, graph) {
  if (!record) return
  nativeToolAssertConstruction(record)
  if (record.agent !== agent || record.node === undefined || record.phase !== "node")
    nativeToolAgentInvalid(record)
  record.graph = graph
  record.phase = "published"
  nativeToolAgentSet(nativeToolAgents, agent, record)
}
function readNativeToolAgentInstance(agent, node, request) {
  if (nativeToolAgentInitialized !== true) return undefined
  const record = nativeToolAgentGet(nativeToolAgents, agent)
  if (!record || record.node !== node || record.request !== request) return undefined
  nativeToolAssertConstruction(record)
  if (record.phase !== "published") nativeToolAgentInvalid(record)
  return record
}
function createNativeToolInvokeAgent(options) {
  if (nativeToolAgentInitialized !== true) nativeToolAgentInvalid(undefined)
  const record = nativeToolCreateConstruction(options)
  record.phase = "executing"
  try {
    const agent = new ReactAgent(options, undefined, record.request)
    if (nativeToolAgentGet(nativeToolAgents, agent) !== record || record.phase !== "published")
      nativeToolAgentInvalid(record)
    return agent
  } catch (reason) {
    record.failed = true
    throw reason
  }
}
function createNativeToolInvokeOperation(agent, call, config, state) {
  if (nativeToolAgentInitialized !== true) nativeToolAgentInvalid(undefined)
  const record = nativeToolAgentGet(nativeToolAgents, agent)
  if (!record) nativeToolAgentInvalid(undefined)
  nativeToolAssertConstruction(record)
  return createNativeToolInvokeOperationForAgent(agent, record.node, record.request, call, config, state)
}
