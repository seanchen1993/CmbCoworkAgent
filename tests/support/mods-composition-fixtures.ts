import { mkdirSync, mkdtempSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"

export function compositionEnvironment(root: string) {
  const isolated = mkdtempSync(join(tmpdir(), "cmb-composition-e2e-"))
  const workspace = join(isolated, "workspace")
  mkdirSync(workspace)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value &&
      /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i.test(
        key
      )
    )
      env[key] = value
  }
  for (const [key, folder] of Object.entries({
    HOME: "home",
    USERPROFILE: "home",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    CMB_COWORK_AGENT_HOME: "data",
    TEMP: "temp",
    TMP: "temp"
  })) {
    env[key] = join(isolated, folder)
    mkdirSync(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_E2E_DISABLE_GPU: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    CMB_E2E_ELECTRON_BIN: createRequire(join(root, "package.json"))("electron"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost"
  })
  return { isolated, workspace, env }
}

/** Independent installed guests, not host callbacks pretending to be plugins. */
export function compositionPlugin(name: "composition-a" | "composition-b") {
  const producer = name === "composition-a"
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(
      JSON.stringify({
        name,
        version: "1.0.0",
        claw: {
          actions: [
            {
              id: producer ? "produce" : "review",
              name: producer ? "Produce order summary" : "Review order summary",
              command: name,
              inputSchema: {
                type: "object",
                properties: { nonce: { type: "string" }, owner: { type: "string" } },
                required: producer ? ["nonce"] : ["nonce", "owner"]
              },
              outputSchema: { type: "object" }
            }
          ]
        }
      })
    )
  )
  zip.addFile("hooks/hooks.json", Buffer.from('{"modules":["./register.ts"]}'))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on) {
    on("session.start", async ($, e, next) => {
      await $.command.register({ name: ${JSON.stringify(name)}, description: "Composition E2E action", immediate: true })
      return next(e)
    })
    on("command.run", { command: ${JSON.stringify(name)} }, async ($, e) => {
      if (e.args === "inspect-count") return { text: String(await $.store.get("execution-count") || 0) }
      const envelope = JSON.parse(e.args)
      if (envelope.version !== 1 || !envelope.runId || !envelope.executionId) throw Error("INVALID_ACTION_ENVELOPE")
      if (${!producer} && envelope.input.owner !== "composition-a") throw Error("UPSTREAM_OWNER_MISMATCH")
      if (envelope.input.nonce !== envelope.task) throw Error("UPSTREAM_NONCE_MISMATCH")
      const output = { nonce: envelope.input.nonce, owner: ${JSON.stringify(name)}, receivedFrom: envelope.input.owner || null, configured: envelope.config.tag || null }
      await $.store.set("execution-count", (await $.store.get("execution-count") || 0) + 1)
      await $.store.set("last-output", output)
      return { text: "Executed " + ${JSON.stringify(name)}, output }
    })
  }`)
  )
  return [...zip.toBuffer()]
}
