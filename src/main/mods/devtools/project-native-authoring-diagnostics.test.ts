import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { createProjectTemplate } from "./project-template"
import { ProjectCompileDiagnosticError } from "./project-compile-diagnostics"
import { compileNativeComposition } from "../../plugins/native-composition"

const scope = {
  threadId: "native-diagnostics",
  workspace: "isolated",
  incarnation: { token: "current", legacyCreatedAt: 1 }
}
const sourcePath = "composition/source.json"
const roots = new Set<string>()
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})

function invalidSource(text: string, kind: "json" | "schema" | "unsafe-path") {
  if (kind === "json") return '{"secret":"PRIVATE_VALUE" "C:/PRIVATE_MACHINE":'
  const value = JSON.parse(text)
  if (kind === "unsafe-path") value.resources.push("C:/PRIVATE_MACHINE/PRIVATE_VALUE")
  else {
    value.modules[0].checks[0].artifactId = null
    value.modules[0].checks[0]["C:/PRIVATE_MACHINE/PRIVATE_KEY"] = "PRIVATE_VALUE"
  }
  return JSON.stringify(value)
}

describe("native author source diagnostics", () => {
  it.each([
    {
      schema: { type: "string", minLength: 1 },
      error: "MODS_TOOL_SCHEMA",
      suffix: "/type",
      code: "PROJECT_JSON_SCHEMA_ROOT_OBJECT_REQUIRED"
    },
    {
      schema: { type: "object", PRIVATE_KEY: "PRIVATE_VALUE" },
      error: "MODS_TOOL_SCHEMA_UNSUPPORTED",
      suffix: "",
      code: "PROJECT_JSON_SCHEMA_UNSUPPORTED_KEYWORD"
    },
    {
      schema: { type: "object", $ref: "#/$defs/PRIVATE_VALUE" },
      error: "MODS_TOOL_SCHEMA_REF",
      suffix: "",
      code: "PROJECT_JSON_SCHEMA_REF_INVALID"
    }
  ])(
    "locates author JSON schema rejection $code without changing the production profile",
    ({ schema, error, suffix, code }) => {
      const base = createProjectTemplate({
        packageId: "native",
        name: "Native",
        template: "native-modular"
      })
      const value = JSON.parse(base.files.find((file) => file.path === sourcePath)!.text)
      value.modules[0].checks[0].schema = schema
      let failure: unknown
      try {
        compileNativeComposition(value, {
          files: base.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) })),
          actionCatalog: []
        })
      } catch (caught) {
        failure = caught
      }
      expect(failure).toBeInstanceOf(ProjectCompileDiagnosticError)
      expect(failure).toMatchObject({
        message: error,
        diagnostics: [
          {
            file: sourcePath,
            path: `/modules/0/checks/0/schema${suffix}`,
            code,
            message: expect.any(String)
          }
        ]
      })
      expect(JSON.stringify((failure as ProjectCompileDiagnosticError).diagnostics)).not.toMatch(
        /PRIVATE_|stack|Error:/
      )
      expect(value.modules[0].checks[0].schema).toEqual(schema)
    }
  )

  it.each(["save", "files-patch"] as const)(
    "rejects invalid %s atomically and permits repair at the same revision",
    async (action) => {
      const sessions = new ProjectAuthoringSessions(async () => [])
      const original = await sessions.scaffold(
        scope,
        "native",
        "Native",
        () => {},
        "native-modular"
      )
      roots.add(dirname(original.directory))
      const native = original.source.files.find((file) => file.path === sourcePath)!
      const before = await readdir(dirname(original.directory))
      for (const kind of ["json", "schema", "unsafe-path"] as const) {
        const file = { path: sourcePath, text: invalidSource(native.text, kind) }
        const rejected = await (
          action === "save"
            ? sessions.save(
                scope,
                {
                  id: original.id,
                  name: original.name,
                  revision: 1,
                  files: original.source.files.map((item) =>
                    item.path === sourcePath ? file : item
                  )
                },
                () => {}
              )
            : sessions.patch(
                scope,
                {
                  id: original.id,
                  revision: 1,
                  sourceDigest: original.source.digest,
                  files: [file]
                },
                () => {}
              )
        ).catch((error: unknown) => error)
        expect(rejected).toBeInstanceOf(ProjectCompileDiagnosticError)
        const diagnostics = (rejected as ProjectCompileDiagnosticError).diagnostics
        expect(diagnostics[0]).toMatchObject({
          file: sourcePath,
          path: kind === "schema" ? "/modules/0/checks/0/artifactId" : "",
          code:
            kind === "json"
              ? "PROJECT_JSON_SYNTAX"
              : kind === "schema"
                ? "PROJECT_SCHEMA_INVALID_TYPE"
                : "PROJECT_SCHEMA_PATH_INVALID"
        })
        expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_|stack|Error:/)
        expect(sessions.read(scope, original.id)).toMatchObject({
          revision: 1,
          source: original.source
        })
        expect(await readdir(dirname(original.directory))).toEqual(before)
      }
      const repaired = await sessions.patch(
        scope,
        { id: original.id, revision: 1, sourceDigest: original.source.digest, files: [native] },
        () => {}
      )
      expect(repaired.revision).toBe(2)
      expect(repaired.source).toEqual(original.source)
    }
  )

  it.each(["json", "schema"] as const)(
    "reports retained %s compile failure before creating a revision or writing persistence",
    async (kind) => {
      const base = createProjectTemplate({
        packageId: "native",
        name: "Native",
        template: "native-modular"
      })
      const source = createAuthoringSourceBundle(
        base.files.map((file) =>
          file.path === sourcePath ? { ...file, text: invalidSource(file.text, kind) } : file
        )
      )
      const directory = await mkdtemp(join(tmpdir(), "native-diagnostics-"))
      roots.add(directory)
      const stored = JSON.stringify({
        schemaVersion: 1,
        drafts: [{ id: "native", name: "Native", revision: 1, source }]
      })
      const compareAndSetSetting = vi.fn(() => true)
      const sessions = new ProjectAuthoringSessions(async () => [])
      sessions.configurePersistence({ getSetting: () => stored, compareAndSetSetting }, directory)
      const before = await readdir(directory)
      const rejected = await sessions
        .compile(scope, "native", 1, () => {})
        .catch((error: unknown) => error)
      expect(rejected).toBeInstanceOf(ProjectCompileDiagnosticError)
      expect((rejected as ProjectCompileDiagnosticError).diagnostics[0]).toMatchObject({
        file: sourcePath,
        path: kind === "schema" ? "/modules/0/checks/0/artifactId" : ""
      })
      expect(JSON.stringify((rejected as ProjectCompileDiagnosticError).diagnostics)).not.toMatch(
        /PRIVATE_/
      )
      expect(sessions.read(scope, "native")).toMatchObject({ revision: 1, source })
      expect(compareAndSetSetting).not.toHaveBeenCalled()
      expect(await readdir(directory)).toEqual(before)
    }
  )

  it("also bounds direct compiler schema diagnostics without reflecting arbitrary field names", () => {
    const source = createProjectTemplate({
      packageId: "native",
      name: "Native",
      template: "native-modular"
    })
    const native = source.files.find((file) => file.path === sourcePath)!
    const value = JSON.parse(invalidSource(native.text, "schema"))
    const failure = () => compileNativeComposition(value, { files: [], actionCatalog: [] })
    expect(failure).toThrowError(
      expect.objectContaining({
        message: "PROJECT_AUTHORING_SCHEMA_INVALID",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            file: sourcePath,
            path: "/modules/0/checks/0/artifactId"
          })
        ])
      })
    )
  })
})
