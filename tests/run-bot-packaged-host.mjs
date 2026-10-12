// Exercise the shipped runtime and Host, reusing the native recovery contracts.
// Models, databases and process kills are confined to the existing test fixtures.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const supplied = process.argv[2]
if (!supplied)
  throw new Error("Usage: node tests/run-bot-packaged-host.mjs <packaged app directory>")
const app = realpathSync(supplied)
const mac = process.platform === "darwin"
const resources = realpathSync(join(app, mac ? "Contents/Resources" : "resources"))
const runtime = realpathSync(
  join(
    app,
    mac
      ? "Contents/MacOS/CMBDevClaw"
      : process.platform === "win32"
        ? "CMBDevClaw.exe"
        : "cmbdevclaw"
  )
)
const host = realpathSync(join(resources, "app.asar.unpacked/out/main/bot-host.js"))
for (const [parent, child] of [
  [app, resources],
  [app, runtime],
  [resources, host]
]) {
  const childPath = relative(parent, child)
  if (!childPath || isAbsolute(childPath) || childPath === ".." || childPath.startsWith(`..${sep}`))
    throw new Error("Packaged runtime and Host must belong to this application")
}
if (!existsSync(join(resources, "app.asar")))
  throw new Error("Missing packaged application archive")
if (mac) {
  // Use the application's public ASAR module path, as Main does. Requiring
  // node-pty from app.asar.unpacked rewrites its helper path a second time.
  const nativeCheck = spawnSync(
    runtime,
    [
      "-e",
      `const req=require('node:module').createRequire(process.argv[1]+'/package.json');
const canvas=req('@napi-rs/canvas').createCanvas(20,20);
if(canvas.toBuffer('image/png').length<50)throw Error('Packaged canvas produced no PNG');
const child=req('node-pty').spawn('/usr/bin/printf',['PACKAGED_PTY_OK'],{
  name:'xterm-color',cols:80,rows:24,cwd:process.cwd(),env:{PATH:'/usr/bin:/bin'}
});
let output='';
const timer=setTimeout(()=>{child.kill();throw Error('Packaged PTY timed out')},10000);
child.onData(value=>output+=value);
child.onExit(({exitCode})=>{
  clearTimeout(timer);
  if(exitCode!==0||output!=='PACKAGED_PTY_OK')throw Error('Packaged PTY output mismatch');
  console.log('PACKAGED_NATIVE_MODULES_OK');
});`,
      join(resources, "app.asar")
    ],
    {
      cwd: tmpdir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    }
  )
  if (nativeCheck.error) throw nativeCheck.error
  if (nativeCheck.status !== 0 || nativeCheck.stdout.trim() !== "PACKAGED_NATIVE_MODULES_OK")
    throw new Error(`Packaged native modules failed: ${nativeCheck.stderr.slice(-2000)}`)
  console.log("Packaged canvas rendering and terminal startup passed")
}
const cases = [
  "retains the model binding across compiled Host SIGKILL",
  "resumes a persisted graph after SIGKILL and review without repeating a committed tool",
  "keeps the compiled Host alive after desktop connections close"
]
const directory = mkdtempSync(join(tmpdir(), "bot-packaged-host-report-"))
const report = join(directory, "results.json")
try {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/main/bots/host-process.test.ts",
      "-t",
      cases.join("|"),
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CMB_BOT_PROCESS_TEST: "1",
        CMB_BOT_NODE: runtime,
        CMB_BOT_COMPILED_HOST_ENTRY: host
      },
      stdio: "inherit",
      windowsHide: true
    }
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
  if (result.status === 0) {
    const results = JSON.parse(readFileSync(report, "utf8"))
    if (results.numPassedTests !== 4 || results.numFailedTests !== 0)
      throw new Error("All four packaged Host recovery checks must run and pass")
    console.log(
      JSON.stringify({
        kind: "packaged-host-recovery",
        app,
        runtime,
        host,
        hostSha256: createHash("sha256").update(readFileSync(host)).digest("hex"),
        passed: results.numPassedTests,
        realModelTest: false
      })
    )
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
