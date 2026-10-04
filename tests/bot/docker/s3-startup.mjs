import { hostState, docker } from "../../../deploy/dev/docker/host.mjs"
import { prepareProject, compose, resources, cleanupTest, validateContainer, verifyListeners, classifyStartup } from "../../../deploy/dev/docker/lifecycle.mjs"

const state = await hostState(), entry = await prepareProject(state, { test: true })
console.log(JSON.stringify({ stage: "claimed", project: entry.project }))
try {
  try { await compose(state, entry, ["up", "--detach", "--wait", "--wait-timeout", "30", "--no-build", "--pull", "never", "s3"], { timeoutMs: 45000 }) }
  catch { process.exitCode = 1 }
  const current = await resources(state, entry)
  if (!current.containers.s3) throw new Error("B00_CONTAINER_MISSING")
  const c = current.containers.s3
  const logs = await docker(state, ["logs", "--tail", "200", c.Id], { timeoutMs: 10000, maxOutput: 65536 })
  console.log(JSON.stringify({ stage: "startup", diagnostics: classifyStartup("s3", c, logs) }))
  if (c.State.Health?.Status === "healthy") {
    const port = validateContainer(c, entry, "s3")
    const uid = await docker(state, ["exec", c.Id, "awk", "/^Uid:/{print $2,$3,$4,$5}", "/proc/1/status"], { stdoutOnly: true })
    const cwd = await docker(state, ["exec", c.Id, "readlink", "/proc/1/cwd"], { stdoutOnly: true })
    if (uid !== Array(4).fill(String(process.getuid())).join(" ") || cwd !== "/data/state") throw new Error("B00_SERVICE_UID")
    console.log(JSON.stringify({ stage: "process", uid: process.getuid(), cwd }))
    console.log(JSON.stringify({ stage: "verified", listener: await verifyListeners(port) }))
  } else process.exitCode = 1
} finally { console.log(JSON.stringify({ stage: "cleaned", result: await cleanupTest(state, entry) })) }
