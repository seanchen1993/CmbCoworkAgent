import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.join(root, "scripts/windows-background-job-controller.cs")
const executable = path.join(root, "resources/bin/win32/background-job-controller.exe")
const stamp = path.join(root, "output/windows-job-controller-build.json")
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
if (process.platform !== "win32") {
  if (
    process.argv.includes("--for-package") &&
    (!existsSync(executable) ||
      !readFileSync(executable).includes(Buffer.from("MODS_PROCESS_STARTED_V1\n", "utf16le")))
  )
    throw new Error(
      "Build the Windows Job controller on Windows before packaging Windows resources"
    )
  process.exit(0)
}
try {
  const previous = JSON.parse(readFileSync(stamp, "utf8"))
  if (previous.source === digest(source) && previous.executable === digest(executable))
    process.exit(0)
} catch {
  /* First build or source/binary changed. */
}
const compiler = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe"
)
if (!existsSync(compiler)) throw new Error(".NET Framework C# compiler is unavailable")
const result = spawnSync(
  compiler,
  ["/nologo", "/optimize+", "/target:exe", `/out:${executable}`, source],
  { stdio: "inherit", windowsHide: true }
)
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Windows Job controller compiler exited ${result.status}`)
mkdirSync(path.dirname(stamp), { recursive: true })
writeFileSync(
  stamp,
  JSON.stringify({ source: digest(source), executable: digest(executable) }) + "\n"
)
