import {
  autobizKnowledgeExample,
  readAutobizKnowledgeExample
} from "./business-adapters/autobiz-example"

/** Closed host-owned templates; manifest authors cannot add readers or executable loaders. */
const exampleRegistry = [
  { descriptor: autobizKnowledgeExample, read: readAutobizKnowledgeExample }
] as const

export const bundledBusinessModExamples: ReadonlyArray<
  (typeof exampleRegistry)[number]["descriptor"]
> = exampleRegistry.map((item) => item.descriptor)

/** Lookup precedes all resource IO; an unknown id can never become a filesystem path. */
export async function readBundledBusinessModExample(exampleId: string, mainDirectory: string) {
  const example = exampleRegistry.find((item) => item.descriptor.exampleId === exampleId)
  if (!example) throw Error("BUSINESS_CREATOR_EXAMPLE_UNAVAILABLE")
  return example.read(mainDirectory)
}
