import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"
import {
  compareDerivationPaths,
  derivationDigest,
  snapshotDerivationSource,
  writeDerivationFiles
} from "./derivation-source"

it("materializes old and renamed Skill resource trees with the exact retained snapshot digest", async () => {
  const root = await mkdtemp(join(canonicalTmpdir(), "derivation-order-"))
  try {
    const files = [
      ["plugin.json", '{"name":"order-regression","version":"1.0.0","skills":"skills"}'],
      ["skills/vendor-dossier/SKILL.md", "# Original"],
      ["skills/vendor-dossier/scripts/check.py", "raise ValueError('required')"],
      ["skills/vendor-dossier-improved/SKILL.md", "# Replacement"],
      ["skills/vendor-dossier-improved/references/input.md", "Normalized input"],
      ["skills/z-publish/SKILL.md", "# Publish"]
    ]
      .map(([path, text]) => {
        const bytes = Buffer.from(text)
        return {
          path,
          bytes,
          mode: process.platform === "win32" ? 0o666 : 0o644,
          digest: createHash("sha256").update(bytes).digest("hex")
        }
      })
      .sort((left, right) => compareDerivationPaths(left.path, right.path))
    expect(files.findIndex((file) => file.path === "skills/vendor-dossier/SKILL.md")).toBeLessThan(
      files.findIndex((file) => file.path === "skills/vendor-dossier-improved/SKILL.md")
    )
    await writeDerivationFiles(root, files)
    const snapshot = await snapshotDerivationSource(root)
    expect(snapshot.files.map((file) => file.path)).toEqual(files.map((file) => file.path))
    expect(snapshot.digest).toBe(derivationDigest(files, []))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
