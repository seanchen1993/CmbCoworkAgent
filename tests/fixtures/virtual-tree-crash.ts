import { VirtualTreeStore } from "../../src/main/mods/flows/virtual-tree"
const [database, treeId, root, phase] = process.argv.slice(2)
const store = new VirtualTreeStore(database)
const session = store.open(treeId, root, () => {}, {
  executionId: "crashed-child",
  parentIncarnation: "parent-1"
})
const operation = session.beginWrite("src/a.txt", Buffer.from("child-write"), `child-${phase}`)
if (phase === "settled") process.stdout.write(session.settleWrite(operation))
// No finally, close, cleanup or cooperative journal settlement.
process.exit(23)
