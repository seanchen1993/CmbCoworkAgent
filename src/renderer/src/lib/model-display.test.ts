import { describe, expect, it } from "vitest"
import { resolveModelDisplay, type ModelDisplayConfig } from "./model-display"

const model = (
  id: string,
  name: string,
  modelName = id.replace(/^(?:custom|builtin):/, ""),
  available = true
): ModelDisplayConfig => ({
  id,
  name,
  source: id.startsWith("builtin:") ? "builtin" : "custom",
  model: modelName,
  available
})

describe("model names without changing model references", () => {
  it("keeps null snapshots neutral even when appStore has a name", () => {
    expect(resolveModelDisplay("custom:b", [model("custom:b", "模型 B")], false)).toEqual({
      name: "模型 B",
      note: "名称尚未取得",
      matchedModelId: null,
      state: "unconfirmed",
      available: null
    })
    expect(resolveModelDisplay("custom:b", [], false).state).toBe("unconfirmed")
  })

  it("distinguishes a successful empty snapshot from unavailable names", () => {
    expect(resolveModelDisplay("custom:b", [], true)).toMatchObject({
      name: "b",
      state: "not-found",
      note: "名称未找到（按已取得列表）"
    })
    expect(resolveModelDisplay(undefined, [], true).state).toBe("unspecified")
  })

  it("prefers exact custom IDs over legacy model aliases regardless of catalog order", () => {
    const entries = [model("custom:other", "别名碰撞", "b"), model("custom:b", "模型 B")]
    expect(resolveModelDisplay(" custom:b ", entries, true)).toMatchObject({
      name: "模型 B",
      matchedModelId: "custom:b",
      state: "matched"
    })
    expect(resolveModelDisplay("b", entries, true).name).toBe("模型 B")
  })

  it("resolves custom legacy model aliases without rewriting their persisted reference", () => {
    const entries = Object.freeze([Object.freeze(model("custom:stable-id", "旧模型", "old-name"))])
    expect(resolveModelDisplay("custom:old-name", entries, true)).toMatchObject({
      name: "旧模型",
      matchedModelId: "custom:stable-id"
    })
    expect(entries[0].id).toBe("custom:stable-id")
  })

  it("keeps explicit prefixes inside their source and does not use builtin model aliases", () => {
    const entries = [model("builtin:b", "内置 B", "builtin-alias"), model("custom:c", "自定 C")]
    expect(resolveModelDisplay("builtin:b", entries, true).name).toBe("内置 B")
    expect(resolveModelDisplay("custom:b", entries, true).state).toBe("not-found")
    expect(resolveModelDisplay("builtin:c", entries, true).state).toBe("not-found")
    expect(resolveModelDisplay("builtin:builtin-alias", entries, true).state).toBe("not-found")
  })

  it("follows custom ID, custom model, then generic ID/model for unprefixed references", () => {
    const entries = [
      model("builtin:value", "内置值", "builtin-name"),
      model("custom:other", "自定义别名", "value")
    ]
    expect(resolveModelDisplay("value", entries, true).name).toBe("自定义别名")
    expect(resolveModelDisplay("builtin-name", entries, true).name).toBe("内置值")
  })

  it("does not guess catalog order when several legacy candidates collide", () => {
    const entries = [model("custom:a", "A", "legacy"), model("custom:b", "B", "legacy")]
    const expected = {
      name: "legacy",
      state: "ambiguous",
      note: "名称尚未确认",
      matchedModelId: null,
      available: null
    }
    expect(resolveModelDisplay("custom:legacy", entries, true)).toEqual(expected)
    expect(resolveModelDisplay("custom:legacy", [...entries].reverse(), true)).toEqual(expected)
  })

  it("does not match display names, substrings or case variants", () => {
    const entries = [model("custom:id", "显示名称", "CaseModel")]
    for (const ref of ["显示名称", "caseModel", "Case", "custom:显示名称"])
      expect(resolveModelDisplay(ref, entries, true).state).toBe("not-found")
  })

  it("describes cached key metadata without claiming endpoint health", () => {
    expect(
      resolveModelDisplay("custom:b", [model("custom:b", "模型 B", "b", false)], true)
    ).toMatchObject({ name: "模型 B", note: "未配置密钥", available: false })
    expect(resolveModelDisplay("custom:b", [model("custom:b", "模型 B")], true).note).toBeNull()
  })
})
