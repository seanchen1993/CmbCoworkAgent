import { test } from "vitest"
import assert from "node:assert/strict"
import { PublicLinkFetcher, isPublicPreviewAddress } from "./public-link-fetch"
import { normalizeBotPreviewUrl } from "../../shared/bot-link-preview"
import { scrapeBotLinkPreview } from "./link-preview-metadata"
import { BotLinkPreviewService } from "./link-preview-service"
import { previewTLSFixture, publicDNS } from "./link-preview-tls-fixture"

const URL = "https://preview.candidate.net/page"
const signal = () => AbortSignal.timeout(3000)
test("shared URL fence refuses credential, custom port, auth, query secrets and nested encoding", () => {
  for (const url of [
    "http://preview.candidate.net/",
    "https://user:pass@preview.candidate.net/",
    "https://preview.candidate.net:8443/",
    "https://node.svc/",
    "https://login.company.com/",
    "https://preview.candidate.net/login",
    "https://preview.candidate.net/?token=secret",
    "https://preview.candidate.net/?%2574oken=secret",
    "https://preview.candidate.net/?data=eyJabcdefghijklmnop.qrs",
    "https://preview.candidate.net/?q=https%3A%2F%2Fprivate.internal",
    "https://preview.candidate.net/?q=abc\n",
    "https://preview.candidate.net\\@evil.net/",
    "https://preview.candidate.net/?q=%25252541"
  ])
    assert.equal(normalizeBotPreviewUrl(url), null, url)
  assert.equal(normalizeBotPreviewUrl(URL + "?q=hello&page=2#secret"), URL + "?q=hello&page=2")
})
test("private/reserved/mapped IPv4 and IPv6 cannot become public preview targets", () => {
  for (const ip of [
    "127.0.0.1",
    "0.0.0.0",
    "10.2.3.4",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.169.254",
    "224.0.0.1",
    "240.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "3fff::1"
  ])
    assert.equal(isPublicPreviewAddress(ip), false, ip)
  assert.equal(isPublicPreviewAddress("8.8.8.8"), true)
  assert.equal(isPublicPreviewAddress("2606:4700:4700::1111"), true)
})
test("all DNS answers and answer-family consistency are checked before any real TLS dial", async () => {
  const fixture = await previewTLSFixture((_request, response) =>
    response.writeHead(200, { "content-type": "text/html" }).end("<title>safe</title>")
  )
  try {
    for (const records of [
      [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ],
      [{ address: "::ffff:8.8.8.8", family: 6 }],
      [{ address: "8.8.8.8", family: 6 }],
      []
    ]) {
      const fetcher = new PublicLinkFetcher(async () => records, fixture.dial)
      await assert.rejects(fetcher.fetch(URL, "html", signal()), {
        reason: "blocked"
      })
    }
    assert.equal(fixture.observed.length, 0)
  } finally {
    await fixture.close()
  }
})
test("actual TLS connects to approved numeric pin while validating original SNI and sending no credentials/cookies", async () => {
  const headers: unknown[] = []
  const fixture = await previewTLSFixture((request, response) => {
    headers.push(request.headers)
    response
      .writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "sensitive=forbidden"
      })
      .end("<title>Public &amp; Safe</title>")
  })
  try {
    let lookups = 0
    const fetcher = new PublicLinkFetcher(async () => {
      lookups++
      return publicDNS()
    }, fixture.dial)
    const result = await fetcher.fetch(URL, "html", signal())
    assert.equal(result.status, 200)
    assert.equal(lookups, 1)
    assert.equal(fixture.observed[0].host, "8.8.8.8")
    assert.equal(fixture.observed[0].servername, "preview.candidate.net")
    const sent = headers[0] as Record<string, string>
    assert.equal(sent.host, "preview.candidate.net")
    assert.equal(sent.cookie, undefined)
    assert.equal(sent.authorization, undefined)
    assert.equal(sent.referer, undefined)
    assert.equal(sent["proxy-authorization"], undefined)
    assert.equal(scrapeBotLinkPreview(result.bytes, result.finalUrl).title, "Public & Safe")
    await assert.rejects(fetcher.fetch("https://wrong.candidate.net/page", "html", signal()), {
      reason: "unavailable"
    })
  } finally {
    await fixture.close()
  }
})
test("redirect to private IP, credential/query-secret URL and cycle is refused before the next connection", async () => {
  let destination = "https://127.0.0.1/private"
  const fixture = await previewTLSFixture((_request, response) =>
    response.writeHead(302, { location: destination }).end()
  )
  try {
    const fetcher = new PublicLinkFetcher(publicDNS, fixture.dial)
    for (const value of [
      "https://127.0.0.1/private",
      "https://preview.candidate.net/?token=secret",
      URL
    ]) {
      destination = value
      const before = fixture.observed.length
      await assert.rejects(fetcher.fetch(URL, "html", signal()), {
        reason: "blocked"
      })
      assert.equal(fixture.observed.length, before + 1)
    }
  } finally {
    await fixture.close()
  }
})
test("PAC redirect requiring proxy is not bypassed; fallback leaves the original ordinary link available", async () => {
  const fixture = await previewTLSFixture((_request, response) =>
    response.writeHead(302, { location: "https://redirect.candidate.net/page" }).end()
  )
  const checked: string[] = []
  const service = new BotLinkPreviewService({
    fetcher: new PublicLinkFetcher(publicDNS, fixture.dial),
    proxyFor: async (url) => {
      checked.push(url)
      return url.includes("redirect") ? "PROXY private:80" : "DIRECT"
    },
    image: async () => null
  })
  try {
    const result = await service.get("owner", {
      requestId: crypto.randomUUID(),
      url: URL
    })
    assert.deepEqual(result, {
      status: "unavailable",
      reason: "proxy_unsupported"
    })
    assert.equal(checked.length, 2)
    assert.equal(fixture.observed.length, 1)
  } finally {
    await service.close()
    await fixture.close()
  }
})
test("actual TLS byte/header/encoding/MIME limits close the request without retaining a partial response", async () => {
  let mode = "bytes"
  const fixture = await previewTLSFixture((_request, response) => {
    if (mode === "headers")
      response
        .writeHead(200, {
          "content-type": "text/html",
          "x-big": "x".repeat(17 * 1024)
        })
        .end("html")
    else if (mode === "svg")
      response.writeHead(200, { "content-type": "image/svg+xml" }).end('<svg onload="evil()"/>')
    else if (mode === "gzip")
      response
        .writeHead(200, {
          "content-type": "text/html",
          "content-encoding": "gzip"
        })
        .end("not gzip")
    else response.writeHead(200, { "content-type": "text/html" }).end(Buffer.alloc(256 * 1024 + 1))
  })
  try {
    const fetcher = new PublicLinkFetcher(publicDNS, fixture.dial)
    for (const value of ["bytes", "headers", "svg", "gzip"]) {
      mode = value
      await assert.rejects(fetcher.fetch(URL, value === "svg" ? "image" : "html", signal()), {
        reason: "unavailable"
      })
    }
  } finally {
    await fixture.close()
  }
})
test("HTML tokenizer handles quoted greater-than, complete entities and fake script metadata without mounting HTML", () => {
  const value = scrapeBotLinkPreview(
    Buffer.from(
      '<head><script>"<meta property=og:title content=evil>"</script><meta property="og:title" content="good > &copy; &#x110000;"><meta name="description" content="<script>alert(1)</script>\u202e"><meta property="og:image" content="http://127.0.0.1/evil"><link rel=canonical href="https://evil.net/"></head>'
    ),
    URL
  )
  assert.equal(value.title, "good > © �")
  assert.equal(value.imageUrl, undefined)
  assert.equal(value.description, "<script>alert(1)</script>")
  assert.throws(() => scrapeBotLinkPreview(Buffer.alloc(256 * 1024 + 1), URL), /byte limit/)
})

test("unknown query semantics are not silently treated as safe public metadata", () => {
  for (const query of [
    "?opaque=unlabelled-secret",
    "?redirect_uri=%2Fprivate",
    "?a=safe-looking-value",
    "?id=private-document-id"
  ])
    assert.equal(normalizeBotPreviewUrl(URL + query), null)
})

test("actual native DNS resolver cancellation settles A and AAAA without an orphan query", async () => {
  const { createSocket } = await import("node:dgram"),
    { Resolver } = await import("node:dns/promises")
  const { resolvePublicPreviewAddresses } = await import("./public-link-fetch")
  const server = createSocket("udp4")
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve))
  let questions = 0
  server.on("message", () => questions++)
  const controller = new AbortController(),
    resolver = new Resolver({ timeout: 2000, tries: 1 })
  resolver.setServers([`127.0.0.1:${server.address().port}`])
  try {
    const pending = resolvePublicPreviewAddresses(
      "preview.candidate.net",
      controller.signal,
      () => resolver
    )
    const deadline = Date.now() + 1000
    while (questions < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(questions, 2)
    controller.abort(new Error("view released"))
    await assert.rejects(pending, /view released/)
  } finally {
    resolver.cancel()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("declared common legacy charset is decoded without detection scans and text caps preserve emoji boundaries", async () => {
  const iconv = await import("iconv-lite")
  const parsed = scrapeBotLinkPreview(
    iconv.default.encode("<head><title>研发协作平台</title></head>", "gb18030"),
    URL,
    "text/html; charset=GB2312"
  )
  assert.equal(parsed.title, "研发协作平台")
  const title = "a".repeat(511) + "😀"
  assert.equal(
    scrapeBotLinkPreview(Buffer.from(`<head><title>${title}</title></head>`), URL).title,
    "a".repeat(511)
  )
})
