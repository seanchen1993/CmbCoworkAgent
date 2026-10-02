import test from "node:test"
import assert from "node:assert/strict"
import { validateConfig, parseArgs, configFromOptions } from "../../../deploy/dev/config.mjs"
import { doctor } from "../../../deploy/dev/doctor.mjs"

const valid = { profile: "dev", host: "127.0.0.1", s3: "disabled", es: "disabled" }
test("explicit dev profile, literal loopback and disabled real infrastructure", async () => {
  assert.deepEqual(validateConfig(valid), valid)
  for (const config of [ {}, { ...valid, profile: undefined }, { ...valid, profile: "prod" }, { ...valid, profile: "unknown" }, ...["localhost", "0.0.0.0", "::1"].map((host) => ({ ...valid, host })), { ...valid, s3: "real" }, { ...valid, es: "real" }, { ...valid, token: "forged" } ]) assert.throws(() => validateConfig(config))
  await assert.rejects(configFromOptions({}))
  assert.deepEqual(await configFromOptions({ profile: "dev" }), valid)
})
test("CLI rejects unknown/missing/duplicate options and implicit modes", () => {
  assert.deepEqual(parseArgs(["mock", "--profile", "dev"]), { command: "mock", options: { profile: "dev" } })
  for (const args of [[], ["prod"], ["mock", "--profile"], ["mock", "--host", "0.0.0.0"], ["mock", "--profile", "dev", "--profile", "dev"]]) assert.throws(() => parseArgs(args))
})
test("missing real tools are unavailable and failure, never skip/pass", async () => {
  const report = await doctor(valid, {})
  assert.equal(report.ok, false)
  for (const name of ["java", "javac", "mysql", "mysqld", "jdbc"]) assert.equal(report[name].status, "unavailable")
  assert.equal(report.s3.status, "disabled")
  assert.equal(report.model.status, "mock")
})
