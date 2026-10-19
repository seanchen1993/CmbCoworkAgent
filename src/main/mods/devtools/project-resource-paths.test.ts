import { expect, it } from "vitest"
import { normalizeProjectResourcePaths } from "./project-resource-paths"

it("admits declared relative text resources independent of business directory names", () => {
  expect(
    normalizeProjectResourcePaths(["company-policy/admission.md", "assets/schema.json"])
  ).toEqual(["assets/schema.json", "company-policy/admission.md"])
})

it("admits public catalog directory prefixes without admitting them as imported text files", () => {
  expect(normalizeProjectResourcePaths(["knowledge", "skills/intake/references"], true)).toEqual([
    "knowledge",
    "skills/intake/references"
  ])
  expect(() => normalizeProjectResourcePaths(["knowledge"])).toThrow(
    "PROJECT_RESOURCE_PATH_INVALID"
  )
  expect(() => normalizeProjectResourcePaths(["knowledge/.env"], true)).toThrow(
    "PROJECT_RESOURCE_PATH_INVALID"
  )
})

it.each([
  "../outside.md",
  "/outside.md",
  "C:/outside.md",
  "one\\outside.md",
  "private/.env.json",
  "private/credentials.json",
  "private/secrets.md",
  ".git/config.md",
  "private/auth.json",
  "private/settings.local.json",
  "private/payload.exe",
  "private/con.md"
])("rejects an unsafe or sensitive imported resource: %s", (path) => {
  expect(() => normalizeProjectResourcePaths([path])).toThrow("PROJECT_RESOURCE_PATH_INVALID")
})

it("rejects resource case aliases before publishing an authoring snapshot", () => {
  expect(() => normalizeProjectResourcePaths(["assets/schema.json", "assets/SCHEMA.json"])).toThrow(
    "PROJECT_RESOURCE_PATH_INVALID"
  )
})
