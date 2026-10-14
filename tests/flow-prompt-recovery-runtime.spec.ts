/** Real provider, checkpoint and NativeFlowHost/FlowManager process-restart regression. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  assert(existsSync(join(root, "src/main/agent/flow-prompt-runtime.ts")))
  const temporaryRoot = resolve(tmpdir())
  const owned = await mkdtemp(join(temporaryRoot, "cmb-flow-prompt-recovery-suite-"))
  try {
    for (const name of ["actual-http", "native-resume"]) {
      const output = join(owned, `${name}.cjs`)
      await build({
        entryPoints: [join(root, `tests/fixtures/flow-prompt-${name}.ts`)],
        outfile: output,
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        logLevel: "silent",
        define: {
          "import.meta.url": JSON.stringify(pathToFileURL(output).href),
          "import.meta.env": "{}"
        },
        // Only Electron's platform surface is supplied for this Node process. Provider,
        // stores, graph, native adapters, CAS and project-command execution are real src.
        plugins:
          name === "native-resume"
            ? [
                {
                  name: "node-electron-platform",
                  setup(builder) {
                    builder.onResolve({ filter: /^electron$/ }, () => ({
                      path: join(root, "tests/fixtures/flow-prompt-electron-platform.ts")
                    }))
                  }
                }
              ]
            : []
      })
      const child = spawn(process.execPath, [output], {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Every child-created app DB, workspace and abrupt-exit artifact stays owned here.
          TEMP: owned,
          TMP: owned,
          TMPDIR: owned,
          NODE_PATH: [join(root, "node_modules"), process.env.NODE_PATH]
            .filter(Boolean)
            .join(delimiter)
        }
      })
      let log = ""
      const collect = (chunk: Buffer) => {
        log += chunk.toString()
        if (Buffer.byteLength(log, "utf8") > 2 * 1024 * 1024) child.kill()
      }
      child.stdout.on("data", collect)
      child.stderr.on("data", collect)
      const timer = setTimeout(() => child.kill(), 110000)
      let code: unknown
      try {
        ;[code] = await once(child, "exit")
      } finally {
        clearTimeout(timer)
      }
      assert.equal(code, 0, `${name} process failed:\n${log}`)
      if (name === "actual-http") {
        assert.match(log, /PASS actual HTTP: original provider auth \+ usage 100\/20/)
        assert.match(log, /PASS fresh Node process/)
        assert.match(log, /PASS actual HTTP cancellation/)
      } else {
        assert.match(log, /PASS first native receipt committed/)
        assert.match(
          log,
          /PASS native process restart: write=1, review=1, nativeChecks=2, approvals=1/
        )
      }
      console.log(`PASS flow prompt ${name}`)
    }
  } finally {
    const target = resolve(owned)
    assert.equal(dirname(target), temporaryRoot)
    assert(basename(target).startsWith("cmb-flow-prompt-recovery-suite-"))
    await rm(target, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
