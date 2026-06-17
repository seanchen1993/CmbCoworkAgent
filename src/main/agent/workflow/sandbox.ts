import vm from "vm"
import {
  WORKFLOW_SYNC_TIMEOUT_MS,
  WorkflowAbortError,
  WorkflowScriptError,
  describeWorkflowError
} from "./types"

/**
 * Deterministic VM sandbox for workflow scripts.
 *
 * The script runs in a fresh V8 context that only sees the injected workflow
 * globals plus the context's own intrinsics. Non-deterministic APIs are
 * disabled because resume replays `agent()` calls by (prompt, opts) identity —
 * `Date.now()`, argless `new Date()` and `Math.random()` throw with a hint.
 *
 * Isolation model. The context exposes no require/process/module bindings and
 * disables code generation (`codeGeneration.strings: false`), so `eval` and the
 * vm-realm `Function` constructor throw. The one remaining leak in a naive vm
 * setup is the constructor chain of values that cross the boundary: a host-realm
 * Promise/object handed to the script exposes the HOST `Function`
 * (`value.constructor.constructor`), which is NOT subject to the vm's codegen
 * flag — that is the `return process` escape. We close it with a bridge prelude:
 * the host primitives are injected under a hidden `__wfBridge`, and the
 * script-facing `agent()/parallel()/pipeline()/workflow()` are vm-realm wrappers
 * that re-materialize every returned value (and re-throw every error) inside the
 * vm realm. So all script-reachable values carry vm intrinsics, their
 * `.constructor.constructor` is the vm `Function`, and vm codegen is disabled —
 * the chain dead-ends. (A separate process would still be stronger defense in
 * depth, but the script layer no longer has require/fs/shell/process reach.)
 */

const DETERMINISM_PRELUDE = `
"use strict";
{
  const fail = (api) => {
    throw new Error(
      api +
        " is unavailable in workflow scripts (breaks resume). " +
        "Pass timestamps/randomness in via args, or vary agent prompts/labels by index."
    )
  }
  Object.defineProperty(Math, "random", {
    value: () => fail("Math.random()"),
    writable: false,
    configurable: false
  })
  Object.freeze(Math)

  // Same surface as Claude Code: only the nondeterministic entry points are
  // blocked (Date.now / argless new Date() / Date()); constructed dates keep
  // the FULL native prototype so common patterns (getFullYear, comparisons,
  // toLocaleString) keep working. Prompt guidance steers scripts toward
  // explicit-timezone strings for cross-machine resume stability.
  const RealDate = Date
  const SafeDate = function (...argumentsList) {
    if (!new.target) fail("Date()")
    if (argumentsList.length === 0) fail("new Date()")
    return Reflect.construct(RealDate, argumentsList, SafeDate)
  }
  Object.defineProperties(SafeDate, {
    UTC: { value: RealDate.UTC.bind(RealDate), writable: false, configurable: false },
    parse: { value: RealDate.parse.bind(RealDate), writable: false, configurable: false },
    now: { value: () => fail("Date.now()"), writable: false, configurable: false },
    prototype: { value: RealDate.prototype, writable: false, configurable: false }
  })
  // date.constructor must not hand back the unguarded native Date.
  Object.defineProperty(RealDate.prototype, "constructor", {
    value: SafeDate,
    writable: false,
    configurable: false
  })
  Object.freeze(SafeDate)
  Object.defineProperty(globalThis, "Date", {
    value: SafeDate,
    writable: false,
    configurable: false
  })
}
`

/**
 * Bridges the host primitives (injected as the hidden `__wfBridge`) into
 * vm-realm globals. Runs AFTER the determinism prelude and the args parse, and
 * BEFORE the script. Every value/error crossing the boundary is re-materialized
 * in the vm realm so its constructor chain can never reach the host `Function`.
 */
const BRIDGE_PRELUDE = `
"use strict";
{
  const bridge = globalThis.__wfBridge;
  delete globalThis.__wfBridge;

  // Re-materialize a boundary value as a vm-realm value (vm intrinsics). null/
  // undefined pass through (JSON.stringify(undefined) is not parseable).
  const clone = (value) =>
    value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));

  // Re-throw a host error as a vm Error, preserving name + message, so a caught
  // error's constructor chain is also vm-realm.
  const reError = (e) => {
    const message =
      e && typeof e === "object" && typeof e.message === "string" ? e.message : String(e);
    const err = new Error(message);
    if (e && typeof e === "object" && typeof e.name === "string") err.name = e.name;
    return err;
  };

  // Mirror the host suppressUnhandled: a detached catch means a fire-and-forget
  // call never raises an unhandledRejection, while an awaiting caller still sees
  // the rejection. The returned promise is a vm promise (vm async fn).
  const wrapAsync = (fn) => (...callArgs) => {
    const promise = (async () => {
      try {
        return clone(await fn(...callArgs));
      } catch (e) {
        throw reError(e);
      }
    })();
    promise.catch(() => {});
    return promise;
  };

  // Same boundary hardening for SYNCHRONOUS primitives. A host error thrown by
  // phase()/log()/the timers (e.g. engine phase() rejects a non-string title with
  // a host TypeError) MUST be re-thrown as a vm-realm Error: otherwise a script
  // that catches it could walk error.constructor.constructor back to the host
  // Function and reach \`process\` — a main-process sandbox escape. clone() also
  // re-materializes the (number/undefined) return value in the vm realm.
  const wrapSync = (fn) => (...callArgs) => {
    try {
      return clone(fn(...callArgs));
    } catch (e) {
      throw reError(e);
    }
  };

  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });

  // Each primitive is wired only when the bridge actually provides it (the
  // engine always provides the full set; a bare sandbox harness may not).
  // agent(prompt, opts) is special: the host reads opts fields (label/phase/
  // model/schema) DIRECTLY, so a hostile getter/toJSON on opts could run UNBOUNDED
  // on the main process. opts is passed to the host AS-IS; the host wrapper
  // (serializeAgentOptsInVm) round-trips it through a FRESH timeout-bounded
  // runInContext, so the box holds even when agent() runs AFTER the first await.
  // Doing the JSON round-trip HERE (vm global) would be untimed past that point —
  // the same freeze gap #2 closed for log().
  if (typeof bridge.agent === "function") {
    const hostAgent = bridge.agent;
    define("agent", (prompt, opts) => {
      const promise = (async () => {
        try {
          return clone(await hostAgent(prompt, opts));
        } catch (e) {
          throw reError(e);
        }
      })();
      promise.catch(() => {});
      return promise;
    });
  }
  for (const name of ["parallel", "pipeline", "workflow", "readFile", "writeFile", "glob", "exists"]) {
    if (typeof bridge[name] === "function") define(name, wrapAsync(bridge[name]));
  }
  if (typeof bridge.phase === "function") define("phase", wrapSync(bridge.phase));
  if (typeof bridge.log === "function") define("log", wrapSync(bridge.log));
  if (bridge.budget) {
    const hostBudget = bridge.budget;
    define(
      "budget",
      Object.freeze({
        total: hostBudget.total,
        spent: wrapSync(() => hostBudget.spent()),
        remaining: wrapSync(() => hostBudget.remaining())
      })
    );
  }
  // Abort-aware timers. setTimeout returns a plain number id; the callback is a
  // vm function the host invokes after the delay (skipped once the run aborts).
  if (typeof bridge.setTimeout === "function") define("setTimeout", wrapSync(bridge.setTimeout));
  if (typeof bridge.clearTimeout === "function")
    define("clearTimeout", wrapSync(bridge.clearTimeout));
}
`

export interface RunWorkflowSandboxOptions {
  body: string
  globals: Record<string, unknown>
  signal: AbortSignal
  /** Wall-clock cap for each synchronous segment; async waits are governed by `signal`. */
  syncTimeoutMs?: number
}

export interface WorkflowScriptResult {
  /** The script's return value, round-tripped through JSON IN the vm realm — a
   * plain host value with no vm getters/toJSON left for the host to execute. */
  value: unknown
  /** True when the return value carried a Promise that was never awaited
   * (detected in-vm before serialization, since JSON drops it to {}). */
  hadUnawaitedThenable: boolean
}

/**
 * Compiles and runs a workflow script body, returning the script's resolved
 * value (serialized inside the vm). Rejects with WorkflowScriptError on compile
 * errors, WorkflowAbortError when the signal fires first, or the script's own
 * thrown error otherwise.
 */
export async function runWorkflowScriptInSandbox(
  options: RunWorkflowSandboxOptions
): Promise<WorkflowScriptResult> {
  const { body, globals, signal, syncTimeoutMs = WORKFLOW_SYNC_TIMEOUT_MS } = options

  if (signal.aborted) {
    throw new WorkflowAbortError()
  }

  const sandbox: Record<string, unknown> = Object.create(null)
  const globalsForSandbox = { ...globals }
  const hasArgs = Object.prototype.hasOwnProperty.call(globalsForSandbox, "args")
  const argsJson = hasArgs ? JSON.stringify(globalsForSandbox.args) : undefined
  delete globalsForSandbox.args
  // #2: box log()'s argument the same way console.* / agent.opts / the return
  // value already are. log() forwarded the raw vm value to the host, where
  // engine's String(message) ran the arg's toString in the HOST realm with NO
  // timeout — an `await … ; log({ toString(){ while(1){} } })` froze the app.
  // Re-stringify the value INSIDE the vm under a short timeout (serializeConsolePart,
  // the same boxing console.* uses — a FRESH timeout-boxed runInContext, so it
  // holds even after the first await), so the host log only ever sees a plain
  // string. Wrapped here (before the bridge is hardened) so the vm-realm `log`
  // global stays the frozen wrapSync(bridge.log) — only the host function it
  // forwards to changes. The context is captured via ctxHolder (assigned right
  // after it's created below; the script can only call log() long after that).
  const ctxHolder: { current: vm.Context | undefined } = { current: undefined }
  // True only while the OUTER runInContext is on the stack (the first sync
  // segment). A hostile agent-opts getter THERE is already bounded by the outer
  // timeout, and a nested runInContext would clash with its V8 termination — so
  // box opts plainly while in-segment, and via a fresh timeout-boxed runInContext
  // only AFTER the first await (when the outer context has returned). (#3)
  let inSyncSegment = true
  const rawHostLog = globalsForSandbox.log
  if (typeof rawHostLog === "function") {
    const logStringifyTimeoutMs = Math.min(CONSOLE_STRINGIFY_TIMEOUT_MS, syncTimeoutMs)
    globalsForSandbox.log = (message: unknown): void => {
      let text: string
      try {
        text =
          ctxHolder.current === undefined
            ? typeof message === "string"
              ? message
              : "[log before sandbox ready]"
            : serializeConsolePart(ctxHolder.current, sandbox, message, logStringifyTimeoutMs)
      } catch {
        text = "[log argument could not be stringified]"
      }
      try {
        ;(rawHostLog as (m: string) => void)(text)
      } catch {
        /* best-effort logging */
      }
    }
  }
  // #3: box agent opts the same way. The vm-realm agent() shim now passes opts to
  // the host as-is; round-trip them here through a FRESH timeout-bounded
  // runInContext, so a hostile toJSON/getter is bounded even when agent() is called
  // after an await (the old vm-global JSON round-trip was untimed past that point).
  const rawHostAgent = globalsForSandbox.agent
  if (typeof rawHostAgent === "function") {
    const optsStringifyTimeoutMs = Math.min(CONSOLE_STRINGIFY_TIMEOUT_MS, syncTimeoutMs)
    const callHostAgent = rawHostAgent as (prompt: unknown, opts: unknown) => unknown
    globalsForSandbox.agent = (prompt: unknown, opts: unknown): unknown => {
      let boxedOpts: unknown
      if (opts === undefined || opts === null || typeof opts !== "object") {
        boxedOpts = opts
      } else if (inSyncSegment || ctxHolder.current === undefined) {
        // First sync segment: the outer runInContext timeout already bounds a
        // hostile getter; a nested runInContext would clash with its termination.
        boxedOpts = JSON.parse(JSON.stringify(opts))
      } else {
        // After the first await: the outer context has returned, so a fresh
        // timeout-boxed runInContext is both safe (not nested) and necessary.
        boxedOpts = serializeAgentOptsInVm(ctxHolder.current, sandbox, opts, optsStringifyTimeoutMs)
      }
      return callHostAgent(prompt, boxedOpts)
    }
  }
  // Inject the host primitives behind a hidden bridge (hardened as defense in
  // depth). The bridge prelude promotes them to vm-realm globals and deletes
  // __wfBridge, so the script never holds a host-realm callable directly.
  sandbox.__wfBridge = hardenVmGlobals(globalsForSandbox)
  if (hasArgs && argsJson === undefined) {
    sandbox.args = undefined
  } else if (hasArgs) {
    sandbox.__workflowArgsJson = argsJson
  }

  // NOTE: do NOT set microtaskMode: "afterEvaluate" here. It gives the context
  // its own microtask queue that node only drains during runInContext, so a
  // script awaiting a host promise (every agent() call) deadlocks — its
  // continuation never runs. Verified empirically; the sync `timeout` below
  // still covers synchronous runaway loops.
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false }
  })
  ctxHolder.current = context

  vm.runInContext(DETERMINISM_PRELUDE, context, { filename: "workflow-prelude.js" })
  if (typeof sandbox.__workflowArgsJson === "string") {
    vm.runInContext(
      "globalThis.args = JSON.parse(globalThis.__workflowArgsJson); delete globalThis.__workflowArgsJson",
      context,
      { filename: "workflow-args.js" }
    )
  }
  // Promote the host bridge to vm-realm primitive globals (and remove the
  // bridge handle). Must run before the script compiles/executes.
  vm.runInContext(BRIDGE_PRELUDE, context, { filename: "workflow-bridge.js" })

  // console.* mirrors log() but accepts multiple args. Inject it AFTER the context
  // exists so the forwarder stringifies each non-string arg INSIDE the vm under a
  // SHORT timeout (serializeConsolePart) — never host-side. console used to call a
  // host JSON.stringify on the raw arg, so a hostile toJSON / throwing getter could
  // run unbounded and freeze the main process (a DoS); the timeout-boxed runInContext
  // cuts an infinite one off.
  const consoleLog = globals.log
  if (typeof consoleLog === "function") {
    // Cap the per-arg stringify budget at the script's own sync window. A console
    // budget LONGER than syncTimeoutMs is pointless — the outer sync timeout fires
    // first. With the default 30s window this stays the full 1s. Caveat: if a
    // caller sets syncTimeoutMs below ~1s, a TOP-LEVEL synchronous
    // console.log(hostileArg) is bounded by the (smaller) sync window and surfaces
    // as a workflow timeout error rather than a placeholder — acceptable, since the
    // whole script window is that short and the run is already failing.
    const consoleStringifyTimeoutMs = Math.min(CONSOLE_STRINGIFY_TIMEOUT_MS, syncTimeoutMs)
    const forward = (...parts: unknown[]): void => {
      let message: string
      try {
        message = parts
          .map((part) => serializeConsolePart(context, sandbox, part, consoleStringifyTimeoutMs))
          .join(" ")
      } catch {
        // A timed-out / otherwise unserializable arg degrades to a placeholder —
        // console logging is best-effort and must never hang or throw.
        message = "[console arguments could not be stringified]"
      }
      try {
        ;(consoleLog as (message: string) => void)(message)
      } catch {
        /* best-effort logging */
      }
    }
    sandbox.console = hardenVmGlobals({
      log: forward,
      info: forward,
      warn: forward,
      error: forward
    })
  }

  let compiled: vm.Script
  try {
    compiled = new vm.Script(`(async () => {\n${body}\n})()`, { filename: "workflow.js" })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new WorkflowScriptError(`workflow script body failed to compile: ${message}`)
  }

  let scriptPromise: unknown
  try {
    scriptPromise = compiled.runInContext(context, { timeout: syncTimeoutMs })
  } catch (error) {
    throw normalizeSandboxError(error, syncTimeoutMs)
  } finally {
    // The outer sync segment is over (first await reached, or the script finished).
    // Agent opts boxing now uses a fresh, non-nested runInContext (see above).
    inSyncSegment = false
  }

  const resolvedValue = await raceWithAbort(Promise.resolve(scriptPromise), signal, syncTimeoutMs)
  // Serialize + inspect the return value INSIDE the vm, under the sync timeout, so
  // a hostile toJSON / throwing getter / unawaited Promise on the returned object
  // cannot run unbounded on the main process. finalize used to JSON.stringify and
  // deep-walk this value host-side with NO timeout — a `{ toJSON(){ while(1){} } }`
  // would hang the whole app. The host now only ever touches the plain JSON-parsed
  // value; no vm getter executes host-side.
  return serializeScriptResult(context, sandbox, resolvedValue, syncTimeoutMs)
}

// Runs in the vm realm (timeout-protected): detect an unawaited Promise in the
// return value, then JSON.stringify it. Both the thenable walk (reads getters)
// and the stringify (invokes toJSON) execute IN-vm, so a hostile/infinite one is
// cut off by the runInContext timeout instead of hanging the main process.
const SERIALIZE_RESULT_SNIPPET = `(() => {
  "use strict";
  const v = globalThis.__wfResult;
  const seen = new Set();
  const hasThenable = (o, d) => {
    if (d > 6 || o === null || typeof o !== "object") return false;
    if (typeof o.then === "function") return true;
    if (Array.isArray(o)) return o.some((e) => hasThenable(e, d + 1));
    if (seen.has(o)) return false;
    seen.add(o);
    for (const k of Object.keys(o)) { if (hasThenable(o[k], d + 1)) return true; }
    return false;
  };
  const thenable = hasThenable(v, 0);
  let json;
  try { json = JSON.stringify(v); } catch (e) { json = JSON.stringify(String(v)); }
  return JSON.stringify({ thenable: thenable, json: json === undefined ? null : json });
})()`

function serializeScriptResult(
  context: vm.Context,
  sandbox: Record<string, unknown>,
  resolved: unknown,
  syncTimeoutMs: number
): WorkflowScriptResult {
  if (resolved === undefined) return { value: undefined, hadUnawaitedThenable: false }
  sandbox.__wfResult = resolved
  let payload: string
  try {
    payload = vm.runInContext(SERIALIZE_RESULT_SNIPPET, context, {
      timeout: syncTimeoutMs,
      filename: "workflow-serialize.js"
    }) as string
  } catch (error) {
    throw normalizeSandboxError(error, syncTimeoutMs)
  } finally {
    delete sandbox.__wfResult
  }
  const parsed = JSON.parse(payload) as { thenable: boolean; json: string | null }
  return {
    value: parsed.json === null ? undefined : (JSON.parse(parsed.json) as unknown),
    hadUnawaitedThenable: parsed.thenable
  }
}

// Short cap for stringifying a single console.* argument. Far below the script
// sync timeout: console logging is best-effort, so a hostile arg should fail fast
// rather than stall the run for the full sync window.
const CONSOLE_STRINGIFY_TIMEOUT_MS = 1_000

// Runs in the vm realm (timeout-protected): stringify ONE console arg. A hostile
// toJSON / throwing getter / infinite toString is cut off by the runInContext
// timeout instead of freezing the main process; a vm Error degrades to its message.
const CONSOLE_SERIALIZE_ONE_SNIPPET = `(() => {
  "use strict";
  const p = globalThis.__wfConsolePart;
  if (typeof p === "string") return p;
  if (p instanceof Error && typeof p.message === "string") return p.message;
  try { const s = JSON.stringify(p); return s === undefined ? String(p) : s; }
  catch (e) { try { return String(p); } catch (e2) { return "[unstringifiable]"; } }
})()`

function serializeConsolePart(
  context: vm.Context,
  sandbox: Record<string, unknown>,
  part: unknown,
  timeoutMs: number
): string {
  if (typeof part === "string") return part
  // Hand the single value (a vm object) back into the vm and stringify it there,
  // so no host-side getter/toJSON runs. One value at a time avoids passing a host
  // Array across the realm boundary.
  sandbox.__wfConsolePart = part
  try {
    return vm.runInContext(CONSOLE_SERIALIZE_ONE_SNIPPET, context, {
      timeout: timeoutMs,
      filename: "workflow-console.js"
    }) as string
  } finally {
    delete sandbox.__wfConsolePart
  }
}

// Round-trip an agent opts OBJECT through the vm under a timeout, returning a plain
// host object — like serializeConsolePart but preserving structure (the host reads
// opts.model/phase/schema/label). A hostile toJSON/getter is bounded by the fresh
// timeout-bounded runInContext instead of running untimed host-side or in the
// vm-global agent shim after an await. (#3)
function serializeAgentOptsInVm(
  context: vm.Context,
  sandbox: Record<string, unknown>,
  opts: unknown,
  timeoutMs: number
): unknown {
  if (opts === undefined || opts === null || typeof opts !== "object") return opts
  sandbox.__wfAgentOpts = opts
  try {
    const json = vm.runInContext("JSON.stringify(globalThis.__wfAgentOpts)", context, {
      timeout: timeoutMs,
      filename: "workflow-agent-opts.js"
    }) as string | undefined
    return json === undefined ? undefined : (JSON.parse(json) as unknown)
  } catch (error) {
    // A hostile toJSON/getter that times out (or otherwise fails) surfaces as a
    // normalized workflow error — same treatment as the return-value serializer —
    // so the run fails with a clear "synchronous execution limit", not a raw V8
    // timeout message.
    throw normalizeSandboxError(error, timeoutMs)
  } finally {
    delete sandbox.__wfAgentOpts
  }
}

async function raceWithAbort(
  promise: Promise<unknown>,
  signal: AbortSignal,
  syncTimeoutMs: number
): Promise<unknown> {
  if (signal.aborted) throw new WorkflowAbortError()
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<unknown>((resolve, reject) => {
      onAbort = () => reject(new WorkflowAbortError())
      signal.addEventListener("abort", onAbort, { once: true })
      promise.then(resolve, (error) => reject(normalizeSandboxError(error, syncTimeoutMs)))
    })
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

function normalizeSandboxError(error: unknown, syncTimeoutMs: number): Error {
  // Errors thrown inside the vm realm are not instanceof the host Error;
  // duck-type via describeWorkflowError before deciding how to wrap.
  const message = describeWorkflowError(error)
  if (message.includes("Script execution timed out")) {
    return new WorkflowScriptError(
      `workflow script exceeded the ${syncTimeoutMs}ms synchronous execution limit — ` +
        "avoid long synchronous loops; do heavy work inside agent() subagents"
    )
  }
  if (error instanceof Error) return error
  return new Error(message)
}

/**
 * Host functions/objects injected into a vm context keep their host prototypes.
 * Without hardening, a script can reach `fn.constructor.constructor(...)` and
 * escape the intended no-process/no-require workflow boundary. Strip prototypes
 * from injected callables and plain objects before exposing them to the script.
 */
function hardenVmGlobals(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "function") {
    Object.defineProperty(value, "constructor", {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false
    })
    Object.setPrototypeOf(value, null)
    return value
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value)
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const item of value) copy.push(hardenVmGlobals(item, seen))
    Object.defineProperty(copy, "constructor", {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false
    })
    Object.setPrototypeOf(copy, null)
    return Object.freeze(copy)
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return seen.get(value)
    const copy: Record<string, unknown> = Object.create(null)
    seen.set(value, copy)
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue
      copy[key] = hardenVmGlobals(entry, seen)
    }
    return Object.freeze(copy)
  }

  return value
}
