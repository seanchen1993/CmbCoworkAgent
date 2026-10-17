/** Run after CMB_BOTS_E2E=1 npm run build. Uses only isolated test profiles and local fixture pages. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"

async function main() {
  const require = createRequire(__filename)
  const root = await mkdtemp(join(tmpdir(), "cmb-bot-native-host-"))
  const fixture = join(root, "parent.cjs")
  const fixtureHtml = `<title>Bot browser fixture</title><label>Name <input></label><label>Upload <input type="file"></label><a href="/download" download>Download</a><button onclick="document.querySelector('#answer').textContent = confirm('Synthetic confirmation') ? 'accepted' : 'dismissed'">Confirm</button><span id="answer"></span>`
  await writeFile(
    fixture,
    `
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
app.setPath('userData', ${JSON.stringify(join(root, "parent-profile"))});
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { startElectronBotBrowser, BotBrowserService } = require(${JSON.stringify(resolve("out/main/bots-browser-e2e.js"))});
  let engine;
  const workspace = bot => path.join(${JSON.stringify(root)}, 'workspaces', bot);
  await fs.mkdir(workspace('a'), { recursive: true });
  await fs.writeFile(path.join(workspace('a'), 'upload.txt'), 'synthetic upload');
  const server = http.createServer((req, res) => {
    if (req.url === '/download') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="result.txt"' });
      res.end('synthetic download');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(${JSON.stringify(fixtureHtml)});
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = 'http://127.0.0.1:' + server.address().port;
  const service = new BotBrowserService(async () => engine = await startElectronBotBrowser(${JSON.stringify(join(root, "bot-profile"))}), workspace);
  try {
    const a = JSON.parse(await service.act('a', { action: 'observe' }, new AbortController().signal));
    const b = JSON.parse(await service.act('b', { action: 'observe' }, new AbortController().signal));
    assert.notEqual(a.pageId, b.pageId);
    const pages = engine.context.pages();
    assert.equal(pages.length, 2);
    await pages[0].setContent('<label>Name <input></label>');
    await pages[1].setContent('<label>Name <input></label>');
    await service.act('a', { action: 'fill', role: 'textbox', name: 'Name', text: 'original Electron 引擎' }, new AbortController().signal);
    assert.equal(await pages[0].getByLabel('Name').inputValue(), 'original Electron 引擎');
    assert.equal(await pages[1].getByLabel('Name').inputValue(), '');
    await service.act('a', { action: 'navigate', url: fixtureUrl }, new AbortController().signal);
    const uploaded = JSON.parse(await service.act('a', { action: 'upload', name: 'Upload', fileId: 'upload.txt' }, new AbortController().signal));
    assert.deepEqual(uploaded.upload, { filename: 'upload.txt', state: 'attached' });
    assert.equal(await pages[0].getByLabel('Upload').evaluate(input => input.files[0].name), 'upload.txt');
    const dialog = JSON.parse(await service.act('a', { action: 'click', role: 'button', name: 'Confirm' }, new AbortController().signal));
    assert.equal(dialog.dialog.message, 'Synthetic confirmation');
    const dialogPreview = await service.preview('a', a.pageId);
    assert.equal(dialogPreview.pages.find(page => page.id === a.pageId).title, 'Bot browser fixture');
    assert.equal(dialogPreview.image, null);
    assert.equal(dialogPreview.dialogPending, true);
    await service.act('a', { action: 'dialog', accept: true }, new AbortController().signal);
    assert.equal((await service.preview('a')).dialogPending, false);
    assert.equal(await pages[0].locator('#answer').textContent(), 'accepted');
    await service.act('a', { action: 'click', role: 'link', name: 'Download' }, new AbortController().signal);
    let download;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      download = JSON.parse(await service.act('a', { action: 'observe' }, new AbortController().signal)).downloads.find(item => item.state === 'saved');
      if (download) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(download, 'download must finish inside the Bot workspace');
    assert.equal(await fs.readFile(path.join(workspace('a'), download.file), 'utf8'), 'synthetic download');
    const screenshot = await service.preview('a');
    assert.ok(screenshot.image.startsWith('data:image/jpeg;base64,'));
    await service.takeOver('a');
    assert.equal((await service.preview('a')).control, 'human');
    await service.navigateAsHuman('a', a.pageId, fixtureUrl + '/manual');
    await service.giveBack('a');
    assert.equal((await service.preview('a')).control, 'bot');
    let helpStarted;
    const waitingForHelp = new Promise(resolve => helpStarted = resolve);
    const help = service.act('a', { action: 'request_help', pageId: a.pageId, instruction: 'Confirm the synthetic page' }, new AbortController().signal, waiting => { if (waiting) helpStarted(); });
    await waitingForHelp;
    const helpState = await service.preview('a');
    assert.equal(helpState.helpInstruction, 'Confirm the synthetic page');
    assert.equal(helpState.control, 'human');
    await service.takeOver('a', a.pageId);
    assert.equal((await service.preview('a')).generation, helpState.generation);
    assert.equal((await service.preview('a')).helpInstruction, 'Confirm the synthetic page');
    await service.navigateAsHuman('a', a.pageId, fixtureUrl + '/help-confirmed');
    await service.giveBack('a', helpState.generation);
    assert.equal(JSON.parse(await help).url, fixtureUrl + '/help-confirmed');
    await service.close();
    const restarted = await startElectronBotBrowser(${JSON.stringify(join(root, "bot-profile"))});
    await restarted.createPage();
    await restarted.close();
    await new Promise(resolve => server.close(resolve));
    console.log('BOT_NATIVE_HOST_PASS');
    app.exit(0);
  } catch(error) { console.error(error); await service.close(); server.close(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
`
  )
  try {
    const child = spawn(require("electron"), [fixture], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" }
    })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-16_000)
    })
    child.stderr.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-16_000)
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once("close", done)
        child.once("error", reject)
      })
      assert.equal(code, 0, output)
      assert.ok(output.includes("BOT_NATIVE_HOST_PASS"), output)
      console.log(
        "PASS: production Bot browser adapter starts the bundled Electron host, binds exact pages, captures previews, shows/hides takeover, and releases its profile for restart."
      )
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
