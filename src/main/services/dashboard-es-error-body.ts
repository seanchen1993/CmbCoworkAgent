/** Keep the error prefix even when ES includes a large failed query in its response. */
export async function readDashboardEsErrorDetail(
  response: Response,
  checkCancelled: () => void = () => undefined
): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const prefix = new Uint8Array(4 * 1024)
  let length = 0
  try {
    while (length < prefix.byteLength) {
      checkCancelled()
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      const chunk = value.subarray(0, prefix.byteLength - length)
      prefix.set(chunk, length)
      length += chunk.byteLength
    }
    checkCancelled()
    return new TextDecoder().decode(prefix.subarray(0, length)).slice(0, 1024)
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
