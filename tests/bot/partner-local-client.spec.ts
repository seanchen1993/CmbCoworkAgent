import assert from "node:assert/strict"
import test from "node:test"
import { createServer, type IncomingMessage } from "node:http"
import {
  PartnerLocalClient,
  parsePartnerDescriptor,
  partnerId,
  partnerUrl,
  type PartnerConnectionDescriptor
} from "../../src/main/services/bot/partner-local-client"
import { descriptor } from "./partner-local-fixture"

async function serverFixture(
  work: (d: PartnerConnectionDescriptor, seen: IncomingMessage[]) => Promise<void>,
  handler?: (request: IncomingMessage) => {
    status?: number
    headers?: Record<string, string>
    value?: unknown
    raw?: string
  }
) {
  const seen: IncomingMessage[] = []
  const server = createServer(async (request, response) => {
    seen.push(request)
    let raw = ""
    for await (const data of request) raw += data
    const body = raw ? JSON.parse(raw) : null
    const value = handler?.(request) ?? {
      value: request.url?.endsWith("node")
        ? { spaceId: "A", nodeId: "node", ownerPrincipalId: "owner" }
        : {
            spaceId: "A",
            principalId:
              request.headers.authorization === `Bearer ${"a".repeat(64)}` ? "owner" : "business"
          }
    }
    response.writeHead(value.status ?? 200, {
      "content-type": "application/json",
      ...value.headers
    })
    response.end(value.raw ?? JSON.stringify(value.value))
    void body
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await work(descriptor((server.address() as { port: number }).port), seen)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
test("descriptor is closed, canonical literal loopback and exact distinct credential roles", () => {
  const d = descriptor()
  assert.deepEqual(parsePartnerDescriptor(d), d)
  for (const url of [
    "https://127.0.0.1:1234",
    "http://localhost:1234",
    "http://127.1:1234",
    "http://127.0.0.1:1234/",
    "http://127.0.0.1:1234?x=1",
    "http://u@127.0.0.1:1234",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:0123",
    "http://127.0.0.1:1234\n"
  ])
    assert.throws(() => partnerUrl(url))
  for (const patch of [
    { extra: true },
    { ownerToken: d.businessToken },
    { ownerToken: d.ownerToken + "\n" },
    { nodeToken: d.nodeToken + "\n" },
    { ownerPrincipalId: "owner\n" },
    { version: 2 },
    { businessPrincipalId: "owner" }
  ])
    assert.throws(() => parsePartnerDescriptor({ ...d, ...patch }))
  assert.throws(() => partnerId("other/id"))
  assert.throws(() => partnerId("owner\n"))
})
test("all three identities come from authenticated requests; node bearer has no XSpace/cookie/origin", async () => {
  await serverFixture(async (d, seen) => {
    const client = new PartnerLocalClient(d)
    try {
      await client.verifyIdentity()
      assert.equal(seen.length, 3)
      assert.equal(seen[0].headers.authorization, `Bearer ${d.nodeToken}`)
      assert.equal(seen[0].headers["x-devclaw-space"], undefined)
      assert.equal(seen[1].headers.authorization, `Bearer ${d.ownerToken}`)
      assert.equal(seen[2].headers.authorization, `Bearer ${d.businessToken}`)
      for (const request of seen) {
        assert.equal(request.headers.cookie, undefined)
        assert.equal(request.headers.origin, undefined)
        assert.equal(request.headers.host, new URL(d.url).host)
      }
    } finally {
      client.close()
    }
  })
})
test("mismatched authenticated identity fails instead of trusting descriptor body", async () => {
  await serverFixture(
    async (d) => {
      const client = new PartnerLocalClient(d)
      try {
        await assert.rejects(client.verifyIdentity(), /FORBIDDEN/)
      } finally {
        client.close()
      }
    },
    () => ({ value: { spaceId: "B", nodeId: "node", ownerPrincipalId: "owner" } })
  )
})
test("redirect, HTML, cookie, encoded secret, unbounded response and arbitrary error details are closed", async () => {
  const replies: Array<{
    status?: number
    headers?: Record<string, string>
    value?: unknown
    raw?: string
  }> = [
    { status: 302, headers: { location: "http://example.com" }, value: {} },
    { headers: { "content-type": "text/html" }, raw: "oops" },
    { headers: { "set-cookie": "auth=secret" }, value: {} },
    { value: { echo: Buffer.from("a".repeat(64)).toString("base64") } },
    { raw: "x".repeat(524289) },
    { status: 503, value: { code: "jdbc:mysql:secret" } }
  ]
  for (const reply of replies)
    await serverFixture(
      async (d, seen) => {
        const client = new PartnerLocalClient(d)
        try {
          await assert.rejects(
            client.verifyIdentity(),
            /(DEPENDENCY_UNAVAILABLE|PAYLOAD_TOO_LARGE)/
          )
          assert.equal(seen.length, 1)
        } finally {
          client.close()
        }
      },
      () => reply
    )
})
test("no closed client requests and no cross-node poll runs", async () => {
  await serverFixture(
    async (d) => {
      const client = new PartnerLocalClient(d)
      try {
        await assert.rejects(client.poll(), /FORBIDDEN/)
      } finally {
        client.close()
      }
      await assert.rejects(client.verifyIdentity(), /DEPENDENCY_UNAVAILABLE/)
    },
    () => ({
      value: {
        runs: [
          { id: "run", status: "queued", spaceId: "A", nodeId: "other", ownerPrincipalId: "owner" }
        ]
      }
    })
  )
})
