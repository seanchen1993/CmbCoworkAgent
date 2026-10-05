// Fixed-path, content-free bind permission diagnosis; never print credentials.
import { hostState } from "../../../deploy/dev/docker/host.mjs"
import { prepareProject, compose, cleanupTest } from "../../../deploy/dev/docker/lifecycle.mjs"

const state = await hostState(), entry = await prepareProject(state, { test: true })
console.log(JSON.stringify({ stage: "claimed", project: entry.project }))
try {
  for (const [service, files] of [["s3", ["/run/secrets/s3-config"]], ["es", ["/run/secrets/es-password", "/run/secrets/es-client"]]]) {
    const paths = ["/", "/run", "/run/secrets", ...files]
    const script = paths.map(p => `stat -c '${p} %u:%g:%a:%F' '${p}'`).join("; ")
    const metadata = await compose(state, entry, ["run", "--rm", "--no-deps", "--user", "0:0", "--entrypoint", "/bin/sh", service, "-c", `set -eu; ${script}`], { timeoutMs: 30000, stdoutOnly: true })
    // Only accept the exact known paths, integer metadata and fixed file types.
    if (!metadata.split("\n").every(line => paths.some(p => line.startsWith(`${p} `)) && /^\S+ \d+:\d+:[0-7]{3,4}:(?:directory|regular file)$/.test(line))) throw new Error("B00_METADATA_OUTPUT")
    console.log(JSON.stringify({ service, metadata: metadata.split("\n") }))
    for (const file of files) for (const gid of [0, process.getuid()]) {
      const result = await compose(state, entry, ["run", "--rm", "--no-deps", "--user", `${process.getuid()}:${gid}`, "--entrypoint", "/bin/sh", service, "-c", `set -eu; id -u; id -g; stat -c '%u:%g:%a' '${file}'; test -x /run && test -x /run/secrets && echo traversable || echo blocked; test -r '${file}' && echo readable || echo unreadable; if dd if='${file}' of=/dev/null 2>/dev/null; then echo open-read-ok; else echo open-read-failed; fi`], { timeoutMs: 30000, stdoutOnly: true })
      const [uid, actualGid, stat, traversal, readable, openRead] = result.split("\n")
      if (uid !== String(process.getuid()) || actualGid !== String(gid) || !/^\d+:\d+:[0-7]{3,4}$/.test(stat) || !["traversable", "blocked"].includes(traversal) || !["readable", "unreadable"].includes(readable) || !["open-read-ok", "open-read-failed"].includes(openRead)) throw new Error("B00_METADATA_OUTPUT")
      console.log(JSON.stringify({ service, file, uid: Number(uid), gid, stat, traversal, readable, openRead }))
    }
  }
} finally { console.log(JSON.stringify({ stage: "cleaned", result: await cleanupTest(state, entry) })) }
