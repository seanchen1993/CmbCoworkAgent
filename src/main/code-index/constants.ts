// ── Chunk sizing ──

export const CHUNK_MAX_CHARS = 1000
export const CHUNK_MIN_CHARS = 50
export const CHUNK_OVERLAP_CHARS = 100
export const CHUNK_MAX_TOLERANCE = 1.15
export const CHUNK_VERSION = `v2:${CHUNK_MAX_CHARS}:${CHUNK_MIN_CHARS}`

// ── Embedding ──

export const EMBEDDING_BATCH_SIZE = 32
export const EMBEDDING_MAX_RETRIES = 3
export const EMBEDDING_RETRY_DELAY_MS = 500

// ── Search ──

export const VECTOR_WEIGHT = 0.7
export const FTS_WEIGHT = 0.3
export const DEFAULT_SEARCH_LIMIT = 10
export const MIN_SEARCH_SCORE = 0.1

// ── Scanning ──

export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024
export const MAX_FILES_TO_SCAN = 50_000
export const INDEX_SAVE_DEBOUNCE_MS = 500
export const WATCHER_DEBOUNCE_MS = 1000

// ── Tree-sitter language mapping ──

export const TREESITTER_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "c_sharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".lua": "lua",
}

// ── Fallback text chunking extensions ──

export const FALLBACK_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".yaml", ".yml",
  ".html", ".css", ".scss", ".less", ".xml", ".svg",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".proto",
  ".ini", ".cfg", ".toml",
])

// ── All supported extensions (union) ──

export const SUPPORTED_EXTENSIONS = new Set([
  ...Object.keys(TREESITTER_EXTENSIONS),
  ...FALLBACK_EXTENSIONS,
])

// ── Directories to always skip ──

export const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out",
  ".next", ".nuxt", "__pycache__", ".cache", ".vscode", ".idea",
  "vendor", "target", "coverage", ".tox", "venv", ".venv",
])
