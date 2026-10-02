import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isolatedEnv, run } from "./process.mjs"

export async function compileProbe(dir, tools, signal) {
  await run(tools.javac, ["-encoding", "UTF-8", "-source", "1.8", "-target", "1.8", "-d", dir, fileURLToPath(new URL("JdbcProbe.java", import.meta.url))], { cwd: dir, env: isolatedEnv(dir, tools.java), signal })
  const bytes = await readFile(join(dir, "JdbcProbe.class"))
  if (bytes.readUInt32BE(0) !== 0xcafebabe || bytes.readUInt16BE(6) !== 52) throw new Error("Probe must compile to class major 52")
  const output = await run(tools.java, ["-cp", `${dir}:${tools.jdbc}`, "JdbcProbe", "driver"], { cwd: dir, env: isolatedEnv(dir, tools.java), signal, stdoutOnly: true })
  const driver = JSON.parse(output)
  if (driver.driver !== "8.0.33" || !driver.java.startsWith("1.8.")) throw new Error("Actual Java/JDBC version mismatch")
  return { status: "verified", version: driver.driver, java: driver.java, classMajor: 52 }
}
