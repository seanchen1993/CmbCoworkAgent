import { createServer, type RequestListener } from "node:http"
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionHttpRequest } from "./http-sdk"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModJson } from "../../../shared/mods/types"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(
  hook: string,
  authorize: (r: Readonly<FunctionHttpRequest>) => Promise<void>,
  handle?: RequestListener,
  protect?: (value: ModJson) => ModJson,
  assertLive?: () => void
) {
  const received: string[] = []
  const server = createServer((request, response) => {
    received.push(request.url!)
    if (handle) handle(request, response)
    else response.end("secret response")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"fetch",description:"fetch"});return next(e)
    });
    on("command.run",async($)=>{
      try{return {response:await $.http.fetch(${JSON.stringify(base + "/original")})}}
      catch(error){return {error:error.code}}
    });
    ${hook}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "http",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "http",
      assertLive() {
        assertLive?.()
      },
      authorizeHttp: async (_, request) => authorize(request),
      publish: async (value) =>
        protect
          ? protect(value)
          : typeof value === "object" && value && !Array.isArray(value) && "text" in value
            ? { ...value, text: "protected response" }
            : value
    }
  )
  cleanup.push(() => session.close())
  return { session, received, base }
}

it("approves the rewritten request and protects text before guest code sees it", async () => {
  const authorize = vi.fn(async () => {})
  const { session, received, base } = await fixture(
    `
    on("http.fetch",async($,e,next)=>next({...e,url:e.url.replace("original","rewritten")}));
  `,
    authorize
  )
  const result = await session.run("fetch", "")
  expect(received).toEqual(["/rewritten"])
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ url: base + "/rewritten" }))
  expect(result).toMatchObject({ response: { text: "protected response", ok: true } })
})

it("a refused HTTP operation sends no network request", async () => {
  const authorize = vi.fn(async () => {})
  const { session, received } = await fixture(
    `on("http.fetch",async()=>({deny:"offline"}));`,
    authorize
  )
  expect(await session.run("fetch", "")).toEqual({ error: "MODS_OPERATION_DENIED" })
  expect(authorize).not.toHaveBeenCalled()
  expect(received).toEqual([])
})

it.each([
  ["gzip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync]
] as const)(
  "real QuickJS receives protected decoded %s response, including its after-hook",
  async (encoding, encode) => {
    const authorize = vi.fn(async () => {})
    const observed: unknown[] = []
    const { session, received } = await fixture(
      `on("http.fetch",async($,e,next)=>{
        const r=await next(e);
        if(r.value.text!=="protected 中文😀")throw Error("after-hook saw unprotected bytes");
        return {...r,value:{...r.value,text:r.value.text+" checked"}}
      });`,
      authorize,
      (request, response) => {
        expect(request.headers["accept-encoding"]).toBe("gzip, deflate, br")
        response.writeHead(200, { "content-encoding": encoding })
        response.end(encode(Buffer.from("secret 中文😀")))
      },
      (value) => {
        if (typeof value === "object" && value && "text" in value) {
          observed.push(value.text)
          return { ...value, text: String(value.text).replace("secret", "protected") }
        }
        return value
      }
    )
    expect(await session.run("fetch", "")).toMatchObject({
      response: { text: "protected 中文😀 checked", ok: true }
    })
    expect(observed).toContain("secret 中文😀")
    expect(authorize).toHaveBeenCalledOnce()
    expect(received).toEqual(["/original"])
  }
)

it("real QuickJS rejects a decoded bomb before the HTTP after-hook can observe a response", async () => {
  const { session } = await fixture(
    `on("http.fetch",async($,e,next)=>{const r=await next(e);return {...r,value:{...r.value,text:"AFTER_RAN"}}});`,
    async () => {},
    (_, response) => {
      response.writeHead(200, { "content-encoding": "gzip" })
      response.end(gzipSync(Buffer.alloc(256 * 1024 + 1)))
    }
  )
  expect(await session.run("fetch", "")).toEqual({ error: "MODS_HTTP_RESPONSE_LIMIT" })
})

it("real QuickJS never receives compressed secrets when content protection refuses the decoded body", async () => {
  const observed: string[] = []
  const { session } = await fixture(
    `on("http.fetch",async($,e,next)=>{const r=await next(e);return {...r,value:{...r.value,text:"AFTER_RAN"}}});`,
    async () => {},
    (_, response) => {
      response.writeHead(200, { "content-encoding": "gzip" })
      response.end(gzipSync("confidential decoded body"))
    },
    (value) => {
      if (typeof value === "object" && value && "text" in value) {
        observed.push(String(value.text))
        throw new ModFunctionError("MODS_CONTENT_DENIED")
      }
      return value
    }
  )
  expect(await session.run("fetch", "")).toEqual({ error: "MODS_CONTENT_DENIED" })
  expect(observed).toEqual(["confidential decoded body"])
})

it("revoking a real QuickJS session during compressed HTTP prevents response publication", async () => {
  let revoked = false
  const published: unknown[] = []
  const { session, received } = await fixture(
    "",
    async () => {},
    (_, response) => {
      response.writeHead(200, { "content-encoding": "gzip" })
      revoked = true
      response.end(gzipSync("must never be published"))
    },
    (value) => {
      published.push(value)
      return value
    },
    () => {
      if (revoked) throw new ModFunctionError("MODS_GRANT_REVOKED")
    }
  )
  await expect(session.run("fetch", "")).rejects.toThrow("MODS_GRANT_REVOKED")
  expect(received).toEqual(["/original"])
  expect(JSON.stringify(published)).not.toContain("must never be published")
})
