import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { PassThrough } from "node:stream"
import { build } from "esbuild"
import {
  collectMcpPerformanceChild,
  MCP_PERFORMANCE_BOOTSTRAP_SOURCE,
  mcpPerformanceEsmExternal,
  mcpPerformanceSamples,
  type McpPerformanceChildOutput
} from "./support/mods-mcp-performance-harness"

async function main() {
  const root = resolve(__dirname, "..")
  const nativeRequire = createRequire(join(root, "package.json"))
  const artifacts = join(root, "output", `mods-mcp-harness-unit-${randomUUID()}`)
  mkdirSync(artifacts, { recursive: true })
  const source = 'import {createMessageConnection} from "vscode-jsonrpc/node";'
  for (const suite of ["runtime", "ingress", "mcp"]) {
    const result = await build({
      stdin: {
        contents: `${source}console.log(typeof createMessageConnection)`,
        resolveDir: root
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      packages: "external",
      plugins: [mcpPerformanceEsmExternal(suite)]
    })
    const output = result.outputFiles[0].text
    assert.equal(output.includes('from "vscode-jsonrpc/node.js"'), suite === "mcp")
    assert.equal(output.includes('from "vscode-jsonrpc/node"'), suite !== "mcp")
  }
  const neighbor = await build({
    stdin: {
      contents: 'import value from "vscode-jsonrpc/node/other";console.log(value)',
      resolveDir: root
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [mcpPerformanceEsmExternal("mcp")]
  })
  assert(neighbor.outputFiles[0].text.includes('from "vscode-jsonrpc/node/other"'))
  console.log("PASS exact MCP-only external normalization; adjacent specifiers unchanged")

  const entry = join(artifacts, "real-import.mjs")
  await build({
    stdin: {
      contents: `${source}process.stdout.write(JSON.stringify(typeof createMessageConnection))`,
      resolveDir: root
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [mcpPerformanceEsmExternal("mcp")]
  })
  const imported = await collectMcpPerformanceChild(
    spawn(process.execPath, [entry], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
    { stdout: () => {}, stderr: () => {} }
  )
  assert.equal(imported.code, 0, imported.stderr.toString("utf8"))
  assert.equal(imported.signal, null)
  assert.equal(imported.stdout.toString("utf8"), '"function"')
  console.log("PASS actual Node ESM loads the installed existing JSON-RPC shim")

  for (const fail of [false, true]) {
    const directory = join(artifacts, fail ? "electron-failure" : "electron-success")
    mkdirSync(directory)
    const bootstrap = join(directory, "mcp-bootstrap.cjs")
    writeFileSync(bootstrap, MCP_PERFORMANCE_BOOTSTRAP_SOURCE)
    writeFileSync(
      join(directory, "performance-entry.mjs"),
      `import assert from "node:assert/strict";
       import {writeFileSync} from "node:fs";
       import {app, BrowserWindow, safeStorage} from "electron";
       try {
         assert.equal(app.isReady(), true);
         assert.equal(typeof BrowserWindow.getAllWindows, "function");
         assert.equal(typeof safeStorage.isEncryptionAvailable, "function");
         ${fail ? 'throw Error("MCP_ORIGINAL_FIXTURE_FAILURE")' : `process.stdout.write(JSON.stringify(Array(100).fill(1)))`}
       } finally {writeFileSync(new URL("./fixture-finally.txt", import.meta.url), "completed")}`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(nativeRequire("electron") as string, [bootstrap], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    })
    const timeout = setTimeout(() => child.kill(), 15000)
    let output: McpPerformanceChildOutput
    try {
      output = await collectMcpPerformanceChild(child, { stdout: () => {}, stderr: () => {} })
    } finally {
      clearTimeout(timeout)
    }
    assert.equal(output.code, fail ? 1 : 0, output.stderr.toString("utf8"))
    assert.equal(output.signal, null)
    assert.equal(readFileSync(join(directory, "fixture-finally.txt"), "utf8"), "completed")
    const proof = JSON.parse(readFileSync(join(directory, "mcp-host-proof.json"), "utf8"))
    assert.equal(proof.pid, child.pid)
    assert(proof.versions.electron)
    assert.equal(proof.unexpectedWindows, 0)
    assert.equal(proof.before.windows, 0)
    assert.equal(proof.before.ownedUtilities, 0)
    const after = fail ? proof.failedAfter : proof.after
    assert.equal(after.windows, 0)
    assert.equal(after.ownedUtilities, 0)
    if (fail) {
      assert(output.stderr.toString("utf8").includes("MCP_ORIGINAL_FIXTURE_FAILURE"))
      assert.throws(() => mcpPerformanceSamples(output), /MCP_PERFORMANCE_CHILD_EXIT/)
    } else {
      assert.equal(proof.stdioDrained, true)
      assert.equal(mcpPerformanceSamples(output).length, 100)
    }
  }
  console.log(
    "PASS real Electron native imports, original finally and failure; no windows or guest utilities"
  )

  const fake = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  let settled = false
  const pending = collectMcpPerformanceChild(fake as unknown as ChildProcess, {
    stdout: () => {},
    stderr: () => {}
  }).then((value) => {
    settled = true
    return value
  })
  const valid = JSON.stringify(Array.from({ length: 100 }, (_, index) => index / 100))
  fake.stdout.write(valid.slice(0, 20))
  fake.emit("exit", 0, null)
  await Promise.resolve()
  assert.equal(settled, false, "exit must not parse partially drained stdout")
  fake.stdout.end(valid.slice(20))
  fake.stderr.end("original stderr")
  fake.emit("close", 0, null)
  const closed = await pending
  assert.equal(closed.stdout.toString("utf8"), valid)
  assert.equal(closed.stderr.toString("utf8"), "original stderr")
  assert.equal(mcpPerformanceSamples(closed).length, 100)
  console.log("PASS exit waits for close and preserves the remaining output")

  const output = (text: string): McpPerformanceChildOutput => ({
    code: 0,
    signal: null,
    closeCode: 0,
    closeSignal: null,
    exitObserved: true,
    stdout: Buffer.from(text),
    stderr: Buffer.alloc(0)
  })
  for (const text of [
    "",
    "[1",
    "null",
    "{}",
    "[]",
    "[1]",
    JSON.stringify(Array(100).fill(-1)),
    JSON.stringify(Array(100).fill("1")),
    `[${Array(100).fill("1e999").join(",")}]`
  ])
    assert.throws(() => mcpPerformanceSamples(output(text)))
  for (const changes of [
    { code: 1, closeCode: 1 },
    { code: null, signal: "SIGTERM", closeCode: null, closeSignal: "SIGTERM" },
    { exitObserved: false },
    { closeCode: 1 }
  ] as const)
    assert.throws(
      () => mcpPerformanceSamples({ ...output("not JSON"), ...changes }),
      /MCP_PERFORMANCE_CHILD_EXIT/,
      "failed/signal/partial processes must fail before attempting JSON parsing"
    )
  assert.equal(mcpPerformanceSamples(output(JSON.stringify(Array(100).fill(0)))).length, 100)
  console.log("PASS failed processes and invalid timing arrays never become valid samples")
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
