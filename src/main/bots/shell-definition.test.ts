import { afterEach, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotProjectFiles } from "./project-files"
import { botShellDefinition, assertBotShellDefinition } from "./shell-definition"

const roots: string[] = []
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "cmb-command-definition-"))
  roots.push(path)
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ scripts: { test: "node test.cjs" } })
  )
  await writeFile(join(path, "test.cjs"), "console.log('test')")
  return { path, project: await BotProjectFiles.open(path, []) }
}
it("binds the full manifest bytes, displays the selected script and rechecks changes before dispatch", async () => {
  const f = await fixture()
  const value = await botShellDefinition(f.project, "npm test")
  expect(value).toMatchObject({
    kind: "package_script",
    path: "package.json",
    definition: "node test.cjs"
  })
  await assertBotShellDefinition(f.project, value)
  await writeFile(
    join(f.path, "package.json"),
    JSON.stringify({ scripts: { test: "node changed.cjs" } })
  )
  await expect(assertBotShellDefinition(f.project, value)).rejects.toThrow("审批后已变化")
  expect(await botShellDefinition(f.project, "npm test")).not.toEqual(value)
})
it("never binds package selection flags or unavailable definitions to the root manifest", async () => {
  const f = await fixture()
  for (const command of [
    "npm test --prefix ../outside",
    "pnpm --filter other test",
    "npm test -w other",
    "npm test -wother",
    "pnpm test -C../outside",
    "yarn --cwd other test",
    "npm run missing"
  ])
    expect(await botShellDefinition(f.project, command), command).toMatchObject({
      kind: "unavailable"
    })
  expect(
    await botShellDefinition(f.project, "npm test -- --prefix argument-to-script")
  ).toMatchObject({ kind: "package_script" })
  await writeFile(join(f.path, "package.json"), "invalid-json")
  expect(await botShellDefinition(f.project, "npm test")).toMatchObject({ kind: "unavailable" })
})
it("binds Windows package-manager launchers and keeps path-qualified or indirect launchers manual", async () => {
  const f = await fixture()
  expect(await botShellDefinition(f.project, "NODE.EXE test.cjs")).toMatchObject({
    kind: "executable",
    path: "test.cjs",
    definition: "console.log('test')"
  })
  for (const command of ["npm.cmd test", "NPM.CMD test", '"pnpm.exe" run test', "YARN.BAT test"])
    expect(await botShellDefinition(f.project, command), command).toMatchObject({
      kind: "package_script",
      path: "package.json",
      definition: "node test.cjs"
    })
  for (const command of [
    '"C:\\Program Files\\nodejs\\npm.cmd" test',
    ".\\NPM.CMD test",
    "npm.cmd test --prefix ../outside",
    "NPM.CMD --workspace other test"
  ])
    expect(await botShellDefinition(f.project, command), command).toMatchObject({
      kind: "unavailable"
    })
})
it("uses project-scoped stable entry-script reads and refuses symlinks, binary and oversized definitions", async () => {
  const f = await fixture()
  const entry = await botShellDefinition(f.project, "node test.cjs")
  expect(entry).toMatchObject({ kind: "executable", path: "test.cjs" })
  await writeFile(join(f.path, "test.cjs"), "changed")
  await expect(assertBotShellDefinition(f.project, entry)).rejects.toThrow("已变化")
  await symlink(join(f.path, "test.cjs"), join(f.path, "link.cjs"))
  for (const [name, bytes] of [
    ["binary.cjs", Buffer.from([0, 1, 2])],
    ["large.cjs", Buffer.alloc(8001, "x")]
  ] as const)
    await writeFile(join(f.path, name), bytes)
  for (const command of [
    "node link.cjs",
    "node binary.cjs",
    "node large.cjs",
    "node ../outside.cjs"
  ])
    expect(await botShellDefinition(f.project, command), command).toMatchObject({
      kind: "unavailable"
    })
  expect(await botShellDefinition(f.project, "git status")).toBeUndefined()
})
