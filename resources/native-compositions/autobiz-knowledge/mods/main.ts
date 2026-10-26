import { selectKnowledge } from "./selector"
const ref = { provider: "native.project-context", id: "materials", version: "1.0.0" }
export function register(on) {
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "knowledge",
      version: "1.0.0",
      title: "AutoBiz组织知识",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        {
          id: "context",
          title: "读取选择知识",
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
        const state = await $.platform.read({ ref, target: { kind: "current" } })
        const configuration = state.value?.configuration
        if (!configuration || typeof configuration.selectedDeployUnits !== "string")
          throw Error("AUTOBIZ_KNOWLEDGE_CONFIGURATION_REQUIRED")
        const selected = JSON.parse(configuration.selectedDeployUnits)
        const roots = state.value.roots
        if (
          !Array.isArray(roots) ||
          !roots.some((root) => root.id === "knowledge") ||
          !roots.some((root) => root.id === "package")
        )
          throw Error("AUTOBIZ_KNOWLEDGE_BOUND_ROOTS_REQUIRED")
        let sequence = 0
        const call = async (action, input) => {
          const receipt = await $.platform.act({
            ref,
            target: { kind: "current" },
            action,
            input,
            requestKey: event.input.executionId + ":materials:" + sequence++
          })
          if (receipt.status !== "succeeded") throw Error("AUTOBIZ_KNOWLEDGE_MATERIAL_UNAVAILABLE")
          return receipt.value
        }
        const documents = []
        const visit = async (path, depth) => {
          if (depth > 12) throw Error("AUTOBIZ_KNOWLEDGE_DEPTH_LIMIT")
          let offset = 0
          while (offset <= 512) {
            const page = await call("list", {
              rootId: "knowledge",
              ...(path ? { path } : {}),
              offset,
              limit: 32
            })
            if (!Array.isArray(page.entries)) throw Error("AUTOBIZ_KNOWLEDGE_LIST_INVALID")
            for (const entry of page.entries) {
              if (entry.kind === "directory") await visit(entry.path, depth + 1)
              else if (entry.kind === "file" && entry.path.endsWith(".md")) {
                if (documents.length >= 512) throw Error("AUTOBIZ_KNOWLEDGE_DOCUMENT_LIMIT")
                const read = await call("read", { rootId: "knowledge", path: entry.path })
                if (
                  read.path !== entry.path ||
                  typeof read.text !== "string" ||
                  typeof read.digest !== "string"
                )
                  throw Error("AUTOBIZ_KNOWLEDGE_READ_INVALID")
                documents.push({ path: read.path, text: read.text, digest: read.digest })
              }
            }
            if (page.nextOffset === null) break
            if (
              !Number.isInteger(page.nextOffset) ||
              page.nextOffset <= offset ||
              page.nextOffset > 512
            )
              throw Error("AUTOBIZ_KNOWLEDGE_PAGE_INVALID")
            offset = page.nextOffset
          }
        }
        await visit("", 0)
        const selection = selectKnowledge(documents, selected)
        const methods = [
          "domain-method.md",
          ...(state.value.stageId === "specs" ? ["review-specs.md"] : []),
          ...(state.value.stageId === "design" ? ["review-design.md"] : [])
        ]
        const sections = []
        for (const path of methods) {
          const document = await call("read", { rootId: "package", path })
          if (typeof document.text !== "string") throw Error("AUTOBIZ_KNOWLEDGE_METHOD_UNAVAILABLE")
          sections.push({ source: "package", path, text: document.text, digest: document.digest })
        }
        for (const document of selection)
          sections.push({
            source: "knowledge",
            ...document,
            digest: documents.find((item) => item.path === document.path).digest
          })
        const text = JSON.stringify({
          trust: "untrusted-task-data",
          selectedDeployUnits: selected,
          documents: sections
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
            selectedPaths: selection.map((document) => document.path),
            documents: sections.length
          }
        }
      }
    }
  )
}
