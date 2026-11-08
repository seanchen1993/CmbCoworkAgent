import { cpSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { installReactVirtuosoScrollCancel } from "../../scripts/apply-react-virtuoso-scroll-cancel.mjs"
import {
  captureModsVirtuosoDependencyProof,
  MODS_VIRTUOSO_PATCH_SOURCE_ROOTS
} from "../support/mods-source-candidate"

/** Real fixed patch and package bytes, installed only in the disposable test repository. */
export async function sourceDependencyFixture(root: string) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  for (const path of [
    "package.json",
    "package-lock.json",
    ...MODS_VIRTUOSO_PATCH_SOURCE_ROOTS,
    "node_modules/react-virtuoso/package.json",
    "node_modules/react-virtuoso/LICENSE",
    ...["index.mjs", "index.cjs", "index.d.ts"].map(
      (name) => `node_modules/react-virtuoso/dist/${name}`
    )
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    cpSync(join(repository, path), join(root, path), { recursive: true })
  }
  await installReactVirtuosoScrollCancel({ workspaceRoot: root })
  return captureModsVirtuosoDependencyProof(root)
}
