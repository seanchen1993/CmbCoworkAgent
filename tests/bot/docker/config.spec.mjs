import test from "node:test"
import assert from "node:assert/strict"
import { stringify } from "yaml"
import { vmSpec, validateVmText, rejectInherited, RUNTIME } from "../../../deploy/dev/docker/host.mjs"
import { composeSpec, MYSQL_IMAGE } from "../../../deploy/dev/docker/compose.mjs"

test("exact full private VM specification passes", () => {
  assert.deepEqual(validateVmText(stringify(vmSpec())), vmSpec())
})
test("Kubernetes enabled cannot hide behind unrelated enabled:false", () => {
  const spec = vmSpec(); spec.kubernetes.enabled = true; spec.unrelated = { enabled: false }
  assert.throws(() => validateVmText(stringify(spec)), /B00_VM_CONFIGURATION/)
})
test("extra HOME mount beyond the old 500-character window is rejected", () => {
  const text = stringify(vmSpec()).replace("    writable: false", `    writable: false\n${"# comment padding\n".repeat(40)}  - location: /Users/heyirui\n    writable: true`)
  assert.throws(() => validateVmText(text), /B00_VM_CONFIGURATION/)
})
test("duplicate keys, arbitrary provisioning, daemon hosts, and unknown fields fail", () => {
  assert.throws(() => validateVmText(stringify(vmSpec()) + "cpu: 2\n"), /B00_VM_CONFIGURATION/)
  for (const mutate of [(s) => { s.provision = [{ mode: "system", script: "unsafe" }] }, (s) => { s.docker = { hosts: ["tcp://0.0.0.0:2375"] } }, (s) => { s.custom = true }, (s) => { s.mounts = [] }, (s) => { s.forwardAgent = true }]) {
    const spec = vmSpec(); mutate(spec)
    assert.throws(() => validateVmText(stringify(spec)), /B00_VM_CONFIGURATION/)
  }
})
test("every inherited remote or alternate Docker/Colima override is rejected", () => {
  rejectInherited({})
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "COLIMA_HOME", "COLIMA_PROFILE", "LIMA_HOME", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    assert.throws(() => rejectInherited({ [key]: "untrusted" }), /B00_HOST_OVERRIDE/)
  }
})
test("Compose keeps secrets out of environment and limits the exact private resources", () => {
  const spec = composeSpec({ project: "devclaw-bot-dev", role: "dev", owner: "12345678-1234-1234-1234-123456789abc", dir: `${RUNTIME}/devclaw-bot-dev` })
  const mysql = spec.services.mysql
  assert.equal(mysql.image, MYSQL_IMAGE)
  assert.equal(mysql.platform, "linux/amd64")
  assert.equal(spec.networks.private.internal, false)
  assert.equal(spec.networks.private.driver, "bridge")
  assert.equal(spec.networks.private.enable_ipv6, false)
  assert.deepEqual(spec.networks.private.driver_opts, { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" })
  assert.deepEqual(mysql.ports, [{ target: 3306, published: "0", host_ip: "127.0.0.1", protocol: "tcp" }])
  assert.equal(mysql.environment.MYSQL_ROOT_HOST, "localhost")
  assert.equal(mysql.environment.MYSQL_ROOT_PASSWORD, undefined)
  assert.equal(mysql.environment.MYSQL_PASSWORD, undefined)
  assert.equal(mysql.privileged, undefined)
  assert.equal(mysql.network_mode, undefined)
  assert.equal(mysql.restart, "no")
  assert.equal(mysql.mem_limit, "768m")
  assert.equal(mysql.pids_limit, 128)
  assert.equal(JSON.stringify(spec).includes("docker.sock"), false)
})
test("three pinned services expose only their API with file credentials and bounded resources", () => {
  const spec = composeSpec({ project: "devclaw-bot-dev", role: "dev", owner: "12345678-1234-1234-1234-123456789abc", dir: `${RUNTIME}/devclaw-bot-dev` })
  assert.deepEqual(Object.keys(spec.services), ["mysql", "es", "s3"])
  assert.equal(Object.keys(spec.volumes).length, 3)
  for (const [service, target] of [["es", 9200], ["s3", 8333]]) {
    const s = spec.services[service]
    assert.match(s.image, /@sha256:[a-f0-9]{64}$/)
    assert.equal(s.platform, "linux/arm64")
    assert.deepEqual(s.ports, [{ target, published: "0", host_ip: "127.0.0.1", protocol: "tcp" }])
    assert.equal(s.restart, "no")
    assert.equal(s.mem_limit, s.memswap_limit)
    assert.equal(s.logging.options["max-size"], "5m")
    assert.deepEqual(s.networks, ["private"])
  }
  assert.equal(spec.services.es.environment["xpack.security.enabled"], "true")
  assert.equal(spec.services.es.environment["xpack.license.self_generated.type"], "basic")
  assert.equal(spec.services.es.environment.ELASTIC_PASSWORD, undefined)
  assert.equal(spec.services.es.environment.ELASTIC_PASSWORD_FILE, "/run/secrets/es-password")
  assert.equal(spec.services.s3.command.includes("-s3.iam=false"), true)
  assert.equal(spec.services.s3.command.includes("-master.telemetry=false"), true)
})
