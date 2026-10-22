/** The local App must not load or register the retired Java-backed expert path. */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import ts from "typescript"

const root = resolve(".")
const sourceRoot = resolve(root, "src")
const options: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  baseUrl: root,
  paths: { "@/*": ["src/renderer/src/*"], "@renderer/*": ["src/renderer/src/*"] }
}
const visited = new Set<string>()
function visit(path: string): void {
  if (visited.has(path) || !path.startsWith(sourceRoot + "/") || path.endsWith(".d.ts")) return
  visited.add(path)
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
  const follow = (name: string) => {
    const result = ts.resolveModuleName(name, path, options, ts.sys).resolvedModule
    if (result) visit(result.resolvedFileName)
  }
  function walk(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      follow(node.moduleSpecifier.text)
    else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      follow(node.moduleSpecifier.text)
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    )
      follow(node.arguments[0].text)
    ts.forEachChild(node, walk)
  }
  walk(source)
}
for (const entry of ["src/main/index.ts", "src/preload/index.ts", "src/renderer/src/main.tsx"])
  visit(resolve(root, entry))
const paths = [...visited].map((p) => relative(root, p))
assert.equal(paths.filter((p) => p.startsWith("src/main/services/bot/")).length, 0)
for (const retained of [
  "src/main/bots/local-service.ts",
  "src/main/bots/work-tools.ts",
  "src/main/bots/conversation-link-service.ts",
  "src/main/bots/mock-channel-store.ts",
  "src/main/services/im/remote-runner.ts"
])
  assert.ok(paths.includes(retained), `normal App path remains reachable: ${retained}`)
for (const removed of [
  "src/main/ipc/partner-dev.ts",
  "src/main/ipc/requirements.ts",
  "src/main/ipc/design.ts",
  "src/main/agent/library/requirement-mode.ts",
  "src/renderer/src/components/requirement",
  "src/renderer/src/components/design",
  "src/renderer/src/components/visual-edit",
  "src/main/services/bot",
  "services/bot-control",
  "contracts/bot",
  "design-systems",
  "design-templates",
  "playwright-main",
  ".playwright-mcp",
  "chrome-extension",
  "src/preload/service-conversation.ts",
  "src/renderer/src/components/bots/ServiceExpertConversation.tsx"
])
  assert.equal(existsSync(resolve(root, removed)), false)
const preload = readFileSync(resolve(root, "src/preload/index.ts"), "utf8")
assert.ok(!preload.includes("partnerDev:") && !preload.includes("serviceConversation:"))
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
assert.equal(pkg.scripts["dev:bot-preview"], pkg.scripts.dev)
for (const resource of [...pkg.files, ...(pkg.build.extraResources ?? []).map((entry: any) => entry.from)])
  assert.ok(!/^(design-systems|design-templates|playwright-main|chrome-extension)(?:\/|$)/.test(resource))
assert.equal(pkg.scripts["test:bot-partner-panel"], undefined)
assert.equal(pkg.scripts["test:bot-partner-app"], undefined)
console.log("legacy disconnection proof", {
  reachableModules: paths.length,
  legacyModules: 0,
  localBetaBotImRetained: true,
  excludedFeatureModules: 0
})
