import ts from "typescript"
import type { AuthoringFile } from "../../../shared/mods/authoring"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FUNCTION_SDK_METHODS } from "../v2/sdk-capabilities"

export interface DevelopmentCandidateDiagnostic {
  code: string
  stage: "candidate-startup"
  event?: "session.start"
  file?: string
  line?: number
  column?: number
  message: string
  hint: string
  method?: string
}

const failures: Record<string, { message: string; hint: string; event?: "session.start" }> = {
  MODS_RETURN_UNDEFINED: {
    event: "session.start",
    message: "启动钩子没有返回结果。静态编译通过不代表启动协议正确。",
    hint: "将 session.start 写为 async ($, event, next) => { /* 初始化 */; return next(event) }，保留原有初始化。不要改命令名称来修复这个返回值错误。"
  },
  MODS_SESSION_START_RESULT: {
    event: "session.start",
    message: "启动钩子返回的结果不符合 session.start 协议。",
    hint: "完成登记和只读初始化后 return next(event)，保留 cwd 等原始事件字段。"
  },
  MODS_COMMAND_CONFLICT: {
    event: "session.start",
    message: "草稿登记的快捷指令与当前组合中的其他灵件重名。",
    hint: "只修改本草稿的命令名称、匹配器和使用说明，使用灵件专属前缀；保留其他已启用灵件。"
  },
  MODS_COMMAND_RESERVED: {
    event: "session.start",
    message: "草稿使用了宿主保留的快捷指令名称。",
    hint: "给本草稿的命令、匹配器和说明换成灵件专属名称，然后重新提交。"
  },
  MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED: {
    event: "session.start",
    message: "候选启动阶段尝试执行需要真实宿主权限或会产生外部效果的 SDK 方法。",
    hint: "session.start 只登记命令、界面和读取已有状态，并 return next(event)。将 HTTP 请求和存储写入移到生效后的首次 ui.render（缓存并防止重复请求）或用户触发的命令/按钮中，保留原网络审批。定时任务在生效后按用户需求启动，未知请求结果不要自动重放。"
  },
  MODS_DEVELOPMENT_CAPABILITY_DENIED: {
    message: "实际登记或调用的能力不在当前草稿的精确能力范围内。",
    hint: "读取本构建的 catalog 类型和 SDK 范围，修复动态或范围外登记后重新提交；不要绕过权限。"
  }
}
const observationCodes = new Set([
  "MODS_DEVELOPMENT_BUSY",
  "MODS_DEVELOPMENT_SOURCE_CHANGED",
  "MODS_SCOPE_CHANGED",
  "MODS_RUNTIME_LOST",
  "MODS_CONFIG_RELOAD_STOPPED",
  "MODS_DEVELOPMENT_CLEANUP_UNCONFIRMED",
  "MODS_SESSION_CAPACITY",
  "MODS_HOOK_FAILED",
  "MODS_BUDGET_EXCEEDED"
])

function startupLocations(files: AuthoringFile[]) {
  const result: Array<{ file: string; line: number; column: number }> = []
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (result.length >= 8) return
      if (
        ts.isCallExpression(node) &&
        node.arguments.length >= 2 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "session.start"
      ) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source))
        result.push({ file: file.path, line: position.line + 1, column: position.character + 1 })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return result
}

/** Only host-known diagnostic text is exposed; arbitrary guest messages and paths stay private. */
export class DevelopmentCandidateError extends Error {
  readonly diagnostics: DevelopmentCandidateDiagnostic[]
  readonly repairable: boolean
  constructor(
    error: unknown,
    readonly target: { id: string; revision: number; digest: string },
    files: AuthoringFile[]
  ) {
    const raw =
      error instanceof ModFunctionError ? error.code : error instanceof Error ? error.message : ""
    const code =
      Object.hasOwn(failures, raw) ||
      (error instanceof ModFunctionError && observationCodes.has(raw))
        ? raw
        : "MODS_DEVELOPMENT_PREPARE_FAILED"
    super(code)
    this.name = "DevelopmentCandidateError"
    const known = failures[code]
    this.repairable = !!known
    let method: string | undefined
    if (code === "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED" && error instanceof Error) {
      const requested = /插件启动时需要 ([a-zA-Z][a-zA-Z0-9_.]*)/.exec(error.message)?.[1]
      if (requested && FUNCTION_SDK_METHODS.some((method) => method === requested))
        method = requested
    }
    const diagnostic: DevelopmentCandidateDiagnostic = {
      code,
      stage: "candidate-startup",
      ...(known?.event ? { event: known.event } : {}),
      ...(method ? { method } : {}),
      message: known?.message ?? "候选启动没有得到确认；旧版未被本次预检查替换。",
      hint:
        known?.hint ??
        "保留草稿和当前可用版本，先核对范围、实际诊断及未完成操作；不要自动重试未知错误或重放外部动作。"
    }
    const locations = known?.event ? startupLocations(files) : []
    this.diagnostics = locations.length
      ? locations.map((location) => ({ ...diagnostic, ...location }))
      : [diagnostic]
  }
}
