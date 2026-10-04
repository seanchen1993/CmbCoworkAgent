import { join } from "node:path"
import { hostState, privateFile } from "../../../deploy/dev/docker/host.mjs"
import { prepareProject, compose, resources, cleanupTest, validateContainer } from "../../../deploy/dev/docker/lifecycle.mjs"
import { localHttp } from "../../../deploy/dev/docker/services-probe.mjs"

const state = await hostState(), entry = await prepareProject(state, { test: true })
console.log(JSON.stringify({ stage: "claimed", project: entry.project }))
try {
  await compose(state, entry, ["up", "--detach", "--wait", "--wait-timeout", "90", "--no-build", "--pull", "never", "es"], { timeoutMs: 100000 })
  const current = await resources(state, entry), port = validateContainer(current.containers.es, entry, "es")
  const password = (await privateFile(join(entry.dir, "es-password"))).trim()
  const authorization = `Basic ${Buffer.from(`elastic:${password}`).toString("base64")}`
  for (let i = 0; i < 10; i++) {
    const response = await localHttp(port, "GET", "/_license", { headers: { authorization } })
    let body; try { body = JSON.parse(response.bytes.toString()) } catch {}
    const shape = body === null ? "response-null" : !body || !Object.hasOwn(body, "license") ? "missing" : body.license === null ? "null" : typeof body.license !== "object" || Array.isArray(body.license) ? "unexpected-type" : "object"
    console.log(JSON.stringify({ sample: i, httpStatus: response.status, licenseShape: shape, type: ["basic", "trial"].includes(body?.license?.type) ? body.license.type : "other_or_null", status: ["active", "expired", "inactive"].includes(body?.license?.status) ? body.license.status : "other_or_null" }))
    await new Promise(resolve => setTimeout(resolve, 500))
  }
} finally { console.log(JSON.stringify({ stage: "cleaned", result: await cleanupTest(state, entry) })) }
