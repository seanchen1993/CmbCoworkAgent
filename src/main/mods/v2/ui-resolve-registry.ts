import { performance } from "node:perf_hooks"
import { Buffer } from "node:buffer"
import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten"
import { MODS_MAX_BYTES } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import type {
  FunctionUiResolveAssembly,
  FunctionUiResolveCall,
  FunctionUiResolveComponent,
  FunctionUiResolveConstructorScope,
  FunctionUiResolveDefinition,
  FunctionUiResolveDriver,
  FunctionUiResolvePeer,
  FunctionUiResolvePreparedTable,
  FunctionUiResolvePropsProof,
  FunctionUiResolveReceipt,
  FunctionUiResolveSyncBudget,
  FunctionUiResolveTarget
} from "./ui-resolve-private-types"

export const FUNCTION_UI_RESOLVE_CONSTRUCTORS = [
  "Box",
  "Text",
  "Button",
  "Input",
  "Select",
  "Link",
  "Code",
  "Svg",
  "Markdown",
  "Client"
] as const
export type FunctionUiResolveConstructor = (typeof FUNCTION_UI_RESOLVE_CONSTRUCTORS)[number]

export interface FunctionUiResolveLimits {
  peers: number
  tables: number
  depth: number
  synchronousMs: number
}

function fail(code = "MODS_UI_RESOLVE_IDENTITY"): never {
  throw new ModFunctionError(code)
}
const opaque = <T extends object>(value: T): Readonly<T> => Object.freeze(value)

/** Local allocated credit only. Main must reserve across utilities until real disposal AND drain. */
export class FunctionUiResolveLedger {
  private handles = 0
  private roots = 0
  private failedDisposals = 0
  private limits: Readonly<{ handles: number; roots: number }>
  private creditRevision: number
  private readonly creditIdentity: object | undefined

  constructor(
    limits: { handles: number; roots: number } = {
      handles: 4096,
      roots: 32
    },
    credit?: { identity: object; revision: number }
  ) {
    if (
      Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 0) ||
      limits.handles > 4096 ||
      limits.roots > 32 ||
      (credit &&
        (!credit.identity ||
          typeof credit.identity !== "object" ||
          !Number.isSafeInteger(credit.revision) ||
          credit.revision < 0))
    )
      fail("MODS_UI_RESOLVE_LIMIT_INVALID")
    this.limits = opaque({ ...limits })
    this.creditIdentity = credit?.identity
    this.creditRevision = credit?.revision ?? 0
  }

  get stats() {
    return opaque({
      handles: this.handles,
      roots: this.roots,
      failedDisposals: this.failedDisposals
    })
  }

  /** Actual private control ACK only; no synchronous call is allowed to request new credit. */
  increaseCredit(identity: object, revision: number, limits: { handles: number; roots: number }) {
    if (
      !this.creditIdentity ||
      identity !== this.creditIdentity ||
      !Number.isSafeInteger(revision) ||
      Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 0) ||
      limits.handles > 4096 ||
      limits.roots > 32
    )
      fail("MODS_UI_RESOLVE_CREDIT")
    if (
      revision === this.creditRevision &&
      limits.handles === this.limits.handles &&
      limits.roots === this.limits.roots
    )
      return
    if (
      revision !== this.creditRevision + 1 ||
      limits.handles < this.limits.handles ||
      limits.roots < this.limits.roots
    )
      fail("MODS_UI_RESOLVE_CREDIT")
    this.limits = opaque({ ...limits })
    this.creditRevision = revision
  }

  hold(handle: QuickJSHandle): () => void {
    if (this.handles >= this.limits.handles) fail("MODS_UI_RESOLVE_LIMIT")
    this.handles++
    let live = true
    return () => {
      if (!live) return
      live = false
      try {
        handle.dispose()
        this.handles--
      } catch (error) {
        this.failedDisposals++
        throw error
      }
    }
  }

  enterRoot(): () => void {
    if (this.roots >= this.limits.roots) fail("MODS_UI_RESOLVE_LIMIT")
    this.roots++
    let live = true
    return () => {
      if (!live) return
      live = false
      this.roots--
    }
  }
}

interface AssemblyRecord {
  value: FunctionUiResolveAssembly
  controller: AbortController
  detach(): void
  retired: boolean
  peers: Set<PeerRecord>
  tables: Set<TableRecord>
  targets: Map<FunctionUiResolvePeer, Map<FunctionUiResolveComponent, FunctionUiResolveTarget>>
}
interface PeerRecord {
  value: FunctionUiResolvePeer
  assembly: AssemblyRecord
  helper: QuickJSHandle
  releaseHelper(): void
  retired: boolean
  definitions: Set<DefinitionRecord>
}
interface DefinitionRecord {
  value: FunctionUiResolveDefinition
  peer: PeerRecord
  fn: QuickJSHandle
  release(): void
  retired: boolean
  entered: number
  dependencies: ReadonlySet<DefinitionRecord>
}
interface TableRecord {
  value: FunctionUiResolvePreparedTable
  target: FunctionUiResolveTarget
  peer: PeerRecord
  handle: QuickJSHandle
  releases: Array<() => void>
  retired: boolean
  entered: number
  native: boolean
  definitions: Set<DefinitionRecord>
}
interface RootRecord {
  target: FunctionUiResolveTarget
  receipt: FunctionUiResolveReceipt
  expiresAt: number
  depth: number
  scope?: FunctionUiResolveConstructorScope
  failure?: unknown
  phase?: "constructor" | "data" | "reconnect"
}
interface PropsRecord {
  active: boolean
  callbacks: Map<string, QuickJSHandle>
  releases: Array<() => void>
}

// Captured before untrusted module evaluation. Accessors are rejected; Proxy traps can run under
// the effect-forbidden data phase. Private encoding never calls object/array toJSON.
const COPY_BOOTSTRAP = String.raw`(() => {
  const keys = Reflect.ownKeys, descriptors = Object.getOwnPropertyDescriptors;
  const proto = Object.getPrototypeOf, array = Array.isArray, freeze = Object.freeze;
  const stringify = JSON.stringify, parse = JSON.parse, plain = Object.prototype;
  const create = Object.create, define = Object.defineProperty, finite = Number.isFinite;
  const SetType = Set, apply = Reflect.apply;
  const ErrorType = Error, text = String;
  const own = Object.prototype.hasOwnProperty;
  const has = Set.prototype.has, add = Set.prototype.add, remove = Set.prototype.delete;
  const callback = key => key === "onPress" || key === "onInput" || key === "onSubmit" ||
    key === "onSelect" || key === "onLinkPress";
  function copy(value, depth, seen, root, saved, count) {
    if (depth > 32) throw ErrorType("MODS_UI_RESOLVE_DATA_DEPTH");
    if (++count.nodes > 30000) throw ErrorType("MODS_UI_RESOLVE_DATA_SIZE");
    if (value === undefined) return undefined;
    if (typeof value === "string") {
      count.text += value.length;
      if (count.text > ${MODS_MAX_BYTES}) throw ErrorType("MODS_UI_RESOLVE_DATA_SIZE");
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && finite(value)) return value;
    if (typeof value !== "object" || apply(has, seen, [value]))
      throw ErrorType("MODS_UI_RESOLVE_DATA");
    const isArray = array(value), p = proto(value);
    if (!isArray && p !== plain && p !== null) throw ErrorType("MODS_UI_RESOLVE_DATA");
    apply(add, seen, [value]);
    const result = isArray ? [] : create(null), props = descriptors(value), names = keys(props);
    if (isArray && props.length.value > 30000) throw ErrorType("MODS_UI_RESOLVE_DATA_SIZE");
    for (let i = 0; i < names.length; i++) {
      const key = names[i];
      if (typeof key !== "string") throw ErrorType("MODS_UI_RESOLVE_DATA");
      count.text += key.length;
      if (count.text > ${MODS_MAX_BYTES}) throw ErrorType("MODS_UI_RESOLVE_DATA_SIZE");
      if (key === "__proto__" || key === "prototype" || key === "constructor")
        throw ErrorType("MODS_UI_RESOLVE_DATA");
      const d = props[key];
      if (!("value" in d)) throw ErrorType("MODS_UI_RESOLVE_DATA");
      if (!d.enumerable) continue;
      if (isArray && (key === "" || text(+key) !== key || +key < 0 || +key >= props.length.value))
        throw ErrorType("MODS_UI_RESOLVE_DATA");
      if (typeof d.value === "function" && callback(key)) {
        if (root && saved) saved[key] = d.value;
        continue;
      }
      const item = copy(d.value, depth + 1, seen, false, null, count);
      if (item !== undefined) define(result, key,
        { value: item, enumerable: true, configurable: true, writable: true });
    }
    apply(remove, seen, [value]);
    return result;
  }
  function encode(value) {
    if (value === null || typeof value !== "object") return stringify(value);
    const d = descriptors(value), names = keys(d);
    let encoded = "";
    if (array(value)) {
      for (let i = 0; i < d.length.value; i++) {
        if (i) encoded += ",";
        encoded += apply(own, d, [text(i)]) ? encode(d[i].value) : "null";
      }
      return "[" + encoded + "]";
    }
    for (let i = 0; i < names.length; i++) {
      const key = names[i];
      if (i) encoded += ",";
      encoded += stringify(key) + ":" + encode(d[key].value);
    }
    return "{" + encoded + "}";
  }
  function bounded(value) {
    const encoded = encode(value);
    if (typeof encoded !== "string" || encoded.length > ${MODS_MAX_BYTES})
      throw ErrorType("MODS_UI_RESOLVE_DATA_SIZE");
    return encoded;
  }
  return (mode, input) => {
    if (mode === "freeze") return freeze(input);
    if (mode === "parse") return parse(input);
    if (mode === "table") {
      if (typeof input !== "object" || input === null || array(input) ||
          (proto(input) !== plain && proto(input) !== null))
        throw ErrorType("MODS_UI_RESOLVE_TABLE");
      const d = descriptors(input), names = keys(d), result = create(null);
      for (let i = 0; i < names.length; i++) {
        const key = names[i];
        if (key !== "Box" && key !== "Text" && key !== "Button" && key !== "Input" &&
            key !== "Select" && key !== "Link" && key !== "Code" && key !== "Svg" &&
            key !== "Markdown" && key !== "Client") throw ErrorType("MODS_UI_RESOLVE_TABLE");
        if (!("value" in d[key]) || typeof d[key].value !== "function")
          throw ErrorType("MODS_UI_RESOLVE_TABLE");
        result[key] = d[key].value;
      }
      return result;
    }
    if (mode === "transparent") return props => {
      const children = [], append = (value, depth) => {
        if (depth > 24 || children.length >= 1000) throw ErrorType("MODS_UI_RESOLVE_DATA_SIZE");
        if (array(value)) {
          for (let i = 0; i < value.length; i++) append(value[i], depth + 1);
        } else if (value !== null && value !== undefined && typeof value !== "boolean") {
          define(children, text(children.length), {value: typeof value === "number" ? text(value) :
            value, enumerable: true, configurable: true, writable: true});
        }
      };
      append(props?.children, 0);
      return {type:"fragment",children};
    };
    if (mode === "props") {
      input ??= {};
      if (typeof input !== "object" || input === null || array(input))
        throw ErrorType("MODS_UI_RESOLVE_PROPS");
      const saved = create(null);
      const data = copy(input, 0, new SetType(), true, saved, {nodes:0,text:0});
      const original = descriptors(input);
      const d = apply(own, original, ["children"]) ? original.children : null;
      return { json: bounded(data), callbacks: saved, children: d ? d.value : undefined,
        key: typeof data.key === "string" ? data.key :
          typeof data.label === "string" ? data.label : undefined };
    }
    const result = copy(input, 0, new SetType(), false, null, {nodes:0,text:0});
    const encoded = bounded(result);
    if (typeof encoded !== "string") throw ErrorType("MODS_UI_RESOLVE_DATA");
    return encoded;
  };
})()`

const capturedCopiers = new WeakMap<QuickJSContext, QuickJSHandle>()

/** Called by VM creation before any untrusted bootstrap/module. Returns the VM owner's cleanup. */
export function installFunctionUiResolveDataCopy(context: QuickJSContext): () => void {
  if (capturedCopiers.has(context)) fail("MODS_UI_RESOLVE_COPY_ALREADY_INSTALLED")
  const result = context.evalCode(COPY_BOOTSTRAP)
  if (result.error) {
    result.error.dispose()
    fail("MODS_UI_RESOLVE_COPY_REQUIRED")
  }
  const handle = result.value
  capturedCopiers.set(context, handle)
  let live = true
  return () => {
    if (!live) return
    live = false
    capturedCopiers.delete(context)
    handle.dispose()
  }
}

/**
 * Unwired utility foundation. Handles never leave their actual VM or become public JSON tokens.
 * The host driver supplies SDK execution, CPU accounting and final Q callback reconciliation.
 */
export class FunctionUiResolveRegistry {
  private readonly assemblies = new WeakMap<FunctionUiResolveAssembly, AssemblyRecord>()
  private readonly hostAssemblies = new WeakMap<object, AssemblyRecord>()
  private readonly peers = new WeakMap<FunctionUiResolvePeer, PeerRecord>()
  private readonly contextPeers = new WeakMap<QuickJSContext, PeerRecord>()
  private readonly actorPeers = new WeakMap<object, PeerRecord>()
  private readonly definitions = new WeakMap<FunctionUiResolveDefinition, DefinitionRecord>()
  private readonly targets = new WeakMap<FunctionUiResolveTarget, AssemblyRecord>()
  private readonly receipts = new WeakSet<FunctionUiResolveReceipt>()
  private readonly tables = new WeakMap<FunctionUiResolvePreparedTable, TableRecord>()
  private readonly props = new WeakMap<FunctionUiResolvePropsProof, PropsRecord>()
  private readonly cached = new Map<FunctionUiResolveTarget, TableRecord>()
  private readonly occupied = new Set<AssemblyRecord>()
  private readonly limits: Readonly<FunctionUiResolveLimits>
  private root: RootRecord | undefined
  private closed = false

  constructor(
    private readonly driver: FunctionUiResolveDriver,
    private readonly ledger = new FunctionUiResolveLedger(),
    limits: Partial<FunctionUiResolveLimits> = {},
    private readonly now: () => number = () => performance.now()
  ) {
    this.limits = opaque({ peers: 16, tables: 224, depth: 24, synchronousMs: 50, ...limits })
    if (
      Object.values(this.limits).some((value) => !Number.isFinite(value) || value <= 0) ||
      !Number.isSafeInteger(this.limits.peers) ||
      this.limits.peers > 16 ||
      !Number.isSafeInteger(this.limits.tables) ||
      this.limits.tables > 224 ||
      !Number.isSafeInteger(this.limits.depth) ||
      this.limits.depth > 24 ||
      this.limits.synchronousMs > 50
    )
      fail("MODS_UI_RESOLVE_LIMIT_INVALID")
  }

  registerAssembly(hostIdentity: object, signal: AbortSignal): FunctionUiResolveAssembly {
    if (
      this.closed ||
      !hostIdentity ||
      typeof hostIdentity !== "object" ||
      this.hostAssemblies.has(hostIdentity)
    )
      fail()
    signal.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    const value = opaque({ hostIdentity, signal: controller.signal })
    const record: AssemblyRecord = {
      value,
      controller,
      detach: () => signal.removeEventListener("abort", abort),
      retired: false,
      peers: new Set(),
      tables: new Set(),
      targets: new Map()
    }
    this.assemblies.set(value, record)
    this.hostAssemblies.set(hostIdentity, record)
    this.occupied.add(record)
    return value
  }

  /** Registration may happen after load, but the copier must have been installed by VM creation. */
  registerPeer(
    assembly: FunctionUiResolveAssembly,
    actor: object,
    context: QuickJSContext,
    assertCurrent: () => void
  ): FunctionUiResolvePeer {
    const group = this.assembly(assembly)
    if (group.peers.size >= this.limits.peers || !actor || typeof actor !== "object")
      fail("MODS_UI_RESOLVE_LIMIT")
    if (this.contextPeers.has(context) || this.actorPeers.has(actor)) fail()
    assertCurrent()
    this.assembly(assembly)
    const captured = capturedCopiers.get(context)
    if (!captured?.alive) fail("MODS_UI_RESOLVE_COPY_REQUIRED")
    const helper = captured.dup()
    let releaseHelper: () => void
    try {
      releaseHelper = this.ledger.hold(helper)
    } catch (error) {
      helper.dispose()
      throw error
    }
    const value = opaque({
      assembly,
      actor,
      context,
      runtime: context.runtime,
      assertCurrent: () => {
        this.assembly(assembly)
        assertCurrent()
        this.assembly(assembly)
      }
    })
    const record: PeerRecord = {
      value,
      assembly: group,
      helper,
      releaseHelper,
      retired: false,
      definitions: new Set()
    }
    this.peers.set(value, record)
    this.contextPeers.set(context, record)
    this.actorPeers.set(actor, record)
    group.peers.add(record)
    return value
  }

  registerDefinition(
    peer: FunctionUiResolvePeer,
    registration: object,
    fn: QuickJSHandle,
    assertCurrent: () => void = () => {},
    dependencies: readonly FunctionUiResolveDefinition[] = []
  ): FunctionUiResolveDefinition {
    const actual = this.peer(peer)
    peer.runtime.assertOwned(fn)
    if (!registration || typeof registration !== "object" || peer.context.typeof(fn) !== "function")
      fail()
    assertCurrent()
    this.peer(peer)
    const graph = new Set<DefinitionRecord>()
    for (const dependency of dependencies) {
      const source = this.definition(dependency)
      if (source.peer.assembly !== actual.assembly) fail()
      graph.add(source)
      for (const nested of source.dependencies) graph.add(nested)
    }
    const handle = fn.dup()
    let release: () => void
    try {
      release = this.ledger.hold(handle)
    } catch (error) {
      handle.dispose()
      throw error
    }
    const value = opaque({
      peer,
      registration,
      assertCurrent: () => {
        this.peer(peer)
        assertCurrent()
        if (this.definitions.get(value)?.retired) fail("MODS_UI_RESOLVE_RETIRED")
      }
    })
    const record: DefinitionRecord = {
      value,
      peer: actual,
      fn: handle,
      release,
      retired: false,
      entered: 0,
      dependencies: graph
    }
    this.definitions.set(value, record)
    actual.definitions.add(record)
    return value
  }

  /** Host assembly supplies a real registration and reuses this actual function for omissions. */
  registerTransparentDefinition(
    peer: FunctionUiResolvePeer,
    registration: object,
    assertCurrent: () => void = () => {},
    dependencies: readonly FunctionUiResolveDefinition[] = []
  ) {
    const actual = this.peer(peer)
    const fn = this.helper(actual, "transparent", peer.context.undefined)
    try {
      return this.registerDefinition(peer, registration, fn, assertCurrent, dependencies)
    } finally {
      fn.dispose()
    }
  }

  /** Caller owns each returned handle. The assembly driver must enter its effect-forbidden data phase. */
  readFunctionTable(peer: FunctionUiResolvePeer, table: QuickJSHandle) {
    const actual = this.peer(peer)
    peer.runtime.assertOwned(table)
    const packet = this.helper(actual, "table", table)
    const functions: Partial<Record<FunctionUiResolveConstructor, QuickJSHandle>> = {}
    try {
      for (const name of FUNCTION_UI_RESOLVE_CONSTRUCTORS) {
        const fn = peer.context.getProp(packet, name)
        if (peer.context.typeof(fn) === "undefined") fn.dispose()
        else functions[name] = fn
      }
      return functions
    } catch (error) {
      for (const fn of Object.values(functions)) fn.dispose()
      throw error
    } finally {
      packet.dispose()
    }
  }

  target(consumer: FunctionUiResolvePeer, component: FunctionUiResolveComponent) {
    const peer = this.peer(consumer)
    if (component !== "Pane" && !FUNCTION_UI_SITES.some((site) => site === component)) fail()
    let components = peer.assembly.targets.get(consumer)
    if (!components) peer.assembly.targets.set(consumer, (components = new Map()))
    let value = components.get(component)
    if (!value) {
      value = opaque({ assembly: consumer.assembly, consumer, component })
      components.set(component, value)
      this.targets.set(value, peer.assembly)
    }
    return value
  }

  prepareTable(
    target: FunctionUiResolveTarget,
    resident: FunctionUiResolvePeer,
    entries: Partial<Record<FunctionUiResolveConstructor, FunctionUiResolveDefinition>>
  ): FunctionUiResolvePreparedTable {
    this.assertTarget(target, resident)
    const peer = this.peer(resident)
    if (
      Object.keys(entries).some(
        (name) => !FUNCTION_UI_RESOLVE_CONSTRUCTORS.includes(name as FunctionUiResolveConstructor)
      )
    )
      fail("MODS_UI_RESOLVE_TABLE")
    const value = opaque({ target, resident })
    const handle = resident.context.newObject()
    const record: TableRecord = {
      value,
      target,
      peer,
      handle,
      releases: [],
      retired: false,
      entered: 0,
      native: false,
      definitions: new Set()
    }
    try {
      record.releases.push(this.ledger.hold(handle))
      for (const [name, definition] of Object.entries(entries)) {
        if (!definition) fail("MODS_UI_RESOLVE_TABLE")
        const actual = this.definition(definition)
        if (actual.peer.assembly !== peer.assembly) fail()
        record.definitions.add(actual)
        for (const dependency of actual.dependencies) record.definitions.add(dependency)
        const proxy = resident.context.newFunction(name, (...args) =>
          this.invoke(record, actual, args, name as FunctionUiResolveConstructor)
        )
        try {
          record.releases.push(this.ledger.hold(proxy))
        } catch (error) {
          proxy.dispose()
          throw error
        }
        resident.context.setProp(handle, name, proxy)
      }
      this.freeze(peer, handle)
      this.tables.set(value, record)
      peer.assembly.tables.add(record)
      return value
    } catch (error) {
      if (record.releases.length) this.releaseAll(record.releases)
      else handle.dispose()
      throw error
    }
  }

  /** No-hook path: one frozen actual native table, no foreign scope, handles or RPC. */
  cacheNativeTable(target: FunctionUiResolveTarget, handle: QuickJSHandle) {
    this.assertTarget(target, target.consumer)
    const peer = this.peer(target.consumer)
    peer.value.runtime.assertOwned(handle)
    if (peer.value.context.typeof(handle) !== "object") fail("MODS_UI_RESOLVE_TABLE")
    this.freeze(peer, handle)
    const value = opaque({ target, resident: target.consumer })
    const owned = handle.dup()
    const record: TableRecord = {
      value,
      target,
      peer,
      handle: owned,
      releases: [() => owned.dispose()],
      retired: false,
      entered: 0,
      native: true,
      definitions: new Set()
    }
    this.tables.set(value, record)
    peer.assembly.tables.add(record)
    try {
      this.adoptTable(value)
    } catch (error) {
      this.retireTable(value)
      throw error
    }
    return value
  }

  adoptTable(table: FunctionUiResolvePreparedTable): void {
    const actual = this.table(table)
    if (actual.peer.value !== actual.target.consumer) fail("MODS_UI_RESOLVE_TABLE")
    const previous = this.cached.get(actual.target)
    const count = [...this.cached.keys()].filter(
      (target) => target.assembly === actual.target.assembly
    ).length
    if (!previous && count >= this.limits.tables) fail("MODS_UI_RESOLVE_LIMIT")
    this.cached.set(actual.target, actual)
    if (previous && previous !== actual) this.retireTable(previous.value)
  }

  readTable(target: FunctionUiResolveTarget): QuickJSHandle {
    this.assertTarget(target, target.consumer)
    const record = this.cached.get(target)
    if (!record) fail("MODS_UI_RESOLVE_TABLE")
    return this.table(record.value).handle.dup()
  }

  /** Private lower-table import; its resident may be P, while its consumer remains Q. */
  readPreparedTable(table: FunctionUiResolvePreparedTable): QuickJSHandle {
    return this.table(table).handle.dup()
  }

  /** Real retained definitions and actual imported lower dependencies, never hook JSON metadata. */
  sources(table: FunctionUiResolvePreparedTable): readonly FunctionUiResolveDefinition[] {
    const actual = this.table(table)
    const values: FunctionUiResolveDefinition[] = []
    for (const definition of actual.definitions) {
      this.definition(definition.value)
      values.push(definition.value)
    }
    return Object.freeze(values)
  }

  retireDefinition(definition: FunctionUiResolveDefinition): void {
    const actual = this.definitions.get(definition)
    if (!actual) fail()
    actual.retired = true
    this.disposeDefinition(actual)
  }

  retireTable(table: FunctionUiResolvePreparedTable): void {
    const actual = this.tables.get(table)
    if (!actual) fail()
    actual.retired = true
    if (this.cached.get(actual.target) === actual) this.cached.delete(actual.target)
    this.disposeTable(actual)
  }

  retireAssembly(assembly: FunctionUiResolveAssembly): void {
    const actual = this.assemblies.get(assembly)
    if (!actual) fail()
    if (actual.retired) return
    actual.retired = true
    actual.controller.abort(new ModFunctionError("MODS_UI_RESOLVE_RETIRED"))
    actual.detach()
    let failure: unknown
    for (const table of [...actual.tables]) {
      try {
        this.retireTable(table.value)
      } catch (error) {
        failure ??= error
      }
    }
    for (const peer of actual.peers) {
      peer.retired = true
      for (const definition of [...peer.definitions]) {
        try {
          this.retireDefinition(definition.value)
        } catch (error) {
          failure ??= error
        }
      }
    }
    try {
      this.disposeAssembly(actual)
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) throw failure
  }

  close(): void {
    this.closed = true
    let failure: unknown
    for (const assembly of [...this.occupied]) {
      try {
        this.retireAssembly(assembly.value)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }

  /** A private proof may only be used by the synchronous call which minted it. */
  assertProps(proof: FunctionUiResolvePropsProof): void {
    const actual = this.props.get(proof)
    if (!actual?.active) fail("MODS_UI_RESOLVE_PROPS_EXPIRED")
    proof.assertCurrent()
  }

  assertReceipt(receipt: FunctionUiResolveReceipt, target?: FunctionUiResolveTarget): void {
    if (!this.receipts.has(receipt)) fail()
    this.peer(receipt.consumer)
    if (target) {
      this.assertTarget(target, target.consumer)
      if (target.consumer !== receipt.consumer || target.component !== receipt.component) fail()
    }
    receipt.signal.throwIfAborted()
    receipt.assertCurrent()
  }

  private invoke(
    table: TableRecord,
    definition: DefinitionRecord,
    args: QuickJSHandle[],
    constructorName: FunctionUiResolveConstructor
  ) {
    if (this.root?.phase === "data" || this.root?.phase === "reconnect") {
      const error = new ModFunctionError("MODS_UI_RESOLVE_DATA_REENTRY")
      this.root.failure ??= error
      throw error
    }
    try {
      this.table(table.value)
      this.definition(definition.value)
      if (args.length > 1) fail("MODS_UI_RESOLVE_PROPS")
    } catch (error) {
      if (this.root) this.root.failure ??= error
      throw error
    }
    const outer = !this.root
    const releaseRoot = outer ? this.ledger.enterRoot() : undefined
    let scope: FunctionUiResolveConstructorScope | undefined
    let result: QuickJSHandle | undefined
    let proof: FunctionUiResolvePropsProof | undefined
    let enteredDepth = false
    const parent = this.root
    try {
      if (outer) {
        const raw = this.driver.captureCurrent(table.target, table.peer.value)
        if (
          raw.consumer !== table.target.consumer ||
          raw.component !== table.target.component ||
          !raw.identity ||
          typeof raw.identity !== "object"
        )
          fail()
        raw.signal.throwIfAborted()
        raw.assertCurrent()
        const sourceSignal = raw.signal
        const sourceGuard = raw.assertCurrent.bind(raw)
        const receipt = opaque({
          consumer: raw.consumer,
          component: raw.component,
          identity: raw.identity,
          signal: AbortSignal.any([sourceSignal, table.target.assembly.signal]),
          assertCurrent: () => {
            if (capturedRoot.failure) throw capturedRoot.failure
            sourceSignal.throwIfAborted()
            sourceGuard()
          }
        })
        this.receipts.add(receipt)
        const capturedRoot: RootRecord = {
          target: table.target,
          receipt,
          expiresAt: this.now() + this.limits.synchronousMs,
          depth: 0
        }
        this.root = capturedRoot
      }
      const root = this.root
      if (!root || root.target !== table.target || !this.receipts.has(root.receipt)) fail()
      root.depth++
      enteredDepth = true
      if (root.depth > this.limits.depth) fail("MODS_UI_RESOLVE_DEPTH")
      const budget = opaque({
        expiresAt: root.expiresAt,
        depth: root.depth,
        assertRemaining: () => {
          if (this.now() >= root.expiresAt) fail("MODS_UI_RESOLVE_BUDGET")
        }
      })
      const call = opaque({
        constructorName,
        definition: definition.value,
        target: table.target,
        resident: table.peer.value,
        receipt: root.receipt,
        budget
      })
      if (outer) root.scope = this.driver.createConstructorScope(definition.value, root.receipt)
      scope = root.scope
      if (!scope) fail()
      const assertCurrent = () => {
        if (root.failure) throw root.failure
        this.table(table.value)
        this.definition(definition.value)
        root.receipt.signal.throwIfAborted()
        root.receipt.assertCurrent()
        scope?.assertCurrent()
        budget.assertRemaining()
      }
      table.entered++
      definition.entered++
      try {
        assertCurrent()
        const copied = this.runSync(scope, call, table.peer.value, budget, "data", () => {
          const packet = this.helper(
            table.peer,
            "props",
            args[0] ?? table.peer.value.context.undefined
          )
          try {
            const json = table.peer.value.context.getProp(packet, "json")
            try {
              if (outer)
                proof = this.propsProof(call, args[0] ?? table.peer.value.context.undefined, packet)
              return this.jsonText(table.peer, json)
            } finally {
              json.dispose()
            }
          } finally {
            packet.dispose()
          }
        })
        assertCurrent()
        const p = definition.peer.value.context
        const input = this.runSync(scope, call, definition.peer.value, budget, "data", () =>
          this.parse(definition.peer, copied)
        )
        let output: QuickJSHandle
        try {
          output = this.runSync(scope, call, definition.peer.value, budget, "constructor", () =>
            this.takeResult(p.callFunction(definition.fn, p.undefined, input))
          )
        } finally {
          input.dispose()
        }
        let json: QuickJSHandle
        try {
          assertCurrent()
          json = this.runSync(scope, call, definition.peer.value, budget, "data", () =>
            this.helper(definition.peer, "copy", output)
          )
        } finally {
          output.dispose()
        }
        let text: string
        try {
          text = this.jsonText(definition.peer, json)
        } finally {
          json.dispose()
        }
        assertCurrent()
        result = this.runSync(scope, call, table.peer.value, budget, "data", () =>
          this.parse(table.peer, text)
        )
        assertCurrent()
        if (outer) {
          if (!proof) fail()
          this.assertProps(proof)
          const originalProof = proof
          const originalOutput = result
          const reconnected = this.runSync(scope, call, table.peer.value, budget, "reconnect", () =>
            this.driver.reconnect(call, originalProof, originalOutput)
          )
          if (reconnected === result) fail("MODS_UI_RESOLVE_HANDLE_ALIAS")
          table.peer.value.runtime.assertOwned(reconnected)
          result.dispose()
          result = reconnected
          assertCurrent()
        }
        if (outer) scope.finishNormal()
        scope = undefined
        const returned = result
        result = undefined
        return returned
      } finally {
        definition.entered--
        table.entered--
        this.disposeDefinition(definition)
        this.disposeTable(table)
        this.disposeAssembly(table.peer.assembly)
      }
    } catch (error) {
      if (this.root) this.root.failure ??= error
      if (outer) scope?.finishFailure(error)
      throw error
    } finally {
      result?.dispose()
      if (proof) this.releaseProps(proof)
      if (this.root && enteredDepth) this.root.depth--
      this.root = outer ? parent : this.root
      releaseRoot?.()
    }
  }

  private propsProof(call: FunctionUiResolveCall, original: QuickJSHandle, packet: QuickJSHandle) {
    const peer = this.peer(call.resident)
    const vm = peer.value.context
    const record: PropsRecord = { active: true, callbacks: new Map(), releases: [] }
    let children: QuickJSHandle | undefined
    try {
      const callbacks = vm.getProp(packet, "callbacks")
      try {
        for (const name of ["onPress", "onInput", "onSubmit", "onSelect", "onLinkPress"]) {
          const fn = vm.getProp(callbacks, name)
          if (vm.typeof(fn) === "undefined") {
            fn.dispose()
            continue
          }
          try {
            record.releases.push(this.ledger.hold(fn))
          } catch (error) {
            fn.dispose()
            throw error
          }
          record.callbacks.set(name, fn)
        }
      } finally {
        callbacks.dispose()
      }
      const rawChildren = vm.getProp(packet, "children")
      if (vm.typeof(rawChildren) === "undefined") rawChildren.dispose()
      else {
        try {
          record.releases.push(this.ledger.hold(rawChildren))
        } catch (error) {
          rawChildren.dispose()
          throw error
        }
        children = rawChildren
      }
      const key = vm.getProp(packet, "key")
      let rootKey: string | undefined
      try {
        if (vm.typeof(key) === "string") rootKey = vm.getString(key)
      } finally {
        key.dispose()
      }
      const actions = this.driver.captureActions(call, original)
      if (!actions || typeof actions !== "object") fail()
      const value = opaque({
        peer: call.resident,
        rootKey,
        children,
        actions,
        callback: (name: string) => {
          if (!record.active) fail("MODS_UI_RESOLVE_PROPS_EXPIRED")
          return record.callbacks.get(name)
        },
        assertCurrent: () => {
          if (!record.active) fail("MODS_UI_RESOLVE_PROPS_EXPIRED")
          call.receipt.signal.throwIfAborted()
          call.receipt.assertCurrent()
          this.peer(call.resident)
        }
      })
      this.props.set(value, record)
      return value
    } catch (error) {
      record.active = false
      this.releaseAll(record.releases)
      throw error
    }
  }

  private releaseProps(proof: FunctionUiResolvePropsProof) {
    const record = this.props.get(proof)
    if (!record) fail()
    record.active = false
    this.releaseAll(record.releases)
  }

  private helper(peer: PeerRecord, mode: string, input: QuickJSHandle) {
    const argument = peer.value.context.newString(mode)
    try {
      return this.takeResult(
        peer.value.context.callFunction(peer.helper, peer.value.context.undefined, argument, input)
      )
    } finally {
      argument.dispose()
    }
  }

  private runSync<T>(
    scope: FunctionUiResolveConstructorScope,
    call: FunctionUiResolveCall,
    peer: FunctionUiResolvePeer,
    budget: FunctionUiResolveSyncBudget,
    phase: "constructor" | "data" | "reconnect",
    run: () => T
  ): T {
    const root = this.root
    if (!root) fail()
    const previous = root.phase
    root.phase = phase
    try {
      return scope.runSync(call, peer, budget, phase, run)
    } finally {
      root.phase = previous
    }
  }

  private freeze(peer: PeerRecord, handle: QuickJSHandle) {
    const result = this.helper(peer, "freeze", handle)
    result.dispose()
  }

  private parse(peer: PeerRecord, text: string) {
    const input = peer.value.context.newString(text)
    try {
      return this.helper(peer, "parse", input)
    } finally {
      input.dispose()
    }
  }

  private jsonText(peer: PeerRecord, value: QuickJSHandle) {
    const text = peer.value.context.getString(value)
    if (Buffer.byteLength(text, "utf8") > MODS_MAX_BYTES) fail("MODS_UI_RESOLVE_DATA_SIZE")
    return text
  }

  private takeResult(result: ReturnType<QuickJSContext["evalCode"]>): QuickJSHandle {
    if (result.error) {
      result.error.dispose()
      fail("MODS_UI_RESOLVE_CONSTRUCTOR")
    }
    return result.value
  }

  private assembly(value: FunctionUiResolveAssembly) {
    const record = this.assemblies.get(value)
    if (!record) fail()
    if (record.retired || this.closed) fail("MODS_UI_RESOLVE_RETIRED")
    value.signal.throwIfAborted()
    return record
  }
  private peer(value: FunctionUiResolvePeer) {
    const record = this.peers.get(value)
    if (!record) fail()
    this.assembly(value.assembly)
    if (record.retired) fail("MODS_UI_RESOLVE_RETIRED")
    value.assertCurrent()
    return record
  }
  private definition(value: FunctionUiResolveDefinition) {
    const record = this.definitions.get(value)
    if (!record) fail()
    this.peer(value.peer)
    value.assertCurrent()
    if (record.retired) fail("MODS_UI_RESOLVE_RETIRED")
    return record
  }
  private table(value: FunctionUiResolvePreparedTable) {
    const record = this.tables.get(value)
    if (!record) fail()
    this.assertTarget(record.target, record.peer.value)
    if (record.retired) fail("MODS_UI_RESOLVE_RETIRED")
    return record
  }
  private assertTarget(target: FunctionUiResolveTarget, resident: FunctionUiResolvePeer) {
    const assembly = this.targets.get(target)
    if (
      !assembly ||
      this.peer(resident).assembly !== assembly ||
      this.peer(target.consumer).assembly !== assembly
    )
      fail()
    this.assembly(target.assembly)
  }
  private disposeDefinition(record: DefinitionRecord) {
    if (!record.retired || record.entered) return
    record.release()
    record.peer.definitions.delete(record)
  }
  private disposeTable(record: TableRecord) {
    if (!record.retired || record.entered) return
    this.releaseAll(record.releases)
    record.peer.assembly.tables.delete(record)
  }
  private disposeAssembly(record: AssemblyRecord) {
    if (
      !record.retired ||
      record.tables.size ||
      [...record.peers].some((peer) => peer.definitions.size)
    )
      return
    let failure: unknown
    for (const peer of record.peers) {
      try {
        peer.releaseHelper()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
    record.peers.clear()
    this.occupied.delete(record)
  }
  private releaseAll(releases: Array<() => void>) {
    let error: unknown
    for (const release of releases.splice(0).reverse()) {
      try {
        release()
      } catch (cause) {
        error ??= cause
      }
    }
    if (error) throw error
  }
}
