import { isAbsolute, join } from "node:path"
import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { fileURLToPath } from "node:url"
import { compileProbe } from "../java-probe.mjs"
import { run, isolatedEnv, privateTemp, removePrivateTemp } from "../process.mjs"
import { privateFile } from "./host.mjs"
import { validateProject, resources, validateContainer } from "./lifecycle.mjs"

export async function compileDockerProbe(tools, dir, signal) {
  for (const key of ["java", "javac", "jdbc"]) {
    if (!tools[key] || !isAbsolute(tools[key])) throw new Error("B00_JDK_ARGUMENTS")
    await access(tools[key], key === "jdbc" ? constants.R_OK : constants.X_OK)
  }
  for (const [key, pattern] of [["java", /(?:openjdk|java) version "1\.8\.0_/], ["javac", /javac 1\.8\.0_/]]) {
    if (!pattern.test(await run(tools[key], ["-version"], { env: isolatedEnv(dir, tools.java), cwd: dir, signal }))) throw new Error("B00_JDK_VERSION")
  }
  const driver = await compileProbe(dir, tools, signal)
  await run(tools.javac, ["-encoding", "UTF-8", "-source", "1.8", "-target", "1.8", "-d", dir, fileURLToPath(new URL("DockerJdbcProbe.java", import.meta.url))], { env: isolatedEnv(dir, tools.java), cwd: dir, signal })
  const bytes = await readFile(join(dir, "DockerJdbcProbe.class"))
  if (bytes.readUInt32BE(0) !== 0xcafebabe || bytes.readUInt16BE(6) !== 52) throw new Error("B00_CLASS_VERSION")
  return { ...driver, classMajor: 52 }
}

export async function jdbc(state, entry, tools, dir, action, { signal, wrongPassword = false } = {}) {
  if (!["probe", "persist", "empty", "ping", "reject-version"].includes(action)) throw new Error("B00_PROBE_ACTION")
  await validateProject(entry)
  const current = await resources(state, entry)
  if (!current.container || !current.container.State.Running) throw new Error("B00_CONTAINER_MISSING")
  const port = validateContainer(current.container, entry)
  const password = wrongPassword ? "a".repeat(64) : (await privateFile(join(entry.dir, "app-password"))).trim()
  const output = await run(tools.java, ["-cp", `${dir}:${tools.jdbc}`, "DockerJdbcProbe", action], { input: `port=${port}\npassword=${password}\n`, env: isolatedEnv(dir, tools.java), cwd: dir, stdoutOnly: true, timeoutMs: 20000, signal })
  const result = JSON.parse(output)
  if (result.status !== "verified" || result.mysql !== "5.7.44" || result.jdbc !== "8.0.33" || !result.java.startsWith("1.8.")) throw new Error("B00_PROBE_RESULT")
  return result
}

export async function verifyDev(state, entry, tools, signal) {
  const dir = await privateTemp()
  try {
    const driver = await compileDockerProbe(tools, dir, signal)
    return { driver, jdbc: await jdbc(state, entry, tools, dir, "ping", { signal }) }
  } finally { await removePrivateTemp(dir) }
}
