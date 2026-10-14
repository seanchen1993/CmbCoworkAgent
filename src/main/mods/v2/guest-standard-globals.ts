/** Fixed-version environment primitives. All signals, errors, buffers and clones belong to QuickJS. */
export const FUNCTION_STANDARD_GLOBALS = String.raw`
const makeFunctionSignal = (() => {
  const bridge = globalThis.__functionStandardHost;
  delete globalThis.__functionStandardHost;
  const define = Object.defineProperty, descriptor = Object.getOwnPropertyDescriptor;
  const call = Function.prototype.call.bind(Function.prototype.call);
  const freeze = Object.freeze, keys = Object.keys, proto = Object.getPrototypeOf;
  const U8 = Uint8Array, AB = ArrayBuffer, DV = DataView;
  const typed = proto(U8.prototype), typedBuffer = descriptor(typed,"buffer").get;
  const typedOffset = descriptor(typed,"byteOffset").get;
  const typedLength = descriptor(typed,"byteLength").get;
  const typedName = descriptor(typed,Symbol.toStringTag).get;
  const dataBuffer = descriptor(DV.prototype,"buffer").get;
  const dataOffset = descriptor(DV.prototype,"byteOffset").get;
  const dataLength = descriptor(DV.prototype,"byteLength").get;
  const bufferLength = descriptor(AB.prototype,"byteLength").get;
  const bufferSlice = AB.prototype.slice, setBytes = U8.prototype.set;
  const states = new WeakMap(), stateGet = WeakMap.prototype.get, stateSet = WeakMap.prototype.set;
  const integerNames = new Set(["Int8Array","Uint8Array","Uint8ClampedArray","Int16Array",
    "Uint16Array","Int32Array","Uint32Array","BigInt64Array","BigUint64Array"]);
  const constructors = new Map();
  for(const name of [...integerNames,"Float32Array","Float64Array"])
    if(typeof globalThis[name]==="function")constructors.set(name,globalThis[name]);
  const makeError = (name,message) => { const error = Error(message); error.name=name; return error; };
  function install(name,value) {
    define(globalThis,name,{value,writable:true,configurable:true,enumerable:false});
  }
  function state(signal) {
    const value=call(stateGet,states,signal);
    if(!value)throw TypeError("Illegal invocation");
    return value;
  }
  function makeSignal() {
    const signal=Object.create(GuestAbortSignal.prototype);
    const value={aborted:false,reason:undefined,listeners:new Map(),onabort:null,cleanup:undefined};
    call(stateSet,states,signal,value);
    define(signal,"onabort",{get:()=>value.onabort,set:fn=>{value.onabort=typeof fn==="function"?fn:null},
      enumerable:true,configurable:true});
    const abort=reason=>{
      if(value.aborted)return;
      value.aborted=true;
      value.reason=reason===undefined?makeError("AbortError","This operation was aborted"):reason;
      value.cleanup?.();value.cleanup=undefined;
      const event=freeze({type:"abort",target:signal,currentTarget:signal});
      const listeners=[...value.listeners];
      for(const [fn,once] of listeners){
        if(once)value.listeners.delete(fn);
        try{call(fn,signal,event)}catch{}
      }
      if(typeof value.onabort==="function")try{call(value.onabort,signal,event)}catch{}
    };
    const dispose=()=>{value.listeners.clear();value.onabort=null;value.cleanup?.();value.cleanup=undefined};
    return {signal,abort,dispose};
  }
  class GuestAbortSignal {
    constructor(){throw TypeError("Illegal constructor")}
    get aborted(){return state(this).aborted}
    get reason(){return state(this).reason}
    throwIfAborted(){const value=state(this);if(value.aborted)throw value.reason}
    addEventListener(type,fn,options){
      if(type!=="abort"||typeof fn!=="function")return;
      const value=state(this);
      value.listeners.set(fn,options?.once===true);
      if(options?.signal&&typeof options.signal.addEventListener==="function")
        options.signal.addEventListener("abort",()=>value.listeners.delete(fn),{once:true});
    }
    removeEventListener(type,fn){if(type==="abort")state(this).listeners.delete(fn)}
    static abort(reason){const made=makeSignal();made.abort(reason);return made.signal}
    static any(signals){
      const made=makeSignal(), subscriptions=[];
      const cleanup=()=>{for(const [one,fn] of subscriptions)one.removeEventListener("abort",fn);subscriptions.length=0};
      state(made.signal).cleanup=cleanup;
      try{
        for(const one of signals){
          state(one);
          if(one.aborted){made.abort(one.reason);break}
          const fn=()=>made.abort(one.reason);
          subscriptions.push([one,fn]);one.addEventListener("abort",fn,{once:true});
        }
      }catch(error){cleanup();throw error}
      return made.signal;
    }
    get [Symbol.toStringTag](){return "AbortSignal"}
  }
  const controllers=new WeakMap();
  class GuestAbortController {
    constructor(){call(stateSet,controllers,this,makeSignal())}
    get signal(){const made=call(stateGet,controllers,this);if(!made)throw TypeError("Illegal invocation");return made.signal}
    abort(reason){const made=call(stateGet,controllers,this);if(!made)throw TypeError("Illegal invocation");made.abort(reason)}
    get [Symbol.toStringTag](){return "AbortController"}
  }
  // Capture native accessors before plugin code, so forged tags/getters cannot cross the byte bridge.
  function viewInfo(value) {
    let buffer,offset,length,name;
    try{
      buffer=call(typedBuffer,value);offset=call(typedOffset,value);length=call(typedLength,value);
      name=call(typedName,value);
    }catch{
      buffer=call(dataBuffer,value);offset=call(dataOffset,value);length=call(dataLength,value);
      name="DataView";
    }
    return {buffer,offset,length,name};
  }
  function digestBytes(value) {
    let buffer,offset=0,length;
    try{length=call(bufferLength,value);buffer=value}
    catch{const info=viewInfo(value);buffer=info.buffer;offset=info.offset;length=info.length}
    if(length>1048576)throw makeError("QuotaExceededError","MODS_DIGEST_LIMIT");
    // A private copy fixes the input at call time, even if the caller mutates it before await.
    return call(bufferSlice,buffer,offset,offset+length);
  }
  const subtle=freeze({__proto__:null,async digest(algorithm,data){
    const name=typeof algorithm==="string"?algorithm:
      algorithm!==null&&typeof algorithm==="object"?String(algorithm.name):String(algorithm);
    return bridge("digest",name,digestBytes(data));
  }});
  const crypto=freeze({__proto__:null,subtle,randomUUID:()=>bridge("uuid"),getRandomValues:array=>{
    let info;
    try{info=viewInfo(array)}catch{throw makeError("TypeMismatchError","Expected an integer TypedArray")}
    if(!integerNames.has(info.name))throw makeError("TypeMismatchError","Expected an integer TypedArray");
    if(info.length>65536)throw makeError("QuotaExceededError","Random buffer exceeds 65536 bytes");
    call(setBytes,new U8(info.buffer,info.offset,info.length),new U8(bridge("random",info.length)));
    return array;
  }});
  function clone(value,seen,budget,depth) {
    if(++budget.nodes>20000||depth>128)throw RangeError("MODS_CLONE_LIMIT");
    if(value===null||typeof value!=="object"){
      if(typeof value==="function"||typeof value==="symbol")throw makeError("DataCloneError","The object can not be cloned.");
      return value;
    }
    if(seen.has(value))return seen.get(value);
    const nested=x=>clone(x,seen,budget,depth+1);
    if(Array.isArray(value)){const out=[];seen.set(value,out);for(const item of value)out.push(nested(item));return out}
    if(value instanceof Date)return new Date(value.getTime());
    if(value instanceof RegExp)return new RegExp(value.source,value.flags);
    if(value instanceof Map){const out=new Map();seen.set(value,out);for(const [key,item] of value)out.set(nested(key),nested(item));return out}
    if(value instanceof Set){const out=new Set();seen.set(value,out);for(const item of value)out.add(nested(item));return out}
    try{call(bufferLength,value);return call(bufferSlice,value,0)}catch{}
    if(AB.isView(value)){
      const info=viewInfo(value), buffer=call(bufferSlice,info.buffer,info.offset,info.offset+info.length);
      return info.name==="DataView"?new DV(buffer):new (constructors.get(info.name))(buffer);
    }
    if(value instanceof Error)return makeError(value.name,value.message);
    const parent=proto(value);
    if(parent!==null&&parent!==Object.prototype&&proto(parent)!==null)
      throw makeError("DataCloneError","The object can not be cloned.");
    const out={};seen.set(value,out);
    for(const key of keys(value))define(out,key,{value:nested(value[key]),writable:true,enumerable:true,configurable:true});
    return out;
  }
  install("AbortSignal",GuestAbortSignal);install("AbortController",GuestAbortController);
  install("structuredClone",value=>clone(value,new Map(),{nodes:0},0));
  install("crypto",crypto);install("performance",freeze({__proto__:null,now:()=>bridge("now")}));
  makeSignal.read=state;
  makeSignal.subscribe=(signal,listener)=>{
    const value=state(signal);value.listeners.set(listener,true);
    return ()=>value.listeners.delete(listener);
  };
  return makeSignal;
})();
`
