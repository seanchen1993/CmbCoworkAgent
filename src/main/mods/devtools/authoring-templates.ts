import { createAuthoringSourceBundle } from "./authoring-bundle"

export const AUTHORING_TEMPLATE_KINDS = ["command", "tool", "rule", "panel", "flow-action"] as const
export type AuthoringTemplateKind = (typeof AUTHORING_TEMPLATE_KINDS)[number]

/** Deterministic starter source. User text is serialized as a literal, never inserted as code. */
export function createAuthoringTemplate(input: {
  id: string
  name: string
  instruction: string
  kind: AuthoringTemplateKind
}) {
  if (
    typeof input.id !== "string" ||
    typeof input.name !== "string" ||
    typeof input.instruction !== "string" ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(input.id) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|constructor|prototype)$/.test(input.id) ||
    !AUTHORING_TEMPLATE_KINDS.includes(input.kind) ||
    !input.name.trim() ||
    input.name.length > 100 ||
    !input.instruction.trim() ||
    input.instruction.length > 2000
  )
    throw Error("AUTHORING_TEMPLATE_INPUT")
  const literal = JSON.stringify
  const id = literal(input.id),
    title = literal(input.name),
    instruction = literal(input.instruction)
  const command = `await $.command.register({ name: ${id}, description: ${title}, immediate: true })`
  const start = `on("session.start", async ($, event, next) => { ${command}; return next(event) })`
  let source: string
  if (input.kind === "command" || input.kind === "flow-action") {
    source = `import type { Register } from "claude-code"
export const register: Register<${id}> = (on) => {
  ${start}
  on("command.run", { command: ${id} }, (_sdk, event) => {
    let text = event.args ?? ""
    try {
      const envelope: unknown = JSON.parse(text)
      if (envelope && typeof envelope === "object" && "version" in envelope && envelope.version === 1 && "input" in envelope && envelope.input && typeof envelope.input === "object" && "text" in envelope.input && typeof envelope.input.text === "string") text = envelope.input.text
    } catch { /* Ordinary slash commands accept plain text. */ }
    const summary = ${instruction} + "\\n" + text
    return { text: summary, output: { text: summary } }
  })
}
`
  } else if (input.kind === "rule") {
    source = `type Section = { id: string; text: string; scope: "session" | "shared" }
type Composition = { sections: Section[] }
type On = (event: "prompt.compose", handler: (sdk: unknown, event: unknown, next: (event: unknown) => Promise<Composition>) => Promise<Composition>) => void
export function register(on: On) {
  on("prompt.compose", async (_sdk, event, next) => {
    const prior = await next(event)
    return { ...prior, sections: [...prior.sections, { id: ${literal(input.id + "-rule")}, text: ${instruction}, scope: "session" }] }
  })
}
`
  } else if (input.kind === "tool") {
    source = `type SDK = { tool: { register(input: { name: string; description: string; inputSchema: unknown }): Promise<unknown> } }
type On = {
  (event: "session.start", handler: (sdk: SDK, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>): void
  (event: "tool.call", filter: { tool: string }, handler: (sdk: SDK, event: { text: string }) => { result: string }): void
}
export function register(on: On) {
  on("session.start", async ($, event, next) => {
    await $.tool.register({ name: "format", description: ${title}, inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 8000 } }, required: ["text"], additionalProperties: false } })
    return next(event)
  })
  on("tool.call", { tool: ${literal(`mcp__${input.id}__format`)} }, (_sdk, event) => ({ result: ${instruction} + "\\n" + event.text }))
}
`
  } else {
    source = `type SDK = {
  command: { register(input: { name: string; description: string; immediate: boolean }): Promise<void> }
  ui: { open(input: { id: string; title: string }): Promise<unknown>; resolve(event: unknown): { Box(props: { flexDirection: "column"; gap: number; children: unknown[] }): unknown; Text(props: { children: string }): unknown } }
}
type On = {
  (event: "session.start", handler: (sdk: SDK, event: unknown, next: (event: unknown) => Promise<unknown>) => Promise<unknown>): void
  (event: "command.run", filter: { command: string }, handler: (sdk: SDK) => Promise<Record<string, never>>): void
  (event: "ui.render", filter: { component: "Pane"; requestId: string }, handler: (sdk: SDK, event: unknown) => unknown): void
}
export function register(on: On) {
  ${start}
  on("command.run", { command: ${id} }, async ($) => { await $.ui.open({ id: ${id}, title: ${title} }); return {} })
  on("ui.render", { component: "Pane", requestId: ${id} }, ($, event) => {
    const { Box, Text } = $.ui.resolve(event)
    return Box({ flexDirection: "column", gap: 1, children: [Text({ children: ${title} }), Text({ children: ${instruction} })] })
  })
}
`
  }
  const action =
    input.kind === "flow-action"
      ? {
          actions: [
            {
              id: "format",
              name: input.name,
              command: input.id,
              inputSchema: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string", maxLength: 8000 } },
                additionalProperties: false
              },
              outputSchema: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string" } },
                additionalProperties: false
              }
            }
          ]
        }
      : {}
  const files = [
    {
      path: "plugin.json",
      text:
        JSON.stringify(
          { name: input.id, version: "0.1.0", description: input.name, mods: "mods/manifest.json" },
          null,
          2
        ) + "\n"
    },
    {
      path: "mods/manifest.json",
      text:
        JSON.stringify(
          {
            apiVersion: "cmb.mods/v2",
            id: input.id,
            claw: {
              componentsVersion: 1,
              components: [
                {
                  id: "main",
                  name: input.name,
                  description: input.instruction,
                  kind: "module",
                  entry: "main.ts",
                  dependsOn: [],
                  actionIds: input.kind === "flow-action" ? ["format"] : []
                }
              ],
              ...action
            }
          },
          null,
          2
        ) + "\n"
    },
    { path: "mods/main.ts", text: source },
    {
      path: "README.md",
      text: `# ${input.name}\n\n模板类型：${input.kind}。此模板不访问文件、网络或模型服务。\n\n${input.instruction}\n\n安装后仍需在项目中核对能力并授权、选择组件并应用。保存草稿不会自动安装或应用。\n`
    }
  ]
  return createAuthoringSourceBundle(files)
}
