import { describe, expect, it } from "vitest"
import { readJsonResponse, RemoteJsonResponseError } from "./json-response"

describe("safe remote JSON responses", () => {
  it.each(["text/html", "application/json", "application/octet-stream"])(
    "does not expose HTML with %s headers",
    async (contentType) => {
      const response = new Response("<!doctype html><html>private-token=fixture</html>", {
        headers: { "content-type": contentType }
      })
      const error = await readJsonResponse(response, "组织技能服务").catch((error) => error)
      expect(error).toBeInstanceOf(RemoteJsonResponseError)
      if (!(error instanceof RemoteJsonResponseError)) throw error
      expect(error).toMatchObject({ status: 200, redirected: false, mime: contentType })
      expect(error.message).toContain("组织技能服务返回了网页")
      expect(String(error.stack)).not.toMatch(/doctype|private-token|fixture|Unexpected token/)
      expect(error.cause).toBeUndefined()
      expect(error).not.toHaveProperty("body")
      expect(error).not.toHaveProperty("url")
    }
  )

  it("reports redirect facts without retaining the destination URL", async () => {
    const response = new Response("<!doctype html><html>login</html>")
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: "https://example.test/login?token=private-fixture" }
    })
    const error = await readJsonResponse(response, "组织技能服务").catch((error) => error)
    if (!(error instanceof RemoteJsonResponseError)) throw error
    expect(error.redirected).toBe(true)
    expect(error.message).toContain("可能进入了登录页")
    expect(String(error.stack)).not.toMatch(/private-fixture|example\.test|\?token/)
  })

  it.each(["", "  ", "{private-fixture", "<body>private-fixture</body>"])(
    "replaces empty or invalid JSON with a safe error",
    async (body) => {
      const error = await readJsonResponse(new Response(body), "组织技能服务").catch(
        (error) => error
      )
      expect(error).toBeInstanceOf(RemoteJsonResponseError)
      if (!(error instanceof RemoteJsonResponseError)) throw error
      expect(error.message).not.toMatch(/private-fixture|Unexpected token|JSON\.parse/)
    }
  )

  it("requires data even when HTTP 204 is successful", async () => {
    await expect(
      readJsonResponse(new Response(null, { status: 204 }), "组织技能服务")
    ).rejects.toMatchObject({ code: "REMOTE_JSON_RESPONSE_INVALID", status: 204 })
  })

  it.each([undefined, "application/json", "application/problem+json", "text/plain"])(
    "preserves valid JSON with %s MIME compatibility",
    async (contentType) => {
      const response = new Response(JSON.stringify({ returnCode: "SUC0000", body: null }), {
        headers: contentType ? { "content-type": contentType } : undefined
      })
      await expect(readJsonResponse(response, "组织技能服务")).resolves.toEqual({
        returnCode: "SUC0000",
        body: null
      })
    }
  )

  it.each([new DOMException("Cancelled", "AbortError"), new TypeError("body transport failed")])(
    "retains body-read cancellation and transport failures",
    async (failure) => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(failure)
          }
        })
      )
      await expect(readJsonResponse(response, "组织技能服务")).rejects.toBe(failure)
    }
  )
})
