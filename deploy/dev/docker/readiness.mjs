import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { setTimeout as pause } from "node:timers/promises"
import { docker, privateFile } from "./host.mjs"
import { resources, validateContainer } from "./lifecycle.mjs"
import { localHttp, s3Headers, servicesHealth } from "./services-probe.mjs"

export function volumeIdsFromPaths(text) {
  const ids = text.split("\n").filter(Boolean).map(path => {
    const match = path.match(/^\/data\/state\/(?:[a-zA-Z0-9_.-]+_)?([1-9][0-9]{0,9})\.dat$/)
    if (!match || Number(match[1]) > 4294967295) throw new Error("B00_S3_VOLUME_PATH")
    return match[1]
  }).sort((a, b) => Number(a) - Number(b))
  if (ids.length > 4 || new Set(ids).size !== ids.length) throw new Error("B00_S3_VOLUME_COUNT")
  return ids
}

export function registeredLookup(text) {
  const status = Number(text.match(/HTTP\/1\.[01] ([0-9]{3})/)?.[1])
  const exit = text.match(/\nB00_LOOKUP_EXIT=([0-9]+)\s*$/)?.[1]
  if (exit === undefined) throw new Error("B00_S3_LOOKUP_BODY")
  if (status === 404 || (!status && exit === "1")) return false
  if (status !== 200 || exit !== "0") throw new Error("B00_S3_LOOKUP_STATUS")
  let value
  try { value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("\nB00_LOOKUP_EXIT="))) } catch { throw new Error("B00_S3_LOOKUP_BODY") }
  if (!Array.isArray(value.locations)) throw new Error("B00_S3_LOOKUP_BODY")
  if (value.locations.some(location => location.url !== "127.0.0.1:8080")) throw new Error("B00_S3_VOLUME_LOCATION")
  return value.locations.length > 0
}

export async function waitForS3(snapshot, { signal, timeoutMs = 30000, pauseMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("B00_CANCELLED")
    const value = await snapshot(deadline)
    if (signal?.aborted) throw new Error("B00_CANCELLED")
    if (Date.now() >= deadline) throw new Error("B00_S3_READY_TIMEOUT")
    if (typeof value.apiReady !== "boolean" || !Array.isArray(value.volumes) || !Array.isArray(value.registered) || value.registered.some(id => !value.volumes.includes(id))) throw new Error("B00_S3_READY_STATE")
    if (value.apiReady && isDeepStrictEqual([...value.volumes].sort(), [...value.registered].sort())) return { authenticated: true, registeredVolumeIds: value.volumes }
    try { await pause(Math.min(pauseMs, Math.max(0, deadline - Date.now())), undefined, { signal }) } catch { throw new Error("B00_CANCELLED") }
  }
  throw new Error("B00_S3_READY_TIMEOUT")
}

export async function serviceReadiness(state, entry, ports, signal) {
  const deadline = Date.now() + 30000
  const current = await resources(state, entry), c = current.containers.s3
  if (!c?.State.Running || validateContainer(c, entry, "s3") !== ports.s3) throw new Error("B00_S3_READY_STATE")
  const remaining = () => { const value = deadline - Date.now(); if (value <= 0) throw new Error("B00_S3_READY_TIMEOUT"); return Math.min(value, 3000) }
  const paths = await docker(state, ["exec", c.Id, "find", "/data/state", "-maxdepth", "1", "-name", "*.dat"], { stdoutOnly: true, timeoutMs: remaining(), signal })
  const volumes = volumeIdsFromPaths(paths)
  for (const path of paths.split("\n").filter(Boolean)) await docker(state, ["exec", c.Id, "/bin/sh", "-c", 'test -f "$1" && test ! -L "$1"', "--", path], { timeoutMs: remaining(), signal })
  const credentials = JSON.parse(await privateFile(join(entry.dir, "s3-client.json")))
  const s3 = await waitForS3(async () => {
    let apiReady = false
    try {
      const response = await localHttp(ports.s3, "GET", "/", { headers: s3Headers({ port: ports.s3, method: "GET", path: "/", credentials }), signal, timeoutMs: remaining() })
      if ([401, 403].includes(response.status)) throw new Error("B00_S3_AUTH")
      if (response.status !== 200 || !/^\s*(?:<\?xml[^>]*>\s*)?<ListAllMyBucketsResult\b[^>]*>[\s\S]*<\/ListAllMyBucketsResult>\s*$/.test(response.bytes.toString())) throw new Error("B00_S3_API")
      apiReady = true
    } catch (error) { if (error.message !== "B00_HTTP_IO") throw error }
    const registered = []
    for (const id of volumes) {
      // Headers and JSON stay in memory; never follow location URLs. Decode the
      // explicit wget status instead of treating the shell's final printf as success.
      const value = await docker(state, ["exec", c.Id, "/bin/sh", "-c", 'set +e; wget -S -O - -T 2 "$1" 2>&1; code=$?; printf "\\nB00_LOOKUP_EXIT=%s\\n" "$code"', "--", `http://127.0.0.1:9333/dir/lookup?volumeId=${id}`], { stdoutOnly: true, timeoutMs: remaining(), signal, maxOutput: 8192 })
      if (registeredLookup(value)) registered.push(id)
    }
    return { apiReady, volumes, registered }
  }, { signal, timeoutMs: Math.max(1, deadline - Date.now()) })
  return { s3, services: await servicesHealth(entry, ports, signal, { deadline }) }
}
