import type { JsonObject, Register } from "devclaw-mods"
import { selectStageKnowledge, stageMapping } from "./stage-selection"
import { knowledgeRoots, readKnowledge, readMaterial } from "./material-selection"

const ref = { provider: "native.project-context", id: "materials", version: "1.0.0" }

export const register: Register = (on) => {
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "knowledge",
      version: "1.0.0",
      title: "AutoBiz阶段知识",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        {
          id: "context",
          title: "读取本阶段知识",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          requiredPermissions: ["platform.read", "platform.act"],
          cancellable: true,
          idempotency: "keyed"
        }
      ]
    },
    {
      act: async ($, event) => {
        if (typeof event.input.executionId !== "string" || !event.input.executionId)
          throw Error("AUTOBIZ_KNOWLEDGE_EXECUTION_ID_REQUIRED")
        const state = await $.platform.read({ ref, target: { kind: "current" } })
        const value = state.value as
          | {
              stageId?: string
              configuration?: { selectedDeployUnits?: string }
              roots?: Array<{ id: string }>
            }
          | undefined
        if (
          typeof value?.stageId !== "string" ||
          typeof value.configuration?.selectedDeployUnits !== "string" ||
          !Array.isArray(value.roots) ||
          !["knowledge", "package"].every((id) => value.roots?.some((root) => root.id === id))
        )
          throw Error("AUTOBIZ_KNOWLEDGE_BOUND_CONFIGURATION_REQUIRED")
        const config = event.input.config as JsonObject | undefined
        const groups = stageMapping(config?.stageTags, value.stageId)
        const roots = knowledgeRoots(config?.knowledgeRoots)
        const selected = JSON.parse(value.configuration.selectedDeployUnits)
        const documents = await readKnowledge($, roots, event.input.executionId)
        const selection = selectStageKnowledge(documents, selected, value.stageId, groups)
        const method = await readMaterial($, event.input.executionId + ":method", "read", {
          rootId: "package",
          path: "method.md"
        })
        if (
          typeof method.text !== "string" ||
          typeof method.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(method.digest)
        )
          throw Error("AUTOBIZ_KNOWLEDGE_METHOD_UNAVAILABLE")
        const sections = [
          { source: "package", path: "method.md", text: method.text, digest: method.digest },
          ...selection.documents.map((document) => ({
            source: "knowledge",
            ...document,
            digest: documents.find((item) => item.path === document.path)!.digest
          }))
        ]
        const text = JSON.stringify({
          trust: "untrusted-task-data",
          stageId: value.stageId,
          selectedDeployUnits: selected,
          documents: sections,
          omittedPaths: selection.omitted,
          coverage: {
            roots,
            mode: "live-subtree-listing",
            outsideRoots: "not-inspected-except-ancestor-AGENTS"
          }
        })
        const bytes = [...text].reduce((sum, char) => {
          const point = char.codePointAt(0)!
          return sum + (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4)
        }, 0)
        if (text.length > 8000 || bytes > 15000)
          throw Error("AUTOBIZ_KNOWLEDGE_SELECTED_CONTEXT_LIMIT")
        return {
          status: "succeeded",
          text,
          output: {
            passed: true,
            selectedPaths: selection.documents.map((document) => document.path),
            omittedPaths: selection.omitted,
            coverage: {
              roots,
              mode: "live-subtree-listing",
              outsideRoots: "not-inspected-except-ancestor-AGENTS"
            },
            documents: sections.length,
            bytes
          }
        }
      }
    }
  )
}
