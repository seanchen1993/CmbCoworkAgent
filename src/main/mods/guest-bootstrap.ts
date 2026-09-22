/** Evaluated only inside QuickJS. All callbacks and SDK objects remain guest objects. */
export const GUEST_BOOTSTRAP = String.raw`
(() => {
  "use strict";
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const define = Object.defineProperty.bind(Object);
  const freeze = Object.freeze.bind(Object);
  const handlers = new Map();
  const registrations = [];
  const signals = new Map();
  const host = globalThis.__cmbHostCall;
  delete globalThis.__cmbHostCall;
  function pack(value) {
    const text = stringify(value);
    if (typeof text !== "string" || text.length > 1048576) throw Error("MODS_JSON_SIZE");
    return text;
  }
  function register(event, options, fn) {
    if (!options || typeof options.id !== "string" || typeof fn !== "function") {
      throw Error("MODS_REGISTRATION_INVALID");
    }
    if (handlers.has(options.id) || registrations.length >= 64) throw Error("MODS_REGISTRATION_LIMIT");
    handlers.set(options.id, fn);
    registrations.push({ ...options, id: options.id, event });
  }
  const on = freeze({
    tool: (options, fn) => register("tool.call", options, fn),
    context: (options, fn) => register("prompt.context", options, fn),
    command: (options, fn) => register("command.run", options, fn),
    ui: (options, fn) => register("ui.render", options, fn)
  });
  define(globalThis, "__cmbRegister", { value: () => {
    const mod = globalThis.__cmbMod && globalThis.__cmbMod.default;
    if (!mod || typeof mod.register !== "function") throw Error("MODS_NO_REGISTER");
    const result = mod.register(on);
    if (result && typeof result.then === "function") throw Error("MODS_ASYNC_REGISTER");
    return pack(registrations);
  }});
  define(globalThis, "__cmbInvoke", { value: async (token, handlerId, json) => {
    const event = parse(json);
    const registration = registrations.find(value => value.id === handlerId);
    const handler = handlers.get(handlerId);
    if (!registration || !handler) throw Error("MODS_HANDLER_MISSING");
    let aborted = false;
    const listeners = new Set();
    signals.set(token, () => {
      aborted = true;
      for (const fn of listeners) fn();
      listeners.clear();
    });
    const signal = freeze({
      get aborted() { return aborted; },
      onAbort(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    });
    async function call(method, value) {
      if (aborted) throw Error("MODS_CANCELLED");
      const reply = await host(token, method, pack(value));
      const result = parse(reply);
      if (result.error) throw Error(result.error);
      return result.value;
    }
    let nextUsed = false;
    const next = async (input) => {
      if (nextUsed) throw Error("MODS_NEXT_ALREADY_USED");
      nextUsed = true;
      return call("next", input);
    };
    define(next, "signal", { value: signal });
    const capabilities = freeze({
      tools: freeze({ invoke: (toolId, args) => call("tools.invoke", { toolId, args }) }),
      context: freeze({ get: (field) => call("context.get", { field }) }),
      store: freeze({
        get: (key) => call("store.get", { key }),
        set: (key, value) => call("store.set", { key, value }),
        delete: (key) => call("store.delete", { key })
      }),
      log: freeze({ write: (level, code) => call("log", { level, code }) })
      ,artifacts: freeze({ create: (value) => call("artifacts.create", value) })
    });
    try {
      const value = registration.event === "ui.render"
        ? await handler(event, next)
        : await handler(capabilities, event, next);
      return pack(value);
    } finally {
      signals.delete(token);
      listeners.clear();
    }
  }});
  define(globalThis, "__cmbCancel", { value: (token) => signals.get(token)?.() });
})();
`
