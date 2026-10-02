import { isAbsolute } from "node:path"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { requireNode22, validateConfig } from "./config.mjs"
import { privateTemp, removePrivateTemp, isolatedEnv, run } from "./process.mjs"

export async function doctor(config, tools) {
  requireNode22()
  validateConfig(config)
  const dir = await privateTemp()
  const report = { node: { status: "verified", version: process.versions.node }, identity: { status: "mock" }, zhaohu: { status: "mock" }, model: { status: "mock" }, s3: { status: "disabled" }, es: { status: "disabled" } }
  try {
    for (const [name, args, pattern] of [
      ["java", ["-version"], /(?:openjdk|java) version "1\.8\.0_/],
      ["javac", ["-version"], /javac 1\.8\.0_/],
      ["mysql", ["--no-defaults", "--version"], /Distrib 5\.7\./],
      ["mysqld", ["--no-defaults", "--version"], /Ver 5\.7\./],
      ["maven", ["-v"], /Apache Maven /]
    ]) {
      if (name === "maven" && !tools[name]) { report[name] = { status: "unavailable", optional: true }; continue }
      try {
        if (!tools[name] || !isAbsolute(tools[name])) throw new Error("Explicit absolute executable required")
        await access(tools[name], constants.X_OK)
        const output = await run(tools[name], args, { cwd: dir, env: isolatedEnv(dir, tools.java) })
        if (!pattern.test(output) || (name === "maven" && !/Java version: 1\.8\./.test(output))) throw new Error("Unsupported version")
        report[name] = { status: "verified", version: output.split("\n").find((line) => pattern.test(line)) }
      } catch (error) { report[name] = { status: "unavailable", reason: error.message } }
    }
    try {
      if (!tools.jdbc || !isAbsolute(tools.jdbc)) throw new Error("Explicit absolute cached JDBC jar required")
      await access(tools.jdbc, constants.R_OK)
      report.jdbc = { status: "unavailable", reason: "Readable local jar; driver/version verification pending real probe", pending: true }
    } catch (error) { report.jdbc = { status: "unavailable", reason: error.message } }
    return { ok: ["java", "javac", "mysql", "mysqld"].every((name) => report[name].status === "verified") && report.jdbc.pending === true, ...report }
  } finally { await removePrivateTemp(dir) }
}
