import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { FUNCTION_SDK_METHODS } from "./sdk-capabilities"

const root = resolve(__dirname, "../../../..")
const normalized = (path: string) => relative(root, path).replaceAll("\\", "/")
interface Edge {
  from: string
  to: string
  typeOnly: boolean
}
const parsed = new Map<string, Edge[]>()

function localModule(from: string, name: string): string | undefined {
  const base = name.startsWith(".")
    ? resolve(dirname(from), name)
    : name.startsWith("@renderer/")
      ? resolve(root, "src/renderer/src", name.slice(10))
      : name.startsWith("@/")
        ? resolve(root, "src/renderer/src", name.slice(2))
        : undefined
  if (!base) return undefined
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".mjs", ".js", ".d.ts"].map((ext) => base + ext),
    join(base, "index.ts"),
    join(base, "index.tsx")
  ]
  const found = candidates.find((path) => existsSync(path) && /\.(?:[cm]?[jt]sx?)$/.test(path))
  if (!found && !/\.(?:css|svg|png|json)(?:\?.*)?$/.test(base))
    throw Error(`Unresolved local dependency: ${normalized(from)} -> ${name}`)
  return found
}

/** Parse actual import/export edges, including literal dynamic imports and import types. */
function imports(path: string): Edge[] {
  const previous = parsed.get(path)
  if (previous) return previous
  const edges: Edge[] = []
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
  const add = (name: string, typeOnly: boolean) => {
    const target = localModule(path, name)
    if (target) edges.push({ from: path, to: target, typeOnly })
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const names = clause?.namedBindings
      const onlyTypes =
        !!clause?.isTypeOnly ||
        (!!clause &&
          !clause.name &&
          !!names &&
          ts.isNamedImports(names) &&
          names.elements.length > 0 &&
          names.elements.every((element) => element.isTypeOnly))
      add(node.moduleSpecifier.text, onlyTypes)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node.isTypeOnly)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
        throw Error(`Computed import requires boundary review: ${normalized(path)}`)
      add(node.arguments[0].text, false)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal.text, true)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  parsed.set(path, edges)
  return edges
}

function graph(paths: string[], includeTypes = false): Edge[] {
  const pending = paths.map((path) => resolve(root, path)),
    seen = new Set<string>(),
    edges: Edge[] = []
  for (let path = pending.pop(); path; path = pending.pop()) {
    if (seen.has(path)) continue
    seen.add(path)
    for (const edge of imports(path)) {
      if (!includeTypes && edge.typeOnly) continue
      edges.push(edge)
      pending.push(edge.to)
    }
  }
  return edges
}

function forbidden(edges: Edge[], rule: (path: string) => boolean): string[] {
  return edges
    .filter((edge) => rule(normalized(edge.to)))
    .map((edge) => `${normalized(edge.from)} -> ${normalized(edge.to)}`)
}

describe("display architectural dependency boundaries", () => {
  const nativeRoots = [
    "display-native-projection",
    "display-snapshot-cache",
    "display-scopes",
    "display-rollout",
    "display-routing",
    "display-preparation",
    "static-ui-render-summary"
  ].map((name) => `src/main/mods/v2/${name}.ts`)

  it("keeps display implementation independent of Creator, business adapters and renderer/settings", () => {
    const edges = graph(nativeRoots, true)
    expect(edges.length).toBeGreaterThan(0)
    expect(
      forbidden(
        edges,
        (path) =>
          path.startsWith("src/renderer/") ||
          /\/(?:devtools|business-adapters|customize|settings)\//.test(path) ||
          /\/(?:creator-[^/]*|autobiz[^/]*)\.[cm]?[jt]sx?$/.test(path)
      ),
      "Native display dependency must not pull authoring/business/UI into the hot path"
    ).toEqual([])
    // Manager is an orchestrating facade; display internals must not import it back.
    expect(forbidden(edges, (path) => path === "src/main/mods/v2/manager.ts")).toEqual([])
  })

  it("uses shared DTOs from renderer display modules without importing Main or preload", () => {
    const renderer = "src/renderer/src"
    const files = readdirSync(resolve(root, renderer, "lib"))
      .filter((name) => /^function-site-.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
      .map((name) => `${renderer}/lib/${name}`)
    files.push(
      `${renderer}/lib/mods-chat-scope.tsx`,
      `${renderer}/components/chat/FunctionSite.tsx`,
      `${renderer}/components/chat/FunctionDisplayContent.tsx`
    )
    const direct = files.flatMap((path) => imports(resolve(root, path)))
    expect(
      forbidden(direct, (path) => path.startsWith("src/main/") || path.startsWith("src/preload/"))
    ).toEqual([])
    const shared = direct.filter((edge) => normalized(edge.to).startsWith("src/shared/"))
    expect(
      shared.some((edge) => normalized(edge.to) === "src/shared/mods/v2/display-snapshot.ts")
    ).toBe(true)
    expect(
      forbidden(
        graph(
          shared.map((edge) => normalized(edge.to)),
          true
        ),
        (path) =>
          path.startsWith("src/main/") ||
          path.startsWith("src/renderer/") ||
          path.startsWith("src/preload/")
      )
    ).toEqual([])
  })

  it("does not expose private scope/cache/rollout lifecycle through the guest SDK", () => {
    const edges = graph([
      "src/main/mods/v2/guest-bootstrap.ts",
      "src/main/mods/v2/sdk-capabilities.ts"
    ])
    expect(forbidden(edges, (path) => /^src\/main\/mods\/v2\/display-/.test(path))).toEqual([])
    expect(
      FUNCTION_SDK_METHODS.filter((method) => /^(?:display|rollout|snapshot)\./.test(method))
    ).toEqual([])
    // Shared passive data may be typed by sites; that must not create a Main import cycle.
    expect(
      forbidden(
        graph(["src/shared/mods/v2/display-snapshot.ts"], true),
        (path) => !path.startsWith("src/shared/")
      )
    ).toEqual([])
  })
})
