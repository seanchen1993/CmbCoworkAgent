import type { ArtifactSourceConnection } from "./desktop-artifact-download-provider"
interface SharedDesktopConnection {
  openIsolatedConnection(): ArtifactSourceConnection
}
/** Cancelling a file preflight must never cancel the shared desktop Host launch. */
export async function openArtifactSourceConnection(
  signal: AbortSignal,
  connect: () => Promise<SharedDesktopConnection>
): Promise<ArtifactSourceConnection> {
  signal.throwIfAborted()
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(signal.reason ?? new Error("成果读取已取消"))
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    const shared = await Promise.race([Promise.resolve().then(connect), aborted])
    signal.throwIfAborted()
    // No clone is made in a late connect() continuation after an aborted race.
    return shared.openIsolatedConnection()
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
