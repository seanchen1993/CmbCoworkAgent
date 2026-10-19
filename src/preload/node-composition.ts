import type { NodeCompositionApi } from "../shared/node-composition"
export function createNodeCompositionBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
): NodeCompositionApi {
  return {
    compatibility: (input) => invoke("node-composition:compatibility", input) as
      ReturnType<NodeCompositionApi["compatibility"]>,
    projects: (input) =>
      invoke("node-composition:projects", input) as ReturnType<NodeCompositionApi["projects"]>,
    catalog: (input) =>
      invoke("node-composition:catalog", input) as ReturnType<NodeCompositionApi["catalog"]>,
    preview: (input) =>
      invoke("node-composition:preview", input) as ReturnType<NodeCompositionApi["preview"]>,
    create: (input) =>
      invoke("node-composition:create", input) as ReturnType<NodeCompositionApi["create"]>
  }
}
