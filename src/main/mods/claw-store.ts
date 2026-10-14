import { parseClawProfile, type ClawState } from "../../shared/mods/claw"
import type { FlowSettingsStore } from "./flows/store"
import type { ClawProfile } from "../../shared/mods/claw"

interface ClawBinding {
  revision: number
  profile: ClawProfile | null
}
type ClawRecord = ClawState & { bindings?: Record<string, ClawBinding> }

export class ClawStore {
  constructor(private readonly settings: FlowSettingsStore) {}
  private key(workspace: string) {
    return JSON.stringify(["claw-profiles-v1", workspace])
  }
  read(workspace: string): ClawState {
    const state = this.record(workspace)
    return { revision: state.revision, profiles: state.profiles, active: state.active }
  }
  private record(workspace: string): ClawRecord {
    const raw = this.settings.getSetting(this.key(workspace), "")
    if (!raw) return { revision: 0, profiles: [], active: null }
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw Error("Claw 配置记录超过大小限制。")
    const value = JSON.parse(raw) as ClawRecord
    if (
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.profiles) ||
      value.profiles.length > 24
    )
      throw Error("Claw 配置记录损坏，请保留控制库并检查备份。")
    const profiles = value.profiles.map(parseClawProfile)
    if (new Set(profiles.map((item) => item.id)).size !== profiles.length)
      throw Error("Claw 配置记录重复。")
    const bindings: Record<string, ClawBinding> = {}
    if (value.bindings !== undefined) {
      if (
        !value.bindings ||
        typeof value.bindings !== "object" ||
        Array.isArray(value.bindings) ||
        Object.keys(value.bindings).length > 512
      )
        throw Error("Claw 对话绑定记录损坏。")
      for (const [key, binding] of Object.entries(value.bindings)) {
        if (
          !key.startsWith("[") ||
          key.length > 600 ||
          !binding ||
          !Number.isSafeInteger(binding.revision) ||
          binding.revision < 1 ||
          binding.revision > value.revision
        )
          throw Error("Claw 对话绑定记录损坏。")
        bindings[key] = {
          revision: binding.revision,
          profile: binding.profile === null ? null : parseClawProfile(binding.profile)
        }
      }
    }
    return {
      revision: value.revision,
      profiles,
      active: value.active === null ? null : parseClawProfile(value.active),
      bindings
    }
  }
  write(workspace: string, state: ClawState, expected: number): void {
    if (!Number.isSafeInteger(expected) || this.read(workspace).revision !== expected)
      throw Error("Claw 配置已变化，请刷新后再试。")
    if (state.profiles.length > 24) throw Error("每个项目最多保存 24 个组合。")
    this.persist(workspace, { ...this.record(workspace), ...state, revision: expected + 1 })
  }
  selection(workspace: string, identity: string): ClawBinding {
    const state = this.record(workspace)
    return state.bindings?.[identity] ?? { revision: 0, profile: state.active }
  }
  apply(workspace: string, identity: string, profile: ClawProfile | null, expected: number): void {
    const state = this.record(workspace)
    if (!Number.isSafeInteger(expected) || state.revision !== expected)
      throw Error("Claw 配置已变化，请刷新后再试。")
    if (!identity.startsWith("[") || identity.length > 600) throw Error("CLAW_IDENTITY_INVALID")
    const bindings = {
      ...state.bindings,
      [identity]: {
        revision: expected + 1,
        profile: profile === null ? null : parseClawProfile(profile)
      }
    }
    if (Object.keys(bindings).length > 512) throw Error("本项目已达到 512 个 Claw 对话绑定上限。")
    this.persist(workspace, { ...state, bindings, revision: expected + 1 })
  }
  private persist(workspace: string, state: ClawRecord): void {
    const encoded = JSON.stringify(state)
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw Error("Claw 配置记录超过大小限制。")
    this.settings.setSetting(this.key(workspace), encoded)
  }
}
