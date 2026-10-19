import { FUNCTION_ASYNC_SCOPE } from "./async-scope"
import { FUNCTION_NEXT_REPLY_WIRE } from "./next-reply-wire"
import { FUNCTION_UI_BOOTSTRAP } from "./guest-ui"
import { FUNCTION_BASE64_GLOBALS } from "./guest-base64"
import { FUNCTION_ENCODING_GLOBALS } from "./guest-encoding"
import { FUNCTION_STANDARD_GLOBALS } from "./guest-standard-globals"
import { FUNCTION_STREAM_CURSORS } from "./guest-stream-cursors"
import { FUNCTION_UI_CONSTRUCTOR_BOOTSTRAP } from "./guest-ui-constructor"

/** Only evaluated in QuickJS. No host closures or objects are handed to plugin code. */
export const FUNCTION_GUEST_BOOTSTRAP = String.raw`
(() => {
  "use strict";
  const host = globalThis.__functionHost;
  delete globalThis.__functionHost;
  const readBudget = globalThis.__functionReadBudget;
  delete globalThis.__functionReadBudget;
  const cancelHostCall = globalThis.__functionCancelCall;
  delete globalThis.__functionCancelCall;
  let cancelCallSequence = 0;
  const moduleHost = globalThis.__functionModuleHost;
  delete globalThis.__functionModuleHost;
  const constructorHost = globalThis.__functionUiConstructorHost;
  delete globalThis.__functionUiConstructorHost;
  const constructorControl = globalThis.__functionUiConstructorControl;
  delete globalThis.__functionUiConstructorControl;
  const constructorReadTable = globalThis.__functionUiConstructorReadTable;
  delete globalThis.__functionUiConstructorReadTable;
  const resolverNext = globalThis.__functionUiResolverNext;
  const resolverDrain = globalThis.__functionUiResolverDrain;
  delete globalThis.__functionUiResolverNext;
  delete globalThis.__functionUiResolverDrain;
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const freeze = Object.freeze.bind(Object);
  const define = Object.defineProperty.bind(Object);
  const ownKeys = Object.keys.bind(Object);
  const hasOwn = Object.hasOwn.bind(Object);
  const descriptor = Object.getOwnPropertyDescriptor.bind(Object);
  const prototype = Object.getPrototypeOf.bind(Object);
  const readProperty = Reflect.get.bind(Reflect);
  const objectPrototype = Object.prototype;
  const isArray = Array.isArray.bind(Array);
  ${FUNCTION_NEXT_REPLY_WIRE}
  ${FUNCTION_ASYNC_SCOPE}
  ${FUNCTION_UI_BOOTSTRAP}
  ${FUNCTION_UI_CONSTRUCTOR_BOOTSTRAP}
  ${FUNCTION_BASE64_GLOBALS}
  ${FUNCTION_ENCODING_GLOBALS}
  ${FUNCTION_STANDARD_GLOBALS}
  ${FUNCTION_STREAM_CURSORS}
  const handlers = new Map();
  const signals = new Map();
  const registrations = [];
  const drawnComponents = new Set();
  const uiComponents = new Set(["Pane","AbovePrompt","PromptHint","InfoNotice","Spinner",
    "TurnDuration","SessionMode","UserMessage","AssistantMessage","CommandOutput",
    "ToolUse","ToolResult","ToolGroup","AskUserQuestion"]);
  // A redraw hint, never an authorization receipt. Inspect current mutable matchers on
  // every call; unknown/dynamic matching retains the original global invalidation.
  function invalidationComponents() {
    try {
      const components = new Set(drawnComponents);
      let found = false;
      for (const row of registrations) {
        if (eventMatches(row.pattern,"ui.resolve")) return undefined;
        if (!eventMatches(row.pattern,"ui.render")) continue;
        found = true;
        if (row.pattern !== "ui.render") return undefined;
        const matcher = handlers.get(row.id)?.matcher;
        if (!matcher || prototype(matcher) !== objectPrototype) return undefined;
        for (const key of ownKeys(matcher)) {
          const field = descriptor(matcher,key);
          if (!field || !hasOwn(field,"value")) return undefined;
          if (field.value !== null && (typeof field.value === "object" ||
              typeof field.value === "function")) return undefined;
          if (readProperty(matcher,key) !== field.value) return undefined;
        }
        const field = descriptor(matcher,"component");
        if (!field || !field.enumerable || !hasOwn(field,"value") ||
            !uiComponents.has(field.value)) return undefined;
        components.add(field.value);
      }
      return found && components.size ? [...components] : undefined;
    } catch { return undefined; }
  }
  const unqualified = new Set();
  const nounMethods = new Map();
  const resourceCallbacks = new Map();
  let resourceSequence = 0;
  function resourceCall(method, args) {
    try {
    if (typeof moduleHost !== "function") throw Error("MODS_RESOURCE_UNAVAILABLE");
    const current = asyncScope;
    if (current?.uiConstructor) return current.call(method, args);
    // Native ordinary frames permit detached background resources. A closed end frame must
    // retain its exact token so it cannot silently become an ordinary module caller.
    const budgetToken = current ? current.budgetToken : undefined;
    const pending = moduleHost(method, pack(args), budgetToken);
    if (current?.uiResolver) return nativeThen.call(pending, text => {
      const reply = parse(text);
      if (reply.error) {
        const error = Error(reply.error.message);
        define(error, "code", { value: reply.error.code });
        if (reply.error.code === "MODS_RUNTIME_INSTANCE_EXPIRED" && reply.error.downstream === true)
          define(error, "__downstream", { value: true });
        throw error;
      }
      return frozen(reply.value);
    });
    return ordinaryResourceReply(pending);
    } catch (error) {return new NativePromise((resolve,reject)=>reject(error));}
  }
  async function ordinaryResourceReply(pending) {
    const reply = parse(await pending);
    if (reply.error) {
      const error = Error(reply.error.message);
      define(error, "code", { value: reply.error.code });
      if (reply.error.code === "MODS_RUNTIME_INSTANCE_EXPIRED" && reply.error.downstream === true)
        define(error, "__downstream", { value: true });
      throw error;
    }
    return frozen(reply.value);
  }
  define(globalThis, "__functionReleaseResource", {value: handle => resourceCallbacks.delete(handle)});
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
  const legacyToolNames = {Read:"read_file",Write:"write_file",Edit:"edit_file",Bash:"execute"};
  // Prefer the public dialect; a matcher accepting only the legacy view keeps that view.
  // Unqualified/new matchers always see the public Claude Code name.
  function legacyToolView(handler, event) {
    const legacy = event && Object.hasOwn(legacyToolNames,event.tool) && legacyToolNames[event.tool];
    if (!legacy || !handler || !handler.matcher || match(handler.matcher,event)) return event;
    const value = {...event,tool:legacy};
    if (event.tool === "Read") {
      if (event.input && typeof event.input === "object") {
        value.input = {...event.input};
        if (typeof value.input.offset === "number") value.input.offset--;
      } else if (typeof value.offset === "number") value.offset--;
    }
    return match(handler.matcher,value) ? value : event;
  }
  function publicToolNext(input, event, publicEvent) {
    if (!input || event.tool === publicEvent.tool || input.tool !== event.tool) return input;
    const value = {...input,tool:publicEvent.tool};
    if (publicEvent.tool === "Read") {
      if (input.input && typeof input.input === "object") {
        value.input = {...input.input};
        if (typeof value.input.offset === "number") value.input.offset++;
      } else if (typeof value.offset === "number") value.offset++;
    }
    return value;
  }
  function eventMatches(pattern, event) {
    const negative = pattern.startsWith("!");
    const positive = negative ? pattern.slice(1) : pattern;
    const result = positive === "*" || positive === event ||
      (positive.endsWith(".*") && event.startsWith(positive.slice(0, -1)));
    return negative ? !result : result;
  }
  const on = (pattern, matcher, fn) => {
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
  };
  define(on, "capability", { value(descriptor, handlers) {
    if (!registering) throw Error("MODS_REGISTRATION_CLOSED");
    const copied = frozen(parse(pack(descriptor)));
    if (!copied || typeof copied.id !== "string" || typeof copied.version !== "string" ||
        !handlers || typeof handlers.act !== "function") throw Error("MODS_PLATFORM_DESCRIPTOR");
    on("platform.action", { capability: { id: copied.id, version: copied.version } }, handlers.act);
    registrations[registrations.length - 1].platformCapability = copied;
  }});
  freeze(on);
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
    return handler.matcher === undefined || match(handler.matcher, legacyToolView(handler, parse(json))) ? "true" : "false";
  }});
  const invokeFunction = async (token, id, json, metadata, resolver = false) => {
    const publicEvent = frozen(parse(json));
    const meta = frozen(parse(metadata));
    const registration = handlers.get(id);
    const event = frozen(legacyToolView(registration, publicEvent));
    if (meta.event === "ui.render" && uiComponents.has(event.component))
      drawnComponents.add(event.component);
    if (!registration && !meta.callback && !meta.resourceCallback && !meta.streamCursor && meta.provider === undefined) throw Error("MODS_HANDLER_MISSING");
    let trace = freeze([]);
    const inheritedActions = new Set();
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
    const madeSignal = makeFunctionSignal();
    const signal = madeSignal.signal;
    signals.set(token, () => madeSignal.abort(Error("MODS_CANCELLED")));
    function call(method,args,callSignal) {
      if(!resolver)return ordinaryCall(method,args,callSignal);
      try {
        if(method==="next")return resolverNext(token,pack(args));
        signal.throwIfAborted();
        const state=callSignal===undefined?undefined:makeFunctionSignal.read(callSignal);
        if(state?.aborted)throw state.reason;
        const cancelId=state?String(++cancelCallSequence):undefined;
        const pending=host(token,method,pack(args),cancelId);
        const detach=state?makeFunctionSignal.subscribe(callSignal,()=>cancelHostCall(token,cancelId)):()=>{};
        if(state?.aborted)cancelHostCall(token,cancelId);
        return nativeThen.call(pending,text=>{
          try {
            const reply=nextReply(text,method);
            if(reply.trace)trace=frozen(reply.trace);
            if(reply.error){
              if(state?.aborted)throw state.reason;
              const error=Error(reply.error.message);
              define(error,"__downstream",{value:reply.error.downstream===true});
              define(error,"code",{value:reply.error.code});
              throw error;
            }
            return frozen(reply.value);
          } finally {detach();}
        },error=>{detach();if(state?.aborted)throw state.reason;throw error;});
      } catch(error){return new NativePromise((resolve,reject)=>reject(error));}
    }
    async function ordinaryCall(method, args, callSignal) {
      if (scope.ended && scope.background && ["ui.log","ui.status","ui.toast"].includes(method))
        return resourceCall("resource.ui", {method,args});
      signal.throwIfAborted();
      const state = callSignal === undefined ? undefined : makeFunctionSignal.read(callSignal);
      if(state?.aborted)throw state.reason;
      const cancelId=state?String(++cancelCallSequence):undefined;
      const pending=host(token,method,pack(args),cancelId);
      const detach=state?makeFunctionSignal.subscribe(callSignal,()=>cancelHostCall(token,cancelId)):()=>{};
      if(state?.aborted)cancelHostCall(token,cancelId);
      let reply;
      try{reply=nextReply(await pending,method)}
      catch(error){if(state?.aborted)throw state.reason;throw error}
      finally{detach()}
      if (reply.trace) trace = frozen(reply.trace);
      if (reply.error) {
        if(state?.aborted)throw state.reason;
        const error = Error(reply.error.message);
        define(error, "__downstream", { value: reply.error.downstream === true });
        define(error, "code", { value: reply.error.code });
        throw error;
      }
      if (meta.operation && method === "next" && reply.value && typeof reply.value === "object" &&
          !Object.hasOwn(reply.value, "value") && !Object.hasOwn(reply.value, "deny"))
        reply.value = { ...reply.value, value: undefined };
      if (meta.event === "ui.render" && method === "next")
        uiHandles(reply.value, press => inheritedActions.add(pack(press)));
      if (meta.event === "engine.create" && method === "next") return engineObjects(reply.value);
      return frozen(reply.value);
    }
    let cursorId = meta.streamCursor?.id;
    function cursorCall(method,args) {
      return meta.streamCursor ? streamCursorScope(cursorId,meta.plugin.name).call(method,args) : call(method,args);
    }
    function streamNext(input, tier) {
      const opening = cursorCall("stream.open", tier === undefined ? {input} : {input,tier});
      let settle, fail;
      const result = new Promise((resolve, reject) => {settle=resolve;fail=reject;});
      result.catch(() => {});
      const stream = (async function* () {
        let done = false;
        let opened;
        try {
          opened = await opening;
          while (true) {
            const item = await cursorCall("stream.pull", {id:opened.id});
            if(typeof item.receipt!=="string")throw Error("MODS_STREAM_RECEIPT_INVALID");
            await cursorCall("stream.accept",{id:opened.id,receipt:item.receipt});
            if (item.done) {done=true;settle(item.value);return item.value;}
            yield item.value;
          }
        } catch (error) {fail(error);throw error;}
        finally {
          if (!done) {
            fail(Error("MODS_STREAM_CLOSED"));
            if (opened) await cursorCall("stream.close", {id:opened.id});
          }
        }
      })();
      define(stream,"result",{value:result});
      return stream;
    }
    const next = meta.streaming || meta.streamCursor ? (input) => streamNext(input) : (input) => call("next", { input: publicToolNext(input,event,publicEvent) });
    define(next, "to", { value: meta.streaming || meta.streamCursor ? (input,tier) => streamNext(input,tier) : (input, tier) => call("next", { input: publicToolNext(input,event,publicEvent), tier }) });
    define(next, "signal", meta.streamCursor ? {get:()=>streamCursorScope(cursorId,meta.plugin.name).signal} : { value: signal });
    define(next, "origin", { value: meta.origin });
    define(next, "event", { value: meta.event });
    define(next, "trace", { get: () => trace });
    define(next, "budget", { get: () => freeze(meta.streamCursor
      ? streamCursorScope(cursorId,meta.plugin.name).budget() : readBudget(token)) });
    define(next, "is", { value: (pattern) => eventMatches(pattern, meta.event) });
    if (meta.caught) {
      define(next, "called", { value: meta.caught.called });
      define(next, "error", { value: frozen({ kind: meta.caught.kind || "throw", ...(meta.caught.message===undefined?{}:{message:meta.caught.message}), budget: meta.caught.budget ?? 1000 }) });
    }
    freeze(next);
    const sdk = Object.create(null);
    if (meta.event !== "engine.create") sdk.plugin = meta.plugin;
    const scope = {
      call, signal, cursorId, plugin: meta.plugin.name, callback: !!meta.callback, event: meta.event,
      budgetToken:token,
      budget:()=>readBudget(token),
      uiGeneration: meta.uiGeneration, requestId: event.requestId, component: event.component,
      ended: false, background: false
    };
    if(resolver){scope.uiResolver=token;resolverScopes.set(token,scope);}
    const unawaited = [];
    const promptAdmissions = [];
    function sdkCall(method, args, callSignal) {
      const current = asyncScope;
      if (current?.uiConstructor) return constructorScopedCall(meta, method, args, callSignal);
      if(meta.streamCursor)return streamCursorScope(cursorId,meta.plugin.name).call(method,args,callSignal);
      return current && current.plugin === meta.plugin.name
        ? current.call(method, args, callSignal) : call(method, args, callSignal);
    }
    for (const capability of meta.capabilities) {
      const [noun, method] = capability.split(".");
      if (!noun || !method || noun === "plugin" || ["__proto__", "constructor", "prototype"].includes(noun))
        throw Error("MODS_CAPABILITY_NAME");
      if (!sdk[noun]) sdk[noun] = Object.create(null);
      if (capability === "agent.spawn") {
        sdk[noun][method] = input => {
          let resourceId;
          const result = sdkCall(capability, [input]).then(packet => {
            resourceId = packet.resourceId;
            return packet.value;
          });
          result.then(() => {
            if (resourceId) Promise.resolve().then(() => resourceCall("agent.ready", {id:resourceId})).catch(()=>{});
          },()=>{});
          return result;
        };
        continue;
      }
      if (capability === "prompt.submit") {
        sdk[noun][method] = input => {
          const copied = parse(pack(input));
          const current = asyncScope;
          const owner = current?.uiConstructor ? current :
            current && current.plugin === meta.plugin.name ? current : scope;
          const opening = owner.call(capability, [copied]);
          const admitted = opening.then(() => {}, () => {});
          if (!owner.ended) {
            owner.unawaited.push(admitted);
            owner.promptAdmissions.push(admitted);
          }
          const result = opening.then(opened => {
            owner.background = true;
            return resourceCall("prompt.submit.wait", {id:opened.id});
          });
          result.catch(() => {});
          return result;
        };
        continue;
      }
      if(capability==="clock.sleep"){
        sdk[noun][method]=(ms,options)=>sdkCall(capability,[ms],options?.signal);
        continue;
      }
      if(capability==="platform.act"){
        sdk[noun][method]=(input,options)=>{
          if(options!==undefined&&(!options||typeof options!=="object"||Array.isArray(options)||
              ownKeys(options).some(key=>key!=="signal")))throw Error("MODS_PLATFORM_ARGUMENTS");
          return sdkCall(capability,[input],options?.signal);
        };
        continue;
      }
      if(capability==="model.complete"){
        sdk[noun][method]=async(input,options)=>{
          if(options!==undefined&&(!options||typeof options!=="object"||Array.isArray(options)||
              ownKeys(options).some(key=>key!=="signal")))throw Error("MODS_MODEL_ARGUMENTS");
          const callSignal=options?.signal;
          const state=callSignal===undefined?undefined:makeFunctionSignal.read(callSignal);
          try{return await sdkCall(capability,[input],callSignal)}
          catch(error){
            if (!asyncScope?.uiConstructor) signal.throwIfAborted();
            if(state?.aborted&&meta.modelProtocol==="result-v1")return frozen({
              isAnswered:false,reason:"aborted",usage:{input_tokens:0,output_tokens:0,
                cache_read_input_tokens:0,cache_creation_input_tokens:0}});
            throw error;
          }
        };
        continue;
      }
      if (capability === "process.spawn") {
        sdk[noun][method] = input => {
          if (resourceSequence >= Number.MAX_SAFE_INTEGER) throw Error("MODS_RESOURCE_LIMIT");
          const openingHandle = ++resourceSequence;
          const copied = parse(pack(input));
          const current = asyncScope;
          const owner = current?.uiConstructor ? current :
            current && current.plugin === meta.plugin.name ? current : scope;
          let settle, fail;
          const result = new Promise((resolve,reject)=>{settle=resolve;fail=reject;});
          result.catch(()=>{});
          let opened, opening, done = false, closed = false;
          const stream = (async function*(){
            try {
              if (owner.ended) throw Error("MODS_STALE_INVOCATION");
              opening = owner.call("process.spawn", [copied, openingHandle]);
              owner.unawaited.push(opening.then(()=>{},()=>{}));
              opened = await opening;
              owner.background = true;
              while (true) {
                const item = await resourceCall("resource.pull", {id:opened.id});
                if (item.done) {done=true;settle(item.value);return item.value;}
                yield item.value;
              }
            } catch(error) {fail(error);throw error;}
            finally {
              if (!done) fail(Error("MODS_STREAM_CLOSED"));
              if (opened) await resourceCall("resource.close", {id:opened.id});
            }
          })();
          const originalReturn=stream.return.bind(stream);
          define(stream,"return",{value:async value=>{
            if (!closed) {
              closed=true;fail(Error("MODS_STREAM_CLOSED"));
              if (opening) {
                if (!opened) await resourceCall("resource.cancel-open",{handle:openingHandle});
                let acknowledged;
                try {acknowledged=await opening;await resourceCall("resource.close",{id:acknowledged.id});}
                catch {}
                finally {
                  // Only a successful host ACK proves a delayed open can no longer arrive.
                  // A local RPC rejection/cancellation must retain its fail-closed tombstone.
                  if (acknowledged) await resourceCall("resource.release-open",{handle:openingHandle,id:acknowledged.id});
                }
              }
            }
            return originalReturn(value);
          }});
          define(stream,"result",{value:result});
          return stream;
        };
        continue;
      }
      if (capability === "clock.after" || capability === "clock.every") {
        sdk[noun][method] = (ms, fn) => {
          if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > 60000 || typeof fn !== "function")
            throw Error("MODS_TIMER_ARGUMENTS");
          if (resourceCallbacks.size >= 64) throw Error("MODS_RESOURCE_LIMIT");
          const handle = ++resourceSequence;
          resourceCallbacks.set(handle, fn);
          let cancelled = false;
          const opening = sdkCall(capability, [ms, handle]);
          const pending = opening.then(async opened => {
            if (cancelled) await resourceCall("resource.close", {id:opened.id});
          }).catch(error => {resourceCallbacks.delete(handle);throw error;});
          pending.catch(() => {});
          const current = asyncScope;
          const owner = current?.uiConstructor ? current :
            current && current.plugin === meta.plugin.name ? current : scope;
          if (!owner.ended) owner.unawaited.push(pending);
          let closing;
          return freeze({cancel() {
            if (closing) return closing;
            cancelled = true;
            resourceCallbacks.delete(handle);
            closing = opening.then(opened => resourceCall("resource.close", {id:opened.id})).then(()=>{});
            closing.catch(() => {});
            return closing;
          }});
        };
        continue;
      }
      if (capability === "ui.resolve") {
        sdk.ui.resolve = input => constructorReadTable
          ? constructorResolve(meta, input, event) : uiElements(meta, input);
        continue;
      }
      if (["ui.invalidate", "ui.toast", "ui.status", "ui.log", "ui.notice"].includes(capability)) {
        sdk[noun][method] = (...args) => {
          if (capability === "ui.invalidate" && args.length !== 1)
            throw Error("MODS_UI_INVALIDATE_UNAVAILABLE");
          if (capability === "ui.invalidate" && args.length === 1 && args[0] === "ui.render") {
            const components = invalidationComponents();
            if (components) args = [args[0], {components}];
          }
          // JSON carries a missing status argument as an empty list, never as null.
          if (capability === "ui.status" && args[0] === undefined) args = [];
          if (capability === "ui.notice" && args.length === 2 && args[1] === undefined) args = [args[0]];
          const pending = sdkCall(capability, args);
          pending.catch(() => {});
          const current = asyncScope;
          const owner = current?.uiConstructor ? current :
            current && current.plugin === meta.plugin.name ? current : scope;
          if (!owner.ended) owner.unawaited.push(pending);
        };
        continue;
      }
      sdk[noun][method] = async (...args) => {
        if (capability === "state.set") {
          args[1] = parse(pack(args[1]));
          if (args.length === 3 && args[2] === undefined) args = args.slice(0, 2);
        }
        if (capability === "store.set") args = [args[0], parse(pack(args[1]))];
        if (capability === "fs.list" && args[0] === undefined) args = ["."];
        if ((capability === "fs.stat" || capability === "fs.read") && args.length === 2 && args[1] === undefined) args = [args[0]];
        if (capability === "state.get") {
          const result = await sdkCall(capability, args);
          return frozen({ ...result, value: result.value });
        }
        return sdkCall(capability, args);
      };
    }
    scope.unawaited = unawaited;
    scope.promptAdmissions = promptAdmissions;
    for (const noun of ownKeys(sdk)) freeze(sdk[noun]);
    freeze(sdk);
    try {
      if(meta.streamCursor&&meta.streamCursor.action!=="open"){
        const item=await advanceStreamCursor(meta,scope);
        if(unawaited.length)await Promise.all(unawaited);
        return pack({value:item});
      }
      const resourceFn = meta.resourceCallback ? resourceCallbacks.get(meta.resourceCallback.handle) : undefined;
      if (meta.resourceCallback && meta.resourceCallback.release) resourceCallbacks.delete(meta.resourceCallback.handle);
      const fn = meta.resourceCallback ? resourceFn : meta.provider !== undefined ? nounMethods.get(meta.provider) : meta.callback ? uiCallback(meta, event) : meta.caught ? registration.recover : registration.fn;
      if (meta.resourceCallback && !fn) return pack({value:{}});
      if (typeof fn !== "function") throw Error("MODS_CATCH_MISSING");
      if(meta.streamCursor){
        const allocated=allocateStreamCursor(meta,scope);cursorId=allocated.id;
        try{
          const body=inScope(scope,()=>fn(sdk,event,next));
          if(!body||typeof body.next!=="function"||typeof body.return!=="function"||!body[Symbol.asyncIterator])
            throw Error("MODS_STREAM_HANDLER");
          allocated.record.body=body;
          return pack({value:{id:cursorId}});
        }catch(error){streamCursors.delete(cursorId);throw error}
      }
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
      } else value = await inScope(scope, () => Promise.resolve(meta.resourceCallback ? fn() : meta.provider !== undefined ? fn(event) : fn(sdk, event, next)));
      if (resolver) {await resolverDrain(token);return value;}
      if (unawaited.length) await Promise.all(unawaited);
      if (meta.callback || meta.resourceCallback) return pack({ value: {} });
      if (meta.event === "tool.describe") value = publicToolNext(value,event,publicEvent);
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
      if (resolver) {await resolverDrain(token);throw error;}
      // Optional source failure cannot retract an already admitted independent child dispatch.
      if (promptAdmissions.length) await Promise.all(promptAdmissions);
      return pack({ error: {
        code: error && error.code,
        message: String(error && error.message || error).slice(0, 2048),
        downstream: error && error.__downstream === true
      }});
    } finally {
      signals.delete(token);
      scope.ended = true;
      if(resolver)resolverScopes.delete(token);
      madeSignal.dispose();
    }
  };
  define(globalThis, "__functionInvoke", { value: (token,id,json,metadata) =>
    invokeFunction(token,id,json,metadata) });
  define(globalThis, "__functionUiResolverInvoke", { configurable:true,
    value:(token,id,json,metadata)=>invokeFunction(token,id,json,metadata,true) });
  define(globalThis, "__functionCancel", { value: token => {
    signals.get(token)?.();
    signals.delete(token);
  }});
})();
`
