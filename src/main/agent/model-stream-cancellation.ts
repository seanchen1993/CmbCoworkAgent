/** Keep cancellation attached to the body after the first-byte retry watchdog releases it. */
export function withModelStreamCancellation(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    if (!response.body || !init?.signal) return response
    const body = response.body.pipeThrough(new TransformStream(), { signal: init.signal })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
}
