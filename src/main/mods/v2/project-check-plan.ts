import { realpath, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"
import type { ProjectCheckKind } from "./project-checks"
import { parseProjectCheckConfig, readProjectCheckConfig } from "./project-check-config"

export interface ProjectCheckPlan {
  kind: ProjectCheckKind
  command: string
  cwd: string
}

const configurations = new WeakMap<ProjectCheckPlan, { digest: string; directory?: string }>()
const pythonDiscovery =
  "import pathlib,sys,unittest; p=pathlib.Path(sys.argv[1]); sys.exit('PROJECT_CHECK_DIRECTORY_INVALID') if p.resolve()!=p.absolute() else None; s=unittest.defaultTestLoader.discover(sys.argv[1],sys.argv[2]); sys.exit(2 if s.countTestCases()==0 else not unittest.TextTestRunner(verbosity=2).run(s).wasSuccessful())"

async function assertDirectory(directory: string) {
  if (
    relative(directory, await realpath(directory)) !== "" ||
    !(await stat(directory)).isDirectory()
  )
    throw Error("PROJECT_CHECK_DIRECTORY_INVALID")
}

/** The command is frozen; a configuration edit must not publish its old execution as current. */
export async function assertProjectCheckPlanCurrent(plan: ProjectCheckPlan, signal?: AbortSignal) {
  const expected = configurations.get(plan)
  if (
    expected === undefined ||
    (await readProjectCheckConfig(plan.cwd, signal)).digest !== expected.digest
  )
    throw Error("PROJECT_CHECK_CONFIG_CHANGED")
  if (expected.directory) await assertDirectory(expected.directory)
  signal?.throwIfAborted()
}

/** Select a fixed project entrypoint; never install a runner or interpolate a script body. */
export async function planProjectCheck(
  workspace: string,
  kind: ProjectCheckKind,
  signal?: AbortSignal
): Promise<ProjectCheckPlan> {
  signal?.throwIfAborted()
  const cwd = resolve(workspace)
  const configuration = await readProjectCheckConfig(cwd, signal)
  const remember = (plan: ProjectCheckPlan, directory?: string) => {
    configurations.set(plan, { digest: configuration.digest, directory })
    return plan
  }
  if (configuration.text !== undefined) {
    const python = parseProjectCheckConfig(configuration.text)
    if (kind === "unit-test") {
      const directory = join(cwd, python.startDirectory)
      await assertDirectory(directory)
      signal?.throwIfAborted()
      // No interpreter install or arbitrary shell body; Python's own loader executes project tests.
      // Unlike `unittest discover`'s CLI, an empty suite cannot count as a passing check.
      return remember(
        {
          kind,
          cwd,
          command: `python -B -c "${pythonDiscovery}" "${python.startDirectory}" "${python.pattern}"`
        },
        directory
      )
    }
  }
  const opened = await openStableFileHandle(cwd, join(cwd, "package.json"))
  let manifest: unknown
  try {
    manifest = JSON.parse((await readStableFileHandleBounded(opened, 128 * 1024)).toString("utf8"))
  } finally {
    await opened.handle.close()
  }
  signal?.throwIfAborted()
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw Error("PROJECT_MANIFEST_INVALID")
  const scripts = (manifest as { scripts?: unknown }).scripts
  const names = kind === "unit-test" ? ["test:unit", "test"] : ["test:e2e", "e2e"]
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
    for (const name of names) {
      const script = (scripts as Record<string, unknown>)[name]
      if (typeof script === "string" && script.trim())
        return remember({ kind, cwd, command: `npm run ${name}` })
    }
  }
  const entry = kind === "unit-test" ? "node_modules/vitest/vitest.mjs" : "tests/run-mods-e2e.mjs"
  const file = await stat(join(cwd, entry)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  signal?.throwIfAborted()
  if (!file?.isFile()) throw Error(`PROJECT_CHECK_UNAVAILABLE: ${kind}`)
  return remember({ kind, cwd, command: `node ${entry}${kind === "unit-test" ? " run" : ""}` })
}
