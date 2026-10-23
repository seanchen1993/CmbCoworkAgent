import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

export default async function verifyOwnedAutomation(service, engine, fixtureUrl, workspace) {
  const act = async (scope, input) =>
    JSON.parse(await service.act(scope, input, new AbortController().signal))
  const ref = (snapshot, role, name, index = 0) => {
    const lines = snapshot.content
      .split("\n")
      .filter((line) => line.includes(role + ' "' + name + '"') && line.includes("[ref="))
    assert.ok(lines[index], `Missing ${role} ${name}: ${snapshot.content}`)
    return lines[index].split("[ref=")[1].split("]")[0]
  }
  const html = `<title>Owned automation fixture</title>
    <h2>订单 A</h2><button onclick="document.querySelector('#result').textContent='订单 A'">查看详情</button>
    <h2>订单 B</h2><button onclick="document.querySelector('#result').textContent='订单 B'">查看详情</button>
    <p id="result">尚未操作</p>
    <label>姓名<input></label><label>城市<select><option value="sh">上海</option><option value="sz">深圳</option></select></label>
    <label>同意<input type="checkbox"></label><label>附件<input type="file"></label>
    <button onmouseenter="document.querySelector('#hover').hidden=false">悬停菜单</button><span id="hover" hidden>菜单已展开</span>
    <button onclick="setTimeout(()=>document.querySelector('#later').hidden=false,100)">加载结果</button><p id="later" hidden>异步结果</p>
    <button draggable="true" ondragstart="event.dataTransfer.setData('text/plain','moved')">拖动源</button>
    <button ondragover="event.preventDefault()" ondrop="event.preventDefault();this.textContent='已放入'">拖动目标</button>
    <a href="${fixtureUrl}/download" download>下载文件</a>
    <a href="${fixtureUrl}/popup" target="_blank">打开新窗口</a>
    <iframe title="子框架" srcdoc="<button onclick=&quot;this.textContent='框架已点击'&quot;>框架按钮</button>"></iframe>`
  const owners = ["work-task-one--alice", "work-task-two--alice", "group-room--alice"]
  const fixtures = []
  try {
    for (const scope of owners) {
      await fs.mkdir(workspace(scope), { recursive: true })
      await fs.writeFile(path.join(workspace(scope), "input.txt"), scope)
      const before = new Set(engine.context.pages())
      const opened = await act(scope, { action: "navigate", newTab: true, url: fixtureUrl })
      const page = engine.context.pages().find((page) => !before.has(page))
      assert.ok(page)
      await page.setContent(html)
      await page.frameLocator("iframe").getByRole("button", { name: "框架按钮" }).waitFor()
      fixtures.push({
        scope,
        page,
        pageId: opened.pageId,
        snapshot: await act(scope, { action: "observe", pageId: opened.pageId })
      })
    }
    const [first, second, group] = fixtures
    // Concurrent scopes at the same URL must resolve duplicate labels independently.
    await Promise.all(
      fixtures.map((item, index) =>
        act(item.scope, {
          action: "click",
          pageId: item.pageId,
          ref: ref(item.snapshot, "button", "查看详情", index % 2)
        })
      )
    )
    assert.equal(await first.page.locator("#result").textContent(), "订单 A")
    assert.equal(await second.page.locator("#result").textContent(), "订单 B")
    assert.equal(await group.page.locator("#result").textContent(), "订单 A")
    const ambiguous = await act(first.scope, {
      action: "click",
      pageId: first.pageId,
      role: "button",
      name: "查看详情"
    })
    assert.equal(ambiguous.ok, false)
    assert.ok(ambiguous.content.includes("[ref="))
    assert.equal(await first.page.locator("#result").textContent(), "订单 A")
    await assert.rejects(
      act(first.scope, {
        action: "click",
        pageId: first.pageId,
        ref: ref(second.snapshot, "button", "查看详情")
      }),
      /引用已失效|其他页面/
    )
    await assert.rejects(
      act(first.scope, {
        action: "click",
        pageId: second.pageId,
        ref: ref(second.snapshot, "button", "查看详情")
      }),
      /不属于/
    )

    let snapshot = await act(first.scope, { action: "observe", pageId: first.pageId })
    await act(first.scope, {
      action: "fill_form",
      pageId: first.pageId,
      fields: [
        { name: "姓名", type: "textbox", ref: ref(snapshot, "textbox", "姓名"), value: "张三" },
        { name: "同意", type: "checkbox", ref: ref(snapshot, "checkbox", "同意"), value: "true" }
      ]
    })
    assert.equal(await first.page.getByLabel("姓名").inputValue(), "张三")
    assert.equal(await first.page.getByLabel("同意").isChecked(), true)
    snapshot = await act(first.scope, {
      action: "select",
      pageId: first.pageId,
      ref: ref(snapshot, "combobox", "城市"),
      values: ["sz"]
    })
    assert.equal(await first.page.getByLabel("城市").inputValue(), "sz")
    snapshot = await act(first.scope, {
      action: "fill",
      pageId: first.pageId,
      ref: ref(snapshot, "textbox", "姓名"),
      text: "李四",
      slowly: true
    })
    const typed = await first.page.getByLabel("姓名").inputValue()
    assert.ok(typed.includes("李四"), JSON.stringify(typed))
    snapshot = await act(first.scope, {
      action: "hover",
      pageId: first.pageId,
      ref: ref(snapshot, "button", "悬停菜单")
    })
    assert.equal(await first.page.locator("#hover").isVisible(), true)
    snapshot = await act(first.scope, {
      action: "drag",
      pageId: first.pageId,
      ref: ref(snapshot, "button", "拖动源"),
      toRef: ref(snapshot, "button", "拖动目标")
    })
    assert.equal(await first.page.getByRole("button", { name: "已放入" }).count(), 1)
    snapshot = await act(first.scope, {
      action: "click",
      pageId: first.pageId,
      ref: ref(snapshot, "button", "加载结果")
    })
    await act(first.scope, { action: "wait", pageId: first.pageId, text: "异步结果" })
    assert.equal(await first.page.locator("#later").isVisible(), true)
    snapshot = await act(first.scope, { action: "observe", pageId: first.pageId })
    await act(first.scope, {
      action: "click",
      pageId: first.pageId,
      ref: ref(snapshot, "button", "框架按钮")
    })
    assert.equal(
      await first.page.frameLocator("iframe").getByRole("button", { name: "框架已点击" }).count(),
      1
    )
    const evaluated = await act(first.scope, {
      action: "evaluate",
      pageId: first.pageId,
      function: "() => document.querySelector('#result').textContent"
    })
    assert.equal(JSON.parse(evaluated.result), "订单 A")

    // Workspace files and downloads still pass through the host, exactly once.
    for (const item of fixtures) {
      snapshot = await act(item.scope, { action: "observe", pageId: item.pageId })
      await act(item.scope, {
        action: "upload",
        pageId: item.pageId,
        ref: ref(snapshot, "button", "附件"),
        fileId: "input.txt"
      })
      assert.equal(
        await item.page.getByLabel("附件").evaluate(async (input) => input.files[0].text()),
        item.scope
      )
      await assert.rejects(
        act(item.scope, {
          action: "upload",
          pageId: item.pageId,
          name: "附件",
          fileId: "../outside.txt"
        }),
        /工作|路径|文件/
      )
      await act(item.scope, {
        action: "click",
        pageId: item.pageId,
        ref: ref(snapshot, "link", "下载文件")
      })
      let download
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        download = (
          await act(item.scope, { action: "observe", pageId: item.pageId })
        ).downloads.find((entry) => entry.state === "saved")
        if (download) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.ok(download)
      assert.equal(
        await fs.readFile(path.join(workspace(item.scope), download.file), "utf8"),
        "synthetic download"
      )
      assert.equal((await fs.readdir(path.join(workspace(item.scope), "downloads"))).length, 1)
    }

    // Popups inherit the originating page's owner; the shared browser context
    // must not expose them in a peer task or group member's page list.
    snapshot = await act(first.scope, { action: "observe", pageId: first.pageId })
    const popupEvent = first.page.waitForEvent("popup")
    await act(first.scope, {
      action: "click",
      pageId: first.pageId,
      ref: ref(snapshot, "link", "打开新窗口")
    })
    const popup = await popupEvent
    await popup.waitForLoadState("domcontentloaded")
    const ownPages = (await act(first.scope, { action: "observe", pageId: first.pageId })).pages
    assert.equal(ownPages.length, 2)
    const popupId = ownPages.find((item) => item.id !== first.pageId).id
    for (const item of [second, group]) {
      const peerPages = (await act(item.scope, { action: "observe", pageId: item.pageId })).pages
      assert.deepEqual(
        peerPages.map((page) => page.id),
        [item.pageId]
      )
      await assert.rejects(act(item.scope, { action: "observe", pageId: popupId }), /不属于/)
    }
    await act(first.scope, { action: "close", pageId: popupId })

    // A queued action during takeover returns evidence, without replaying its click.
    snapshot = await act(first.scope, { action: "observe", pageId: first.pageId })
    const stale = ref(snapshot, "button", "查看详情", 1)
    await service.takeOver(first.scope, first.pageId)
    const lease = await service.preview(first.scope)
    let entered
    const waiting = new Promise((resolve) => (entered = resolve))
    const pending = service.act(
      first.scope,
      { action: "click", pageId: first.pageId, ref: stale },
      new AbortController().signal,
      (active) => {
        if (active) entered()
      }
    )
    await waiting
    await service.giveBack(first.scope, lease.generation)
    const returned = JSON.parse(await pending)
    assert.ok(returned.content.includes("查看详情"))
    assert.equal(await first.page.locator("#result").textContent(), "订单 A")
    await assert.rejects(
      act(first.scope, { action: "click", pageId: first.pageId, ref: stale }),
      /引用已失效/
    )
    await act(first.scope, {
      action: "click",
      pageId: first.pageId,
      ref: ref(returned, "button", "查看详情", 1)
    })
    assert.equal(await first.page.locator("#result").textContent(), "订单 B")

    // Long snapshots can be read to their end without re-querying/changing the page.
    await first.page.setContent(
      Array.from({ length: 1800 }, (_, index) => `<p>记录 ${index} ${"内容".repeat(15)}</p>`).join(
        ""
      ) + "<button>末尾操作</button>"
    )
    snapshot = await act(first.scope, { action: "observe", pageId: first.pageId })
    assert.equal(snapshot.truncated, true)
    const initialCursor = snapshot.nextCursor
    const cursors = new Set()
    let text = snapshot.content
    while (snapshot.nextCursor) {
      assert.ok(!cursors.has(snapshot.nextCursor))
      cursors.add(snapshot.nextCursor)
      snapshot = await act(first.scope, {
        action: "observe",
        pageId: first.pageId,
        cursor: snapshot.nextCursor
      })
      text += snapshot.content
    }
    assert.ok(text.includes("记录 1799"))
    assert.ok(text.includes("末尾操作"))
    await assert.rejects(
      act(second.scope, { action: "observe", pageId: second.pageId, cursor: initialCursor }),
      /游标已失效|其他页面/
    )
    await act(first.scope, {
      action: "click",
      pageId: first.pageId,
      ref: ref(snapshot, "button", "末尾操作")
    })
    const beforeNavigation = ref(snapshot, "button", "末尾操作")
    await act(first.scope, { action: "navigate", pageId: first.pageId, url: fixtureUrl + "/next" })
    await assert.rejects(
      act(first.scope, { action: "click", pageId: first.pageId, ref: beforeNavigation }),
      /引用已失效/
    )
    console.log(
      "BOT_OWNED_AUTOMATION_PASS: duplicate labels, scoped refs, popups, iframe, forms, hover/drag, waiting, uploads/downloads, takeover and pagination"
    )
  } finally {
    for (const item of fixtures) await service.removeBot(item.scope)
  }
}
