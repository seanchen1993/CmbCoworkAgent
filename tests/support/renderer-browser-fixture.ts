import { build, type BuildOptions } from "esbuild"

/** Bundle real renderer assets for fixtures that mount one in-memory browser script. */
export async function buildRendererBrowserFixture(options: BuildOptions): Promise<string> {
  const result = await build({
    outdir: "/virtual",
    ...options,
    write: false,
    loader: { ".svg": "dataurl", ...options.loader },
    define: {
      "import.meta.env": "{}",
      "import.meta.hot": "undefined",
      ...options.define
    }
  })
  const script = result.outputFiles.find((file) => file.path.endsWith(".js"))
  if (!script) throw Error("Missing renderer browser fixture script")
  const styles = result.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n")
  if (!styles) return script.text
  return [
    "(() => {",
    '  const style = document.createElement("style")',
    "  style.textContent = " + JSON.stringify(styles),
    "  document.head.appendChild(style)",
    "})();",
    script.text
  ].join("\n")
}

/** Strict exports for store substitutes used by fixtures that never delete conversations. */
export const unexpectedThreadDeletionExports = `
  function rejectDeletion() { throw Error("Thread deletion is outside this fixture") }
  export { rejectDeletion as applyCommittedBotWorkDeletion, rejectDeletion as applyCommittedThreadDeletion }
`
