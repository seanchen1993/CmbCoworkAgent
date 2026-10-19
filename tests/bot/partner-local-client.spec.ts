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
import { inputFixture, runFixture } from "./requirement-execution-fixture"
import { memoryFixture, memoryListFixture } from "./group-memory-fixture"

async function serverFixture(
  work: (d: PartnerConnectionDescriptor, seen: IncomingMessage[]) => Promise<void>,
  handler?: (
    request: IncomingMessage,
    body: Record<string, unknown> | null
  ) => {
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
    const value = handler?.(request, body) ?? {
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
test("memory uses fixed owner/control, business/history and node/confirmation roles", async () => {
  const operations: string[] = []
  await serverFixture(
    async (d, seen) => {
      const client = new PartnerLocalClient(d)
      try {
        const memory = memoryFixture()
        await client.listGroupMemories("group")
        await client.createGroupMemory(
          "group",
          { text: memory.text, source: memory.source },
          "create-memory"
        )
        await client.updateGroupMemory(
          "group",
          { ...memory, memoryId: memory.id, expectedVersion: 1 },
          "update-memory"
        )
        await client.disableGroupMemory("group", memory.id, 1, "disable-memory")
        await client.inspectMemorySnapshot("run", "group")
        assert.equal(await client.memoryChanged(runFixture()), true)
        assert.deepEqual(operations, [
          "listGroupMemories",
          "createGroupMemory",
          "updateGroupMemory",
          "disableGroupMemory",
          "inspectMemorySnapshot",
          "inspect"
        ])
        for (let i = 0; i < seen.length; i++) {
          assert.equal(seen[i].method, "POST")
          assert.equal(
            seen[i].url,
            i === 5 ? "/api/bot/local/v1/node" : "/api/bot/local/v1/control"
          )
          assert.equal(
            seen[i].headers.authorization,
            `Bearer ${i === 5 ? d.nodeToken : i === 4 ? d.businessToken : d.ownerToken}`
          )
          assert.equal(seen[i].headers["x-devclaw-space"], i === 5 ? undefined : "A")
        }
        const count = seen.length
        await assert.rejects(
          client.createGroupMemory(
            "group",
            { text: "x", source: { kind: "manual", url: "file:///private" } as never },
            "bad"
          ),
          /INVALID_PAYLOAD/
        )
        assert.equal(seen.length, count)
      } finally {
        client.close()
      }
    },
    (_request, body) => {
      operations.push(String(body?.operation))
      if (body?.operation === "listGroupMemories") return { value: memoryListFixture() }
      if (body?.operation === "inspectMemorySnapshot")
        return { value: { memorySnapshot: { revision: 1, memories: [memoryFixture()] } } }
      if (body?.operation === "inspect")
        return {
          value: {
            run: { ...runFixture(), status: "failed" },
            result: {
              runId: "run",
              attemptId: "attempt",
              outcome: "failed",
              text: "MEMORY_CHANGED",
              settledAt: new Date().toISOString()
            }
          }
        }
      return { value: { revision: 1, memory: memoryFixture() } }
    }
  )
})
test("memory responses reject cross-team data, undeclared fields and incomplete execution snapshots", async () => {
  for (const value of [
    { ...memoryListFixture(), memories: [memoryFixture({ groupId: "other" })] },
    { ...memoryListFixture(), ownerToken: "not-a-field" },
    { ...memoryListFixture(), revision: Number.MAX_SAFE_INTEGER + 1 }
  ])
    await serverFixture(
      async (d) => {
        const client = new PartnerLocalClient(d)
        try {
          await assert.rejects(client.listGroupMemories("group"), /(FORBIDDEN|INVALID_PAYLOAD)/)
        } finally {
          client.close()
        }
      },
      () => ({ value })
    )
  const input = inputFixture()
  const { memorySnapshot: _unused, ...oldInput } = input
  for (const value of [
    { run: runFixture(), input: oldInput },
    {
      run: runFixture(),
      input: {
        ...input,
        memorySnapshot: { revision: 1, memories: [memoryFixture({ spaceId: "B" })] }
      }
    }
  ])
    await serverFixture(
      async (d) => {
        const client = new PartnerLocalClient(d)
        try {
          await assert.rejects(client.start(runFixture()), /(FORBIDDEN|INVALID_PAYLOAD)/)
        } finally {
          client.close()
        }
      },
      () => ({ value })
    )
})
test("memory invalidation is confirmed only for the complete authenticated attempt", async () => {
  for (const patch of [
    { groupId: "other" },
    { taskVersion: 2 },
    { fence: 2 },
    { attemptId: "other" },
    { leaseId: "other" },
    { botVersionId: "other" }
  ])
    await serverFixture(
      async (d) => {
        const client = new PartnerLocalClient(d)
        try {
          await assert.rejects(
            client.memoryChanged(runFixture()),
            /FORBIDDEN|PARTNER_RUN_INPUT_INVALID/
          )
        } finally {
          client.close()
        }
      },
      () => ({
        value: {
          run: { ...runFixture(), status: "failed", ...patch },
          result: {
            runId: "run",
            attemptId: "attempt",
            outcome: "failed",
            text: "MEMORY_CHANGED",
            settledAt: new Date().toISOString()
          }
        }
      })
    )
  await serverFixture(
    async (d) => {
      const client = new PartnerLocalClient(d)
      try {
        assert.equal(await client.memoryChanged(runFixture()), false)
      } finally {
        client.close()
      }
    },
    () => ({
      value: {
        run: { ...runFixture(), status: "failed" },
        result: {
          runId: "other",
          attemptId: "attempt",
          outcome: "failed",
          text: "MEMORY_CHANGED",
          settledAt: new Date().toISOString()
        }
      }
    })
  )
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

test("current authorization is read under owner credential and strictly validates grant scope/version/lifetime shape", async () => {
  const base = {
    id: "grant",
    groupId: "group",
    nodeId: "node",
    ownerPrincipalId: "owner",
    workspaceRef: "view",
    version: 3,
    enabled: true,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z"
  }
  let grant: unknown = base
  await serverFixture(
    async (d, seen) => {
      const client = new PartnerLocalClient(d)
      try {
        const value = await client.currentAuthorization("group")
        assert.equal(value!.spaceId, d.spaceId)
        assert.equal(value!.version, 3)
        assert.equal(value!.nodeId, "node")
        assert.equal(seen[0].headers.authorization, `Bearer ${d.ownerToken}`)
        for (const patch of [
          { groupId: "another" },
          { enabled: "true" },
          { version: 0 },
          { expiresAt: "bad" },
          { workspaceRef: "../path" },
          { extra: true }
        ]) {
          grant = { ...base, ...patch }
          await assert.rejects(client.currentAuthorization("group"), /INVALID_PAYLOAD/)
        }
      } finally {
        client.close()
      }
    },
    (_request, body) => {
      assert.deepEqual(body, { operation: "authorization", groupId: "group" })
      return { value: { grant } }
    }
  )
})
