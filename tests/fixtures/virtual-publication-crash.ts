import { join } from "node:path"
import { ModControlStore } from "../../src/main/mods/control-store"
import { VirtualTreeStore } from "../../src/main/mods/flows/virtual-tree"
import {
  prepareVirtualTreeReview,
  readVirtualTreeReview,
  VirtualPublicationJournal
} from "../../src/main/mods/flows/virtual-tree-publication"
import { publishReviewedVirtualTree } from "../../src/main/mods/flows/virtual-tree-writeback"

async function main() {
  const [directory, treeId, root] = process.argv.slice(2)
  const store = new VirtualTreeStore(join(directory, "tree.sqlite"), undefined, true)
  const control = new ModControlStore(join(directory, "control.sqlite"))
  const journal = new VirtualPublicationJournal(control)
  const token = prepareVirtualTreeReview({
    store,
    treeId,
    finalRoot: root,
    assertCurrent: () => {}
  })
  await publishReviewedVirtualTree({
    token,
    approvedDigest: readVirtualTreeReview(token)!.digest,
    journal,
    signal: AbortSignal.timeout(15000),
    assertCurrent: () => {
      if (journal.list().some((row) => row.paths?.some((path) => path.state === "backed-up")))
        process.exit(0)
    }
  })
  throw Error("fixture did not reach durable backup window")
}
main().catch(() => {
  process.exitCode = 1
})
