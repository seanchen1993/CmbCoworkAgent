import * as path from "path"

/**
 * Pure, electron-free helpers shared with the unit-tested gates. Anything that
 * actually touches the filesystem lives in plugin-files.ts; this module only
 * normalises strings so it can run under bare `tsx` without main-process deps.
 */

/**
 * File extensions a user is allowed to overwrite inside their own plugin.
 *
 * Broad text whitelist — the user owns the plugin so editing manifest /
 * hooks JSON / scripts / configs is legitimate. A bad edit only breaks
 * loading of *their own plugin*, which they'll notice immediately when the
 * plugin disables itself or refuses to enable. Same risk surface as zipping
 * a different version and re-uploading.
 *
 * The truly excluded category is binaries — see {@link BINARY_EXTENSIONS}
 * and {@link isBinaryExtension}. Those produce garbage when toString'd as
 * utf-8 and have nothing useful to edit anyway.
 *
 * Stored without the leading dot, lowercase, for `extname` comparison.
 */
export const EDITABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Markdown / docs
  "md",
  "markdown",
  "mdx",
  "txt",
  "rst",
  // Configuration formats
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "env",
  // Shell / batch
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  // Scripting languages we ship hooks in
  "py",
  "js",
  "ts",
  "mjs",
  "cjs",
  "jsx",
  "tsx",
  // Web / templates
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "svg"
])

/**
 * Dotfiles whose basename starts with "." and has no real extname.
 * `path.extname(".gitignore") === ""`, so they fall outside the extension
 * whitelist by accident — list the ones we want editable explicitly.
 */
const EDITABLE_DOTFILES: ReadonlySet<string> = new Set([
  ".gitignore",
  ".npmignore",
  ".dockerignore",
  ".editorconfig",
  ".env",
  ".prettierrc",
  ".eslintrc"
])

/**
 * Binaries and assets we don't show in the file tree at all. Reading them as
 * utf-8 produces noise and there's nothing the user could meaningfully edit
 * in a textarea. Excluded at walk time so the tree stays tidy.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Native executables / libs
  "exe",
  "dll",
  "so",
  "dylib",
  "a",
  "o",
  "lib",
  "node",
  "wasm",
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "tiff",
  // Documents
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  // Archives
  "zip",
  "tar",
  "gz",
  "tgz",
  "7z",
  "rar",
  "bz2",
  "xz",
  // Fonts
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  // Audio / video
  "mp3",
  "mp4",
  "wav",
  "ogg",
  "flac",
  "mkv",
  "mov",
  "avi",
  // Data blobs
  "db",
  "sqlite",
  "sqlite3",
  "bin",
  "dat",
  "pyc"
])

function getNormalizedExt(filePath: string): string {
  return path.extname(filePath).replace(/^\./, "").toLowerCase()
}

export function isEditableExtension(filePath: string): boolean {
  const ext = getNormalizedExt(filePath)
  if (ext && EDITABLE_EXTENSIONS.has(ext)) return true
  // Dotfile fall-through: `.gitignore` etc. have no real extname but are
  // valid plain-text targets.
  if (!ext) {
    const base = path.basename(filePath).toLowerCase()
    if (EDITABLE_DOTFILES.has(base)) return true
  }
  return false
}

export function isBinaryExtension(filePath: string): boolean {
  const ext = getNormalizedExt(filePath)
  return !!ext && BINARY_EXTENSIONS.has(ext)
}

function normalizeForCompare(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * Strict containment check used after resolving real paths. Treat equal paths
 * as inside (so the plugin root itself is a valid "inside the plugin" target,
 * matching how skills.ts handles its own gate). Returns false on any "../"
 * escape or absolute-rebound relative path.
 */
export function isPathInsideDir(targetPath: string, dirPath: string): boolean {
  const target = normalizeForCompare(targetPath)
  const dir = normalizeForCompare(dirPath)
  if (target === dir) return true
  const rel = path.relative(dir, target)
  if (!rel) return true
  if (rel.startsWith("..")) return false
  if (path.isAbsolute(rel)) return false
  return true
}

export interface PluginOriginCheck {
  origin?: "market" | "local"
}

/**
 * Only user-uploaded plugins (origin === "local") are editable. Plugins from
 * the market are read-only by policy — they have an upstream we must not
 * silently diverge from. Pre-origin legacy installs (origin === undefined)
 * are treated as non-local for safety; once the renderer migration writes a
 * concrete value to disk they get re-evaluated.
 */
export function isPluginEditable(plugin: PluginOriginCheck | null | undefined): boolean {
  return !!plugin && plugin.origin === "local"
}
