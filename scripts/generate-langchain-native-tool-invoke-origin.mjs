import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { gunzipSync } from "node:zlib"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyNativeTextPatch } from "./langchain-native-patch-text.mjs"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
export const toolInvokePackageFiles = [
  "dist/agents/ReactAgent.js", "dist/agents/ReactAgent.cjs",
  "dist/agents/nodes/ToolNode.js", "dist/agents/nodes/ToolNode.cjs", "package.json",
  "dist/native-tool-invoke-origin.js", "dist/native-tool-invoke-origin.cjs",
  "dist/native-tool-invoke-origin.d.ts", "dist/native-tool-invoke-origin.d.cts"
]
export const toolInvokeTemplateFiles = [
  "langchain-native-tool-invoke-agent.js.inc", "langchain-native-tool-invoke-node.js.inc",
  "langchain-native-tool-invoke-origin.d.ts"
]
const nodeExports = [
  "constructNativeToolNode", "readNativeToolNodeInstance", "createNativeToolInvokeOperationForAgent",
  "executeNativeToolInvokeOperation", "readNativeToolInvokeSelections", "readNativeToolInvokeSelection",
  "readNativeToolInvokeOutcome", "closeAndDrainNativeToolInvokeOperation"
]
const agentExports = ["readNativeToolConstruction", "readNativeToolAgentInstance"]
const apiExports = nodeExports.slice(3)
function replaceOnce(source, before, after) {
  const index = source.indexOf(before)
  if (index < 0 || source.indexOf(before, index + before.length) >= 0)
    throw Error("LANGCHAIN_TOOL_PATCH_EXACT_SEAM_REQUIRED")
  return source.slice(0, index) + after + source.slice(index + before.length)
}
function exportsAtBirth(names) {
  return names.map(name => `Object.defineProperty(exports, "${name}", { value: ${name}, enumerable: true });`).join("\n") + "\n"
}

/** Build additive postimages from checked stream-base and official ToolNode bytes. No SDK execution. */
export function buildToolInvokePostimages(originals, templates) {
  const outputs = new Map()
  for (const extension of ["js", "cjs"]) {
    const cjs = extension === "cjs"
    const agentPath = `dist/agents/ReactAgent.${extension}`
    let agent = originals.get(agentPath).toString("utf8")
    const nodeImport = cjs ? "require_ToolNode.ToolNode" : "ToolNode"
    const wrapper = cjs ? "require_utils.wrapToolCall" : "wrapToolCall"
    const agentImports = cjs
      ? nodeExports.slice(0, 3).map(name => `const ${name} = require_ToolNode.${name};`).join("\n") + "\n"
      : `import { ${nodeExports.slice(0, 3).join(", ")} } from "./nodes/ToolNode.js";\n`
    agent = "var nativeToolAgentInitialized = false;\n" + (cjs ? exportsAtBirth(agentExports) : "") + agent
    agent = replaceOnce(agent, "//#region src/agents/ReactAgent.ts", agentImports + "//#region src/agents/ReactAgent.ts")
    agent = replaceOnce(agent, "var ReactAgent = class", templates.agent + "\nvar ReactAgent = class")
    agent = replaceOnce(agent, "constructor(options, defaultConfig) {", "constructor(options, defaultConfig, nativeToolConstructionRequest) {")
    agent = replaceOnce(agent, "\t\tthis.options = options;", "\t\tconst nativeToolConstruction = consumeNativeToolConstruction(nativeToolConstructionRequest, options, this);\n\t\tthis.options = options;")
    const oldNode = `\t\t\tconst toolNode = new ${nodeImport}(clientTools, {\n\t\t\t\tsignal: this.options.signal,\n\t\t\t\twrapToolCall: ${wrapper}(middleware)\n\t\t\t});`
    const newNode = `\t\t\tconst toolNode = nativeToolConstruction\n\t\t\t\t? constructNativeToolNode(clientTools, {\n\t\t\t\t\tsignal: this.options.signal,\n\t\t\t\t\twrapToolCall: ${wrapper}(middleware)\n\t\t\t\t}, prepareNativeToolNode(nativeToolConstruction, clientTools), this)\n\t\t\t\t: new ${nodeImport}(clientTools, {\n\t\t\t\t\tsignal: this.options.signal,\n\t\t\t\t\twrapToolCall: ${wrapper}(middleware)\n\t\t\t\t});\n\t\t\tfinishNativeToolNode(nativeToolConstruction, toolNode);`
    agent = replaceOnce(agent, oldNode, newNode)
    agent = replaceOnce(agent, "\t\tregisterNativeStreamInstance(this, this.#graph);", "\t\tregisterNativeStreamInstance(this, this.#graph);\n\t\tpublishNativeToolAgent(nativeToolConstruction, this, this.#graph);")
    if (cjs) agent = replaceOnce(agent, "exports.ReactAgent = ReactAgent;", "nativeToolAgentInitialized = true;\nexports.createNativeToolInvokeAgent = createNativeToolInvokeAgent;\nexports.createNativeToolInvokeOperation = createNativeToolInvokeOperation;\nexports.ReactAgent = ReactAgent;")
    else agent = replaceOnce(agent, "export { ReactAgent, createNativeStreamOperation, executeNativeStreamOperation, readNativeStreamBoundary };", "nativeToolAgentInitialized = true;\nexport { ReactAgent, createNativeStreamOperation, executeNativeStreamOperation, readNativeStreamBoundary, readNativeToolConstruction, readNativeToolAgentInstance, createNativeToolInvokeAgent, createNativeToolInvokeOperation };")
    outputs.set(agentPath, Buffer.from(agent))

    const nodePath = `dist/agents/nodes/ToolNode.${extension}`
    let node = originals.get(nodePath).toString("utf8")
    const nodeImports = cjs
      ? 'const require_NativeReactAgent = require("../ReactAgent.cjs");\n' + agentExports.map(name => `const ${name} = require_NativeReactAgent.${name};`).join("\n") + "\n"
      : `import { ${agentExports.join(", ")} } from "../ReactAgent.js";\n`
    node = "var nativeToolNodeInitialized = false;\n" + (cjs ? exportsAtBirth(nodeExports) : "") + node
    node = replaceOnce(node, "//#region src/agents/nodes/ToolNode.ts", nodeImports + "//#region src/agents/nodes/ToolNode.ts\n" + templates.node)
    node = replaceOnce(node, "constructor(tools, options) {", "constructor(tools, options, nativeConstruction, nativeAgent) {")
    node = replaceOnce(node, "\t\tthis.wrapToolCall = wrapToolCall;", "\t\tthis.wrapToolCall = wrapToolCall;\n\t\tregisterNativeToolNode(this, tools, options, nativeConstruction, nativeAgent);")
    node = replaceOnce(node, "\tasync runTool(call, config, state) {", "\tasync runTool(call, config, state) {\n\t\tconst nativeToolOperation = consumeNativeToolInvokeOperation(this, call, config, state);")
    const invokeStart = node.indexOf("\t\t\t\tconst output = await invokableTool.invoke({")
    const invokeEnd = node.indexOf("\n\t\t\t\tif (", invokeStart)
    if (invokeStart < 0 || invokeEnd < invokeStart) throw Error("LANGCHAIN_TOOL_PATCH_INVOKE_SEAM_REQUIRED")
    const originalInvoke = node.slice(invokeStart, invokeEnd)
    const argumentsText = originalInvoke.slice(originalInvoke.indexOf("({") + 1, -2)
    const invoke = `\t\t\t\tconst nativeSelection = nativeToolOperation ? selectNativeToolInvoke(nativeToolOperation, invokableTool, request, toolCall) : undefined;\n\t\t\t\tconst output = nativeSelection\n\t\t\t\t\t? await invokeSelectedNativeTool(nativeSelection, ${argumentsText})\n\t\t\t\t\t: await invokableTool.invoke(${argumentsText});`
    node = node.slice(0, invokeStart) + invoke + node.slice(invokeEnd)
    node = replaceOnce(node, "\t\tconst request = {", "\t\tconst nativeBaseHandler = nativeToolOperation ? wrapNativeToolBaseHandler(nativeToolOperation, baseHandler) : baseHandler;\n\t\tconst request = {")
    node = replaceOnce(node, "this.wrapToolCall(request, baseHandler)", "this.wrapToolCall(request, nativeBaseHandler)")
    node = replaceOnce(node, "return await baseHandler(request);", "return await nativeBaseHandler(request);")
    const captures = "const originalNativeToolNodeConstructor = ToolNode;\nconst originalNativeToolRunTool = Object.getOwnPropertyDescriptor(ToolNode.prototype, \"runTool\").value;\nnativeToolNodeInitialized = true;\n"
    if (cjs) node = replaceOnce(node, "exports.TOOLS_NODE_NAME = TOOLS_NODE_NAME;", captures + "exports.TOOLS_NODE_NAME = TOOLS_NODE_NAME;")
    else node = replaceOnce(node, "export { TOOLS_NODE_NAME, ToolNode };", captures + `export { TOOLS_NODE_NAME, ToolNode, ${nodeExports.join(", ")} };`)
    outputs.set(nodePath, Buffer.from(node))
  }
  let pkg = originals.get("package.json").toString("utf8")
  const subpath = '    "./native-tool-invoke-origin": {\n      "types": "./dist/native-tool-invoke-origin.d.ts",\n      "browser": null,\n      "node": {\n        "require": {\n          "types": "./dist/native-tool-invoke-origin.d.cts",\n          "default": "./dist/native-tool-invoke-origin.cjs"\n        },\n        "import": {\n          "types": "./dist/native-tool-invoke-origin.d.ts",\n          "default": "./dist/native-tool-invoke-origin.js"\n        }\n      }\n    },\n'
  pkg = replaceOnce(pkg, '    "./package.json": "./package.json"', subpath + '    "./package.json": "./package.json"')
  outputs.set("package.json", Buffer.from(pkg))
  outputs.set("dist/native-tool-invoke-origin.js", Buffer.from('export { createNativeToolInvokeAgent, createNativeToolInvokeOperation } from "./agents/ReactAgent.js";\n' + `export { ${apiExports.join(", ")} } from "./agents/nodes/ToolNode.js";\n`))
  outputs.set("dist/native-tool-invoke-origin.cjs", Buffer.from('const agent = require("./agents/ReactAgent.cjs");\nconst node = require("./agents/nodes/ToolNode.cjs");\n' + ["createNativeToolInvokeAgent", "createNativeToolInvokeOperation"].map(name => `exports.${name} = agent.${name};`).join("\n") + "\n" + apiExports.map(name => `exports.${name} = node.${name};`).join("\n") + "\n"))
  outputs.set("dist/native-tool-invoke-origin.d.ts", Buffer.from(templates.types))
  outputs.set("dist/native-tool-invoke-origin.d.cts", Buffer.from(templates.types))
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
    if (header[156] === 0 || header[156] === 48)
      result.set(prefix ? `${prefix}/${name}` : name, tar.subarray(offset + 512, offset + 512 + size))
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

/** Generate repository artifacts only, from the SRI-verified official archive plus the approved base. */
export async function generateLangchainNativeToolInvokeOrigin() {
  const baseBytes = await readFile(resolve(repository, "patches/langchain-1.2.37-native-stream-origin.manifest.json"))
  const base = JSON.parse(baseBytes)
  const archive = await readFile(resolve(repository, "output/langchain-1.2.37-official-verification/langchain-1.2.37.tgz"))
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== base.upstreamIntegrity ||
    createHash("sha1").update(archive).digest("hex") !== base.upstreamSha1)
    throw Error("LANGCHAIN_OFFICIAL_ARCHIVE_CHANGED")
  const members = tarMembers(archive), originalBase = new Map()
  for (const file of base.files) {
    const bytes = members.get(`package/${file.path}`)
    if ((bytes === undefined ? null : hash(bytes)) !== file.beforeSha256)
      throw Error("LANGCHAIN_OFFICIAL_BASE_CHANGED")
    originalBase.set(file.path, bytes)
  }
  const basePatch = await readFile(resolve(repository, "patches/langchain-1.2.37-native-stream-origin.patch"))
  if (hash(basePatch) !== base.patchSha256) throw Error("LANGCHAIN_BASE_PATCH_CHANGED")
  const baseOutputs = applyNativeTextPatch(basePatch.toString("utf8"), originalBase)
  for (const file of base.files)
    if (hash(baseOutputs.get(file.path)) !== file.afterSha256) throw Error("LANGCHAIN_BASE_POSTIMAGE_CHANGED")
  const originals = new Map()
  for (const path of toolInvokePackageFiles)
    originals.set(path, baseOutputs.get(path) ?? members.get(`package/${path}`))
  const templateBytes = await Promise.all(toolInvokeTemplateFiles.map(path => readFile(resolve(repository, "patches", path))))
  const outputs = buildToolInvokePostimages(originals, {
    agent: templateBytes[0].toString("utf8"), node: templateBytes[1].toString("utf8"), types: templateBytes[2].toString("utf8")
  })
  let patch = ""
  for (const path of toolInvokePackageFiles) patch += wholeFileHunk(path, originals.get(path), outputs.get(path))
  const applied = applyNativeTextPatch(patch, originals)
  for (const path of toolInvokePackageFiles)
    if (!applied.get(path).equals(outputs.get(path))) throw Error("LANGCHAIN_TOOL_PATCH_ROUNDTRIP_CHANGED")
  const manifest = {
    name: "langchain", version: "1.2.37", upstreamTarball: base.upstreamTarball,
    upstreamIntegrity: base.upstreamIntegrity, upstreamSha1: base.upstreamSha1,
    license: base.license, licenseSha256: base.licenseSha256,
    baseManifestSha256: hash(baseBytes), basePatchSha256: base.patchSha256,
    patchSha256: hash(Buffer.from(patch)),
    files: toolInvokePackageFiles.map(path => ({ path,
      beforeSha256: originals.get(path) === undefined ? null : hash(originals.get(path)),
      afterSha256: hash(outputs.get(path)) })),
    templates: toolInvokeTemplateFiles.map((path, index) => ({ path, sha256: hash(templateBytes[index]) }))
  }
  await writeFile(resolve(repository, "patches/langchain-1.2.37-native-tool-invoke-origin.patch"), patch)
  await writeFile(resolve(repository, "patches/langchain-1.2.37-native-tool-invoke-origin.manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  return { targets: outputs.size, patchSha256: manifest.patchSha256 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateLangchainNativeToolInvokeOrigin()
  process.stdout.write(JSON.stringify(result) + "\n")
}
