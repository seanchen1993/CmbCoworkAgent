import { join } from "node:path"
import { lstat, readFile } from "node:fs/promises"
import { hostState, daemon, docker, RUNTIME, privateDirectory, privateFile } from "../docker/host.mjs"
import { composeSpec, INIT_SQL } from "../docker/compose.mjs"
import { validateContainer, validateNetwork, verifyListeners } from "../docker/lifecycle.mjs"
import { stableMounts } from "./application-proof.mjs"
import { active } from "./test-database.mjs"

const check = x => { if (!x) throw Error("C2_RESOURCE_PROOF") }
// Original B00 checks remain the authority. Only marker/compose/static init are
// read; every original dev credential is metadata-only, never content.
export async function httpDevProof() {
  const state = await hostState(), identity = await daemon(state), entry = { project: "devclaw-bot-dev", role: "dev", owner: state.owner.id, dir: join(RUNTIME,"devclaw-bot-dev") }
  const dir = await privateDirectory(entry.dir)
  check(JSON.stringify(JSON.parse(await privateFile(join(entry.dir,"owner.json")))) === JSON.stringify({ project: entry.project, role: entry.role, owner: entry.owner }))
  check(await privateFile(join(entry.dir,"compose.json")) === JSON.stringify(composeSpec(entry),null,2) + "\n")
  for (const name of ["root-password","app-password","app-client.cnf","es-password","es-client.cnf","s3-client.json","s3-config.json","secret-hashes.json"]) {
    const s = await lstat(join(entry.dir,name)); check(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && s.nlink === 1 && (s.mode & 0o777) === 0o600)
  }
  const init = await lstat(join(entry.dir,"initialize.sql")); check(init.isFile() && !init.isSymbolicLink() && init.uid === process.getuid() && (init.mode & 0o777) === 0o644 && await readFile(join(entry.dir,"initialize.sql"),"utf8") === INIT_SQL)
  const ids = (await docker(state,["ps","-aq","--filter","label=com.docker.compose.project=devclaw-bot-dev"],{stdoutOnly:true})).split(/\s+/).filter(Boolean); check(ids.length === 3)
  const containers = JSON.parse(await docker(state,["inspect",...ids],{stdoutOnly:true})), services = {}
  for (const c of containers) {
    const service = c.Config.Labels["com.docker.compose.service"], port = validateContainer(c,entry,service)
    check(!services[service] && c.State.Running && c.State.Health?.Status === "healthy"); await verifyListeners(port)
    if (service === "mysql") check(c.Id === "693a1c3fd9c1aefc968a850f6187724b3b89864283a78cf9c44c52a015eeba3c")
    services[service] = { id:c.Id, port, image:c.Image, mounts:stableMounts(c.Mounts) }
  }
  check(Object.keys(services).sort().join() === "es,mysql,s3")
  const network = JSON.parse(await docker(state,["network","inspect","devclaw-bot-dev-private"],{stdoutOnly:true}))[0]; validateNetwork(network,entry,containers)
  return { daemon:identity.id, owner:state.owner.id, inode:dir.ino, network:network.Id, services:Object.fromEntries(Object.entries(services).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) }
}
export async function httpCapacity(signal) {
  active(signal); await httpDevProof(); active(signal)
  const state = await hostState(); await daemon(state); active(signal)
  const info = JSON.parse(await docker(state,["info","--format","{{json .}}"],{stdoutOnly:true,signal})), stats = (await docker(state,["stats","--no-stream","--format","{{json .}}"],{stdoutOnly:true,signal})).split("\n").filter(Boolean).map(JSON.parse)
  const bytes = text => { const m = /^([0-9.]+)([KMG]?i?B)$/.exec(text.trim()); check(m); const factor = {B:1,kB:1000,KB:1000,KiB:1024,MB:1e6,MiB:1048576,GB:1e9,GiB:1073741824}[m[2]]; check(factor); return Number(m[1]) * factor }
  const used = stats.reduce((sum,x) => sum + bytes(x.MemUsage.split("/")[0]),0)
  check(info.NCPU === 2 && info.MemTotal >= 4e9 && used + 805306368 + 536870912 < info.MemTotal); active(signal)
  return { stage:"http-capacity", daemon:info.ID, memoryBytes:info.MemTotal, usedContainerBytes:Math.ceil(used), extraDatabases:1 }
}
export async function httpAbsent(project) {
  check(/^devclaw-bot-test-[a-f0-9]{16}$/.test(project)); const state = await hostState(); await daemon(state)
  check(!(await docker(state,["ps","-aq","--filter",`label=com.docker.compose.project=${project}`],{stdoutOnly:true})))
  for (const [type,suffix] of [["network","private"],["volume","data"]]) check(!(await docker(state,[type,"ls","--format","{{.Name}}"],{stdoutOnly:true})).split("\n").includes(`${project}-${suffix}`))
  try { await lstat(join(RUNTIME,project)); throw Error("C2_RESOURCE_RESIDUE") } catch(error) { if(error.code !== "ENOENT") throw error }
}
