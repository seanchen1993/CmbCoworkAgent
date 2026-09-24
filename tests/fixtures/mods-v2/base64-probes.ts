/** Independent vectors for actual hooks and isolated Client VMs; no host SDK calls. */
export const BASE64_PROBE_SOURCE = String.raw`
function base64Probe() {
  if (typeof atob !== "function" || typeof btoa !== "function")
    return {missing:["atob","btoa"].filter(name=>typeof globalThis[name]!=="function")};
  const name = fn => { try { fn(); return "accepted" } catch (error) { return error.name } };
  const bytes = Array.from({length:256},(_,i)=>String.fromCharCode(i)).join("");
  return {
    encoded:btoa(bytes),
    decoded:[atob(" Z\tg\n==\r\f "),atob("YR"),atob("Zm8"),atob("Zm9v")],
    invalid:[name(()=>atob("AA-_")),name(()=>atob("Zg=")),name(()=>btoa("你好"))],
    roundTrip:atob(btoa(bytes))===bytes,
    hiddenHost:[typeof globalThis.process,typeof globalThis.require,typeof globalThis.__functionHost]
  };
}
`

export function expectedBase64Probe() {
  return {
    encoded: btoa(Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("")),
    decoded: ["f", "a", "fo", "foo"],
    invalid: ["InvalidCharacterError", "InvalidCharacterError", "InvalidCharacterError"],
    roundTrip: true,
    hiddenHost: ["undefined", "undefined", "undefined"]
  }
}
