import { app } from "electron"
import { dirname, join, resolve } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { checkFunctionPlugin } from "./check"
import { FunctionRuntimeClient } from "../v2/runtime-client"
import { functionCheckExitCode, parseFunctionCheckOptions } from "./cli-options"
import { compileFunctionPlugin } from "../v2/loader"
import { functionAuthoringDeclarations } from "./authoring-declarations"
import { runProjectCli } from "./project-cli"

/** Dedicated headless entry: does not initialize application databases, accounts or the renderer. */
const args = process.argv.slice(2)
void app.whenReady().then(async () => {
  const client = new FunctionRuntimeClient(join(__dirname, "function-mod-host.js"))
  try {
    const project = await runProjectCli(args)
    if (project.handled) {
      console.log(JSON.stringify(project.result, null, 2))
      client.stop()
      app.exit(project.exitCode)
      return
    }
    if (args[0] === "types") {
      if (
        !args[1] ||
        args[1].startsWith("--") ||
        (args.length !== 2 &&
          !(args.length === 4 && args[2] === "--out" && args[3]?.endsWith(".d.ts")))
      )
        throw Error("Usage: openwork plugin types <directory> [--out <new-file.d.ts>]")
      const compiled = await compileFunctionPlugin(resolve(args[1]))
      const declarations = functionAuthoringDeclarations(compiled.modelProtocol)
      if (args[3]) {
        const output = resolve(args[3])
        await mkdir(dirname(output), { recursive: true })
        await writeFile(output, declarations, { encoding: "utf8", flag: "wx" })
        console.error(
          `Authoring subset written to ${output}; existing files are never overwritten.`
        )
      } else process.stdout.write(declarations)
      app.exit(0)
      return
    }
    const options = parseFunctionCheckOptions(args)
    if (!options) {
      console.error(
        "Usage: openwork plugin check|inspect <directory> [--strict-compatibility] [--types]"
      )
      client.stop()
      app.exit(2)
      return
    }
    const report = await checkFunctionPlugin(resolve(options.directory), (code, guestOptions) =>
      client.load(code, guestOptions)
    )
    const typecheck = options.typecheck
      ? await (
          await import("./authoring-check")
        ).checkFunctionAuthorTypes(resolve(options.directory))
      : undefined
    if (typecheck && typecheck.digest !== report.digest) throw Error("MODS_TYPES_SNAPSHOT_CHANGED")
    console.log(JSON.stringify({ ...report, ...(typecheck ? { typecheck } : {}) }, null, 2))
    client.stop()
    app.exit(
      typecheck && !typecheck.valid ? 1 : functionCheckExitCode(report, options.strictCompatibility)
    )
  } catch (error) {
    client.stop()
    console.error(error instanceof Error ? error.message : "MODS_CHECK_FAILED")
    app.exit(1)
  }
})
