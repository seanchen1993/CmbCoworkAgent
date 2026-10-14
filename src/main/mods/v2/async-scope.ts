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
    if (scope?.uiConstructor || scope?.uiResolver) {
      // Promise adoption occurs in a later native job. Reserve its original owner NOW;
      // entering that job must never reuse the already-closed root execution token.
      const reaction = constructorControl("reaction.add", scope.uiConstructor||scope.uiResolver);
      let settle, fail;
      const completion = new NativePromise((resolve, reject) => {settle=resolve;fail=reject;});
      nativeThen.call(completion,
        () => constructorControl("reaction.settle", reaction),
        () => constructorControl("reaction.settle", reaction));
      const wrapped = { then(resolve, reject) {
        try {
          const result = constructorControl("reaction.run", reaction, () => then.call(value,
            item => {
              try {
                const adopted = scopedResult(item, asyncScope);
                settle(adopted);
                resolve(adopted);
              } catch (error) {fail(error);reject(error);}
            }, error => {fail(error);reject(error);}));
          // A tracked then may reject before entering either callback when its owner
          // expires. Observe that actual rejected Promise with the captured native
          // primitive so the adoption itself rejects without running a stale callback.
          // A general thenable is allowed to return a non-Promise; its return is ignored.
          try { nativeThen.call(result, undefined, error => {fail(error);reject(error);}); }
          catch { /* Non-Promise thenable return. */ }
          return result;
        } catch (error) {fail(error);reject(error);}
      }};
      adoptedPromises.add(wrapped);
      return wrapped;
    }
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
  function constructorContinuation(fn, scope, reaction, rejected) {
    return function(value) {
      return constructorControl("reaction.run", reaction, nextValue => {
        if (typeof fn !== "function") {
          if (rejected) throw nextValue;
          return nextValue;
        }
        return scopedResult(fn(nextValue), asyncScope);
      }, value);
    };
  }
  define(NativePromise.prototype, "then", { value: function(resolve, reject) {
    const scope = asyncScope;
    if (scope?.uiConstructor || scope?.uiResolver) {
      const reaction = constructorControl("reaction.add", scope.uiConstructor||scope.uiResolver);
      let result;
      try {
        result = nativeThen.call(this,
          constructorContinuation(resolve, scope, reaction, false),
          constructorContinuation(reject, scope, reaction, true));
      } catch (error) {
        constructorControl("reaction.settle", reaction);
        throw error;
      }
      nativeThen.call(result,
        () => constructorControl("reaction.settle", reaction),
        () => constructorControl("reaction.settle", reaction));
      return result;
    }
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
