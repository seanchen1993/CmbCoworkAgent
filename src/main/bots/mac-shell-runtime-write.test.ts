import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createTrustedMacBotHostShellTestFactory } from "./mac-host-shell-test-factory"
import { macBotShellPolicy } from "./mac-shell-sandbox"
import { botShellEnvironment, type BotShellRequest } from "./shell-contract"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const native = it.skipIf(process.platform !== "darwin")
async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/cmb-native-runtime-write-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, '源码 "项目'),
    directory = join(root, "host")
  const artifacts = join(workspace, "out", "main"),
    modules = join(workspace, "node_modules")
  const source = join(workspace, "src", "main", "bots")
  await Promise.all([
    mkdir(directory, { mode: 0o700 }),
    mkdir(artifacts, { recursive: true }),
    mkdir(join(modules, "zod"), { recursive: true }),
    mkdir(source, { recursive: true })
  ])
  await writeFile(join(workspace, "package.json"), '{"name":"runtime-fixture","type":"commonjs"}')
  await writeFile(join(modules, "zod", "package.json"), '{"name":"zod","version":"0.0.0"}')
  const files = {
    helper: join(artifacts, "bot-shell-owner.js"),
    worker: join(artifacts, "bot-shell.js"),
    chunk: join(artifacts, "owned-shell-common.js"),
    module: join(modules, "zod", "index.js"),
    source: join(source, "user.ts")
  }
  await Promise.all(Object.values(files).map((file) => writeFile(file, "ORIGINAL")))
  const request: BotShellRequest = {
    command: "node task.cjs",
    cwd: workspace,
    runId: "native-runtime-write",
    timeoutMs: 5000,
    execution: { windowsSandbox: "none", resourceDirectory: root }
  }
  const factory = await createTrustedMacBotHostShellTestFactory({
    directory,
    helperEntry: files.helper,
    workerEntry: files.worker,
    hostId: () => "host",
    dataEpoch: () => "epoch",
    assertOwnership: async (signal) => signal.throwIfAborted()
  })
  return { root, workspace, directory, artifacts, modules, source, files, request, factory }
}
async function probe(f: Awaited<ReturnType<typeof fixture>>, script: string) {
  const options = await f.factory(f.request, new AbortController().signal)
  cleanup.push(() => options.releasePrepared!(true))
  const child = spawn(options.launch.executable, [...options.launch.execArgv, "--eval", script], {
    cwd: f.workspace,
    env: {
      ...botShellEnvironment(process.env),
      ...options.launch.environment,
      ELECTRON_RUN_AS_NODE: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let output = "",
    error = ""
  child.stdout.on("data", (value) => (output += value))
  child.stderr.on("data", (value) => (error += value))
  expect((await once(child, "close"))[0], error).toBe(0)
  return JSON.parse(output) as Record<string, string>
}
const actions = (entries: Record<string, string>) =>
  `const fs=require('fs');const result={};for(const [key,file] of Object.entries(${JSON.stringify(entries)})){try{fs.writeFileSync(file,'MUTATED');result[key]='allowed'}catch(error){result[key]=error.code}}console.log(JSON.stringify(result))`

native(
  "blocks writes to current helper/worker/sibling chunks and modules while allowing project source",
  async () => {
    const f = await fixture()
    const result = await probe(f, actions(f.files))
    for (const key of ["helper", "worker", "chunk", "module"])
      expect(["EPERM", "EACCES"]).toContain(result[key])
    expect(result.source).toBe("allowed")
    for (const key of ["helper", "worker", "chunk", "module"] as const)
      expect(await readFile(f.files[key], "utf8")).toBe("ORIGINAL")
    expect(await readFile(f.files.source, "utf8")).toBe("MUTATED")
  },
  15000
)

native(
  "refuses rename-parent mutation and rename-back around the current runtime",
  async () => {
    const f = await fixture(),
      original = join(f.workspace, "out"),
      moved = join(f.workspace, "moved-out")
    const result = await probe(
      f,
      `const fs=require('fs');let result;try{fs.renameSync(${JSON.stringify(original)},${JSON.stringify(moved)});fs.writeFileSync(${JSON.stringify(join(moved, "main", "owned-shell-common.js"))},'MUTATED');fs.renameSync(${JSON.stringify(moved)},${JSON.stringify(original)});result='allowed'}catch(error){result=error.code}console.log(JSON.stringify({renameParent:result}))`
    )
    expect(["EPERM", "EACCES"]).toContain(result.renameParent)
    expect(await readFile(f.files.chunk, "utf8")).toBe("ORIGINAL")
  },
  15000
)

native(
  "keeps runtime aliases and hard links from becoming writable copies of installed code",
  async () => {
    const f = await fixture(),
      alias = join(f.workspace, "runtime-link"),
      moduleAlias = join(f.workspace, "module-link")
    await symlink(f.artifacts, alias, "dir")
    await symlink(f.modules, moduleAlias, "dir")
    const result = await probe(
      f,
      `const fs=require('fs');const result={};for(const [key,action] of Object.entries({linkedChunk:()=>fs.writeFileSync(${JSON.stringify(join(alias, "owned-shell-common.js"))},'MUTATED'),linkedModule:()=>fs.writeFileSync(${JSON.stringify(join(moduleAlias, "zod", "index.js"))},'MUTATED'),hardLink:()=>{fs.linkSync(${JSON.stringify(f.files.chunk)},'hard-chunk');fs.writeFileSync('hard-chunk','MUTATED')}})){try{action();result[key]='allowed'}catch(error){result[key]=error.code}}console.log(JSON.stringify(result))`
    )
    for (const key of ["linkedChunk", "linkedModule", "hardLink"])
      expect(["EPERM", "EACCES"]).toContain(result[key])
    expect(await readFile(f.files.chunk, "utf8")).toBe("ORIGINAL")
    expect(await readFile(f.files.module, "utf8")).toBe("ORIGINAL")
  },
  15000
)

native(
  "preserves source edits, ordinary output and tool caches, and installed runtime reads",
  async () => {
    const f = await fixture()
    const result = await probe(
      f,
      `const fs=require('fs'),path=require('path'),os=require('os');const result={};for(const [key,action] of Object.entries({source:()=>{fs.writeFileSync(${JSON.stringify(f.files.source)},'EDITED');fs.unlinkSync(${JSON.stringify(f.files.source)})},output:()=>fs.writeFileSync('out/report.txt','BUILD_RESULT'),home:()=>fs.writeFileSync(path.join(os.homedir(),'cache'),'CACHE'),temporary:()=>fs.writeFileSync(path.join(os.tmpdir(),'tmp-data'),'TMP'),runtimeRead:()=>fs.readFileSync(${JSON.stringify(f.files.chunk)})})){try{action();result[key]='allowed'}catch(error){result[key]=error.code}}console.log(JSON.stringify(result))`
    )
    expect(result).toEqual({
      source: "allowed",
      output: "allowed",
      home: "allowed",
      temporary: "allowed",
      runtimeRead: "allowed"
    })
    expect(await readFile(join(f.workspace, "out", "report.txt"), "utf8")).toBe("BUILD_RESULT")
  },
  15000
)

native(
  "guards private-data ancestors without blocking other project directories",
  async () => {
    const f = await fixture(),
      parent = join(f.workspace, "private"),
      privateRoot = join(parent, "data")
    await mkdir(privateRoot, { recursive: true })
    await writeFile(join(privateRoot, "secret"), "PRIVATE")
    f.request.protectedRoots = [privateRoot]
    const result = await probe(
      f,
      `const fs=require('fs');let result;try{fs.renameSync(${JSON.stringify(parent)},${JSON.stringify(join(f.workspace, "moved-private"))});fs.readFileSync(${JSON.stringify(join(f.workspace, "moved-private/data/secret"))});result='allowed'}catch(error){result=error.code}console.log(JSON.stringify({renamePrivate:result}))`
    )
    expect(["EPERM", "EACCES"]).toContain(result.renamePrivate)
    expect(await readFile(join(privateRoot, "secret"), "utf8")).toBe("PRIVATE")
  },
  15000
)

it("rejects unsafe write-denied roots instead of interpolating untrusted profile text", () => {
  for (const path of ["relative", "/tmp/\n(allow default)", "/tmp/\0"])
    expect(() =>
      macBotShellPolicy({
        readRoots: [],
        writeRoots: [],
        protectedRoots: [],
        writeDeniedRoots: [path]
      })
    ).toThrow()
})
