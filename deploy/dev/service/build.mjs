import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { mkdir, lstat, readFile, writeFile, readdir } from "node:fs/promises"
import { randomUUID, createHash } from "node:crypto"
import { run } from "../process.mjs"

const root = fileURLToPath(new URL("../../../", import.meta.url)), project = join(root, "services/bot-control")
const base = join(homedir(), ".devclaw-bot-b01-a1")
const jdk = "/Users/heyirui/Library/Java/JavaVirtualMachines/corretto-1.8.0_482-1/Contents/Home"
const maven = "/Users/heyirui/.m2/wrapper/dists/apache-maven-3.9.6-bin/439sdfsg2nbdob9ciift5h5nse/apache-maven-3.9.6"
const settings = '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"><mirrors><mirror><id>b01-central-only</id><mirrorOf>*</mirrorOf><url>https://repo.maven.apache.org/maven2</url></mirror></mirrors></settings>\n'
const globalSettings = '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>\n'

async function directory(path) {
  try { await mkdir(path, { mode: 0o700 }) } catch (e) { if (e.code !== "EEXIST") throw e }
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) throw new Error("B01_PRIVATE_DIRECTORY")
}
async function exactFile(path, contents) {
  try { await writeFile(path, contents, { mode: 0o600, flag: "wx" }) } catch (e) { if (e.code !== "EEXIST") throw e }
  const s = await lstat(path)
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || await readFile(path, "utf8") !== contents) throw new Error("B01_PRIVATE_FILE")
}

export async function build() {
  await directory(base)
  const ownerFile = join(base, "owner.json")
  try { await writeFile(ownerFile, JSON.stringify({ kind: "devclaw-bot-b01-a1", id: randomUUID() }) + "\n", { mode: 0o600, flag: "wx" }) } catch (e) { if (e.code !== "EEXIST") throw e }
  const owner = JSON.parse(await readFile(ownerFile, "utf8"))
  if (owner.kind !== "devclaw-bot-b01-a1" || !/^[a-f0-9-]{36}$/.test(owner.id)) throw new Error("B01_BUILD_OWNER")
  await exactFile(ownerFile, JSON.stringify(owner) + "\n")
  for (const name of ["repository", "home", "tmp"]) await directory(join(base, name))
  await exactFile(join(base, "settings.xml"), settings)
  await exactFile(join(base, "global-settings.xml"), globalSettings)
  try { await lstat(join(project, ".mvn")); throw new Error("B01_MAVEN_EXTENSION") } catch (e) { if (e.code !== "ENOENT") throw e }
  if ((await readdir(join(maven, "lib/ext"))).some(name => name.endsWith(".jar"))) throw new Error("B01_MAVEN_EXTENSION")
  const env = { HOME: join(base, "home"), JAVA_HOME: jdk, PATH: `${jdk}/bin:/usr/bin:/bin`, TMPDIR: join(base, "tmp"), LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "UTC" }
  const java = join(jdk, "bin/java")
  // Direct Classworlds entry: never execute mvnrc, jvm.config, or inherited JVM/Maven options.
  const args = [`-Duser.home=${join(base, "home")}`, `-Djava.io.tmpdir=${join(base, "tmp")}`, `-Dmaven.home=${maven}`, `-Dmaven.conf=${join(maven, "conf")}`, `-Dmaven.multiModuleProjectDirectory=${project}`, `-Dclassworlds.conf=${join(maven, "bin/m2.conf")}`, "-cp", join(maven, "boot/plexus-classworlds-2.7.0.jar"), "org.codehaus.plexus.classworlds.launcher.Launcher"]
  const version = await run(java, [...args, "--version"], { cwd: project, env })
  if (!/Apache Maven 3\.9\.6/.test(version) || !/Java version: 1\.8\.0_482/.test(version)) throw new Error("B01_BUILD_TOOL_VERSION")
  console.log(JSON.stringify({ stage: "build", owner: owner.id, java: "1.8.0_482", maven: "3.9.6", repository: join(base, "repository"), central: "https://repo.maven.apache.org/maven2", timeoutMs: 600000 }))
  const output = await run(java, [...args, "-B", "-ntp", "-s", join(base, "settings.xml"), "-gs", join(base, "global-settings.xml"), `-Dmaven.repo.local=${join(base, "repository")}`, "-Dmaven.wagon.http.retryHandler.count=1", "-Dmaven.wagon.httpconnectionManager.ttlSeconds=30", "-Dmaven.wagon.rto=30000", "package", "dependency:tree", "-DoutputFile=target/dependency-tree.txt"], { cwd: project, env, timeoutMs: 600000, maxOutput: 1048576 })
  console.log(output)
  const jar = join(project, "target/bot-control-0.0.1-SNAPSHOT.jar")
  const packaged = await run(java, [`-Duser.home=${join(base, "home")}`, "-jar", jar], { cwd: project, env, timeoutMs: 30000 })
  if (!packaged.includes('"status":"verified"')) throw new Error("B01_PACKAGED_PROBE")
  console.log(packaged)
  console.log(JSON.stringify({ stage: "packaged", sha256: createHash("sha256").update(await readFile(jar)).digest("hex"), path: jar }))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await build() } catch (e) { console.error(JSON.stringify({ status: "failed", reason: /^B01_[A-Z0-9_]+$/.test(e.message) ? e.message : e.failureCode ?? "compatibility", exitCode: e.exitCode ?? 1 })); process.exitCode = 1 }
}
