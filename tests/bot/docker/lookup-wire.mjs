// Narrow, content-free diagnosis of the fixed master lookup wire parser.
import { join } from "node:path"
import { hostState, privateFile, docker } from "../../../deploy/dev/docker/host.mjs"
import { prepareProject, compose, resources, stop, cleanupTest, validateContainer } from "../../../deploy/dev/docker/lifecycle.mjs"
import { localHttp, s3Headers } from "../../../deploy/dev/docker/services-probe.mjs"
import { volumeIdsFromPaths, registeredLookup } from "../../../deploy/dev/docker/readiness.mjs"
const state = await hostState(), entry = await prepareProject(state, { test: true })
console.log(JSON.stringify({ stage: "claimed", project: entry.project }))
try {
  const credentials = JSON.parse(await privateFile(join(entry.dir, "s3-client.json")))
  async function up() {
    await compose(state, entry, ["up", "--detach", "--wait", "--wait-timeout", "90", "--no-build", "--pull", "never", "s3"], { timeoutMs: 100000 })
    return (await resources(state, entry)).containers.s3
  }
  const c = await up(), port = validateContainer(c, entry, "s3")
  for (const path of [`/${entry.project}`, `/${entry.project}/proof.txt`]) {
    const body = path.endsWith(".txt") ? Buffer.from("lookup proof") : undefined
    if ((await localHttp(port, "PUT", path, { body, headers: s3Headers({ port, method: "PUT", path, body, credentials }) })).status !== 200) throw new Error("B00_S3_CREATE")
  }
  await stop(state, entry)
  const restarted = await up(), ids = volumeIdsFromPaths(await docker(state, ["exec", restarted.Id, "find", "/data/state", "-maxdepth", "1", "-name", "*.dat"], { stdoutOnly: true }))
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const wire = await docker(state, ["exec", restarted.Id, "/bin/sh", "-c", 'set +e; wget -q -S -O - -T 2 "$1" 2>&1; code=$?; printf "\\nB00_LOOKUP_EXIT=%s\\n" "$code"', "--", `http://127.0.0.1:9333/dir/lookup?volumeId=${ids[0]}`], { stdoutOnly: true, timeoutMs: Math.min(3000, deadline - Date.now()), maxOutput: 8192 })
    let ready, failure, value, jsonExact = false
    try { ready = registeredLookup(wire) } catch (e) { failure = e.message }
    try { value = JSON.parse(wire.slice(wire.indexOf("{"), wire.lastIndexOf("}") + 1)); jsonExact = true } catch {}
    console.log(JSON.stringify({ stage: "lookup-wire", httpStatus: Number(wire.match(/HTTP\/1\.[01] ([0-9]{3})/)?.[1]) || null, wgetExit: wire.match(/B00_LOOKUP_EXIT=([0-9]+)/)?.[1] ?? null, ready, failure, jsonExact, trailingAfterJson: wire.lastIndexOf("}") >= 0 && !!wire.slice(wire.lastIndexOf("}") + 1, wire.lastIndexOf("B00_LOOKUP_EXIT=")).trim(), locationsShape: Array.isArray(value?.locations) ? "array" : value?.locations === null ? "null" : "missing", errorPresent: typeof value?.error === "string", fixedLocation: value?.locations?.every(l => l.url === "127.0.0.1:8080") ?? false }))
    if (failure || ready) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
} finally { console.log(JSON.stringify({ stage: "cleaned", result: await cleanupTest(state, entry) })) }
