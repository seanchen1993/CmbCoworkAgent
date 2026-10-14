import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { applyNativeTextPatch } from "./langchain-native-patch-text.mjs"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
export const innerStreamPackages = [
  {
    name: "@langchain/core", version: "1.1.36", directory: "core",
    artifact: "langchain-core-1.1.36-native-stream-origin",
    upstreamTarball: "https://registry.npmjs.org/@langchain/core/-/core-1.1.36.tgz",
    upstreamIntegrity: "sha512-9NWsdzU3uZD13lJwunXK0t6SIwew+UwcbHggW5yUdaiMmzKeNkDpp1lRD6p49N8+D0Vv4qmQBEKB4Ukh2jfnvw==",
    upstreamSha1: "672d758e50e09fe402db2919ceb98b82cbca901b",
    module: "dist/runnables/base",
    before: [
      "d638764da6211151e90fe9140797f815bac4fa769785d03b154ec8a1c9cef3f3",
      "c413e618ebfbecbdf58bbda9c0fe3e2ae3a347b871c009eae565d141a13c2bb0",
      "c6b4e79c586ae63c51a51e44b4b693e34e3615b2c701235dd513b5f6407f2773"
    ],
    templates: ["langchain-core-native-stream-runtime.js.inc", "langchain-core-native-stream.d.ts"]
  },
  {
    name: "@langchain/langgraph", version: "1.2.5", directory: "langgraph",
    artifact: "langgraph-1.2.5-native-stream-origin",
    upstreamTarball: "https://registry.npmjs.org/@langchain/langgraph/-/langgraph-1.2.5.tgz",
    upstreamIntegrity: "sha512-O/ROF1oaXN7VK6+WTpXsDvJp7L+YyTOHa9rt3L85jrvwxBqQQRIlRLOWT8ehB/ywE3M1K7WAWOAXbmorCYzviQ==",
    upstreamSha1: "f4285b77baee945092795c2989bdd6589dc5b142",
    module: "dist/pregel/index",
    before: [
      "afeb36cdae00f2e32f78001961909562189621fc3e57922946d334a9042fa63c",
      "aaa0f408a24ecf58e2c0410503b86d366f2e7dd735ea375e1910346fdd0d9949",
      "c0c31f93b425c37d0c906801758f822b682e841bf33bb442946f4fc7bd1422e2",
      null, null, null, null,
      "c7c0b58507d214e09f6a8cfe0fac9f485a1811e19a42aee9eaf5b5c566a85366",
      "62730c465066f861299f3ad5a70efc1da22db295b52557995f8fe12f4f90cfaa",
      "b4859fe9aa953273324f5d9210072f51cded818ccc383ab2885780abfd5f15f2",
      "0b1f125ee7e92df3a629d5993131fc90bc464ce548c826809e97cf673bc6efdb"
    ],
    templates: ["langgraph-native-stream-runtime.js.inc", "langgraph-native-stream.d.ts",
      "langgraph-native-checkpoint-loop-runtime.js.inc"]
  }
]
export function innerStreamPackageFiles(description) {
  const paths = [`${description.module}.js`, `${description.module}.cjs`, "package.json",
    "dist/native-stream-origin.js", "dist/native-stream-origin.cjs",
    "dist/native-stream-origin.d.ts", "dist/native-stream-origin.d.cts"]
  return description.name === "@langchain/langgraph"
    ? [...paths, "dist/pregel/loop.js", "dist/pregel/loop.cjs",
      "dist/pregel/runner.js", "dist/pregel/runner.cjs"] : paths
}
function replaceOnce(source, before, after) {
  const index = source.indexOf(before)
  if (index < 0 || source.indexOf(before, index + before.length) >= 0)
    throw Error("LANGCHAIN_INNER_PATCH_EXACT_SEAM_REQUIRED")
  return source.slice(0, index) + after + source.slice(index + before.length)
}
function fixedCjsExports(names) {
  return names.map(name => `Object.defineProperty(exports, "${name}", { value: ${name}, enumerable: true });`).join("\n")
}
function subpath() {
  return '    "./native-stream-origin": {\n      "types": "./dist/native-stream-origin.d.ts",\n      "browser": null,\n      "node": {\n        "import": {\n          "types": "./dist/native-stream-origin.d.ts",\n          "default": "./dist/native-stream-origin.js"\n        },\n        "require": {\n          "types": "./dist/native-stream-origin.d.cts",\n          "default": "./dist/native-stream-origin.cjs"\n        }\n      }\n    },\n'
}
function addShims(outputs, module, names, types) {
  outputs.set("dist/native-stream-origin.js", Buffer.from(`export { ${names.join(", ")} } from "./${module.slice(5)}.js";\n`))
  outputs.set("dist/native-stream-origin.cjs", Buffer.from(`const origin = require("./${module.slice(5)}.cjs");\n` +
    names.map(name => `Object.defineProperty(exports, "${name}", { value: origin.${name}, enumerable: true });`).join("\n") + "\n"))
  outputs.set("dist/native-stream-origin.d.ts", Buffer.from(types))
  outputs.set("dist/native-stream-origin.d.cts", Buffer.from(types))
}

/** Pure postimage construction; it does not execute or install the SDK. */
export function buildInnerStreamPostimages(description, originals, runtime, types, loopRuntime) {
  const outputs = new Map()
  const core = description.name === "@langchain/core"
  const names = core
    ? ["createNativeRunnableStreamOperation", "executeNativeRunnableStreamOperation",
      "readNativeRunnableStreamBoundary", "readNativeRunnableStreamSettlement"]
    : ["createNativePregelStreamOperation", "executeNativePregelStreamOperation",
      "readNativePregelStreamOperation", "readNativePregelStreamSettlement",
      "createNativePregelCheckpointIterator", "readNativePregelCheckpointIteratorOrigin",
      "claimNativePregelCheckpointCall", "readNativePregelCheckpointCall",
      "readNativePregelCheckpointSettlement"]
  for (const extension of ["js", "cjs"]) {
    const path = `${description.module}.${extension}`, cjs = extension === "cjs"
    let source = originals.get(path).toString("utf8")
    if (core) {
      source = replaceOnce(source, "//#region src/runnables/base.ts", "//#region src/runnables/base.ts\n" + runtime)
      const configCallee = cjs ? "require_config.ensureConfig" : "ensureConfig"
      const streamStart = `\tasync stream(input, options) {\n\t\tconst config = ${configCallee}(options);\n\t\tconst wrappedGenerator = new `
      source = replaceOnce(source, streamStart,
        `\tasync stream(input, options) {\n\t\tconst nativeOperation = consumeNativeRunnableStreamOperation(this, input, options);\n\t\tconst config = ${configCallee}(options);\n\t\tinitializeNativeRunnableStreamOperation(nativeOperation, config);\n\t\tconst wrappedGenerator = new `)
      source = replaceOnce(source, "generator: this._streamIterator(input, config),",
        "generator: nativeOperation ? invokeNativeRunnableStreamIterator(nativeOperation, this, input, config) : this._streamIterator(input, config),")
      const captures = 'const originalNativeRunnableStream = Object.getOwnPropertyDescriptor(Runnable.prototype, "stream").value;\nnativeRunnableInitialized = true;\n'
      if (cjs) source = replaceOnce(source, "exports.Runnable = Runnable;", captures + fixedCjsExports(names) + "\nexports.Runnable = Runnable;")
      else source = replaceOnce(source, "export { Runnable,", captures + `export { ${names.join(", ")}, Runnable,`)
    } else {
      if (typeof loopRuntime !== "string") throw Error("LANGGRAPH_CHECKPOINT_TEMPLATE_REQUIRED")
      const privateNames = ["readNativePregelCheckpointLoopRequest", "readNativePregelCheckpointExecution"]
      const loopNames = ["invokeNativePregelLoopInitialization", "assertNativePregelLoopInitializeOrigin",
        "claimNativePregelCheckpointCall", "readNativePregelCheckpointCall",
        "readNativePregelCheckpointSettlement"]
      const imports = cjs
        ? 'const require_NativeRunnableStream = require("@langchain/core/native-stream-origin");\n' +
          ["createNativeRunnableStreamOperation", "executeNativeRunnableStreamOperation", "readNativeRunnableStreamBoundary"]
            .map(name => `const ${name} = require_NativeRunnableStream.${name};`).join("\n") + "\n" +
          loopNames.map(name => `const ${name} = require_loop.${name};`).join("\n") + "\n"
        : 'import { createNativeRunnableStreamOperation, executeNativeRunnableStreamOperation, readNativeRunnableStreamBoundary } from "@langchain/core/native-stream-origin";\n'
      if (cjs) source = fixedCjsExports(privateNames) + "\n" + source
      else source = replaceOnce(source, 'import { PregelLoop } from "./loop.js";',
        `import { PregelLoop, ${loopNames.join(", ")} } from "./loop.js";`)
      source = replaceOnce(source, "//#region src/pregel/index.ts", imports + "//#region src/pregel/index.ts\n" + runtime)
      source = replaceOnce(source, "\tstream(input, options) {\n\t\treturn super.stream(input, options);\n\t}",
        "\tstream(input, options) {\n\t\tconst nativeOperation = consumeNativePregelPartialStream(this, input, options);\n\t\treturn nativeOperation ? invokeNativePregelRunnableStream(nativeOperation, this, input, options) : super.stream(input, options);\n\t}")
      source = replaceOnce(source, "\t\tif (this.autoValidate) this.validate();",
        "\t\tif (this.autoValidate) this.validate();\n\t\tregisterNativePregelBirth(this);")
      source = replaceOnce(source, "\tasync stream(input, options) {\n\t\tconst abortController",
        "\tasync stream(input, options) {\n\t\tconst nativeOperation = consumeNativePregelStreamOperation(this, input, options);\n\t\tconst abortController")
      source = replaceOnce(source, "\t\tconst stream = await super.stream(input, config);",
        "\t\tconst stream = await (nativeOperation ? invokeNativePregelPartialStream(nativeOperation, this, input, config) : super.stream(input, config));")
      source = replaceOnce(source, "\tasync *_streamIterator(input, options) {",
        "\tasync *_streamIterator(input, options, nativeCheckpointTicket = undefined) {\n" +
        "\t\tconst nativeCheckpointBody = consumeNativePregelCheckpointBody(nativeCheckpointTicket, this, input, options);")
      const initializeCallee = cjs ? "require_loop.PregelLoop.initialize" : "PregelLoop.initialize"
      const initializeStart = `\t\t\t\tloop = await ${initializeCallee}(`
      const from = source.indexOf(initializeStart)
      const to = source.indexOf("\n\t\t\t\tconst runner = ", from)
      if (from < 0 || to <= from || source.indexOf(initializeStart, from + 1) >= 0)
        throw Error("LANGGRAPH_LOOP_INITIALIZE_SEAM_REQUIRED")
      const ordinary = source.slice(from, to)
      if (!ordinary.endsWith(");")) throw Error("LANGGRAPH_LOOP_INITIALIZE_END_REQUIRED")
      const params = ordinary.slice(initializeStart.length, -2)
      const controlled = "\t\t\t\tif (nativeCheckpointBody) {\n" +
        "\t\t\t\t\tconst request = beginNativePregelCheckpointLoop(nativeCheckpointBody);\n" +
        "\t\t\t\t\tassertNativePregelLoopInitializeOrigin();\n" +
        `\t\t\t\t\tconst nativeParams = ${params};\n` +
        "\t\t\t\t\tloop = await invokeNativePregelCheckpointLoop(request, nativeParams);\n" +
        "\t\t\t\t} else {\n" + ordinary + "\n\t\t\t\t}"
      source = source.slice(0, from) + controlled + source.slice(to)
      const iteratorBodyStart = source.indexOf("\n\t\tconst streamEncoding = ",
        source.indexOf("\tasync *_streamIterator(input, options, nativeCheckpointTicket"))
      const iteratorBodyEnd = source.indexOf("\n\t}\n\t/**\n\t* Run the graph with a single input", iteratorBodyStart)
      if (iteratorBodyStart < 0 || iteratorBodyEnd <= iteratorBodyStart)
        throw Error("LANGGRAPH_ITERATOR_COMPLETE_BODY_REQUIRED")
      source = source.slice(0, iteratorBodyStart) + "\n\t\ttry {" +
        source.slice(iteratorBodyStart, iteratorBodyEnd) +
        "\n\t\t} catch (reason) {\n\t\t\tinvalidateNativePregelCheckpointBody(nativeCheckpointBody);\n\t\t\tthrow reason;\n\t\t}" +
        source.slice(iteratorBodyEnd)
      const captures = 'const originalNativePartialStream = Object.getOwnPropertyDescriptor(PartialRunnable.prototype, "stream").value;\nconst originalNativePregelStream = Object.getOwnPropertyDescriptor(Pregel.prototype, "stream").value;\nconst originalNativePregelIteratorOwner = Pregel.prototype;\nconst originalNativePregelIteratorField = Object.getOwnPropertyDescriptor(Pregel.prototype, "_streamIterator");\nnativePregelInitialized = true;\n'
      if (cjs) source = replaceOnce(source, "exports.Channel = Channel;", captures + fixedCjsExports(names) + "\nexports.Channel = Channel;")
      else source = replaceOnce(source, "export { Channel, Pregel };", captures +
        `export { Channel, Pregel, ${names.join(", ")}, ${privateNames.join(", ")} };`)
      // Cache replay can leave no pending tasks. Do not create an unobserved abort waiter.
      // Keep the existing already-aborted guard first and leave nonempty scheduling unchanged.
      const runnerPath = `dist/pregel/runner.${extension}`
      const runnerSource = originals.get(runnerPath).toString("utf8")
      const abortGuard = '\t\tif (signals?.composedAbortSignal?.aborted) throw new Error("Abort");'
      outputs.set(runnerPath, Buffer.from(replaceOnce(runnerSource, abortGuard,
        abortGuard + "\n\t\tif (tasks.length === 0) return;")))
      const loopPath = `dist/pregel/loop.${extension}`
      let loopSource = originals.get(loopPath).toString("utf8")
      if (cjs) loopSource = fixedCjsExports(loopNames) + "\n" + loopSource
      const loopImports = cjs
        ? 'const nativeCheckpointPregel = require("./index.cjs");\n' +
          privateNames.map(name => `const ${name} = nativeCheckpointPregel.${name};`).join("\n") + "\n"
        : `import { ${privateNames.join(", ")} } from "./index.js";\n`
      loopSource = replaceOnce(loopSource, "//#region src/pregel/loop.ts",
        loopImports + "//#region src/pregel/loop.ts\n" + loopRuntime)
      loopSource = replaceOnce(loopSource, "\tstatic async initialize(params) {",
        "\tstatic async initialize(params, nativeRequest = undefined) {\n" +
        "\t\tconst nativeCheckpointLoop = consumeNativePregelLoopInitialization(this, params, nativeRequest);")
      loopSource = replaceOnce(loopSource,
        "\t\tconst saved = await params.checkpointer?.getTuple(checkpointConfig) ?? {",
        "\t\tconst saved = await (nativeCheckpointLoop ? invokeNativePregelCheckpointCall(nativeCheckpointLoop, checkpointConfig) : params.checkpointer?.getTuple(checkpointConfig)) ?? {")
      const loopCapture = 'const originalNativeLoopPrototype = Object.getPrototypeOf(PregelLoop);\n' +
        'const originalNativeLoopInitializeField = Object.getOwnPropertyDescriptor(PregelLoop, "initialize");\n' +
        'nativeLoopInitialized = true;\n'
      if (cjs) loopSource = replaceOnce(loopSource, "exports.PregelLoop = PregelLoop;",
        loopCapture + "exports.PregelLoop = PregelLoop;")
      else loopSource = replaceOnce(loopSource, "export { PregelLoop };",
        loopCapture + `export { PregelLoop, ${loopNames.join(", ")} };`)
      outputs.set(loopPath, Buffer.from(loopSource))
    }
    outputs.set(path, Buffer.from(source))
  }
  outputs.set("package.json", Buffer.from(replaceOnce(originals.get("package.json").toString("utf8"),
    '    "./package.json": "./package.json"', subpath() + '    "./package.json": "./package.json"')))
  addShims(outputs, description.module, names, types)
  return outputs
}
function tarMembers(bytes) {
  const result = new Map(), tar = gunzipSync(bytes)
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString("utf8").split("\0")[0]
    const prefix = header.subarray(345, 500).toString("utf8").split("\0")[0]
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim(), 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw Error("LANGCHAIN_OFFICIAL_TAR_INVALID")
    if (header[156] === 0 || header[156] === 48) {
      const key = prefix ? `${prefix}/${name}` : name
      if (result.has(key)) throw Error("LANGCHAIN_OFFICIAL_TAR_DUPLICATE")
      result.set(key, tar.subarray(offset + 512, offset + 512 + size))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return result
}
function wholeFileHunk(path, before, after) {
  const old = before === undefined ? "" : before.toString("utf8"), next = after.toString("utf8")
  const rows = value => {
    const list = value === "" ? [] : value.split("\n")
    if (value.endsWith("\n")) list.length--
    return list
  }
  const oldRows = rows(old), newRows = rows(next)
  let patch = `--- ${before === undefined ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n@@ -${oldRows.length ? 1 : 0},${oldRows.length} +${newRows.length ? 1 : 0},${newRows.length} @@\n`
  for (let index = 0; index < oldRows.length; index++) {
    patch += `-${oldRows[index]}\n`
    if (index === oldRows.length - 1 && !old.endsWith("\n")) patch += "\\ No newline at end of file\n"
  }
  for (let index = 0; index < newRows.length; index++) {
    patch += `+${newRows[index]}\n`
    if (index === newRows.length - 1 && !next.endsWith("\n")) patch += "\\ No newline at end of file\n"
  }
  return patch
}

/** Repository artifacts only. Root runs this after independent source review, never during dev. */
export async function generateLangchainInnerStreamOrigin() {
  const generated = []
  for (const description of innerStreamPackages) {
    const official = resolve(repository, "output/langchain-core-graph-official-verification-20261006", description.directory)
    const archive = await readFile(resolve(official, "official.tgz"))
    if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== description.upstreamIntegrity ||
      createHash("sha1").update(archive).digest("hex") !== description.upstreamSha1)
      throw Error("LANGCHAIN_OFFICIAL_ARCHIVE_CHANGED")
    const members = tarMembers(archive), paths = innerStreamPackageFiles(description), originals = new Map()
    for (let index = 0; index < paths.length; index++) {
      const bytes = members.get(`package/${paths[index]}`)
      if ((bytes === undefined ? null : hash(bytes)) !== (description.before[index] ?? null))
        throw Error("LANGCHAIN_OFFICIAL_PREIMAGE_CHANGED")
      originals.set(paths[index], bytes)
    }
    const pkg = JSON.parse(originals.get("package.json")), license = members.get("package/LICENSE")
    if (pkg.name !== description.name || pkg.version !== description.version || pkg.license !== "MIT" || !license)
      throw Error("LANGCHAIN_OFFICIAL_PACKAGE_CHANGED")
    const templateBytes = await Promise.all(description.templates.map(path => readFile(resolve(repository, "patches", path))))
    const outputs = buildInnerStreamPostimages(description, originals,
      templateBytes[0].toString("utf8"), templateBytes[1].toString("utf8"), templateBytes[2]?.toString("utf8"))
    let patch = ""
    for (const path of paths) patch += wholeFileHunk(path, originals.get(path), outputs.get(path))
    const applied = applyNativeTextPatch(patch, originals)
    for (const path of paths)
      if (!applied.get(path).equals(outputs.get(path))) throw Error("LANGCHAIN_INNER_PATCH_ROUNDTRIP_CHANGED")
    const manifest = { name: description.name, version: description.version,
      upstreamTarball: description.upstreamTarball, upstreamIntegrity: description.upstreamIntegrity,
      upstreamSha1: description.upstreamSha1, license: "MIT", licenseSha256: hash(license),
      patchSha256: hash(Buffer.from(patch)),
      files: paths.map(path => ({ path,
        beforeSha256: originals.get(path) === undefined ? null : hash(originals.get(path)),
        afterSha256: hash(outputs.get(path)) })),
      templates: description.templates.map((path, index) => ({ path, sha256: hash(templateBytes[index]) })) }
    generated.push({ description, patch, manifest })
  }
  // Both official packages and all eighteen postimages must validate before any artifact is published.
  for (const { description, patch, manifest } of generated) {
    await writeFile(resolve(repository, "patches", `${description.artifact}.patch`), patch)
    await writeFile(resolve(repository, "patches", `${description.artifact}.manifest.json`), JSON.stringify(manifest, null, 2) + "\n")
  }
  return generated.map(({ description, manifest }) => ({ name: description.name, targets: manifest.files.length,
    patchSha256: manifest.patchSha256 }))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await generateLangchainInnerStreamOrigin()) + "\n")
}
