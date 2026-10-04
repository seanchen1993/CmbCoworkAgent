import test from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { RUNTIME } from "../../../deploy/dev/docker/host.mjs"
import { IMAGE_ID, LABEL } from "../../../deploy/dev/docker/compose.mjs"
import { validateContainer, validateProject, cleanupTest } from "../../../deploy/dev/docker/lifecycle.mjs"

const entry = { project: "devclaw-bot-test-0123456789abcdef", role: "test", owner: "12345678-1234-1234-1234-123456789abc" }
entry.dir = join(RUNTIME, entry.project)
function container() {
  return {
    Image: IMAGE_ID,
    Config: { Labels: { [`${LABEL}.owner`]: entry.owner, [`${LABEL}.project`]: entry.project, [`${LABEL}.role`]: entry.role, "com.docker.compose.project": entry.project } },
    HostConfig: { Privileged: false, NetworkMode: `${entry.project}-private`, Memory: 805306368, MemorySwap: 805306368, NanoCpus: 1000000000, PidsLimit: 128, LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } }, SecurityOpt: ["no-new-privileges:true"], CapDrop: ["NET_RAW"], PortBindings: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
    Mounts: [
      { Type: "volume", Source: `/var/lib/docker/volumes/${entry.project}-data/_data`, Destination: "/var/lib/mysql", RW: true, Name: `${entry.project}-data` },
      { Type: "bind", Source: join(entry.dir, "initialize.sql"), Destination: "/docker-entrypoint-initdb.d/10-limited-account.sql", RW: false },
      { Type: "bind", Source: join(entry.dir, "root-password"), Destination: "/run/secrets/root-password", RW: false },
      { Type: "bind", Source: join(entry.dir, "app-password"), Destination: "/run/secrets/app-password", RW: false },
      { Type: "bind", Source: join(entry.dir, "app-client.cnf"), Destination: "/run/secrets/app-client", RW: false }
    ],
    NetworkSettings: { Ports: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "54321" }], "33060/tcp": null }, Networks: { [`${entry.project}-private`]: {} } }
  }
}
test("exact loopback container with five exact mounts passes", () => assert.equal(validateContainer(container(), entry), 54321))
test("Docker canonical CAP_NET_RAW retains the exact capability-drop policy", () => {
  const c = container(); c.HostConfig.CapDrop = ["CAP_NET_RAW"]
  assert.equal(validateContainer(c, entry), 54321)
  c.HostConfig.CapDrop = ["CAP_SYS_ADMIN"]
  assert.throws(() => validateContainer(c, entry), /B00_CONTAINER_SECURITY/)
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
