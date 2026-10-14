/** Only the fixed trusted library may be initialized; no source string crosses this bridge. */
export const FUNCTION_URL_LAZY_GLOBALS = String.raw`
(() => {
  const initialize = globalThis.__functionInitializeUrl;
  delete globalThis.__functionInitializeUrl;
  const define = Object.defineProperty.bind(Object);
  const descriptor = Object.getOwnPropertyDescriptor.bind(Object);
  const names = ["URL", "URLSearchParams"], getters = {};
  let constructors;
  function load() {
    if (!constructors) constructors = initialize();
    // These are writable globals: initializing one must not undo an author's replacement
    // or deletion of the other, including a non-configurable author-owned descriptor.
    for (const name of names) {
      const property = descriptor(globalThis, name);
      if (property && property.configurable && property.get === getters[name])
        define(globalThis, name, { value: constructors[name], writable: true, configurable: true });
    }
  }
  for (const name of names) {
    getters[name] = function() { load(); return constructors[name]; };
    define(globalThis, name, {
      configurable: true,
      get: getters[name],
      set(value) { define(globalThis, name, { value, writable: true, configurable: true }); }
    });
  }
})();
`
