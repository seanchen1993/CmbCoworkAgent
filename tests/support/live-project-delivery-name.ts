import assert from "node:assert/strict"

/** Pick a new UI delivery identity; never replace an installed plugin during a live test. */
export function liveProjectDeliveryName(name: string, digest: string, installedNames: string[]) {
  assert(/^[a-z][a-z0-9-]{0,47}$/.test(name), "LIVE_DELIVERY_NAME_INVALID")
  assert(/^[a-f0-9]{64}$/.test(digest), "LIVE_DELIVERY_SOURCE_DIGEST_INVALID")
  if (!installedNames.includes(name)) return name
  const next = `${name.slice(0, 37).replace(/-+$/, "")}-${digest.slice(0, 10)}`
  assert(!installedNames.includes(next), "LIVE_DELIVERY_UNIQUE_NAME_CONFLICT")
  return next
}
