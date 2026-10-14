/** Controlled loopback provider; actual graph, SQLite and native project checks. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const temporaryRoot = resolve(tmpdir())
  const owned = await mkdtemp(join(temporaryRoot, "cmb-evaluation-suite-"))
  try {
    const output = join(owned, "evaluation.cjs")
    await build({
      entryPoints: [join(root, "tests/fixtures/flow-evaluation-native.ts")],
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
      plugins: [
        {
          name: "node-electron-platform",
          setup(builder) {
            builder.onResolve({ filter: /^electron$/ }, () => ({
              path: join(root, "tests/fixtures/flow-prompt-electron-platform.ts")
            }))
          }
        }
      ]
    })
    const child = spawn(process.execPath, [output], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
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
    const timer = setTimeout(() => child.kill(), 90000)
    try {
      const [code] = await once(child, "close")
      assert.equal(code, 0, log)
    } finally {
      clearTimeout(timer)
    }
    assert.match(log, /PASS controlled actual Native Flow evaluation/)
    assert.match(log, /PASS fresh Node process reads exact persisted evaluation/)
    assert.match(log, /PASS controlled provider requests=4/)
    console.log(log)
  } finally {
    const target = resolve(owned)
    assert.equal(dirname(target), temporaryRoot)
    assert(basename(target).startsWith("cmb-evaluation-suite-"))
    await rm(target, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
