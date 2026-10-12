import { expect, it } from "vitest"
import { parseBotShellReviewCandidate as parse } from "./shell-review-candidate"

it("resolves explicit Windows entry scripts without rewriting their command or relying on the host OS", () => {
  for (const command of [
    ".\\gradlew.bat test",
    '"C:\\研发\\gradlew.bat" test',
    "& '.\\gradlew.bat' test"
  ])
    expect(parse(command, "C:\\研发"), command).toEqual({
      kind: "executable",
      path: "C:\\研发\\gradlew.bat"
    })
  expect(parse("..\\other\\check.ps1", "C:\\研发")).toEqual({
    kind: "executable",
    path: "C:\\other\\check.ps1"
  })
  expect(parse('"\\\\server\\share\\check.cmd"', "C:\\研发")).toEqual({
    kind: "executable",
    path: "\\\\server\\share\\check.cmd"
  })
})

it("keeps PATH-resolved scripts, launcher shims, dynamic paths and mismatched platforms manual", () => {
  for (const command of [
    "gradlew.bat test",
    "build.cmd",
    "check.ps1",
    ".\\npm.cmd test",
    ".\\$script.ps1",
    ".\\%SCRIPT%.cmd",
    ".\\check.cmd && next.cmd"
  ])
    expect(parse(command, "C:\\研发"), command).toMatchObject({ kind: "package_script_unresolved" })
  expect(parse(".\\gradlew.bat test", "/tmp/project")).toMatchObject({
    kind: "package_script_unresolved"
  })
  expect(parse(".\\gradlew.bat test")).toMatchObject({ kind: "package_script_unresolved" })
})
