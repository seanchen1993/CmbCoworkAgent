import { describe, expect, it } from "vitest"
import { resolveFixtureExecutable } from "./native-fixture-executable.test-helper"

const options = {
  name: "Maven",
  overrideEnv: "AUTOBIZ_TEST_MAVEN",
  homeEnvs: ["MAVEN_HOME", "M2_HOME"],
  commands: ["mvn.cmd", "mvn.bat", "mvn.exe"]
}

describe("portable native fixture executable resolution", () => {
  it("prefers an explicit executable over home and PATH", () => {
    expect(
      resolveFixtureExecutable(options, {
        platform: "win32",
        env: { AUTOBIZ_TEST_MAVEN: "D:\\Tools\\mvn.cmd", MAVEN_HOME: "D:\\Maven", PATH: "D:\\bin" },
        isExecutableFile: (path) => path === "D:\\Tools\\mvn.cmd"
      })
    ).toBe("D:\\Tools\\mvn.cmd")
  })
  it.each(["MAVEN_HOME", "M2_HOME"])("uses %s without relying on PATH", (key) => {
    expect(
      resolveFixtureExecutable(options, {
        platform: "win32",
        env: { [key]: "D:\\Apache Maven" },
        isExecutableFile: (path) => path === "D:\\Apache Maven\\bin\\mvn.cmd"
      })
    ).toBe("D:\\Apache Maven\\bin\\mvn.cmd")
  })
  it("supports Windows Path casing and quoted directories with spaces", () => {
    expect(
      resolveFixtureExecutable(options, {
        platform: "win32",
        env: { Path: ';relative;"D:\\Build Tools"' },
        isExecutableFile: (path) => path === "D:\\Build Tools\\mvn.bat"
      })
    ).toBe("D:\\Build Tools\\mvn.bat")
  })
  it("resolves a Unix executable and never appends Windows extensions", () => {
    expect(
      resolveFixtureExecutable(
        { ...options, commands: ["mvn"] },
        {
          platform: "linux",
          env: { PATH: ":relative:/usr/bin:/opt/maven/bin" },
          isExecutableFile: (path) => path === "/opt/maven/bin/mvn"
        }
      )
    ).toBe("/opt/maven/bin/mvn")
  })
  it.each([
    { AUTOBIZ_TEST_MAVEN: "D:\\missing\\mvn.cmd", PATH: "D:\\working" },
    { AUTOBIZ_TEST_MAVEN: "mvn.cmd --offline", PATH: "D:\\working" },
    { MAVEN_HOME: "D:\\missing", PATH: "D:\\working" }
  ])("fails explicitly instead of hiding invalid configured tools with PATH fallback", (env) => {
    expect(() =>
      resolveFixtureExecutable(options, {
        platform: "win32",
        env,
        isExecutableFile: (path) => path === "D:\\working\\mvn.cmd"
      })
    ).toThrow("NATIVE_FIXTURE_EXECUTABLE_MISSING")
  })
  it("reports a missing dependency instead of skipping or inventing a local fallback", () => {
    expect(() =>
      resolveFixtureExecutable(options, {
        platform: "win32",
        env: {},
        isExecutableFile: () => false
      })
    ).toThrow("Tests require the real tool")
  })
})
