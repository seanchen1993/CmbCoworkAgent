import { businessModId } from "./business-mod-manifest"

export const BUSINESS_MOD_DUPLICATE_ID_CODE = "BUSINESS_MOD_DUPLICATE_ID"

export const BUSINESS_MOD_DUPLICATE_ID_RECOVERY =
  "用 inspect/read_mod 核对本次来源中已有的同名 Mod。复用现有实现时，只移除本次组合中重复的草稿或来源引用；需要独立的新功能时，显式修改新 Mod ID，并同步其资源命名空间和依赖后重新预览。保留现有插件、草稿、Hooks、知识入口和校验，不自动覆盖或删除它们。"

/** Host-created assembly rejection. Arbitrary source text/details are never diagnostics. */
export class BusinessModDuplicateIdError extends Error {
  readonly code = BUSINESS_MOD_DUPLICATE_ID_CODE
  readonly modId: string

  constructor(modId: unknown) {
    const id = businessModId(modId)
    // Keep the original UI/error-message contract while exposing a stable tool diagnostic.
    super(`来源包含重复业务 Mod 标识：${id}`)
    this.name = "BusinessModDuplicateIdError"
    this.modId = id
  }
}
