import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import extract from "extract-zip"

// Digests from the official release assets at github.com/git-for-windows/git.
const version = "2.56.1"
const tag = "v2.56.1.windows.1"
const assets = new Map([
  ["x64", ["64-bit", "4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd"]],
  ["arm64", ["arm64", "96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c"]],
  ["ia32", ["32-bit", "e9b2c628c6d3bfc86405568d05979c605ee994172eb232cc4cbc4daf54425829"]]
])

async function digest(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
}

async function verifiedArchive(name, expected) {
  const cache = path.join(
    process.env.LOCALAPPDATA || path.join(homedir(), ".cache"),
    "CmbDevClaw",
    "build-cache"
  )
  await mkdir(cache, { recursive: true })
  const cached = path.join(cache, name)
  try {
    if ((await digest(cached)) === expected) return cached
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const staging = await mkdtemp(path.join(cache, "download-"))
  try {
    const file = path.join(staging, name)
    const url = `https://github.com/git-for-windows/git/releases/download/${tag}/${name}`
    execFileSync(
      process.platform === "win32" ? "curl.exe" : "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--retry",
        "2",
        "--max-time",
        "240",
        "--output",
        file,
        url
      ],
      { stdio: "inherit", windowsHide: true }
    )
    if ((await digest(file)) !== expected) throw new Error(`SHA-256 mismatch for ${name}`)
    await rename(file, cached)
    return cached
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

// Used by electron-builder afterPack and by developers testing with an older system Git.
export async function installTaskCommitGit(resourcesDir, arch) {
  const asset = assets.get(arch)
  if (!asset) throw new Error(`No MinGit package for Windows architecture ${arch}`)
  const [suffix, expected] = asset
  const name = `MinGit-${version}-${suffix}.zip`
  const archive = await verifiedArchive(name, expected)
  await mkdir(resourcesDir, { recursive: true })
  const staging = await mkdtemp(path.join(resourcesDir, ".task-commit-git-"))
  const next = path.join(staging, "next")
  const dest = path.join(resourcesDir, "task-commit-git")
  const previous = path.join(staging, "previous")
  try {
    await extract(archive, { dir: next })
    await access(path.join(next, "cmd", "git.exe"))
    await access(path.join(next, "LICENSE.txt"))
    let replaced = false
    try {
      await rename(dest, previous)
      replaced = true
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    try {
      await rename(next, dest)
    } catch (error) {
      if (replaced) await rename(previous, dest)
      throw error
    }
    console.log(`Installed verified ${name} into ${dest}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await installTaskCommitGit(fileURLToPath(new URL("../resources/", import.meta.url)), process.arch)
}
