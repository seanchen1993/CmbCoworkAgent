import { basename, resolve } from "node:path"
import { doctorProjectPlugin } from "./project-doctor"
import {
  compileProjectPlugin,
  initProjectPlugin,
  packProjectPlugin,
  prepareProjectDevelopment,
  testProjectPlugin
} from "./project-tooling"
import type { ProjectTemplateKind } from "./project-template"

export async function runProjectCli(args: string[]): Promise<{
  handled: boolean
  exitCode: number
  result?: unknown
}> {
  if (!["init", "compile", "doctor", "test", "pack", "dev"].includes(args[0]))
    return { handled: false, exitCode: 0 }
  const command = args[0]
  if (!args[1] || args[1].startsWith("--"))
    throw Error(`Usage: openwork plugin ${command} <directory>`)
  const options = new Map<string, string>()
  const allowed =
    command === "init"
      ? ["--template", "--id", "--name", "--version"]
      : ["pack", "dev", "compile"].includes(command)
        ? ["--out"]
        : []
  for (let index = 2; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!allowed.includes(key) || options.has(key) || !value || value.startsWith("--"))
      throw Error("PROJECT_CLI_ARGUMENT_INVALID")
    options.set(key, value)
  }
  const directory = resolve(args[1])
  if (command === "init") {
    const template = options.get("--template") ?? "project-lite"
    if (
      !["project-lite", "native-modular", "command", "harness-lite", "harness-fullstack", "harness-data"].includes(
        template
      )
    )
      throw Error("PROJECT_TEMPLATE_UNSUPPORTED")
    const packageId = options.get("--id") ?? basename(directory)
    return {
      handled: true,
      exitCode: 0,
      result: await initProjectPlugin(directory, {
        template: template as ProjectTemplateKind | "command",
        packageId,
        name: options.get("--name") ?? packageId,
        version: options.get("--version")
      })
    }
  }
  if (command === "doctor") {
    const result = await doctorProjectPlugin(directory)
    return { handled: true, exitCode: result.valid ? 0 : 1, result }
  }
  if (command === "test") {
    const result = await testProjectPlugin(directory)
    return { handled: true, exitCode: result.valid ? 0 : 1, result }
  }
  const output = options.get("--out")
  if (!output)
    throw Error(
      `Usage: openwork plugin ${command} <directory> --out <new-${command === "pack" ? "file.zip" : "directory"}>`
    )
  if (command === "compile")
    return { handled: true, exitCode: 0, result: await compileProjectPlugin(directory, output) }
  return {
    handled: true,
    exitCode: 0,
    result:
      command === "pack"
        ? await packProjectPlugin(directory, output)
        : await prepareProjectDevelopment(directory, output)
  }
}
