import { parse, type AnyNode, type Node } from "acorn"
import { dirname, relative, resolve } from "node:path"
import type { Loader } from "esbuild"
import { modCompiler, resolveModFile } from "../loader"

function nodes(tree: Node): AnyNode[] {
  const result: AnyNode[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) return value.forEach(visit)
    if ("type" in value && typeof value.type === "string") result.push(value as AnyNode)
    for (const child of Object.values(value)) visit(child)
  }
  visit(tree)
  return result
}

/** Resolve Client assets at approval time, including TSX and renamed destructured constructors. */
export function resolveClientModules(
  source: string,
  loader: Loader,
  file: string,
  root: string
): { code: string; modules: string[] } {
  const { code } = modCompiler().transformSync(source, {
    loader,
    target: "esnext",
    jsxFactory: "__functionJsx",
    jsxFragment: "__functionFragment"
  })
  const ast = nodes(parse(code, { ecmaVersion: "latest", sourceType: "module" }))
  const names = new Set(["Client"])
  for (const node of ast) {
    if (node.type !== "ObjectPattern") continue
    for (const property of node.properties)
      if (
        property.type === "Property" &&
        !property.computed &&
        property.key.type === "Identifier" &&
        property.key.name === "Client" &&
        property.value.type === "Identifier"
      )
        names.add(property.value.name)
  }
  const constructor = (node: AnyNode | undefined): boolean =>
    !!node &&
    ((node.type === "Identifier" && names.has(node.name)) ||
      (node.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "Client"))
  const replacements: Array<{ start: number; end: number; text: string }> = []
  const modules = new Set<string>()
  for (const node of ast) {
    if (node.type !== "CallExpression") continue
    const jsx =
      node.callee.type === "Identifier" &&
      (node.callee.name === "__functionJsx" || node.callee.name === "h")
    if (!constructor(jsx ? node.arguments[0] : node.callee)) continue
    const props = node.arguments[jsx ? 1 : 0]
    if (props?.type !== "ObjectExpression") throw Error("MODS_CLIENT_MODULE_LITERAL")
    const property = props.properties.find(
      (p) =>
        p.type === "Property" &&
        !p.computed &&
        (p.key.type === "Identifier"
          ? p.key.name
          : p.key.type === "Literal"
            ? p.key.value
            : undefined) === "module"
    )
    if (
      property?.type !== "Property" ||
      property.value.type !== "Literal" ||
      typeof property.value.value !== "string" ||
      !property.value.value.startsWith(".")
    )
      throw Error("MODS_CLIENT_MODULE_LITERAL")
    const module = relative(
      root,
      resolveModFile(root, relative(root, resolve(dirname(file), property.value.value)))
    ).replaceAll("\\", "/")
    modules.add(module)
    replacements.push({
      start: property.value.start,
      end: property.value.end,
      text: JSON.stringify(module)
    })
  }
  let rewritten = code
  for (const edit of replacements.sort((a, b) => b.start - a.start))
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
  return { code: rewritten, modules: [...modules] }
}
