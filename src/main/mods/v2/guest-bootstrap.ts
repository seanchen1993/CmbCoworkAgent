import { FUNCTION_ASYNC_SCOPE } from "./async-scope"
import { FUNCTION_UI_BOOTSTRAP } from "./guest-ui"
import { FUNCTION_BASE64_GLOBALS } from "./guest-base64"

/** Only evaluated in QuickJS. No host closures or objects are handed to plugin code. */
export const FUNCTION_GUEST_BOOTSTRAP = String.raw`
(() => {
  "use strict";
  const host = globalThis.__functionHost;
  delete globalThis.__functionHost;
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const freeze = Object.freeze.bind(Object);
  const define = Object.defineProperty.bind(Object);
  const ownKeys = Object.keys.bind(Object);
  ${FUNCTION_ASYNC_SCOPE}
  ${FUNCTION_UI_BOOTSTRAP}
  ${FUNCTION_BASE64_GLOBALS}
  const handlers = new Map();
  const signals = new Map();
  const registrations = [];
  const unqualified = new Set();
  const nounMethods = new Map();
  let registering = true;
  function pack(value) {
    const text = stringify(value);
    if (typeof text !== "string") throw Error("MODS_RETURN_UNDEFINED");
    if (text.length > 1048576) throw Error("MODS_JSON_SIZE");
    return text;
  }
  function frozen(value, depth = 0) {
    if (depth > 32) throw Error("MODS_JSON_DEPTH");
    if (value && typeof value === "object") {
      for (const key of ownKeys(value)) frozen(value[key], depth + 1);
      freeze(value);
    }
    return value;
  }
  function providerJson(value, depth = 0) {
    if (depth > 32) throw Error("MODS_JSON_DEPTH");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object") throw Error("MODS_ENGINE_RESULT_JSON");
    if (typeof value[Symbol.asyncIterator] === "function") throw Error("MODS_ENGINE_STREAM_UNSUPPORTED");
    for (const key of ownKeys(value)) providerJson(value[key], depth + 1);
  }
  function match(pattern, value, depth = 0) {
    if (depth > 8) throw Error("MODS_MATCHER_DEPTH");
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      return typeof value === "string" && pattern.test(value);
    }
    if (Array.isArray(pattern)) return pattern.some(item => match(item, value, depth + 1));
    if (Array.isArray(value)) return value.some(item => match(pattern, item, depth + 1));
    if (pattern && typeof pattern === "object") {
      return value !== null && typeof value === "object" &&
        ownKeys(pattern).every(key => match(pattern[key], value[key], depth + 1));
    }
    return pattern === value;
  }
  function eventMatches(pattern, event) {
    const negative = pattern.startsWith("!");
    const positive = negative ? pattern.slice(1) : pattern;
    const result = positive === "*" || positive === event ||
      (positive.endsWith(".*") && event.startsWith(positive.slice(0, -1)));
    return negative ? !result : result;
  }
  const on = freeze((pattern, matcher, fn) => {
    if (!registering) throw Error("MODS_REGISTRATION_CLOSED");
    if (typeof matcher === "function") { fn = matcher; matcher = undefined; }
    if (typeof pattern !== "string" || typeof fn !== "function") throw Error("MODS_REGISTRATION_INVALID");
    if (matcher === undefined) {
      if (unqualified.has(pattern)) throw Error("MODS_DUPLICATE_REGISTRATION");
      unqualified.add(pattern);
    }
    if (registrations.length >= 128) throw Error("MODS_REGISTRATION_LIMIT");
    const id = String(registrations.length);
    const record = { id, pattern, hasCatch: false, hasMatcher: matcher !== undefined };
    const handler = { fn, matcher, recover: undefined };
    registrations.push(record);
    handlers.set(id, handler);
    return freeze({ catch(recover) {
      if (!registering || record.hasCatch || pattern === "engine.create" || typeof recover !== "function")
        throw Error("MODS_CATCH_INVALID");
      record.hasCatch = true;
      handler.recover = recover;
    }});
  });
  define(globalThis, "__functionRegister", { value(json) {
    const options = frozen(parse(json));
    const module = globalThis.__cmbFunctionMod;
    if (!module || typeof module.register !== "function") throw Error("MODS_NO_REGISTER");
    try {
      const result = module.register(on, options);
      if (result && typeof result.then === "function") throw Error("MODS_ASYNC_REGISTER");
      return pack(registrations);
    } finally { registering = false; }
  }});
  define(globalThis, "__functionMatches", { value(id, json) {
    const handler = handlers.get(id);
    if (!handler) throw Error("MODS_HANDLER_MISSING");
    return handler.matcher === undefined || match(handler.matcher, parse(json)) ? "true" : "false";
  }});
  define(globalThis, "__functionInvoke", { value: async (token, id, json, metadata) => {
    const event = frozen(parse(json));
    const meta = frozen(parse(metadata));
    const registration = handlers.get(id);
    if (!registration && !meta.callback && meta.provider === undefined) throw Error("MODS_HANDLER_MISSING");
    let aborted = false;
    let reason;
    let trace = freeze([]);
    const inheritedActions = new Set();
    const listeners = new Set();
    const engineDescriptors = new WeakMap();
    function engineObjects(descriptors) {
      const built = Object.create(null);
      for (const noun of ownKeys(descriptors)) {
        const descriptor = descriptors[noun];
        const table = Object.create(null);
        for (const method of ownKeys(descriptor.methods))
          table[method] = (...args) => sdkCall(noun + "." + method, args);
        engineDescriptors.set(table, descriptor);
        built[noun] = freeze(table);
      }
      return freeze(built);
    }
    function engineSerialize(built) {
      if (!built || typeof built !== "object" || Array.isArray(built)) throw Error("MODS_ENGINE_NOUN_INVALID");
      const result = Object.create(null);
      for (const noun of ownKeys(built)) {
        const table = built[noun];
        if (!table || typeof table !== "object" || Array.isArray(table)) throw Error("MODS_ENGINE_NOUN_INVALID");
        const inherited = engineDescriptors.get(table);
        if (inherited) {result[noun] = inherited;continue;}
        const methods = Object.create(null);
        for (const method of ownKeys(table)) {
          if (typeof table[method] !== "function") throw Error("MODS_ENGINE_NOUN_INVALID");
          if (nounMethods.size >= 256) throw Error("MODS_ENGINE_NOUN_LIMIT");
          const handle = String(nounMethods.size);
          const fn = table[method];
          nounMethods.set(handle, input => fn.call(table, input));
          methods[method] = handle;
        }
        result[noun] = {provider:meta.plugin.name,methods};
      }
      return result;
    }
    const signal = freeze({
      get aborted() { return aborted; },
      get reason() { return reason; },
      throwIfAborted() { if (aborted) throw reason; },
      addEventListener(type, fn) { if (type === "abort") listeners.add(fn); },
      removeEventListener(type, fn) { if (type === "abort") listeners.delete(fn); }
    });
    signals.set(token, () => {
      aborted = true;
      reason = Error("MODS_CANCELLED");
      for (const fn of listeners) { try { fn.call(signal); } catch {} }
      listeners.clear();
    });
    async function call(method, args) {
      signal.throwIfAborted();
      const reply = parse(await host(token, method, pack(args)));
      if (reply.trace) trace = frozen(reply.trace);
      if (reply.error) {
        const error = Error(reply.error.message);
        define(error, "__downstream", { value: reply.error.downstream === true });
        define(error, "code", { value: reply.error.code });
        throw error;
      }
      if (meta.operation && method === "next" && reply.value && typeof reply.value === "object" &&
          !Object.hasOwn(reply.value, "value") && !Object.hasOwn(reply.value, "deny"))
        reply.value.value = undefined;
      if (meta.event === "ui.render" && method === "next")
        uiHandles(reply.value, press => inheritedActions.add(pack(press)));
      if (meta.event === "engine.create" && method === "next") return engineObjects(reply.value);
      return frozen(reply.value);
    }
    function streamNext(input, tier) {
      const opening = call("stream.open", tier === undefined ? {input} : {input,tier});
      let settle, fail;
      const result = new Promise((resolve, reject) => {settle=resolve;fail=reject;});
      result.catch(() => {});
      const stream = (async function* () {
        let done = false;
        let opened;
        try {
          opened = await opening;
          while (true) {
            const item = await call("stream.pull", {id:opened.id});
            if (item.done) {done=true;settle(item.value);return item.value;}
            yield item.value;
          }
        } catch (error) {fail(error);throw error;}
        finally {
          if (!done) {
            fail(Error("MODS_STREAM_CLOSED"));
            if (opened) await call("stream.close", {id:opened.id});
          }
        }
      })();
      define(stream,"result",{value:result});
      return stream;
    }
    const next = meta.streaming ? (input) => streamNext(input) : (input) => call("next", { input });
    define(next, "to", { value: meta.streaming ? (input,tier) => streamNext(input,tier) : (input, tier) => call("next", { input, tier }) });
    define(next, "signal", { value: signal });
    define(next, "origin", { value: meta.origin });
    define(next, "event", { value: meta.event });
    define(next, "trace", { get: () => trace });
    define(next, "is", { value: (pattern) => eventMatches(pattern, meta.event) });
    if (meta.caught) {
      define(next, "called", { value: meta.caught.called });
      define(next, "error", { value: frozen({ kind: meta.caught.kind || "throw", message: meta.caught.message, budget: meta.caught.budget || 100 }) });
    }
    freeze(next);
    const sdk = Object.create(null);
    if (meta.event !== "engine.create") sdk.plugin = meta.plugin;
    const scope = {
      call, plugin: meta.plugin.name, callback: !!meta.callback, event: meta.event,
      uiGeneration: meta.uiGeneration, requestId: event.requestId, component: event.component
    };
    const unawaited = [];
    function sdkCall(method, args) {
      const current = asyncScope;
      return current && current.plugin === meta.plugin.name
        ? current.call(method, args) : call(method, args);
    }
    for (const capability of meta.capabilities) {
      const [noun, method] = capability.split(".");
      if (!noun || !method || noun === "plugin" || ["__proto__", "constructor", "prototype"].includes(noun))
        throw Error("MODS_CAPABILITY_NAME");
      if (!sdk[noun]) sdk[noun] = Object.create(null);
      if (capability === "ui.resolve") {
        sdk.ui.resolve = input => uiElements(meta, input);
        continue;
      }
      if (["ui.invalidate", "ui.toast", "ui.status", "ui.log", "ui.notice"].includes(capability)) {
        sdk[noun][method] = (...args) => {
          // JSON carries a missing status argument as an empty list, never as null.
          if (capability === "ui.status" && args[0] === undefined) args = [];
          if (capability === "ui.notice" && args.length === 2 && args[1] === undefined) args = [args[0]];
          const pending = sdkCall(capability, args);
          pending.catch(() => {});
          const current = asyncScope;
          (current && current.plugin === meta.plugin.name ? current.unawaited : unawaited).push(pending);
        };
        continue;
      }
      sdk[noun][method] = async (...args) => {
        if (capability === "store.set") args = [args[0], parse(pack(args[1]))];
        if (capability === "fs.list" && args[0] === undefined) args = ["."];
        if (capability === "fs.stat" && args.length === 2 && args[1] === undefined) args = [args[0]];
        return sdkCall(capability, args);
      };
    }
    scope.unawaited = unawaited;
    for (const noun of ownKeys(sdk)) freeze(sdk[noun]);
    freeze(sdk);
    try {
      const fn = meta.provider !== undefined ? nounMethods.get(meta.provider) : meta.callback ? uiCallback(meta, event) : meta.caught ? registration.recover : registration.fn;
      if (typeof fn !== "function") throw Error("MODS_CATCH_MISSING");
      let value;
      if (meta.streaming) {
        const body = inScope(scope, () => fn(sdk, event, next));
        if (!body || typeof body.next !== "function" || !body[Symbol.asyncIterator]) throw Error("MODS_STREAM_HANDLER");
        while (true) {
          const item = await inScope(scope, () => body.next());
          if (item.done) {value=item.value;break;}
          await call("stream.yield", {chunk:item.value});
        }
        if (value === undefined) return pack({absent:true});
      } else value = await inScope(scope, () => Promise.resolve(meta.provider !== undefined ? fn(event) : fn(sdk, event, next)));
      if (unawaited.length) await Promise.all(unawaited);
      if (meta.callback) return pack({ value: {} });
      if (meta.event === "ui.render") uiProvenance(value, meta, inheritedActions);
      if (value === undefined && meta.caught) return pack({ absent: true });
      if (meta.provider !== undefined && value === undefined) return pack({ absent: true });
      if (meta.provider !== undefined) providerJson(value);
      if (meta.event === "engine.create") return pack({value:engineSerialize(value)});
      if (meta.operation && (!value || typeof value !== "object" || Array.isArray(value) ||
          (!Object.hasOwn(value, "value") && typeof value.deny !== "string")))
        throw Error("MODS_OPERATION_RESULT");
      return pack({ value });
    } catch (error) {
      return pack({ error: {
        code: error && error.code,
        message: String(error && error.message || error).slice(0, 2048),
        downstream: error && error.__downstream === true
      }});
    } finally {
      signals.delete(token);
      listeners.clear();
    }
  }});
  define(globalThis, "__functionCancel", { value: token => {
    signals.get(token)?.();
    signals.delete(token);
  }});
})();
`
