import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync, constants } from "node:zlib"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionHttpHost, functionHttpRequest, type FunctionHttpContext } from "./http-sdk"
import type { ModObject } from "../../../shared/mods/types"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function server(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const app = createServer(handle)
  const sockets = new Set<Socket>()
  app.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve))
  cleanup.push(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        app.close(() => resolve())
      })
  )
  return `http://127.0.0.1:${(app.address() as { port: number }).port}`
}

function context(): FunctionHttpContext & { controller: AbortController } {
  const controller = new AbortController()
  return {
    controller,
    signal: controller.signal,
    assertLive: vi.fn(),
    authorize: vi.fn(async () => {}),
    publish: vi.fn(async (response) => response)
  }
}

it("normalizes an immutable exact request and rejects unsupported or malformed requests", () => {
  const request = functionHttpRequest({
    url: "https://example.com/a#fragment",
    init: {
      method: "post",
      body: "中文",
      headers: {
        Host: "forged",
        "Content-Length": "0",
        "Transfer-Encoding": "chunked",
        "Accept-Encoding": "gzip",
        "X-Tag": "a"
      }
    }
  })
  expect(request).toEqual({
    url: "https://example.com/a",
    method: "POST",
    body: "中文",
    headers: { "accept-encoding": "gzip, deflate, br", "content-length": "6", "x-tag": "a" }
  })
  expect(Object.isFrozen(request)).toBe(true)
  expect(Object.isFrozen(request.headers)).toBe(true)
  const invalidInputs: ModObject[] = [
    { url: "https://secret:password@example.com" },
    { url: "file:///tmp/x" },
    { url: "https://a", init: { auth: "handle" } },
    { url: "https://a", init: { socketPath: "/tmp/x" } },
    { url: "https://a", init: { method: "GET\r\nx" } },
    { url: "https://a", init: { method: "CONNECT" } },
    { url: "https://a", init: { headers: { x: "bad\r\nvalue" } } },
    { url: "https://a", init: { headers: { x: "中" } } },
    { url: "https://a", init: { body: "x" } }
  ]
  for (const input of invalidInputs) expect(() => functionHttpRequest(input)).toThrow()
})

it("returns 4xx and complete UTF8 text normally only after approval and publication", async () => {
  const received: string[] = []
  const url = await server((req, res) => {
    req.on("data", (data) => received.push(data.toString()))
    req.on("end", () => {
      res.writeHead(422, { "X-Result": "invalid" })
      const bytes = Buffer.from("中文😀")
      res.write(bytes.subarray(0, 2))
      res.end(bytes.subarray(2))
    })
  })
  const c = context()
  const value = await new FunctionHttpHost().fetch(
    { url, init: { method: "POST", body: "hello" } },
    c
  )
  expect(value).toMatchObject({
    status: 422,
    ok: false,
    text: "中文😀",
    headers: { "x-result": "invalid" }
  })
  expect(received).toEqual(["hello"])
  expect(c.authorize).toHaveBeenCalledOnce()
  expect(c.publish).toHaveBeenCalledOnce()
  expect(c.assertLive).toHaveBeenCalled()
})

it.each([301, 302, 303, 307, 308])(
  "reapproves redirect %i using the actual next method, body and destination",
  async (status) => {
    const seen: Array<{ method: string | undefined; body: string }> = []
    const url = await server((req, res) => {
      if (req.url === "/start") {
        res.writeHead(status, { Location: "/end" })
        res.end()
        return
      }
      let body = ""
      req.on("data", (data) => {
        body += data
      })
      req.on("end", () => {
        seen.push({ method: req.method, body })
        res.end("ok")
      })
    })
    const c = context()
    await new FunctionHttpHost().fetch(
      {
        url: url + "/start",
        init: { method: "POST", body: "payload", headers: { "content-type": "text/plain" } }
      },
      c
    )
    const preserve = status === 307 || status === 308
    expect(seen).toEqual([{ method: preserve ? "POST" : "GET", body: preserve ? "payload" : "" }])
    expect(c.authorize).toHaveBeenCalledTimes(2)
    expect(vi.mocked(c.authorize).mock.calls[1][0]).toMatchObject({
      url: url + "/end",
      method: preserve ? "POST" : "GET"
    })
  }
)

it("drops cross-origin credentials and never sends to a redirect destination before approval", async () => {
  let targetHits = 0
  let targetHeaders: IncomingMessage["headers"] = {}
  const target = await server((req, res) => {
    targetHits++
    targetHeaders = req.headers
    res.end("done")
  })
  const start = await server((_, res) => {
    res.writeHead(302, { location: target })
    res.end()
  })
  const c = context()
  vi.mocked(c.authorize).mockImplementation(async (request) => {
    if (request.url === target + "/") {
      expect(targetHits).toBe(0)
      expect(request.headers).not.toHaveProperty("authorization")
      expect(request.headers).not.toHaveProperty("cookie")
      expect(request.headers).not.toHaveProperty("x-secret")
    }
  })
  await new FunctionHttpHost().fetch(
    {
      url: start,
      init: {
        headers: {
          Authorization: "token",
          Cookie: "secret",
          "Proxy-Authorization": "proxy",
          "X-Secret": "private",
          Accept: "text/plain"
        }
      }
    },
    c
  )
  expect(targetHits).toBe(1)
  expect(targetHeaders.authorization).toBeUndefined()
  expect(targetHeaders.cookie).toBeUndefined()
  expect(targetHeaders.accept).toBe("text/plain")
})

it("matches pinned Claude 303 HEAD-to-GET behavior and preserves explicit content type", async () => {
  const seen: string[] = []
  const url = await server((req, res) => {
    seen.push(req.method!)
    if (req.url === "/start") res.writeHead(303, { location: "/end" })
    res.end("done")
  })
  const c = context()
  await new FunctionHttpHost().fetch(
    { url: url + "/start", init: { method: "HEAD", headers: { "content-type": "text/plain" } } },
    c
  )
  expect(seen).toEqual(["HEAD", "GET"])
  expect(vi.mocked(c.authorize).mock.calls[1][0].headers["content-type"]).toBe("text/plain")
})

it("does not issue a request after denied approval or stale authority", async () => {
  let hits = 0
  const url = await server((_, res) => {
    hits++
    res.end("ok")
  })
  const c = context()
  vi.mocked(c.authorize).mockRejectedValueOnce(Error("denied"))
  await expect(new FunctionHttpHost().fetch({ url }, c)).rejects.toThrow("denied")
  vi.mocked(c.authorize).mockImplementation(async () => {
    vi.mocked(c.assertLive).mockImplementation(() => {
      throw Error("stale")
    })
  })
  await expect(new FunctionHttpHost().fetch({ url }, c)).rejects.toThrow("stale")
  expect(hits).toBe(0)
})

it("aborts pending approval and never commits a stale publication", async () => {
  const c = context()
  vi.mocked(c.authorize).mockImplementation(() => new Promise(() => {}))
  const pending = new FunctionHttpHost().fetch({ url: "http://127.0.0.1:1" }, c)
  c.controller.abort(Error("cancelled"))
  await expect(pending).rejects.toThrow("cancelled")
  const url = await server((_, res) => res.end("ok"))
  const fresh = context()
  vi.mocked(fresh.publish).mockImplementation(async (response) => {
    vi.mocked(fresh.assertLive).mockImplementation(() => {
      throw Error("stale")
    })
    return response
  })
  await expect(new FunctionHttpHost().fetch({ url }, fresh)).rejects.toThrow("stale")
})

it("bounds response body, JSON escaping and response encoding", async () => {
  const url = await server((req, res) => {
    if (req.url === "/encoding") {
      res.writeHead(200, { "content-encoding": "gzip" })
      res.end("compressed")
      return
    }
    res.end(req.url === "/escaped" ? "\0".repeat(200_000) : "x".repeat(270_000))
  })
  for (const path of ["/large", "/escaped"])
    await expect(new FunctionHttpHost().fetch({ url: url + path }, context())).rejects.toThrow(
      "MODS_HTTP_RESPONSE_LIMIT"
    )
  await expect(new FunctionHttpHost().fetch({ url: url + "/encoding" }, context())).rejects.toThrow(
    "MODS_HTTP_DECOMPRESSION"
  )
})

const LIMIT = 256 * 1024
const encoders = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }

it.each(Object.entries(encoders))(
  "decodes real %s with UTF8 bytes split across wire chunks",
  async (encoding, encode) => {
    const text = "中文😀".repeat(4000)
    const compressed = encode(Buffer.from(text))
    const url = await server((req, res) => {
      expect(req.headers["accept-encoding"]).toBe("gzip, deflate, br")
      res.writeHead(200, { "content-encoding": encoding })
      res.write(compressed.subarray(0, 7))
      setImmediate(() => res.end(compressed.subarray(7)))
    })
    const c = context()
    expect(await new FunctionHttpHost().fetch({ url }, c)).toMatchObject({
      text,
      headers: { "content-encoding": encoding }
    })
    expect(c.publish).toHaveBeenCalledOnce()
  }
)

it.each(["identity", "gzip", "deflate", "br"])(
  "%s accepts exactly the decoded limit and rejects one extra byte",
  async (encoding) => {
    const url = await server((req, res) => {
      const bytes = Buffer.alloc(LIMIT + (req.url === "/over" ? 1 : 0), "a")
      res.writeHead(200, { "content-encoding": encoding })
      res.end(encoding === "identity" ? bytes : encoders[encoding as keyof typeof encoders](bytes))
    })
    const c = context()
    expect((await new FunctionHttpHost().fetch({ url }, c)).text).toBe("a".repeat(LIMIT))
    const rejected = context()
    await expect(new FunctionHttpHost().fetch({ url: url + "/over" }, rejected)).rejects.toThrow(
      "MODS_HTTP_RESPONSE_LIMIT"
    )
    expect(rejected.publish).not.toHaveBeenCalled()
  }
)

it("counts actual compressed wire bytes independently of the decoded size", async () => {
  // A standards-compliant gzip optional filename is wire data but produces no decoded bytes.
  const gzip = gzipSync(Buffer.from("ok"))
  const padded = (length: number) => {
    const header = Buffer.from(gzip.subarray(0, 10))
    header[3] |= 8
    return Buffer.concat([
      header,
      Buffer.alloc(length - gzip.length - 1, 97),
      Buffer.from([0]),
      gzip.subarray(10)
    ])
  }
  const url = await server((req, res) => {
    const wire = padded(LIMIT + (req.url === "/over" ? 1 : 0))
    res.writeHead(200, { "content-encoding": "gzip" })
    for (let offset = 0; offset < wire.length; offset += 4096)
      res.write(wire.subarray(offset, offset + 4096))
    res.end()
  })
  expect((await new FunctionHttpHost().fetch({ url }, context())).text).toBe("ok")
  const c = context()
  await expect(new FunctionHttpHost().fetch({ url: url + "/over" }, c)).rejects.toThrow(
    "MODS_HTTP_RESPONSE_LIMIT"
  )
  expect(c.publish).not.toHaveBeenCalled()
})

it.each(["gzip, br", "identity, gzip", "compress", "gzip, gzip"])(
  "rejects unsupported encoding %s",
  async (encoding) => {
    const url = await server((_, res) => {
      res.writeHead(200, { "content-encoding": encoding })
      res.end(gzipSync("data"))
    })
    const c = context()
    await expect(new FunctionHttpHost().fetch({ url }, c)).rejects.toThrow(
      "MODS_HTTP_ENCODING_UNSUPPORTED"
    )
    expect(c.publish).not.toHaveBeenCalled()
  }
)

it.each(["gzip", "deflate", "br"] as const)(
  "rejects malformed and truncated %s without publishing",
  async (encoding) => {
    const valid = encoders[encoding](Buffer.from("a".repeat(10_000)))
    const url = await server((req, res) => {
      res.writeHead(200, { "content-encoding": encoding })
      res.end(
        req.url === "/bad" ? Buffer.from([255, 255, 255]) : valid.subarray(0, valid.length - 2)
      )
    })
    for (const path of ["/bad", "/short"]) {
      const c = context()
      await expect(new FunctionHttpHost().fetch({ url: url + path }, c)).rejects.toThrow(
        "MODS_HTTP_DECOMPRESSION"
      )
      expect(c.publish).not.toHaveBeenCalled()
    }
  }
)

it("does not retry raw-deflate or buffer a compression bomb", async () => {
  const url = await server((req, res) => {
    res.writeHead(200, { "content-encoding": "deflate" })
    res.end(req.url === "/raw" ? deflateRawSync("raw") : deflateSync(Buffer.alloc(2 * 1024 * 1024)))
  })
  for (const [path, error] of [
    ["/raw", "DECOMPRESSION"],
    ["/bomb", "RESPONSE_LIMIT"]
  ]) {
    const c = context()
    await expect(new FunctionHttpHost().fetch({ url: url + path }, c)).rejects.toThrow(
      `MODS_HTTP_${error}`
    )
    expect(c.publish).not.toHaveBeenCalled()
  }
})

it.each(["HEAD", "204", "304"])(
  "treats %s as empty even with encoded oversized resource metadata",
  async (kind) => {
    const url = await server((_, res) => {
      res.writeHead(kind === "HEAD" ? 200 : Number(kind), {
        "content-encoding": "gzip",
        "content-length": LIMIT * 10
      })
      res.end()
    })
    const result = await new FunctionHttpHost().fetch(
      { url, init: { method: kind === "HEAD" ? "HEAD" : "GET" } },
      context()
    )
    expect(result.text).toBe("")
  }
)

it("never decodes or buffers redirect bodies and separately approves the compressed destination", async () => {
  const url = await server((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, {
        location: "/end",
        "content-encoding": "unknown",
        "content-length": LIMIT * 100
      })
      res.flushHeaders()
      return
    }
    res.writeHead(200, { "content-encoding": "br" })
    res.end(brotliCompressSync(Buffer.from("target")))
  })
  const c = context()
  expect((await new FunctionHttpHost().fetch({ url: url + "/start" }, c)).text).toBe("target")
  expect(c.authorize).toHaveBeenCalledTimes(2)
  expect(c.publish).toHaveBeenCalledOnce()
})

it.each(["timeout", "abort", "revoke"])(
  "destroys an active gzip response on %s without late publication",
  async (mode) => {
    const c = context()
    let stale = false
    let close!: () => void
    const closed = new Promise<void>((resolve) => {
      close = resolve
    })
    vi.mocked(c.assertLive).mockImplementation(() => {
      if (stale) throw Error("grant revoked")
    })
    const url = await server((_, res) => {
      res.once("close", close)
      res.writeHead(200, { "content-encoding": "gzip" })
      res.write(gzipSync("started", { finishFlush: constants.Z_SYNC_FLUSH }))
      if (mode !== "timeout")
        setImmediate(() => {
          if (mode === "abort") c.controller.abort(Error("cancelled"))
          else {
            stale = true
            res.end(Buffer.from([0]))
          }
        })
    })
    await expect(new FunctionHttpHost(60).fetch({ url }, c)).rejects.toThrow(
      mode === "timeout" ? "MODS_HTTP_TIMEOUT" : mode === "abort" ? "cancelled" : "grant revoked"
    )
    await closed
    expect(c.publish).not.toHaveBeenCalled()
  }
)

it("covers slow body with the timeout and closes the response socket on cancellation", async () => {
  let closed!: () => void
  const ended = new Promise<void>((resolve) => {
    closed = resolve
  })
  const url = await server((_, res) => {
    res.writeHead(200)
    res.write("started")
    res.once("close", closed)
  })
  await expect(new FunctionHttpHost(40).fetch({ url }, context())).rejects.toThrow(
    "MODS_HTTP_TIMEOUT"
  )
  await ended
})

it("limits redirect chains and rejects credentialed or non-http destinations", async () => {
  const url = await server((req, res) => {
    res.writeHead(302, { location: req.url === "/bad" ? "file:///tmp/x" : "/loop" })
    res.end()
  })
  const c = context()
  await expect(new FunctionHttpHost().fetch({ url: url + "/loop" }, c)).rejects.toThrow(
    "MODS_HTTP_REDIRECT_LIMIT"
  )
  expect(c.authorize).toHaveBeenCalledTimes(6)
  await expect(new FunctionHttpHost().fetch({ url: url + "/bad" }, context())).rejects.toThrow(
    "MODS_HTTP_REDIRECT_URL"
  )
})
