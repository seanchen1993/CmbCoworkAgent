import { ownedProcess, run } from "../process.mjs"
import { appPassword, active, testResources } from "./test-database.mjs"
import { verifyListeners } from "../docker/lifecycle.mjs"
import { checkHttpFixture, readHttpIdentity } from "./http-fixture.mjs"

const modes = new Set(["production", "serve", "race-same", "race-cas", "partial-version", "partial-members", "before-receipt", "before-commit", "lost-response"])
const owned = new WeakMap(), children = new Set()
let starts = 0, secretSends = 0
export function httpChildFacts() { return { starts, secretSends, active: children.size } }
export function httpMode(mode) { if (!modes.has(mode)) throw Error("C2_SELECTION"); return mode !== "production" }
const handles=new Map()
export async function stopHttpChildren() { await Promise.all([...children].map(child => handles.get(child)?.stop() ?? child.stop())) }
async function listenerAbsent(port) {
  const child=ownedProcess("/usr/sbin/lsof",["-nP",`-iTCP:${port}`,"-sTCP:LISTEN","-Fpn"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TZ:"UTC"},maxOutput:4096})
  const timer=setTimeout(()=>{void child.stop()},5000);child.child.stdin.end()
  try { const result=await child.done; if(result.code!==1||result.stdout||result.stderr||result.overflow||result.spawnError)throw Error("C2_LISTENER_RESIDUE") }
  finally {clearTimeout(timer);await child.stop()}
}
async function ownListenerPorts(pid) {
  const child=ownedProcess("/usr/sbin/lsof",["-nP","-a","-p",String(pid),"-iTCP","-sTCP:LISTEN","-Fpn"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TZ:"UTC"},maxOutput:4096})
  const timer=setTimeout(()=>{void child.stop()},5000);child.child.stdin.end()
  try {
    const result=await child.done
    if(result.code===1&&!result.stdout&&!result.stderr)return []
    if(result.code!==0||result.stderr||result.overflow||result.spawnError)throw Error("C2_ENDPOINT_PROOF")
    const lines=result.stdout.trim().split("\n"),names=lines.filter(x=>x.startsWith("n"))
    if(lines.filter(x=>x.startsWith("p")).join()!==`p${pid}`||names.some(x=>!/^n127\.0\.0\.1:[0-9]+$/.test(x)))throw Error("C2_ENDPOINT_PROOF")
    return names.map(x=>Number(x.slice(x.lastIndexOf(":")+1)))
  }finally{clearTimeout(timer);await child.stop()}
}
export async function currentHttpDatabase(entry, signal) {
  active(signal); const current = await testResources(entry, signal, true); active(signal)
  if (!entry.container || !entry.port || current.containers.length !== 1 || current.containers[0].Id !== entry.container || !current.containers[0].State.Running || current.containers[0].State.Health?.Status !== "healthy" || current.port !== entry.port) throw Error("C2_DATABASE_PROOF")
  await verifyListeners(current.port); active(signal)
}
export async function proveHttpEndpoint(handle, signal) {
  active(signal); const owner = owned.get(handle); if (!owner || owner.child.exited || !Number.isInteger(owner.port) || owner.port <= 1024 || owner.port > 65535) throw Error("C2_ENDPOINT_PROOF")
  await currentHttpDatabase(owner.entry, signal); await checkHttpFixture(owner.fixture, signal); active(signal)
  try { process.kill(owner.child.child.pid, 0) } catch { throw Error("C2_ENDPOINT_PROOF") }
  const lines = (await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(owner.child.child.pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeoutMs: 5000, signal })).split("\n")
  if (lines.filter(x => x.startsWith("p")).join() !== `p${owner.child.child.pid}` || lines.filter(x => x.startsWith("n")).join() !== `n127.0.0.1:${owner.port}`) throw Error("C2_ENDPOINT_PROOF")
  active(signal); return { pid: owner.child.child.pid, port: owner.port }
}
export async function httpBearer(handle, principal, signal) {
  await proveHttpEndpoint(handle, signal)
  const identity = await readHttpIdentity(owned.get(handle).fixture, signal); active(signal)
  const bearer = identity.bearers.find(x => x.principalId === principal)
  if (!bearer) throw Error("C2_PRINCIPAL_SELECTION")
  await proveHttpEndpoint(handle, signal); active(signal)
  return bearer.token
}
export function assertHttpNoSecret(handle,bytes){
  const owner=owned.get(handle);if(!owner||!(Buffer.isBuffer(bytes)||typeof bytes==="string"))throw Error("C2_SECRET_PROOF")
  const text=Buffer.isBuffer(bytes)?bytes.toString("utf8"):bytes
  if(owner.secrets.some(value=>text.includes(value))||/jdbc:mysql:|SQLSyntaxErrorException|at com\.devclaw\.|HTTP_ERROR_INPUT_SENTINEL/.test(text))throw Error("C2_SECRET_LEAK")
}
export async function startHttpJava(runtime, entry, fixture, mode, signal) {
  const controlled = httpMode(mode); active(signal)
  await currentHttpDatabase(entry, signal); await checkHttpFixture(fixture, signal); active(signal)
  const password = await appPassword(entry, signal); active(signal)
  const identity = await readHttpIdentity(fixture, signal); active(signal)
  const input = JSON.stringify({ mode: "local-dev", http: { host: "127.0.0.1", port: 0 }, db: { mode: "local-dev", host: "127.0.0.1", port: entry.port, schema: "devclaw", user: "devclaw_app", password }, identity })
  if (Buffer.byteLength(input) > 65536) throw Error("C2_CONFIG_SIZE")
  await currentHttpDatabase(entry, signal); await checkHttpFixture(fixture, signal); active(signal)
  const main = `com.devclaw.botcontrol.http.${controlled ? "HttpTestMain" : "LocalHttpMain"}`
  const child = ownedProcess(runtime.java, ["-Xmx256m", "-Duser.timezone=UTC", "-cp", runtime.classpath, main, ...(controlled ? [mode] : [])], { cwd: runtime.dir, env: runtime.env, maxOutput: 65536 })
  starts++; children.add(child)
  const handle = {}, owner = { child, entry, fixture, port: null, secrets:[password,...identity.bearers.map(x=>x.token)] }; owned.set(handle, owner)
  const stop = () => { void child.stop() }
  signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop()
  let timedOut = false, released = new Set(), closing
  const lifetime = setTimeout(() => { timedOut = true; stop() }, 1200000)
  child.child.stdin.on("error", () => {})
  const done = child.done.finally(() => { clearTimeout(lifetime); signal?.removeEventListener("abort", stop) })
  function records() {
    if (child.output.length > 65536) throw Error("C2_JAVA_BOUNDARY")
    const lines = child.output.split("\n"); lines.pop()
    try { return lines.map(line => JSON.parse(line)) } catch { throw Error("C2_JAVA_BOUNDARY") }
  }
  async function stage(name, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      active(signal)
      const found = records().find(x => x.stage === name)
      if (found) return found
      if (child.exited || timedOut) throw Error("C2_JAVA_BOUNDARY")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw Error("C2_STAGE_TIMEOUT")
  }
  Object.assign(handle, {
    pid: child.child.pid, done, stage,
    getOutput: () => child.output,
    stop() {
      if(!closing)closing=(async()=>{
        let ports=[],proofFailed=false
        try{ports=await ownListenerPorts(child.child.pid)}catch{proofFailed=true}
        await child.stop();const result=await done
        try{process.kill(child.child.pid,0);throw Error("C2_JAVA_RESIDUE")}catch(error){if(error.code!=="ESRCH")throw error}
        for(const port of new Set([...ports,...(owner.port?[owner.port]:[])]))await listenerAbsent(port)
        children.delete(child);handles.delete(child)
        assertHttpNoSecret(handle,result.stdout);assertHttpNoSecret(handle,result.stderr)
        if(proofFailed||result.stderr||result.overflow||result.spawnError)throw Error("C2_JAVA_BOUNDARY")
      })()
      return closing
    },
    release(word) {
      active(signal)
      if (!controlled || !["go", "commit-go", "response-go"].includes(word) || released.has(word) || child.exited) throw Error("C2_CONTROL")
      released.add(word); child.child.stdin.write(word + "\n")
    }
  })
  Object.defineProperty(handle, "port", { get: () => owner.port })
  handles.set(child,handle)
  try {
    // Awaited secret/readiness checks may observe an OS cancellation: never send
    // the config if that happened, even if the abort listener was installed later.
    await currentHttpDatabase(entry, signal); await checkHttpFixture(fixture, signal); active(signal)
    secretSends++; if (controlled) child.child.stdin.write(input + "\n"); else child.child.stdin.end(input)
    const ready = await stage("http-ready", 30000)
    if (Object.keys(ready).sort().join() !== "port,stage" || !Number.isInteger(ready.port)) throw Error("C2_JAVA_BOUNDARY")
    owner.port = ready.port; await proveHttpEndpoint(handle, signal)
    return handle
  } catch (error) {
    // A ready record may precede failure/cancellation of its ownership proof.
    // Capture only the fixed, bounded port record for absence checking, never
    // credentials or a self-reported endpoint as authorization to connect.
    try{if(!owner.port){const ready=records().find(x=>x.stage==="http-ready");if(Number.isInteger(ready?.port)&&ready.port>1024&&ready.port<=65535)owner.port=ready.port}}catch{}
    await handle.stop();throw error
  }
}
