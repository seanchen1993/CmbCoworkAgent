import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")

// Run before npm ci: this suite needs only Node and Git, not installed dependencies.
test("native patch artifacts retain their manifest hashes after real Git checkouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmb-patch-checkout-"))
  const source = join(root, "source")
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "-c",
        `core.attributesFile=${join(root, "empty-attributes")}`,
        ...args
      ],
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    )

  try {
    await mkdir(source)
    await writeFile(join(root, "empty-attributes"), "")
    await cp(join(repository, ".gitattributes"), join(source, ".gitattributes"))
    await cp(join(repository, "patches"), join(source, "patches"), { recursive: true })
    await writeFile(join(source, "checkout-control.txt"), "conversion is active\n")
    git(source, "init", "--initial-branch=main")
    git(source, "add", ".gitattributes", "patches", "checkout-control.txt")
    const tree = git(source, "write-tree").trim()
    const commit = git(
      source,
      "-c",
      "user.name=Checkout regression",
      "-c",
      "user.email=checkout-test@example.invalid",
      "commit-tree",
      tree,
      "-m",
      "Native patch checkout fixture"
    ).trim()
    git(source, "update-ref", "refs/heads/main", commit)

    const names = await readdir(join(source, "patches"))
    const manifests = names.filter((name) => name.endsWith(".manifest.json"))
    assert.equal(manifests.length, 4, "cover the base, overlay, core and graph patches")

    for (const autocrlf of ["true", "false", "input"]) {
      const checkout = join(root, `checkout-${autocrlf}`)
      git(root, "clone", "--no-checkout", source, checkout)
      git(checkout, "-c", `core.autocrlf=${autocrlf}`, "checkout", "--force", "main")
      assert.equal(
        await readFile(join(checkout, "checkout-control.txt"), "utf8"),
        autocrlf === "true" ? "conversion is active\r\n" : "conversion is active\n"
      )

      for (const name of names) {
        assert.equal(
          hash(await readFile(join(checkout, "patches", name))),
          hash(await readFile(join(source, "patches", name))),
          `${autocrlf}: exact bytes for ${name}`
        )
      }
      for (const name of manifests) {
        const manifest = JSON.parse(await readFile(join(checkout, "patches", name), "utf8"))
        const patch = await readFile(
          join(checkout, "patches", name.replace(/\.manifest\.json$/, ".patch"))
        )
        assert.equal(hash(patch), manifest.patchSha256, `${autocrlf}: ${name} patch checksum`)
        for (const template of manifest.templates) {
          assert.equal(
            hash(await readFile(join(checkout, "patches", template.path))),
            template.sha256,
            `${autocrlf}: ${template.path} template checksum`
          )
        }
        if (manifest.baseManifestSha256) {
          const base = await readFile(
            join(checkout, "patches", "langchain-1.2.37-native-stream-origin.manifest.json")
          )
          assert.equal(
            hash(base),
            manifest.baseManifestSha256,
            `${autocrlf}: overlay references exact base manifest bytes`
          )
          assert.equal(JSON.parse(base).patchSha256, manifest.basePatchSha256)
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
