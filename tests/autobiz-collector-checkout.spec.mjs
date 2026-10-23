import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const assets = {
  "collector-gray-matter.cjs": "a18fe1c53ab582a75ca3818a5eddf4109efa787594e571324ffe41cd899aceb1",
  "collector-THIRD-PARTY-NOTICES.md":
    "2bd6662b4ecd587835cf373d792834820b352d99cc037aad566f4818972906b7"
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")

// Runs before npm ci using only Node and Git, including the production fixture's pinned hashes.
test("offline collector assets retain their pinned bytes across real Git checkout modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmb-collector-checkout-"))
  const source = join(root, "source")
  const relativeAssets = "resources/mods/autobiz-knowledge"
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
    await mkdir(join(source, relativeAssets), { recursive: true })
    await writeFile(join(root, "empty-attributes"), "")
    await cp(join(repository, ".gitattributes"), join(source, ".gitattributes"))
    const fixtureSource = await readFile(
      join(repository, "tests/support/autobiz-collector-dependency-fixture.ts"),
      "utf8"
    )
    for (const [name, expected] of Object.entries(assets)) {
      const original = join(repository, relativeAssets, name)
      assert.equal(hash(await readFile(original)), expected, `original locked bytes: ${name}`)
      assert.ok(
        fixtureSource.includes(`"${expected}"`),
        `fixture uses the same locked hash: ${name}`
      )
      await cp(original, join(source, relativeAssets, name))
    }
    await writeFile(join(source, "checkout-control.txt"), "conversion is active\n")
    git(source, "init", "--initial-branch=main")
    git(source, "add", ".gitattributes", relativeAssets, "checkout-control.txt")
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
      "Offline collector checkout fixture"
    ).trim()
    git(source, "update-ref", "refs/heads/main", commit)

    for (const autocrlf of ["true", "false", "input"]) {
      const checkout = join(root, `checkout-${autocrlf}`)
      git(root, "clone", "--no-checkout", source, checkout)
      git(checkout, "-c", `core.autocrlf=${autocrlf}`, "checkout", "--force", "main")
      assert.equal(
        await readFile(join(checkout, "checkout-control.txt"), "utf8"),
        autocrlf === "true" ? "conversion is active\r\n" : "conversion is active\n"
      )
      for (const [name, expected] of Object.entries(assets))
        assert.equal(
          hash(await readFile(join(checkout, relativeAssets, name))),
          expected,
          `${autocrlf}: collector integrity for ${name}`
        )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
