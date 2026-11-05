import assert from "node:assert/strict"
import http from "node:http"

/** Real Electron pages, synthetic WPS async API and cookies; no intranet/Chrome credentials. */
export default async function journey(service, engine, BrowserService, syncBotBrowserProfile) {
  const documentText = "需求正文：客户资料、业务规则与验收标准。\n".repeat(1600)
  const frameServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(
      `<canvas></canvas><script>window.WPSOpenApi={Application:{ActiveDocument:Promise.resolve({GetDocumentRange:async()=>({Text:Promise.resolve(${JSON.stringify(documentText)})})})}}</script>`
    )
  })
  await new Promise((resolve) => frameServer.listen(0, "127.0.0.1", resolve))
  const frameUrl = `http://127.0.0.1:${frameServer.address().port}`
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    if (req.url === "/wps")
      res.end(`<title>文档夹具</title><iframe name="office-iframe" src="${frameUrl}"></iframe>`)
    else
      res.end(
        req.headers.cookie?.includes("wps-login=updated")
          ? "updated-login"
          : req.headers.cookie?.includes("wps-login=synthetic")
            ? "signed-in"
            : "signed-out"
      )
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const source = new BrowserService(() => null)
  const act = async (owner, input) =>
    JSON.parse(await service.act(owner, input, new AbortController().signal))
  let disconnect = () => {}
  const scopes = ["wps-bot", "im-fixture--wps-bot", "work-wps--wps-bot"]
  try {
    const pages = []
    for (const scope of scopes) {
      const opened = await act(scope, { action: "navigate", url: base + "/wps" }).catch((error) => {
        // The cross-origin frame may commit while the navigation's initial snapshot is read.
        // Keep the created page and re-observe after it loads; never replay navigation.
        if (!error.message.includes("观察期间页面已改变") || !error.pageId) throw error
        return { pageId: error.pageId }
      })
      pages.push(opened.pageId)
      const page = engine.context
        .pages()
        .filter((page) => page.url() === base + "/wps")
        .at(-1)
      await page.frame({ name: "office-iframe" }).waitForFunction(() => Boolean(window.WPSOpenApi))
      await act(scope, { action: "observe", pageId: opened.pageId })
      const text = []
      let offset = 0
      do {
        const result = await act(scope, {
          action: "read_wps_document",
          pageId: opened.pageId,
          textOffset: offset,
          maxTextChars: 20_000
        })
        assert.equal(result.pageId, opened.pageId)
        assert.equal(result.totalChars, documentText.length)
        assert.ok(result.text.length <= 20_000)
        text.push(result.text)
        offset = result.nextTextOffset
      } while (offset !== undefined)
      assert.equal(text.join(""), documentText)
    }
    await assert.rejects(
      act(scopes[0], { action: "read_wps_document", pageId: pages[1] }),
      /不属于此 Bot/
    )
    await act(scopes[0], { action: "navigate", pageId: pages[0], url: base + "/session" })
    await assert.rejects(
      act(scopes[0], { action: "read_wps_document", pageId: pages[0] }),
      /office-iframe/
    )
    const page = engine.context.pages().find((page) => page.url() === base + "/session")
    assert.equal(await page.locator("body").innerText(), "signed-out")
    const data = (value) => ({
      cookies: [
        {
          name: "wps-login",
          value,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          sameSite: "lax"
        }
      ],
      localStorage: []
    })
    await source.importProfileData(data("synthetic"))
    disconnect = await syncBotBrowserProfile(engine.context, {
      enabled: () => true,
      prepare: async () => {},
      read: () => source.readProfileCookies(),
      subscribe: (callback) => source.onProfileImported(callback)
    })
    await page.reload()
    assert.equal(await page.locator("body").innerText(), "signed-in")
    assert.equal(
      await page.evaluate(() => document.cookie.includes("wps-login")),
      false,
      "HttpOnly must remain HttpOnly"
    )
    await source.importProfileData(data("updated"))
    await page.reload()
    assert.equal(await page.locator("body").innerText(), "updated-login")
    assert.equal(
      (await service.preview(scopes[1])).pages[0].id,
      pages[1],
      "import must preserve page ownership"
    )
    assert.equal((await service.preview(scopes[2])).pages[0].id, pages[2])
    console.log(
      "BOT_WPS_LOGIN_PASS: cross-origin WPS text pagination, Bot/group/work ownership, opt-in cookie sync and manual refresh"
    )
  } finally {
    disconnect()
    for (const scope of scopes) {
      const state = await service.preview(scope)
      for (const page of state.pages) await act(scope, { action: "close", pageId: page.id })
    }
    await Promise.all(
      [server, frameServer].map((server) => new Promise((resolve) => server.close(resolve)))
    )
  }
}
