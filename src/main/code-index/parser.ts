import Parser from "web-tree-sitter"
import { join, extname } from "path"
import { existsSync } from "fs"
import { createHash } from "crypto"
import type { CodeBlock } from "./types"
import {
  TREESITTER_EXTENSIONS,
  FALLBACK_EXTENSIONS,
  SUPPORTED_EXTENSIONS,
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  CHUNK_MAX_TOLERANCE,
  CHUNK_OVERLAP_CHARS,
} from "./constants"

// Tree-sitter node types to extract per language
const EXTRACTABLE_TYPES: Record<string, Set<string>> = {
  typescript: new Set([
    "function_declaration", "method_definition", "class_declaration",
    "interface_declaration", "type_alias_declaration", "enum_declaration",
    "arrow_function", "export_statement", "lexical_declaration",
  ]),
  tsx: new Set([
    "function_declaration", "method_definition", "class_declaration",
    "interface_declaration", "type_alias_declaration", "enum_declaration",
    "arrow_function", "export_statement", "lexical_declaration",
  ]),
  javascript: new Set([
    "function_declaration", "method_definition", "class_declaration",
    "arrow_function", "export_statement", "lexical_declaration",
  ]),
  python: new Set([
    "function_definition", "class_definition", "decorated_definition",
  ]),
  go: new Set([
    "function_declaration", "method_declaration", "type_declaration",
  ]),
  rust: new Set([
    "function_item", "impl_item", "struct_item", "enum_item", "trait_item",
    "mod_item", "type_item",
  ]),
  java: new Set([
    "method_declaration", "class_declaration", "interface_declaration",
    "enum_declaration", "constructor_declaration",
  ]),
  c: new Set([
    "function_definition", "struct_specifier", "enum_specifier",
    "type_definition", "declaration",
  ]),
  cpp: new Set([
    "function_definition", "class_specifier", "struct_specifier",
    "enum_specifier", "namespace_definition", "template_declaration",
  ]),
  c_sharp: new Set([
    "method_declaration", "class_declaration", "interface_declaration",
    "enum_declaration", "struct_declaration", "namespace_declaration",
  ]),
  ruby: new Set([
    "method", "class", "module", "singleton_method",
  ]),
  php: new Set([
    "function_definition", "method_declaration", "class_declaration",
    "interface_declaration", "trait_declaration",
  ]),
  swift: new Set([
    "function_declaration", "class_declaration", "struct_declaration",
    "enum_declaration", "protocol_declaration",
  ]),
  kotlin: new Set([
    "function_declaration", "class_declaration", "object_declaration",
  ]),
  lua: new Set([
    "function_declaration", "function_definition", "local_function",
  ]),
}

function getIdentifier(node: Parser.SyntaxNode): string | null {
  const nameField = node.childForFieldName("name")
  if (nameField) return nameField.text
  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "type_identifier" || child.type === "property_identifier") {
      return child.text
    }
  }
  return null
}

function makeSegmentHash(filePath: string, startLine: number, endLine: number, content: string): string {
  return createHash("sha256")
    .update(`${filePath}:${startLine}:${endLine}:${content}`)
    .digest("hex")
}

export class CodeParser {
  private parserCache = new Map<string, Parser>()
  private langCache = new Map<string, Parser.Language>()
  private initPromise: Promise<void> | null = null
  private wasmDir: string

  constructor(wasmDir: string) {
    this.wasmDir = wasmDir
  }

  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = Parser.init().catch((e: unknown) => {
        this.initPromise = null // Reset so next call can retry
        throw e
      })
    }
    await this.initPromise
  }

  async parseFile(filePath: string, relativePath: string, content: string, fileHash: string): Promise<CodeBlock[]> {
    const ext = extname(filePath).toLowerCase()

    if (!SUPPORTED_EXTENSIONS.has(ext)) return []
    if (FALLBACK_EXTENSIONS.has(ext)) {
      return this.fallbackChunk(filePath, relativePath, content, fileHash)
    }

    const langName = TREESITTER_EXTENSIONS[ext]
    if (!langName) {
      return this.fallbackChunk(filePath, relativePath, content, fileHash)
    }

    try {
      await this.ensureInit()
      const parser = await this.getOrCreateParser(langName)
      if (!parser) {
        return this.fallbackChunk(filePath, relativePath, content, fileHash)
      }

      const tree = parser.parse(content)
      try {
        const extractable = EXTRACTABLE_TYPES[langName] ?? EXTRACTABLE_TYPES.javascript
        const blocks: CodeBlock[] = []
        const seen = new Set<string>()

        this.extractBlocks(tree.rootNode, extractable, filePath, relativePath, fileHash, blocks, seen)

        // If tree-sitter found nothing useful, fall back
        if (blocks.length === 0) {
          return this.fallbackChunk(filePath, relativePath, content, fileHash)
        }

      return blocks
      } finally {
        tree.delete() // release WASM memory
      }
    } catch (e) {
      console.warn(`[CodeParser] Tree-sitter failed for ${filePath}:`, e)
      return this.fallbackChunk(filePath, relativePath, content, fileHash)
    }
  }

  private extractBlocks(
    node: Parser.SyntaxNode,
    extractable: Set<string>,
    filePath: string,
    relativePath: string,
    fileHash: string,
    blocks: CodeBlock[],
    seen: Set<string>,
  ): void {
    if (extractable.has(node.type)) {
      const text = node.text
      if (text.length < CHUNK_MIN_CHARS) {
        // Too small, skip
      } else if (text.length <= CHUNK_MAX_CHARS * CHUNK_MAX_TOLERANCE) {
        // Good size, add as block
        const startLine = node.startPosition.row + 1
        const endLine = node.endPosition.row + 1
        const segmentHash = makeSegmentHash(filePath, startLine, endLine, text)
        if (!seen.has(segmentHash)) {
          seen.add(segmentHash)
          blocks.push({
            filePath,
            relativePath,
            identifier: getIdentifier(node),
            type: node.type,
            startLine,
            endLine,
            content: text,
            fileHash,
            segmentHash,
          })
        }
        return // Don't recurse into this node's children
      } else {
        // Too large — try to split by children, or fall back to line chunking
        let foundChildBlocks = false
        for (const child of node.children) {
          if (extractable.has(child.type) && child.text.length >= CHUNK_MIN_CHARS) {
            foundChildBlocks = true
            break
          }
        }
        if (foundChildBlocks) {
          // Recurse into children to find smaller extractable units
          for (const child of node.children) {
            this.extractBlocks(child, extractable, filePath, relativePath, fileHash, blocks, seen)
          }
        } else {
          // No extractable children — chunk this node by lines
          const subBlocks = this.chunkByLines(text, filePath, relativePath, fileHash, node.startPosition.row + 1)
          for (const b of subBlocks) {
            if (!seen.has(b.segmentHash)) {
              seen.add(b.segmentHash)
              blocks.push(b)
            }
          }
        }
        return
      }
    }

    // Recurse into children for non-extractable nodes
    for (const child of node.children) {
      this.extractBlocks(child, extractable, filePath, relativePath, fileHash, blocks, seen)
    }
  }

  private fallbackChunk(filePath: string, relativePath: string, content: string, fileHash: string): CodeBlock[] {
    const lines = content.split("\n")
    const blocks: CodeBlock[] = []
    let currentText = ""
    let startLine = 1

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (currentText.length + line.length + 1 > CHUNK_MAX_CHARS && currentText.length > 0) {
        const trimmed = currentText.trim()
        if (trimmed.length >= CHUNK_MIN_CHARS) {
          const endLine = i
          const segmentHash = makeSegmentHash(filePath, startLine, endLine, trimmed)
          blocks.push({
            filePath,
            relativePath,
            identifier: null,
            type: "chunk",
            startLine,
            endLine,
            content: trimmed,
            fileHash,
            segmentHash,
          })
        }
        // Overlap
        const overlapStart = Math.max(0, currentText.length - CHUNK_OVERLAP_CHARS)
        currentText = currentText.slice(overlapStart)
        startLine = Math.max(1, i - currentText.split("\n").length + 1)
      }
      currentText += (currentText ? "\n" : "") + line
    }

    const lastTrimmed = currentText.trim()
    if (lastTrimmed.length >= CHUNK_MIN_CHARS) {
      const segmentHash = makeSegmentHash(filePath, startLine, lines.length, lastTrimmed)
      blocks.push({
        filePath,
        relativePath,
        identifier: null,
        type: "chunk",
        startLine,
        endLine: lines.length,
        content: lastTrimmed,
        fileHash,
        segmentHash,
      })
    }

    return blocks
  }

  private chunkByLines(text: string, filePath: string, relativePath: string, fileHash: string, baseStartLine: number): CodeBlock[] {
    const lines = text.split("\n")
    const blocks: CodeBlock[] = []
    let currentText = ""
    let localStart = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (currentText.length + line.length + 1 > CHUNK_MAX_CHARS && currentText.length > 0) {
        const trimmed = currentText.trim()
        if (trimmed.length >= CHUNK_MIN_CHARS) {
          const startLine = baseStartLine + localStart
          const endLine = baseStartLine + i - 1
          const segmentHash = makeSegmentHash(filePath, startLine, endLine, trimmed)
          blocks.push({
            filePath,
            relativePath,
            identifier: null,
            type: "chunk",
            startLine,
            endLine,
            content: trimmed,
            fileHash,
            segmentHash,
          })
        }
        // Overlap: keep tail of current text for context continuity
        const overlapStart = Math.max(0, currentText.length - CHUNK_OVERLAP_CHARS)
        currentText = currentText.slice(overlapStart)
        localStart = Math.max(0, i - currentText.split("\n").length)
      }
      currentText += (currentText ? "\n" : "") + line
    }

    const lastTrimmed = currentText.trim()
    if (lastTrimmed.length >= CHUNK_MIN_CHARS) {
      const startLine = baseStartLine + localStart
      const endLine = baseStartLine + lines.length - 1
      const segmentHash = makeSegmentHash(filePath, startLine, endLine, lastTrimmed)
      blocks.push({
        filePath,
        relativePath,
        identifier: null,
        type: "chunk",
        startLine,
        endLine,
        content: lastTrimmed,
        fileHash,
        segmentHash,
      })
    }

    return blocks
  }

  dispose(): void {
    for (const parser of this.parserCache.values()) {
      parser.delete()
    }
    this.parserCache.clear()
    this.langCache.clear()
  }

  private async getOrCreateParser(langName: string): Promise<Parser | null> {
    if (this.parserCache.has(langName)) return this.parserCache.get(langName)!
    try {
      let lang = this.langCache.get(langName)
      if (!lang) {
        const wasmFile = `tree-sitter-${langName}.wasm`
        const wasmPath = join(this.wasmDir, wasmFile)
        if (!existsSync(wasmPath)) {
          console.warn(`[CodeParser] WASM not found: ${wasmPath}`)
          return null
        }
        lang = await Parser.Language.load(wasmPath)
        this.langCache.set(langName, lang)
      }
      const parser = new Parser()
      parser.setLanguage(lang)
      this.parserCache.set(langName, parser)
      return parser
    } catch (e) {
      console.warn(`[CodeParser] Failed to load ${langName}:`, e)
      return null
    }
  }
}
