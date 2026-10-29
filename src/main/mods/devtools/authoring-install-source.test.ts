import { expect, it } from "vitest"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { createAuthoringTemplate } from "./authoring-templates"
import { readPureFunctionSource } from "./authoring-install-source"

const base = createAuthoringTemplate({
  id: "sample",
  name: "Sample",
  kind: "command",
  instruction: "Review"
})

it("retains exact inert project companion paths without adding registration declarations", () => {
  const source = createAuthoringSourceBundle([
    ...base.files,
    { path: "modules/review/SKILL.md", text: "---\nname: review\n---\nProject companion" },
    { path: "workflows/review.workflow.js", text: "// Project companion only" }
  ])
  expect(readPureFunctionSource(source)).toEqual(source)
})

it.each([
  "SKILL.md",
  "skills/review/SKILL.md",
  "hooks/hooks.json",
  "hooks/register.ts",
  "agents/reviewer.md",
  ".mcp.json",
  "commands/review.md",
  "modules/review/main.ts",
  "workflows/register.ts",
  "workflows/review.js"
])("keeps auto-load and undeclared paths rejected: %s", (path) => {
  expect(() =>
    readPureFunctionSource(createAuthoringSourceBundle([...base.files, { path, text: "{}" }]))
  ).toThrow("AUTHORING_INSTALL_PURE_SOURCE_REQUIRED")
})

it.each(["skills", "hooks", "mcpServers", "agents", "commands", "workflows"])(
  "does not let inert companions enable %s through plugin metadata",
  (key) => {
    const files = base.files.map((file) =>
      file.path === "plugin.json"
        ? { ...file, text: JSON.stringify({ ...JSON.parse(file.text), [key]: "modules" }) }
        : file
    )
    expect(() => readPureFunctionSource(createAuthoringSourceBundle(files))).toThrow(
      "AUTHORING_INSTALL_PURE_SOURCE_REQUIRED"
    )
  }
)
