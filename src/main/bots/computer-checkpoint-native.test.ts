import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, expect, it } from "vitest"
import { BotHostLock } from "./host-lock"
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})
it("ends an actual active SQLite writer thread with its SIGKILLed coordinator before another owner can reuse the stage", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-sqlite-lifetime-")))
  roots.push(root)
  const nonce = randomUUID(),
    stage = join(root, "computer-recovery", "points", `.pending-${nonce}`, "data"),
    worker = join(root, "active-sqlite-worker.cjs"),
    database = join(stage, "bots.sqlite")
  await mkdir(stage, { recursive: true })
  // Use the production ComputerNativeSQLite bridge/lifetime and a deterministic
  // native SQLite writer fixture. This keeps a real connection actively writing
  // while the owner dies; the other suite exercises the shipped VACUUM/fence.
  await writeFile(
    worker,
    `const {workerData}=require("node:worker_threads"); const {DatabaseSync}=require("node:sqlite"); const {join}=require("node:path");
const path=join(workerData.directory,"computer-recovery","points",".pending-"+workerData.nonce,"data","bots.sqlite");
const db=new DatabaseSync(path); db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE writes(id INTEGER PRIMARY KEY,bytes BLOB)");
const sleep=new Int32Array(new SharedArrayBuffer(4)); for(let i=0;i<1000;i++){db.prepare("INSERT INTO writes VALUES(?,zeroblob(8192))").run(i); Atomics.wait(sleep,0,0,20)} db.close();`
  )
  const native = pathToFileURL(resolve("src/main/bots/computer-checkpoint-native.ts")).href,
    locks = pathToFileURL(resolve("src/main/bots/host-lock.ts")).href,
    source = `const nm=await import(${JSON.stringify(native)}), lm=await import(${JSON.stringify(locks)}); const {ComputerNativeSQLite}=nm.default??nm, {BotHostLock}=lm.default??lm;
const lock=BotHostLock.acquire(${JSON.stringify(root)}); if(!lock)process.exit(2);
const owner={assertCurrent:()=>lock.assertCurrent(),checkCurrent:()=>lock.checkCurrent(),identity:()=>lock.recoveryOwnershipIdentity()};
const bridge=new ComputerNativeSQLite(${JSON.stringify(root)},owner,new AbortController().signal,()=>process.exit(3),()=>{},${JSON.stringify(worker)});
await bridge.capture(${JSON.stringify(nonce)},20*1024**3); lock.release();`,
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      stdio: ["ignore", "ignore", "pipe"]
    }),
    errors: Buffer[] = [],
    completed = once(child, "close")
  child.stderr!.on("data", (bytes) => errors.push(bytes))
  void completed.catch(() => {})
  try {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (((await stat(database).catch(() => undefined))?.size ?? 0) >= 20_000) break
      if (child.exitCode !== null) throw new Error(Buffer.concat(errors).toString())
      await delay(5)
    }
    expect((await stat(database)).size, Buffer.concat(errors).toString()).toBeGreaterThanOrEqual(
      20_000
    )
    child.kill("SIGKILL")
    await completed
    const lock = BotHostLock.acquire(root)
    expect(lock).not.toBeNull()
    try {
      const digest = () =>
          readFile(database).then((bytes) => createHash("sha256").update(bytes).digest("hex")),
        before = await digest()
      await delay(250)
      expect(await digest()).toBe(before)
      // No standalone SQLite child remains to mutate this same stage after its
      // lifetime lock has been acquired by a different process/owner.
    } finally {
      lock?.release()
    }
  } finally {
    child.kill("SIGKILL")
    await completed
  }
}, 15_000)
