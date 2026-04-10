import type { IpcMain } from "electron"
import { analyzeCodeExecForSavedToolPromotion } from "../code-exec/saved-tool-promotion"
import {
  computeSavedCodeExecToolHash,
  deleteSavedCodeExecTool,
  getSavedCodeExecTool,
  getSavedCodeExecToolName,
  listSavedCodeExecTools,
  parseCodeExecDependencies,
  parseCodeExecOutputValue,
  replaceSavedCodeExecTool,
  resolveSavedCodeExecToolId,
  setSavedCodeExecToolEnabled,
  setSavedCodeExecToolLastPreviewParams,
  validateSavedCodeExecToolName,
  type SavedCodeExecTool
} from "../code-exec/saved-tool-store"
import { CodeExecEngine } from "../code-exec/engine"
import { LocalProcessRunner } from "../code-exec/runner"
import type { CodeExecResult } from "../code-exec/types"
import { getGlobalMcpCapabilityService } from "../mcp/capability-service"
import { getOpenworkDir, isCodeExecEnabled, setCodeExecEnabled } from "../storage"

const DEFAULT_TIMEOUT_MS = 20_000
const TIMEOUT_MIN = 1_000
const TIMEOUT_MAX = 120_000

export interface ManagedSavedCodeExecTool extends SavedCodeExecTool {
  toolName: string
}

export interface SavedCodeExecToolUpdatePayload {
  id: string
  toolName: string
  description: string
  code: string
  timeoutMs?: number
  previewParams?: Record<string, unknown>
  previewOutput?: string
}

export interface SavedCodeExecPreviewPayload {
  code: string
  params?: Record<string, unknown>
  timeoutMs?: number
}

export interface SavedCodeExecPreviewResult extends CodeExecResult {
  parsedOutput?: unknown
}

export interface CodeExecToolSettings {
  codeExecEnabled: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function validateTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(resolved) || resolved < TIMEOUT_MIN || resolved > TIMEOUT_MAX) {
    throw new Error(`超时时间必须在 ${TIMEOUT_MIN}ms 到 ${TIMEOUT_MAX}ms 之间`)
  }
  return resolved
}

function validateToolUpdatePayload(payload: SavedCodeExecToolUpdatePayload): void {
  if (!payload.id?.trim()) {
    throw new Error("工具 ID 不能为空")
  }
  if (!payload.toolName?.trim()) {
    throw new Error("tool_name 不能为空")
  }
  const toolNameError = validateSavedCodeExecToolName(payload.toolName)
  if (toolNameError) {
    throw new Error(toolNameError)
  }
  if (!payload.description?.trim()) {
    throw new Error("tool_description 不能为空")
  }
  if (!payload.code?.trim()) {
    throw new Error("code 不能为空")
  }
  if (payload.previewParams !== undefined && !isRecord(payload.previewParams)) {
    throw new Error("previewParams 必须是对象")
  }
  validateTimeout(payload.timeoutMs)
}

function validatePreviewPayload(payload: SavedCodeExecPreviewPayload): number {
  if (!payload.code?.trim()) {
    throw new Error("code 不能为空")
  }
  if (payload.params !== undefined && !isRecord(payload.params)) {
    throw new Error("params 必须是对象")
  }
  return validateTimeout(payload.timeoutMs)
}

function toManagedSavedCodeExecTool(tool: SavedCodeExecTool): ManagedSavedCodeExecTool {
  return {
    ...tool,
    toolName: getSavedCodeExecToolName(tool.toolId)
  }
}

async function runCodeExecPreview(
  payload: SavedCodeExecPreviewPayload
): Promise<SavedCodeExecPreviewResult> {
  const timeoutMs = validatePreviewPayload(payload)
  const engine = new CodeExecEngine(new LocalProcessRunner(getGlobalMcpCapabilityService()))
  const result = await engine.execute({
    code: payload.code,
    params: payload.params ?? {},
    timeoutMs,
    workspacePath: getOpenworkDir()
  })

  return result.ok
    ? {
        ...result,
        parsedOutput: parseCodeExecOutputValue(result.output)
      }
    : result
}

export function registerCodeExecToolsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("codeExecTools:list", async (): Promise<ManagedSavedCodeExecTool[]> => {
    return listSavedCodeExecTools({ includeDisabled: true }).map(toManagedSavedCodeExecTool)
  })

  ipcMain.handle(
    "codeExecTools:getSettings",
    async (): Promise<CodeExecToolSettings> => ({
      codeExecEnabled: isCodeExecEnabled()
    })
  )

  ipcMain.handle(
    "codeExecTools:setCodeExecEnabled",
    async (_event, enabled: boolean): Promise<void> => {
      setCodeExecEnabled(enabled)
    }
  )

  ipcMain.handle(
    "codeExecTools:setEnabled",
    async (
      _event,
      { id, enabled }: { id: string; enabled: boolean }
    ): Promise<ManagedSavedCodeExecTool> => {
      if (!id?.trim()) {
        throw new Error("工具 ID 不能为空")
      }

      const updated = setSavedCodeExecToolEnabled(id, enabled === true)
      return toManagedSavedCodeExecTool(updated)
    }
  )

  ipcMain.handle(
    "codeExecTools:setLastPreviewParams",
    async (_event, { id, params }: { id: string; params: Record<string, unknown> }): Promise<ManagedSavedCodeExecTool> => {
      if (!id?.trim()) {
        throw new Error("工具 ID 不能为空")
      }
      if (!isRecord(params)) {
        throw new Error("params 必须是对象")
      }

      const updated = setSavedCodeExecToolLastPreviewParams(id, params)
      return toManagedSavedCodeExecTool(updated)
    }
  )

  ipcMain.handle(
    "codeExecTools:update",
    async (_event, payload: SavedCodeExecToolUpdatePayload): Promise<ManagedSavedCodeExecTool> => {
      validateToolUpdatePayload(payload)

      const current = getSavedCodeExecTool(payload.id, { includeDisabled: true })
      if (!current) {
        throw new Error(`工具不存在: ${payload.id}`)
      }

      const timeoutMs = validateTimeout(payload.timeoutMs ?? current.timeoutMs)
      const nextToolId = resolveSavedCodeExecToolId(payload.toolName, {
        currentToolId: current.toolId
      })
      const codeChanged = payload.code !== current.code

      let inputSchema = current.inputSchema
      let outputSchema = current.outputSchema
      let resultExample = current.resultExample
      let dependencies = parseCodeExecDependencies(payload.code)

      if (codeChanged && typeof payload.previewOutput !== "string") {
        throw new Error("代码已修改，请先试运行成功后再保存")
      }

      if (codeChanged && typeof payload.previewOutput === "string") {
        const promotion = analyzeCodeExecForSavedToolPromotion({
          code: payload.code,
          params: payload.previewParams,
          output: payload.previewOutput
        })

        if (promotion.status === "ready") {
          inputSchema = promotion.inputSchema
          outputSchema = promotion.outputSchema
          resultExample = promotion.resultExample
          dependencies = promotion.dependencies
        }
      }

      const updated = replaceSavedCodeExecTool(current.toolId, {
        ...current,
        toolId: nextToolId,
        description: payload.description.trim(),
        code: payload.code,
        timeoutMs,
        updatedAt: new Date().toISOString(),
        codeHash: computeSavedCodeExecToolHash(payload.code, timeoutMs),
        dependencies,
        inputSchema,
        outputSchema,
        resultExample,
        lastPreviewParams: payload.previewParams ?? current.lastPreviewParams
      })

      return toManagedSavedCodeExecTool(updated)
    }
  )

  ipcMain.handle("codeExecTools:delete", async (_event, id: string): Promise<void> => {
    if (!id?.trim()) {
      throw new Error("工具 ID 不能为空")
    }
    deleteSavedCodeExecTool(id)
  })

  ipcMain.handle(
    "codeExecTools:runPreview",
    async (_event, payload: SavedCodeExecPreviewPayload): Promise<SavedCodeExecPreviewResult> => {
      return runCodeExecPreview(payload)
    }
  )
}
