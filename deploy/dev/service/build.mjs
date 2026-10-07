import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { mkdir, lstat, readFile, writeFile, readdir } from "node:fs/promises"
import { randomUUID, createHash } from "node:crypto"
import { run, privateTemp, removePrivateTemp } from "../process.mjs"
import { prepareContracts } from "./prepare-contracts.mjs"
import { compareParity } from "./compare-parity.mjs"

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
  if (await readPrivate(path) !== contents) throw new Error("B01_PRIVATE_FILE")
}
async function readPrivate(path) {
  const s = await lstat(path)
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600) throw new Error("B01_PRIVATE_FILE")
  return readFile(path, "utf8")
}

export async function build() {
  // Check-only: a build must never regenerate DTOs and conceal committed drift.
  console.log(await run(process.execPath, [join(root, "scripts/generate-bot-java-contracts.mjs"), "--check"], { cwd: root }))
  await prepareContracts()
  await directory(base)
  const ownerFile = join(base, "owner.json")
  try { await writeFile(ownerFile, JSON.stringify({ kind: "devclaw-bot-b01-a1", id: randomUUID() }) + "\n", { mode: 0o600, flag: "wx" }) } catch (e) { if (e.code !== "EEXIST") throw e }
  const owner = JSON.parse(await readPrivate(ownerFile))
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
  await compareParity()
  const jar = join(project, "target/bot-control-0.0.1-SNAPSHOT.jar")
  const packaged = await run(java, [`-Duser.home=${join(base, "home")}`, "-jar", jar], { cwd: project, env, timeoutMs: 30000 })
  if (!packaged.includes('"status":"verified"')) throw new Error("B01_PACKAGED_PROBE")
  console.log(packaged)
  console.log(JSON.stringify({ stage: "packaged", sha256: createHash("sha256").update(await readFile(jar)).digest("hex"), path: jar }))
  await audit()
}

export async function audit() {
  const jar = join(project, "target/bot-control-0.0.1-SNAPSHOT.jar"), temp = await privateTemp()
  const env = { HOME: join(base, "home"), JAVA_HOME: jdk, PATH: `${jdk}/bin:/usr/bin:/bin`, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "UTC" }
  try {
    const contents = (await run(join(jdk, "bin/jar"), ["tf", jar], { env, cwd: temp })).split("\n")
    const libraries = contents.filter(name => /^BOOT-INF\/lib\/[^/]+\.jar$/.test(name)).map(name => name.slice("BOOT-INF/lib/".length)).sort()
    const required = ["spring-boot-2.7.18.jar", "spring-boot-autoconfigure-2.7.18.jar", "spring-webmvc-5.3.31.jar", "spring-jdbc-5.3.31.jar", "HikariCP-4.0.3.jar", "mysql-connector-j-8.0.33.jar", "flyway-core-7.15.0.jar", "json-schema-validator-1.5.9.jar", "jackson-core-2.18.3.jar", "jackson-annotations-2.18.3.jar", "jackson-databind-2.18.3.jar", "slf4j-api-2.0.17.jar", "log4j-api-2.25.3.jar", "log4j-core-2.25.3.jar", "log4j-slf4j2-impl-2.25.3.jar"]
    if (libraries.some(name => name.startsWith("flyway-") && name !== "flyway-core-7.15.0.jar")) throw new Error("B01_PACKAGED_DEPENDENCIES")
    if (required.some(name => libraries.filter(value => value === name).length !== 1) || libraries.some(name => /logback|log4j-to-slf4j|slf4j-(?:simple|jdk14|log4j12|reload4j)|spring-boot-starter-logging|slf4j-api-1\./.test(name))) throw new Error("B01_PACKAGED_DEPENDENCIES")
    const classes = contents.filter(name => /^BOOT-INF\/classes\/.+\.class$/.test(name))
    if (classes.length < 2) throw new Error("B01_PACKAGED_CLASSES")
    const resources = ["schemas.json", "openapi.json", "state-transitions.json", "manifest.json"].map(file => `BOOT-INF/classes/contracts/bot/v1/${file}`)
    if (resources.some(name => contents.filter(value => value === name).length !== 1)) throw new Error("B01_PACKAGED_SCHEMA_RESOURCES")
    const migrationResource = "BOOT-INF/classes/db/bot-migration/V1__bot_group_storage.sql"
    const taskMigration = "BOOT-INF/classes/db/bot-migration/V2__task_collaboration.sql"
    if (contents.filter(name => name.startsWith("BOOT-INF/classes/db/bot-migration/") && name.endsWith(".sql")).sort().join() !== [migrationResource, taskMigration].sort().join()) throw new Error("B01_PACKAGED_MIGRATIONS")
    await run(join(jdk, "bin/jar"), ["xf", jar, ...classes, ...resources, migrationResource, taskMigration, "BOOT-INF/classes/log4j2.xml"], { env, cwd: temp })
    const taskMigrationBytes = await readFile(join(temp, taskMigration))
    if (!taskMigrationBytes.equals(await readFile(join(project, "src/main/resources/db/bot-migration/V2__task_collaboration.sql")))) throw new Error("B02_PACKAGED_MIGRATIONS")
    const migrationBytes = await readFile(join(temp, migrationResource))
    if (!migrationBytes.equals(await readFile(join(project, "src/main/resources/db/bot-migration/V1__bot_group_storage.sql"))) || !(await readFile(join(temp, "BOOT-INF/classes/log4j2.xml"))).equals(await readFile(join(project, "src/main/resources/log4j2.xml")))) throw new Error("B01_PACKAGED_MIGRATIONS")
    const manifest = JSON.parse(await readFile(join(temp, resources[3]), "utf8")), sourceHashes = {}
    if (!(await readFile(join(temp, resources[3]))).equals(await readFile(join(project, "target/generated-resources/contracts/bot/v1/manifest.json")))) throw new Error("B01_PACKAGED_SCHEMA_RESOURCES")
    for (const name of resources.slice(0, 3)) {
      const file = name.slice(name.lastIndexOf("/") + 1), bytes = await readFile(join(temp, name))
      sourceHashes[file] = createHash("sha256").update(bytes).digest("hex")
      if (!bytes.equals(await readFile(join(root, "contracts/bot/v1", file))) || manifest.hashes[file] !== sourceHashes[file]) throw new Error("B01_PACKAGED_SCHEMA_RESOURCES")
    }
    for (const name of classes) {
      const bytes = await readFile(join(temp, name))
      if (bytes.readUInt32BE(0) !== 0xcafebabe || bytes.readUInt16BE(6) !== 52) throw new Error("B01_CLASS_MAJOR")
    }
    const suites = { CompatibilityTest: 4, ContractConsumptionTest: 5, "validation.BoundaryTest": 6, "persistence.PersistenceBoundaryTest": 5 }
    suites["application.ApplicationUnitTest"] = 5
    suites["http.HttpBoundaryTest"] = 7
    suites["application.TaskUnitTest"] = 3
    suites["http.TaskHttpBoundaryTest"] = 1
    let tests = 0
    for (const [name, count] of Object.entries(suites)) {
      const xml = await readFile(join(project, `target/surefire-reports/TEST-com.devclaw.botcontrol.${name}.xml`), "utf8")
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? ""
      for (const [field, value] of [["tests", String(count)], ["failures", "0"], ["errors", "0"], ["skipped", "0"]]) if (!suite.includes(`${field}="${value}"`)) throw new Error("B01_TEST_RESULT")
      tests += count
    }
    const tree = await readFile(join(project, "target/dependency-tree.txt"), "utf8")
    console.log(JSON.stringify({ stage: "artifact-audit", classMajor: 52, classes, libraries, sourceHashes, migrationSha256: createHash("sha256").update(migrationBytes).digest("hex"), taskMigrationSha256: createHash("sha256").update(taskMigrationBytes).digest("hex"), suites, tests, failures: 0, errors: 0, skipped: 0, treeSha256: createHash("sha256").update(tree).digest("hex"), jarSha256: createHash("sha256").update(await readFile(jar)).digest("hex") }))
  } finally { await removePrivateTemp(temp) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length === 2) await build(); else if (process.argv.length === 3 && process.argv[2] === "--audit-only") await audit(); else throw new Error("B01_BUILD_ARGUMENTS") } catch (e) { console.error(JSON.stringify({ status: "failed", reason: /^B01_[A-Z0-9_]+$/.test(e.message) ? e.message : e.failureCode ?? "compatibility", exitCode: e.exitCode ?? 1 })); process.exitCode = 1 }
}
