/**
 * Host-evaluated before any plugin code. Keep native async/generator syntax here:
 * lowering it would inspect the wrong constructor prototypes.
 */
export const FUNCTION_CODEGEN_GUARD = String.raw`
(() => {
  const prototype = Function.prototype;
  const deny = function() { throw TypeError("MODS_CODE_GENERATION_DENIED"); };
  for (const fn of [function(){}, function*(){}, async function(){}, async function*(){}]) {
    Object.defineProperty(Object.getPrototypeOf(fn), "constructor", {
      get: () => deny, configurable: false
    });
  }
  Object.defineProperty(deny, "prototype", { value: prototype, writable: false });
  // Getter-only globals also resist QuickJS's global data-property redefinition.
  Object.defineProperty(globalThis, "Function", { get: () => deny, configurable: false });
  Object.defineProperty(globalThis, "eval", { get: () => deny, configurable: false });
})();
`
