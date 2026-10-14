import type { ModJson, ModObject } from "../types"
import { encodeModJson } from "../validation"
import { ModFunctionError, isModObject } from "./contracts"

export type FunctionInstructionFile = {
  path: string
  kind: "managed" | "user" | "project" | "local" | "memory"
  content: string
  parent?: string
}
export type FunctionPromptContext = {
  blocks: Array<{ name: string; text: string }>
  instructionFiles?: FunctionInstructionFile[]
}

const kinds = new Set(["managed", "user", "project", "local", "memory"])
const absolutePath = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 4096 &&
  ![...value].some(char => char.charCodeAt(0) < 32) &&
  /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value)

export function validatePromptContext(value: ModJson): asserts value is ModObject {
  if (!isModObject(value) || !Array.isArray(value.blocks) || value.blocks.length > 256 ||
    Object.keys(value).some(key => key !== "blocks" && key !== "instructionFiles"))
    throw new ModFunctionError("MODS_PROMPT_CONTEXT_INVALID")
  const names = new Set<string>()
  for (const block of value.blocks) {
    if (!isModObject(block) || typeof block.name !== "string" || !block.name.trim() ||
      block.name.length > 220 || names.has(block.name) || typeof block.text !== "string" ||
      Object.keys(block).some(key => key !== "name" && key !== "text"))
      throw new ModFunctionError("MODS_PROMPT_CONTEXT_BLOCK")
    names.add(block.name)
  }
  if (value.instructionFiles !== undefined) {
    if (!Array.isArray(value.instructionFiles) || value.instructionFiles.length > 256)
      throw new ModFunctionError("MODS_PROMPT_CONTEXT_FILES")
    for (const file of value.instructionFiles) {
      if (!isModObject(file) || !absolutePath(file.path) ||
        typeof file.kind !== "string" || !kinds.has(file.kind) ||
        typeof file.content !== "string" ||
        (file.parent !== undefined && !absolutePath(file.parent)) ||
        Object.keys(file).some(key => !["path", "kind", "content", "parent"].includes(key)))
        throw new ModFunctionError("MODS_PROMPT_CONTEXT_FILES")
    }
  }
  if (new TextEncoder().encode(encodeModJson(value)).length > 512 * 1024)
    throw new ModFunctionError("MODS_PROMPT_CONTEXT_LIMIT")
}

function equalFiles(left: FunctionInstructionFile[] | undefined,
  right: FunctionInstructionFile[] | undefined): boolean {
  return left === right || !!left && !!right && left.length === right.length &&
    left.every((file, index) => {
      const other = right[index]
      return file.path === other.path && file.kind === other.kind &&
        file.content === other.content && file.parent === other.parent
    })
}

/** Paths are labels here, never instructions to read files or evidence of file authority. */
export function renderFunctionInstructionFiles(files: readonly FunctionInstructionFile[]): string {
  return files.map(file => `# ${file.path}\n\n${file.content}`).join("\n\n")
}

/** Apply at every downward and upward link, against that link's actual input/result. */
export function synchronizePromptContext(value: ModJson, baseline: ModJson): ModObject {
  validatePromptContext(value)
  validatePromptContext(baseline)
  const current = structuredClone(value) as unknown as FunctionPromptContext
  const previous = baseline as unknown as FunctionPromptContext
  const block = current.blocks.find(block => block.name === "claudeMd")
  const old = previous.blocks.find(block => block.name === "claudeMd")
  if (!block) {
    // An omitted block is an intentional removal, including when a file list is supplied.
    if (old) current.instructionFiles = []
    else if (current.instructionFiles?.length &&
      !equalFiles(current.instructionFiles, previous.instructionFiles)) {
      current.blocks.push({ name: "claudeMd",
        text: renderFunctionInstructionFiles(current.instructionFiles) })
    } else if (current.instructionFiles !== undefined) current.instructionFiles = []
  } else if (current.instructionFiles !== undefined &&
    !equalFiles(current.instructionFiles, previous.instructionFiles)) {
    if (current.instructionFiles.length) block.text =
      renderFunctionInstructionFiles(current.instructionFiles)
    else current.blocks = current.blocks.filter(block => block.name !== "claudeMd")
  } else if (block.text !== old?.text) {
    delete current.instructionFiles
  } else if (previous.instructionFiles !== undefined) {
    current.instructionFiles = structuredClone(previous.instructionFiles)
  } else {
    delete current.instructionFiles
  }
  const result = current as unknown as ModObject
  validatePromptContext(result)
  return result
}
