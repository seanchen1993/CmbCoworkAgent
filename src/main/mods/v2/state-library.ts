/** Bundled into the plugin VM, never executed in the Electron host. No ambient authority. */
export const FUNCTION_STATE_LIBRARY = String.raw`
const atoms = new WeakSet();
const derived = new WeakMap();
const freeze = Object.freeze.bind(Object);
function reference(ref, id = ref.id) {
  return freeze(id === undefined
    ? { plugin: ref.plugin, key: ref.key }
    : { plugin: ref.plugin, key: ref.key, id });
}
function freezeInitial(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) freezeInitial(value[key], seen);
  return freeze(value);
}
export function atom(ref, initial, options) {
  const result = {
    ref: reference(ref), initial: freezeInitial(initial),
    ...(options?.shape === undefined ? {} : { shape: options.shape })
  };
  atoms.add(result);
  return freeze(result);
}
export function derive(sources, compute) {
  if (!Array.isArray(sources) || typeof compute !== "function")
    throw TypeError("MODS_STATE_DERIVE_ARGUMENT");
  const result = freeze({
    sources: freeze(sources.map(source =>
      atoms.has(source) || derived.has(source) ? source : reference(source))), compute
  });
  derived.set(result, {});
  return result;
}
export function memberOf(family, event) {
  if (typeof event?.requestId !== "string") throw TypeError("MODS_STATE_MEMBER_ARGUMENT");
  if (!atoms.has(family)) return reference(family, event.requestId);
  return atom(reference(family.ref, event.requestId), family.initial,
    family.shape === undefined ? undefined : { shape: family.shape });
}
function heldValue(target, value) {
  if (!atoms.has(target)) return value;
  if (target.shape === undefined) return value === undefined ? target.initial : value;
  return value?.shape === target.shape && value.value !== undefined ? value.value : target.initial;
}
async function sample(state, source) {
  const cache = derived.get(source);
  if (!cache) {
    const held = await state.get(atoms.has(source) ? source.ref : source);
    return { value: heldValue(source, held.value), versions: [held.version] };
  }
  // Reads are required even on a cache hit: the drawing subscribes through the host.
  const dependencies = await Promise.all(source.sources.map(item => sample(state, item)));
  const versions = dependencies.flatMap(item => item.versions);
  if (!cache.versions || versions.length !== cache.versions.length ||
      versions.some((version, index) => version !== cache.versions[index])) {
    const value = source.compute(...dependencies.map(item => item.value));
    cache.value = value;
    cache.versions = versions;
  }
  return { value: cache.value, versions };
}
export async function read($, source) {
  return (await sample($.state, source)).value;
}
export async function update($, target, change) {
  const ref = atoms.has(target) ? target.ref : target;
  for (let attempt = 0; attempt < 64; attempt++) {
    const held = await $.state.get(ref);
    const value = change(heldValue(target, held.value));
    const wire = atoms.has(target) && target.shape !== undefined
      ? { shape: target.shape, value } : value;
    if ((await $.state.set(ref, wire, { ifVersion: held.version })).isSet) return value;
  }
  throw Error("MODS_STATE_UPDATE_CONFLICT: exhausted 64 compare-and-set attempts");
}
`
