import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import AdmZip from "adm-zip"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const destination = join(root, "output", "mods-composition-examples")
mkdirSync(destination, { recursive: true })
const packages = []
for (const name of ["mods-composition-board", "mods-composition-style"]) {
  const zip = new AdmZip()
  for (const file of ["plugin.json", "hooks/hooks.json", "hooks/register.ts"]) {
    zip.addFile(file, readFileSync(join(root, "examples", name, file)))
  }
  const bytes = zip.toBuffer()
  const path = join(destination, name + ".zip")
  writeFileSync(path, bytes)
  packages.push({ name, path, sha256: createHash("sha256").update(bytes).digest("hex") })
}
writeFileSync(join(destination, "packages.json"), JSON.stringify({ packages }, null, 2) + "\n")
console.log(JSON.stringify({ packages }, null, 2))
