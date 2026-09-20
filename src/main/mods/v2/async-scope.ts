/**
 * Evaluated inside the private guest bootstrap closure. All trusted and plugin async functions
 * are lowered to Promise continuations before evaluation; native async bypasses `then`.
 * This propagates a call's identity, never a mutable "latest invocation" pointer.
 */
export const FUNCTION_ASYNC_SCOPE = String.raw`
  const NativePromise = Promise;
  const nativeThen = NativePromise.prototype.then;
  const adoptedPromises = new WeakSet();
  let asyncScope;
  function inScope(scope, fn) {
    const previous = asyncScope;
    asyncScope = scope;
    try { return fn(); } finally { asyncScope = previous; }
  }
  function scopedResult(value, scope) {
    if (!value || (typeof value !== "object" && typeof value !== "function") ||
        adoptedPromises.has(value)) return value;
    const then = value.then;
    if (typeof then !== "function") return value;
    const wrapped = { then(resolve, reject) {
      return inScope(scope, () => then.call(value, resolve, reject));
    }};
    adoptedPromises.add(wrapped);
    return wrapped;
  }
  function continuation(fn, scope) {
    return typeof fn !== "function" ? fn : function(value) {
      return inScope(scope, () => scopedResult(fn(value), scope));
    };
  }
  define(NativePromise.prototype, "then", { value: function(resolve, reject) {
    const scope = asyncScope;
    return nativeThen.call(this, continuation(resolve, scope), continuation(reject, scope));
  }});
  globalThis.Promise = class Promise extends NativePromise {
    constructor(executor) {
      if (typeof executor !== "function") throw TypeError("executor");
      const promiseScope = asyncScope;
      let settled = false;
      super((resolve, reject) => executor(value => {
        if (settled) return;
        settled = true;
        // Promise resolution adopts foreign thenables in the context where the
        // promise was created. This matches Node AsyncLocalStorage when a
        // promise created in A is resolved by a callback running in B (or
        // outside a guest scope).
        try { resolve(scopedResult(value, promiseScope)); } catch (error) { reject(error); }
      }, error => {
        if (settled) return;
        settled = true;
        reject(error);
      }));
    }
  };
`
