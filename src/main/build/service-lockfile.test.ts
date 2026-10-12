import { describe, expect, it } from "vitest"
import { projectServiceLock } from "./service-lockfile"

const service = {
  name: "cmb-host",
  version: "1.0.0",
  license: "MIT",
  engines: { node: ">=22.16 <23" },
  dependencies: { agent: "1.0.0" }
}
describe("independent Host dependency lock", () => {
  it("retains locked nested and required peer dependencies without unrelated desktop packages", () => {
    const lock = projectServiceLock(
      {
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/agent": {
            version: "1.0.0",
            dependencies: { transport: "^2" },
            peerDependencies: { shared: "^3" },
            dev: true
          },
          "node_modules/agent/node_modules/transport": {
            version: "2.1.0",
            integrity: "sha512-locked",
            dependencies: { shared: "^3" },
            devOptional: true
          },
          "node_modules/transport": { version: "9.0.0" },
          "node_modules/shared": { version: "3.2.0" },
          "node_modules/electron": { version: "39.8.10", dev: true }
        }
      },
      service
    ) as { packages: Record<string, Record<string, unknown>> }
    expect(Object.keys(lock.packages).sort()).toEqual([
      "",
      "node_modules/agent",
      "node_modules/agent/node_modules/transport",
      "node_modules/shared"
    ])
    expect(lock.packages["node_modules/agent/node_modules/transport"]).toEqual({
      version: "2.1.0",
      integrity: "sha512-locked",
      dependencies: { shared: "^3" }
    })
    expect(lock.packages[""].dependencies).toEqual(service.dependencies)
  })
  it("promotes a runtime package reached through both optional and required edges", () => {
    const lock = projectServiceLock(
      {
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/agent": {
            version: "1.0.0",
            dependencies: { shared: "^1" },
            optionalDependencies: { optional: "^1" }
          },
          "node_modules/optional": {
            version: "1.0.0",
            dependencies: { shared: "^1" },
            optional: true
          },
          "node_modules/shared": {
            version: "1.0.0",
            optional: true,
            dependencies: { child: "^1" }
          },
          "node_modules/child": { version: "1.0.0", dev: true, optional: true }
        }
      },
      service
    ) as { packages: Record<string, Record<string, unknown>> }
    expect(lock.packages["node_modules/optional"].optional).toBe(true)
    expect(lock.packages["node_modules/shared"].optional).toBeUndefined()
    expect(lock.packages["node_modules/child"].optional).toBeUndefined()
  })
  it("rejects installed-version drift and missing or linked required runtime packages", () => {
    expect(() =>
      projectServiceLock(
        { lockfileVersion: 3, packages: { "": {}, "node_modules/agent": { version: "2.0.0" } } },
        service
      )
    ).toThrow(/differs/)
    expect(() =>
      projectServiceLock(
        {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/agent": { version: "1.0.0", dependencies: { missing: "*" } }
          }
        },
        service
      )
    ).toThrow(/Missing/)
    expect(() =>
      projectServiceLock(
        {
          lockfileVersion: 3,
          packages: { "": {}, "node_modules/agent": { version: "1.0.0", link: true } }
        },
        service
      )
    ).toThrow(/linked/)
  })
})
