import test from "node:test"
import assert from "node:assert/strict"
import { readFile, access, stat, mkdtemp, rm, realpath } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { inspect } from "node:util"
import { ownedProcess, run, isolatedEnv, privateTemp, removePrivateTemp } from "../../../deploy/dev/process.mjs"
import { realProbe } from "../../../deploy/dev/mysql-probe.mjs"
import { probeFailure } from "../../../deploy/dev/probe-error.mjs"

const root = fileURLToPath(new URL("../../../", import.meta.url))
test("temporary directories require actual registered ownership, not a matching prefix", async () => {
  const foreign = await mkdtemp(join(await realpath("/tmp"), "dcb-f05-"))
  const owned = await privateTemp()
  try {
    await assert.rejects(removePrivateTemp(foreign), /unowned/)
    await access(foreign)
    assert.equal((await stat(owned)).mode & 0o777, 0o700)
    await removePrivateTemp(owned)
    await assert.rejects(access(owned))
    await assert.rejects(removePrivateTemp(owned), /unowned/)
  } finally { await rm(foreign, { recursive: true, force: true }) }
})
test("subprocess unavailable/failure/timeout never counts as success; env is isolated", async () => {
  const dir = await privateTemp()
  try {
    const env = isolatedEnv(dir)
    assert.equal(env.MYSQL_TEST_LOGIN_FILE, join(dir, "absent-login.cnf"))
    for (const key of ["MYSQL_PWD", "MYSQL_HOST", "MYSQL_TCP_PORT", "HOME", "OPENAI_API_KEY", "NODE_OPTIONS"]) assert.equal(Object.hasOwn(env, key), false)
    assert.equal(env.MAVEN_SKIP_RC, "1")
    await assert.rejects(run("/does-not-exist/f05", [], { cwd: dir, env }), /unavailable/)
    await assert.rejects(run(process.execPath, ["-e", "process.exit(3)"], { cwd: dir, env }), /exit 3/)
    await assert.rejects(run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { cwd: dir, env, timeoutMs: 100 }), /timeout/)
    const warning = 'process.stdout.write(JSON.stringify({sqlReady:true}));process.stderr.write("synthetic warning\\n")'
    assert.deepEqual(JSON.parse(await run(process.execPath, ["-e", warning], { cwd: dir, env, stdoutOnly: true })), { sqlReady: true })
    const noisy = ownedProcess(process.execPath, ["-e", 'process.stdout.write("a".repeat(100000));process.stderr.write("b".repeat(100000))'], { cwd: dir, env, maxOutput: 1024 })
    noisy.child.stdin.end()
    try {
      const result = await noisy.done
      assert.equal(result.overflow, true)
      for (const key of ["output", "stdout", "stderr"]) assert.ok(Buffer.byteLength(result[key]) <= 1024)
    } finally { await noisy.stop() }
  } finally { await removePrivateTemp(dir) }
})
test("raw full/truncated credential output never survives the reported Error object", async () => {
  const credential = "synthetic-only-credential-76f234bd"
  const prefix = credential.slice(0, 17)
  const original = Object.assign(new Error(`SQL password=${prefix}`), { childOutput: `failed SQL '${credential}' then '${prefix}'`, diagnostic: credential, failureCode: "exit", exitCode: 3, readiness: { ownedPidMatch: true, readyLog: false } })
  for (const phase of ["credential-bootstrap", "jdbc-probe", credential]) {
    const clean = probeFailure(original, phase)
    const rendered = [String(clean), inspect(clean), JSON.stringify(clean)].join("\n")
    assert.ok(!rendered.includes(credential) && !rendered.includes(prefix), "no full or partial credential in errors/logs")
    assert.equal(Object.hasOwn(clean, "childOutput"), false)
    assert.equal(Object.hasOwn(clean, "cause"), false)
  }
  const dir = await privateTemp()
  try {
    await assert.rejects(run(process.execPath, ["-e", 'process.stdin.on("data",chunk=>process.stderr.write(chunk));process.stdin.on("end",()=>process.exit(4))'], { cwd: dir, env: isolatedEnv(dir), input: credential }), (error) => {
      assert.equal(Object.hasOwn(error, "childOutput"), false)
      assert.ok(!inspect(error).includes(credential))
      return true
    })
  } finally { await removePrivateTemp(dir) }
})
test("compile failure cleans its actual private resource without starting a database", async () => {
  const resources = []
  await assert.rejects(realProbe({ profile: "dev", host: "127.0.0.1", s3: "disabled", es: "disabled" }, { javac: "/does-not-exist/f05-javac", java: process.execPath }, { onResource: (value) => resources.push(value) }), /unavailable/)
  assert.equal(resources.some((resource) => resource.pid), false)
  assert.equal(resources.at(-1).cleaned, true)
  await assert.rejects(access(resources[0].directory))
})
test("independent serve process: finite lifetime, SIGTERM, credential privacy, fresh restart and no leftovers", async () => {
  let old
  for (const mode of ["deadline", "signal"]) {
    const temp = await privateTemp()
    const child = ownedProcess(process.execPath, ["deploy/dev/cli.mjs", "serve", "--profile", "dev", "--lifetime-ms", mode === "deadline" ? "800" : "5000"], { cwd: root, env: isolatedEnv(temp) })
    child.child.stdin.end()
    let metadata, session
    try {
      const deadline = Date.now() + 3000
      while (!child.output.includes("\n") && !child.exited && Date.now() < deadline) await delay(10)
      metadata = JSON.parse(child.output.split("\n")[0])
      session = JSON.parse(await readFile(metadata.sessionFile, "utf8"))
      assert.equal((await stat(metadata.directory)).mode & 0o777, 0o700)
      assert.equal((await stat(metadata.sessionFile)).mode & 0o777, 0o600)
      assert.ok(!child.output.includes(session.credentials.alice), "stdout excludes test credentials")
      if (old) assert.ok(old !== session.credentials.alice, "fresh process credentials rotate (values withheld)")
      old = session.credentials.alice
      const response = await fetch(session.url + "/dev/v1/session", { headers: { Authorization: `Bearer ${session.credentials.alice}` }, signal: AbortSignal.timeout(1000) })
      assert.equal(response.status, 200)
      if (mode === "signal") await child.stop()
      else {
        const timeout = setTimeout(() => child.child.kill("SIGKILL"), 3000)
        try { assert.equal((await child.done).code, 0) } finally { clearTimeout(timeout) }
      }
      await assert.rejects(access(metadata.directory))
      await assert.rejects(fetch(session.url + "/dev/v1/session", { signal: AbortSignal.timeout(1000) }))
    } finally { await child.stop(); await removePrivateTemp(temp) }
  }
})
