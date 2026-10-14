import { posix } from "node:path"
import { functionMcpToolName } from "../v2/mcp-names"
import type * as TS from "typescript"
import type { FunctionModelProtocol } from "../../../shared/mods/v2/model-protocol"
import { FUNCTION_SDK_METHODS } from "../v2/sdk-capabilities"
import { matchesEventPattern } from "../../../shared/mods/v2/contracts"
import { FUNCTION_NATIVE_TOOL_COMPATIBILITY, FUNCTION_LOCAL_TOOL_NAMES }
  from "../../../shared/mods/v2/compatibility-catalog"

interface Location {
  file: string
  line: number
  column: number
}
export interface FunctionSdkDiagnostic extends Location {
  code: "MODS_SDK_UNSUPPORTED" | "MODS_SDK_UNVERIFIED" | "MODS_SDK_PROTOCOL"
  message: string
}
export interface FunctionSdkUsage extends Location {
  method: string
  support: "bounded" | "unsupported" | "unverified"
}
interface Snapshot {
  name?: string
  authoringSources?: Record<string, string>
  authoringEntries?: string[]
  digest: string
  modelProtocol: FunctionModelProtocol
}
type FunctionNode = TS.FunctionDeclaration | TS.FunctionExpression | TS.ArrowFunction

/** Bounded syntax analysis only. Never loads a plugin module or probes its hooks. */
export async function analyzeFunctionSdk(snapshot: Snapshot) {
  try {
    if (!snapshot.authoringSources || !Object.keys(snapshot.authoringSources).length ||
      !snapshot.authoringEntries?.length)
      throw Error("MODS_SDK_SOURCE_SNAPSHOT_REQUIRED")
    return await analyzeSnapshot(snapshot)
  } catch {
    return {
      scope: "static-sdk-usage" as const,
      digest: snapshot.digest,
      modelProtocol: snapshot.modelProtocol,
      runtimeVerified: false as const,
      parameterCoverage: "selected-protocol-differences" as const,
      strictCompatible: false,
      truncated: true,
      usages: [] as FunctionSdkUsage[],
      diagnostics: [
        {
          file: "",
          line: 1,
          column: 1,
          code: "MODS_SDK_UNVERIFIED" as const,
          message: "静态分析未能完成或超过资源上限；不能据此确认兼容。"
        }
      ]
    }
  }
}

async function analyzeSnapshot(snapshot: Snapshot) {
  const captured = Object.entries(snapshot.authoringSources ?? {})
  if (
    captured.length > 160 ||
    captured.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0) > 3 * 1024 * 1024
  )
    throw Error("MODS_SDK_ANALYSIS_LIMIT")
  let work = 0
  function budget(depth = 0) {
    if (++work > 1000000 || depth > 64) throw Error("MODS_SDK_ANALYSIS_LIMIT")
  }
  const ts = await import("typescript")
  const sources = new Map<string, TS.SourceFile>()
  for (const [name, text] of captured) {
    if (/\.(?:[cm]?[tj]s|tsx|jsx)$/.test(name) && !name.endsWith(".d.ts")) {
      const path = posix.resolve("/", name.replace(/\\/g, "/"))
      sources.set(path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))
    }
  }
  const options: TS.CompilerOptions = { noLib: true, noResolve: false, allowJs: true }
  const host: TS.CompilerHost = {
    getSourceFile: (name) => sources.get(name),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => sources.has(name),
    readFile: (name) => sources.get(name)?.text,
    resolveModuleNames: (names, from) =>
      names.map((name) => {
        if (!name.startsWith(".")) return undefined
        const base = posix.resolve(posix.dirname(from), name)
        const path = [
          base,
          ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].flatMap((suffix) => [
            base + suffix,
            base + "/index" + suffix
          ])
        ].find((candidate) => sources.has(candidate))
        if (!path) return undefined
        return {
          resolvedFileName: path,
          extension: path.endsWith("x") ? ts.Extension.Tsx : ts.Extension.Ts
        }
      })
  }
  const program = ts.createProgram([...sources.keys()], options, host)
  const checker = program.getTypeChecker()
  const diagnostics: FunctionSdkDiagnostic[] = []
  const usages: FunctionSdkUsage[] = []
  const diagnosticKeys = new Set<string>()
  let truncated = false
  function location(node?: TS.Node): Location {
    if (!node) return { file: "", line: 1, column: 1 }
    const source = node.getSourceFile()
    const point = source.getLineAndCharacterOfPosition(node.getStart(source))
    return { file: source.fileName.slice(1), line: point.line + 1, column: point.character + 1 }
  }
  function diagnostic(
    node: TS.Node | undefined,
    code: FunctionSdkDiagnostic["code"],
    message: string
  ) {
    const row = { ...location(node), code, message }
    const key = JSON.stringify(row)
    if (diagnosticKeys.has(key)) return
    if (diagnostics.length >= 512) {
      truncated = true
      return
    }
    diagnosticKeys.add(key)
    diagnostics.push(row)
  }
  const unknown = (node: TS.Node | undefined, message: string) =>
    diagnostic(node, "MODS_SDK_UNVERIFIED", message)
  const nodes: TS.Node[] = []
  const pending: TS.Node[] = [...sources.values()]
  while (pending.length && nodes.length < 100000) {
    const node = pending.pop()!
    nodes.push(node)
    if (!ts.isTypeNode(node))
      ts.forEachChild(node, (child) => {
        pending.push(child)
      })
  }
  if (pending.length) {
    truncated = true
    unknown(undefined, "源码超过静态分析节点上限。")
  }
  const bindings = new Map<TS.Symbol, string>()
  const supported = new Set<string>(FUNCTION_SDK_METHODS)
  const symbols = (node: TS.Node) =>
    node.parent && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node)
  function unwrap(node: TS.Node): TS.Node {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      budget()
      node = node.expression
    }
    return node
  }
  function property(node: TS.Node): string | undefined {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
      return node.text
    if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression))
      return node.expression.text
    return undefined
  }
  function path(node: TS.Node, depth = 0): string | undefined {
    budget(depth)
    node = unwrap(node)
    if (ts.isIdentifier(node)) {
      const symbol = symbols(node)
      return symbol ? bindings.get(symbol) : undefined
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = path(node.expression, depth + 1)
      if (base === undefined) return undefined
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : "*"
      return base ? base + "." + key : key
    }
    if (ts.isCallExpression(node) && path(node.expression, depth + 1) === "@on")
      return "@registration"
    return undefined
  }
  let changed = false
  function bind(name: TS.BindingName, value: string, depth = 0) {
    budget(depth)
    if (["plugin.name", "plugin.root"].includes(value)) return
    if (
      value &&
      !value.startsWith("@") &&
      !supported.has(value) &&
      !FUNCTION_SDK_METHODS.some((method) => method.startsWith(value + "."))
    )
      diagnostic(
        name,
        "MODS_SDK_UNSUPPORTED",
        `${value} 没有内置会话 SDK 实现；自定义提供者须单独验证。`
      )
    if (ts.isIdentifier(name)) {
      const symbol = symbols(name)
      if (symbol && !bindings.has(symbol)) {
        bindings.set(symbol, value)
        changed = true
      }
      return
    }
    if (ts.isArrayBindingPattern(name)) {
      unknown(name, "SDK 数组解构无法验证。")
      return
    }
    for (const part of name.elements) {
      const key = property(part.propertyName ?? part.name)
      if (part.dotDotDotToken || part.initializer || key === undefined) {
        unknown(part, "SDK 解构包含动态字段、默认值或剩余属性。")
        continue
      }
      bind(part.name, value ? value + "." + key : key, depth + 1)
    }
  }
  const written = new Set<TS.Symbol>()
  for (const node of nodes) {
    const target =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ? node.left
        : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
          ? node.operand
          : (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
              !ts.isVariableDeclarationList(node.initializer)
            ? node.initializer
            : undefined
    if (!target) continue
    const stack = [target as TS.Node]
    while (stack.length) {
      budget()
      const item = stack.pop()!
      const symbol = ts.isIdentifier(item) && symbols(item)
      if (symbol) written.add(symbol)
      ts.forEachChild(item, (child) => {
        stack.push(child)
      })
    }
  }
  function implicitArguments(fn: FunctionNode) {
    const stack: TS.Node[] = [...fn.parameters, ...(fn.body ? [fn.body] : [])]
    while (stack.length) {
      budget()
      const node = stack.pop()!
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) continue
      if (
        ts.isIdentifier(node) &&
        node.text === "arguments" &&
        !symbols(node)?.declarations?.length
      )
        unknown(node, "隐式 arguments 可能传递 SDK 或注册函数，无法验证。")
      ts.forEachChild(node, (child) => {
        stack.push(child)
      })
    }
  }
  function functionValue(node: TS.Node, seen = new Set<TS.Symbol>()): FunctionNode | undefined {
    budget(seen.size)
    node = unwrap(node)
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      const symbol = "name" in node && node.name && symbols(node.name)
      return symbol && written.has(symbol) ? undefined : node
    }
    let symbol = symbols(node)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    if (!symbol || seen.has(symbol) || written.has(symbol)) return undefined
    seen.add(symbol)
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration)) return declaration
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
      )
        return functionValue(declaration.initializer, seen)
    }
    return undefined
  }
  for (const entry of snapshot.authoringEntries ?? []) {
    const source = sources.get(posix.resolve("/", entry.replace(/\\/g, "/")))
    const module = source && symbols(source)
    const exported =
      module && checker.getExportsOfModule(module).find((symbol) => symbol.name === "register")
    const target =
      exported &&
      (exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported)
    const declaration = target?.valueDeclaration
    const fn =
      declaration &&
      functionValue(ts.isVariableDeclaration(declaration) ? declaration.name : declaration)
    if (!fn) {
      unknown(source, "无法解析入口 register 导出，未验证其 SDK 使用。")
      continue
    }
    implicitArguments(fn)
    if (fn.parameters[0]) bind(fn.parameters[0].name, "@on")
  }
  if (!snapshot.authoringEntries?.length) unknown(undefined, "缺少不可变入口快照。")
  // Monotone identity propagation, bounded even for adversarial alias chains.
  const inspectedCallbacks = new Set<FunctionNode>()
  const restrictedParameters = new Set<TS.Symbol>()
  for (let pass = 0; pass < 32; pass++) {
    changed = false
    for (const node of nodes) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const value = path(node.initializer)
        if (value !== undefined) {
          bind(node.name, value)
          if (!(ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const))
            unknown(node, "可变 SDK 别名无法验证。")
        }
      }
      if (!ts.isCallExpression(node)) continue
      const value = path(node.expression)
      if (value !== "@on" && value !== "@registration.catch") continue
      const handler = node.arguments.at(-1)
      const fn = handler && functionValue(handler)
      if (!fn) {
        unknown(node, "无法静态解析 Hook 回调。")
        continue
      }
      if (!inspectedCallbacks.has(fn)) {
        implicitArguments(fn)
        inspectedCallbacks.add(fn)
      }
      if (fn.parameters[0]) bind(fn.parameters[0].name, "")
      if (value === "@on") {
        const event = node.arguments[0]
        if (!event || !ts.isStringLiteralLike(event))
          unknown(node, "动态事件表达式的 SDK 上下文未验证。")
        else if (matchesEventPattern(event.text, "engine.create")) {
          const parameter = fn.parameters[0]?.name
          if (parameter && ts.isIdentifier(parameter)) {
            const symbol = symbols(parameter)
            if (symbol) restrictedParameters.add(symbol)
          } else if (parameter) unknown(node, "engine.create 上下文不提供普通 SDK。")
          if (event.text === "engine.create")
            unknown(node, "engine.create 可改变运行时 SDK；其上下文没有普通会话能力。")
        }
      }
    }
    if (!changed) break
    if (pass === 31) {
      truncated = true
      unknown(undefined, "SDK 别名超过静态分析深度。")
    }
  }
  function literalOptions(node: TS.Expression | undefined): TS.ObjectLiteralExpression | undefined {
    if (!node) {
      unknown(undefined, "缺少必需的请求参数。")
      return undefined
    }
    const current = unwrap(node)
    if (!ts.isObjectLiteralExpression(current)) {
      unknown(node, "请求参数不是可确认的字面量对象。")
      return undefined
    }
    if (
      current.properties.some(
        (item) => ts.isSpreadAssignment(item) || !item.name || property(item.name) === undefined
      )
    )
      unknown(node, "请求含展开或动态字段，参数未验证。")
    return current
  }
  function checkOptions(call: TS.CallExpression, method: string) {
    if (method === "tool.call" || method === "tool.check") {
      checkToolObject(call.arguments[0], false)
      return
    }
    if (method !== "model.complete" && method !== "tool.register") return
    const input = literalOptions(call.arguments[0])
    for (const item of input?.properties ?? []) {
      const key = item.name && property(item.name)
      if (
        method === "model.complete" &&
        key === "timeoutMs" &&
        snapshot.modelProtocol !== "result-v1"
      )
        diagnostic(
          item,
          "MODS_SDK_PROTOCOL",
          "model.complete.timeoutMs 需要显式选择 result-v1；当前返回值为旧版字符串协议。"
        )
    }
    if (method === "model.complete" && call.arguments[1]) {
      const options = literalOptions(call.arguments[1])
      for (const item of options?.properties ?? [])
        if (item.name && property(item.name) !== "signal")
          diagnostic(item, "MODS_SDK_PROTOCOL", "model.complete 的第二个参数只接受 signal。")
    }
  }
  // Recognize only this immutable package's explicit startup registrations.
  // This proves a supported provider declaration, not that startup has executed.
  const ownTools = new Set<string>()
  if (snapshot.name) for (const node of nodes) {
    if (!ts.isCallExpression(node) || path(node.expression) !== "@on") continue
    const event = node.arguments[0]
    if (!event || !ts.isStringLiteralLike(event) || event.text !== "session.start") continue
    const handler = node.arguments.at(-1)
    const fn = handler && functionValue(handler)
    if (!fn?.body || !ts.isBlock(fn.body)) continue
    for (const statement of fn.body.statements) {
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break
      if (!ts.isExpressionStatement(statement)) continue
      const expression = unwrap(statement.expression)
      if (!ts.isAwaitExpression(expression)) continue
      const call = unwrap(expression.expression)
      if (!ts.isCallExpression(call) || path(call.expression) !== "tool.register") continue
      const input = call.arguments[0] && unwrap(call.arguments[0])
      if (!input || !ts.isObjectLiteralExpression(input)) continue
      const keys = new Set<string>()
      let valid = true
      let localName: string | undefined
      for (const item of input.properties) {
        if (!ts.isPropertyAssignment(item) || ts.isComputedPropertyName(item.name)) {
          valid = false
          break
        }
        const key = property(item.name)
        if (!key || keys.has(key)) { valid = false; break }
        keys.add(key)
        if (key === "name") {
          const value = unwrap(item.initializer)
          if (ts.isStringLiteralLike(value) && /^[a-zA-Z0-9_-]{1,64}$/.test(value.text))
            localName = value.text
        }
      }
      if (valid && localName) {
        const name = functionMcpToolName(snapshot.name, localName)
        if (name.length <= 256) ownTools.add(name)
      }
    }
  }
  function toolName(node: TS.Node, name: string) {
    if (ownTools.has(name) || (FUNCTION_LOCAL_TOOL_NAMES as readonly string[]).includes(name)) return
    const known = Object.hasOwn(FUNCTION_NATIVE_TOOL_COMPATIBILITY, name)
      ? FUNCTION_NATIVE_TOOL_COMPATIBILITY[name] : undefined
    if (known?.support === "bounded") return
    if (known) diagnostic(node, "MODS_SDK_UNSUPPORTED", `${name}：${known.note} 指定此工具的规则不会收到对应本机调用。`)
    else unknown(node, `工具 ${name} 没有已确认的内置适配，可能由第三方提供；需验证提供者及真实调用，不能据此确认规则生效。`)
  }
  function toolSelector(node: TS.Node, matcher: boolean) {
    node = unwrap(node)
    if (ts.isStringLiteralLike(node)) { toolName(node, node.text); return }
    if (matcher && ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) toolSelector(item, true)
      return
    }
    if (matcher && ts.isRegularExpressionLiteral(node)) {
      // Only finite, anchored name alternatives can prove their entire selection.
      // Never evaluate author regexes or infer equivalence from a partial match.
      const literal = node.text.match(/^\/\^(?:\((?:\?:)?([A-Za-z0-9_|-]+)\)|([A-Za-z0-9_-]+))\$\/[guy]*$/)
      if (literal) {
        for (const name of (literal[1] ?? literal[2]).split("|")) toolName(node, name)
        return
      }
    }
    unknown(node, "工具名称或匹配表达式无法静态确认；可能包含尚无适配的原版工具，需验证真实触发。")
  }
  function checkToolObject(node: TS.Node | undefined, matcher: boolean) {
    if (!node) { unknown(node, "工具请求缺少可确认的工具名。"); return }
    const input = unwrap(node)
    if (!ts.isObjectLiteralExpression(input)) {
      unknown(node, "工具请求或匹配对象为动态表达式，无法确认工具适配。")
      return
    }
    let found = false
    for (const item of input.properties) {
      if (ts.isSpreadAssignment(item) || !item.name || property(item.name) === undefined)
        unknown(item, "工具请求或匹配对象含展开或动态字段，无法确认完整工具范围。")
      if (item.name && property(item.name) === "tool") {
        found = true
        if (ts.isPropertyAssignment(item)) toolSelector(item.initializer, matcher)
        else unknown(item, "工具名使用动态字段，需验证真实提供者。")
      }
    }
    if (!found && !matcher) unknown(node, "工具请求没有可确认的工具名。")
  }
  for (const node of nodes) {
    if (!ts.isCallExpression(node) || path(node.expression) !== "@on" || node.arguments.length < 3) continue
    const event = node.arguments[0]
    if (ts.isStringLiteralLike(event) &&
      ["tool.call", "tool.check", "tool.describe"].some(name => matchesEventPattern(event.text, name)))
      checkToolObject(node.arguments[1], true)
  }
  for (const node of nodes) {
    if (
      !ts.isIdentifier(node) &&
      !ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)
    )
      continue
    const value = path(node)
    if (value === undefined) continue
    const parent = node.parent
    if (
      ts.isIdentifier(node) &&
      restrictedParameters.has(symbols(node)!) &&
      !(ts.isParameter(parent) && parent.name === node)
    )
      unknown(node, "此 Hook 可能处理 engine.create，其上下文不提供普通 SDK。")
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node
    )
      continue
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) continue
    if (
      (ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) &&
      parent.name === node
    )
      continue
    if (ts.isBindingElement(parent) && parent.propertyName === node) continue
    if (ts.isTypeNode(parent)) continue
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) continue
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      // Wrapping can hide a transfer; conservative until the wrapper is normalized end-to-end.
      unknown(node, "SDK 引用经过表达式包装，使用方式未验证。")
      continue
    }
    const called = ts.isCallExpression(parent) && parent.expression === node
    if (value.startsWith("@")) {
      if (!called || !["@on", "@registration.catch"].includes(value))
        unknown(node, "注册函数发生传递或动态访问，后续 SDK 使用未验证。")
      continue
    }
    if (["plugin.name", "plugin.root"].includes(value) && !called) continue
    const support =
      value.includes("*") || !value.includes(".")
        ? "unverified"
        : supported.has(value)
          ? "bounded"
          : "unsupported"
    if (called) {
      if (usages.length < 2048) usages.push({ ...location(node), method: value, support })
      else truncated = true
      checkOptions(parent, value)
    } else unknown(node, "SDK 对象或方法被传递、返回或修改，后续使用未验证。")
    if (support === "unsupported")
      diagnostic(
        node,
        "MODS_SDK_UNSUPPORTED",
        `${value} 没有内置会话 SDK 实现；自定义提供者须单独验证。`
      )
    if (support === "unverified") unknown(node, "SDK 动态访问无法确认实际方法。")
  }
  return {
    scope: "static-sdk-usage" as const,
    digest: snapshot.digest,
    modelProtocol: snapshot.modelProtocol,
    runtimeVerified: false as const,
    parameterCoverage: "selected-protocol-differences" as const,
    strictCompatible: !truncated && diagnostics.length === 0,
    truncated,
    usages,
    diagnostics
  }
}
