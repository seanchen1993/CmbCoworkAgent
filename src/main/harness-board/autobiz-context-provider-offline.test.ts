import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(collector: string) {
  const root = await mkdtemp(join(tmpdir(), "autobiz-offline-collector-"))
  roots.push(root)
  const provider = join(root, "provider.py"),
    tools = join(root, "collector")
  await mkdir(tools)
  await cp(resolve("resources/mods/autobiz-context-provider.py"), provider)
  await cp(
    resolve("resources/mods/autobiz-knowledge/collector-gray-matter.cjs"),
    join(root, "collector-gray-matter.cjs")
  )
  const script = join(tools, "collect-knowledge.js")
  await writeFile(script, collector)
  const invoke = async (body: string) => {
    const source = `
import importlib.util, json, time
from pathlib import Path
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("provider", ${JSON.stringify(provider)})
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)
collected = SimpleNamespace(KnowledgeCollectorError=RuntimeError,
    _timing_log=lambda *a, **kw: None, _short_error=lambda value: value[:500])
tools, script = Path(${JSON.stringify(tools)}), ${JSON.stringify(script)}
node = ${JSON.stringify(process.execPath)}
${body}
`
    const result = await execute("python", ["-B", "-X", "utf8", "-c", source], {
      windowsHide: true,
      timeout: 4000,
      maxBuffer: 128 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
    })
    return JSON.parse(result.stdout)
  }
  return { root, invoke }
}

it("parses full YAML anchors, quoted values, arrays and block scalars with the bundled original parser", async () => {
  const f = await fixture(`const fs=require('node:fs'),matter=require('gray-matter');
console.log(JSON.stringify(matter(fs.readFileSync(process.argv.at(-1)+'/knowledge.md','utf8')).data));`)
  await writeFile(
    join(f.root, "knowledge.md"),
    `---
defaults: &common
  type: Product Knowledge
<<: *common
deploy_unit: "DW.ORDER"
title: "a: b # c"
tags:
  - order
  - "a,b"
description: |
  first line
  second line
---
body
`
  )
  const result = await f.invoke(`provider.configure_offline_collector(collected, tools, script)
assert collected._npm_install(script) == ""
print(json.dumps(collected._run_collector(script, [], knowledge_path=${JSON.stringify(f.root)}, node_command=node)))`)
  expect(result).toMatchObject({
    type: "Product Knowledge",
    deploy_unit: "DW.ORDER",
    title: "a: b # c",
    tags: ["order", "a,b"],
    description: "first line\nsecond line\n"
  })
  expect(await readFile(join(f.root, "collector/collect-knowledge.js"), "utf8")).toContain(
    "require('gray-matter')"
  )
})

it("caps an actually stalled metadata request without manufacturing an application type", async () => {
  let requests = 0
  const sockets = new Set<import("node:net").Socket>()
  const server = createServer(() => {
    requests++
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Missing fixture port")
    const f = await fixture(`const http=require('node:http');
const request=http.request({hostname:'127.0.0.1',port:${address.port},path:'/',timeout:30000});
request.on('error',error=>console.log(JSON.stringify({unavailable:true,reason:error.message})));request.end();`)
    const result = await f.invoke(`provider.configure_offline_collector(collected, tools, script)
started = time.monotonic()
value = collected._run_collector(script, [], knowledge_path=str(tools), node_command=node)
print(json.dumps({"value":value,"elapsed":time.monotonic()-started}))`)
    expect(requests).toBe(1)
    expect(result.value).toEqual({ unavailable: true, reason: "AUTOBIZ_CONTEXT_METADATA_TIMEOUT" })
    expect(result.elapsed).toBeLessThan(3)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

it("shares a bounded deadline across units and never restores a manifest-only partial success", async () => {
  const f = await fixture("throw Error('CONTROLLED_COLLECTOR_MUST_NOT_START_NODE')")
  // Node startup and real I/O are exercised above. Control only this collector boundary
  // and its monotonic clock so host load cannot consume the first unit's test budget.
  const result = await f.invoke(`clock, calls = [100.0], []
real_subprocess = provider.subprocess
provider.time = SimpleNamespace(monotonic=lambda: clock[0])
def run_collector(argv, **options):
    timeout = options["timeout"]
    calls.append(timeout)
    duration = 1.5
    clock[0] += min(duration, timeout)
    if timeout < duration:
        raise real_subprocess.TimeoutExpired(argv, timeout)
    return SimpleNamespace(returncode=0, stdout='{"ok":true}', stderr="")
provider.subprocess = SimpleNamespace(run=run_collector, TimeoutExpired=real_subprocess.TimeoutExpired)
provider.configure_offline_collector(collected, tools, script)
started, completed, reason = clock[0], 0, ""
for i in range(20):
    try:
        collected._run_collector(script, [], knowledge_path=str(tools), node_command=node)
        completed += 1
    except RuntimeError as error:
        reason = str(error)
        break
calls_at_timeout = len(calls)
try:
    collected._run_collector(script, [], knowledge_path=str(tools), node_command=node)
except RuntimeError as error:
    exhausted = str(error)
try:
    collected._legacy_result([], "missing complete collector knowledge")
except RuntimeError as error:
    fallback = str(error)
print(json.dumps({"completed":completed,"reason":reason,"fallback":fallback,"elapsed":clock[0]-started,
    "calls":calls,"callsAtTimeout":calls_at_timeout,"exhausted":exhausted,
    "totalBudget":provider.SESSION_COLLECTOR_BUDGET_SECONDS,"callLimit":provider.COLLECTOR_CALL_TIMEOUT_SECONDS}))`)
  expect(result.completed).toBeGreaterThan(0)
  expect(result.completed).toBeLessThan(20)
  expect(result.completed).toBe(5)
  expect(result.totalBudget).toBe(8)
  expect(result.callLimit).toBe(3)
  expect(result.calls).toEqual([3, 3, 3, 3, 2, 0.5])
  expect(result.calls).toHaveLength(result.callsAtTimeout)
  expect(result.reason).toContain("AUTOBIZ_CONTEXT_COLLECTOR_TIMEOUT")
  expect(result.exhausted).toContain("AUTOBIZ_CONTEXT_COLLECTOR_BUDGET_EXHAUSTED")
  expect(result.fallback).toContain("SELECTED_KNOWLEDGE_UNAVAILABLE")
  expect(result.elapsed).toBe(result.totalBudget)
})

it("reports a missing offline resource before launching any node or package manager", async () => {
  const f = await fixture("throw Error('MUST_NOT_START')")
  await rm(join(f.root, "collector-gray-matter.cjs"))
  const result = await f.invoke(`try:
    provider.configure_offline_collector(collected, tools, script)
except RuntimeError as error:
    print(json.dumps({"error":str(error)}))`)
  expect(result.error).toContain("AUTOBIZ_CONTEXT_OFFLINE_PARSER_MISSING")
})
