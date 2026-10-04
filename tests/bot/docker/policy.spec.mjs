import test from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { RUNTIME } from "../../../deploy/dev/docker/host.mjs"
import { IMAGE_ID, LABEL, composeSpec } from "../../../deploy/dev/docker/compose.mjs"
import { SERVICE_IMAGES } from "../../../deploy/dev/docker/service-images.mjs"
import { validateContainer, validateNetwork, validateProject, cleanupTest } from "../../../deploy/dev/docker/lifecycle.mjs"

const entry = { project: "devclaw-bot-test-0123456789abcdef", role: "test", owner: "12345678-1234-1234-1234-123456789abc" }
entry.dir = join(RUNTIME, entry.project)
function container(service = "mysql") {
  const all = composeSpec({ ...entry, owner: entry.owner })
  const spec = all.services[service], portKey = `${spec.ports[0].target}/tcp`
  return {
    Image: service === "mysql" ? IMAGE_ID : SERVICE_IMAGES[service].digest,
    Config: { User: spec.user ?? "", Cmd: spec.command, Entrypoint: spec.entrypoint, Env: Object.entries(spec.environment).map(([k,v]) => `${k}=${v}`), Healthcheck: { Test: spec.healthcheck.test }, Labels: { ...spec.labels, "com.docker.compose.project": entry.project, "com.docker.compose.service": service } },
    HostConfig: { Privileged: false, NetworkMode: `${entry.project}-private`, Memory: Number.parseInt(spec.mem_limit) * 1048576, MemorySwap: Number.parseInt(spec.memswap_limit) * 1048576, NanoCpus: spec.cpus * 1000000000, PidsLimit: spec.pids_limit, LogConfig: { Type: "json-file", Config: spec.logging.options }, SecurityOpt: ["no-new-privileges:true"], CapDrop: ["NET_RAW"], PortBindings: { [portKey]: [{ HostIp: "127.0.0.1", HostPort: "0" }] } },
    Mounts: [
      ...spec.volumes.map((v) => v.type === "volume" ? { Type: "volume", Source: `/var/lib/docker/volumes/${all.volumes[v.source].name}/_data`, Destination: v.target, RW: true, Name: all.volumes[v.source].name } : { Type: "bind", Source: v.source, Destination: v.target, RW: !v.read_only }),
      ...spec.secrets.map((s) => ({ Type: "bind", Source: all.secrets[s.source].file, Destination: `/run/secrets/${s.target}`, RW: false }))
    ],
    NetworkSettings: { Ports: { [portKey]: [{ HostIp: "127.0.0.1", HostPort: "54321" }] }, Networks: { [`${entry.project}-private`]: {} } }
  }
}
test("exact loopback container with five exact mounts passes", () => assert.equal(validateContainer(container(), entry), 54321))
test("Docker canonical CAP_NET_RAW retains the exact capability-drop policy", () => {
  const c = container(); c.HostConfig.CapDrop = ["CAP_NET_RAW"]
  assert.equal(validateContainer(c, entry), 54321)
  c.HostConfig.CapDrop = ["CAP_SYS_ADMIN"]
  assert.throws(() => validateContainer(c, entry), /B00_CONTAINER_SECURITY/)
})
test("exact task bridge rejects internal/default/IPv6/extra options and foreign labels", () => {
  const spec = composeSpec({ ...entry })
  const network = { Name: `${entry.project}-private`, Driver: "bridge", Internal: false, EnableIPv6: false, Options: spec.networks.private.driver_opts, Labels: { ...spec.networks.private.labels, "com.docker.compose.project": entry.project } }
  validateNetwork(network, entry)
  for (const change of [{ Internal: true }, { Driver: "host" }, { EnableIPv6: true }, { Options: {} }, { Options: { ...network.Options, "unsafe": "true" } }, { Name: "bridge" }, { Labels: {} }]) assert.throws(() => validateNetwork({ ...network, ...change }, entry), /B00_(?:NETWORK_POLICY|RESOURCE_OWNER)/)
})
test("ES and S3 exact mounts, API-only ports, file credentials and network membership", () => {
  for (const service of ["es", "s3"]) {
    assert.equal(validateContainer(container(service), entry, service), 54321)
    for (const mutate of [(c) => { c.Mounts[1].Source = join(entry.dir, "foreign-secret") }, (c) => { c.NetworkSettings.Ports["9300/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "54322" }] }, (c) => { c.NetworkSettings.Networks.bridge = {} }, (c) => { c.Config.Env.push("ELASTIC_PASSWORD=unsafe") }, (c) => { c.HostConfig.CapAdd = ["CAP_SYS_ADMIN"] }]) {
      const c = container(service); mutate(c)
      assert.throws(() => validateContainer(c, entry, service), /B00_(?:CONTAINER_MOUNT|LOOPBACK|PRIVATE_NETWORK|CONTAINER_CONFIG|CONTAINER_SECURITY)/)
    }
  }
})
test("all published bindings are checked, including extra exposed ports", () => {
  for (const mutate of [
    (c) => { c.NetworkSettings.Ports["33060/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "54322" }] },
    (c) => { c.HostConfig.PortBindings["8080/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "54322" }] },
    (c) => { c.NetworkSettings.Ports["3306/tcp"][0].HostIp = "0.0.0.0" },
    (c) => { c.NetworkSettings.Ports["3306/tcp"].push({ HostIp: "::", HostPort: "54321" }) },
    (c) => { c.NetworkSettings.Ports["3306/tcp"][0].HostPort = "3306" }
  ]) {
    const c = container(); mutate(c); assert.throws(() => validateContainer(c, entry), /B00_LOOPBACK/)
  }
})
test("same-directory substitutions, RW/destination changes and extra mounts fail", () => {
  for (const mutate of [
    (c) => { c.Mounts[1].Source = join(entry.dir, "foreign.sql") },
    (c) => { c.Mounts[2].RW = true },
    (c) => { c.Mounts[3].Destination = "/foreign" },
    (c) => { c.Mounts.push({ Type: "bind", Source: entry.dir, Destination: "/host", RW: false }) },
    (c) => { c.Mounts[0].Source = "/var/lib/docker/volumes/foreign/_data" }
  ]) {
    const c = container(); mutate(c); assert.throws(() => validateContainer(c, entry), /B00_CONTAINER_MOUNT/)
  }
})
test("wrong image, foreign labels, privileged and host networking fail", () => {
  for (const mutate of [
    (c) => { c.Image = "mysql:8.0" },
    (c) => { c.Config.Labels[`${LABEL}.owner`] = "foreign" },
    (c) => { c.HostConfig.Privileged = true },
    (c) => { c.HostConfig.NetworkMode = "host" }
  ]) {
    const c = container(); mutate(c); assert.throws(() => validateContainer(c, entry), /B00_(?:CONTAINER_POLICY|RESOURCE_OWNER)/)
  }
})
test("cleanup rejects arbitrary entries, missing inode and noncanonical directories before daemon access", async () => {
  for (const fake of [entry, { ...entry, inode: { ino: 1, dev: 1 } }, { ...entry, dir: RUNTIME, inode: { ino: 1, dev: 1 } }, { ...entry, dir: join(entry.dir, ".."), inode: { ino: 1, dev: 1 } }]) {
    await assert.rejects(cleanupTest({}, fake), /B00_DIRECTORY_OWNER/)
  }
  await assert.rejects(cleanupTest({}, { ...entry, role: "dev" }), /B00_TEST_ONLY/)
  await assert.rejects(validateProject({ ...entry, dir: "/private/tmp/unowned" }), /B00_DIRECTORY_OWNER/)
})
