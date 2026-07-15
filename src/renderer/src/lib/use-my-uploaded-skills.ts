import { useEffect, useMemo, useState } from "react"
import { marketApi, type MarketItem } from "../api/market"
import { normalizeMarketSkillKey } from "../components/dashboard/skill-market"
import { buildUploaderIdCandidates, getUploaderIdCandidates } from "./skill-data-service"

type UserInfoLite = {
  sapId?: string | null
  ystId?: string | null
}

export interface MyUploadedSkills {
  /** 归一化后的技能 key 集合（去版本号、去后缀、小写），用于和候选的 skill_name 比对。 */
  ownedSkillKeys: Set<string>
  /** 归一化后的技能 key -> 当前用户在应用市场上传的技能条目。 */
  ownedSkillItemsByKey: Map<string, MarketItem>
  /** 当前用户在应用市场上传的技能数量。 */
  ownedSkillCount: number
  loading: boolean
}

const EMPTY_KEYS: Set<string> = new Set()
const EMPTY_ITEMS_BY_KEY: Map<string, MarketItem> = new Map()

function isUploadedByCurrentUser(item: MarketItem, currentUserCandidates: Set<string>): boolean {
  if (!item.user_id || currentUserCandidates.size === 0) return false
  return getUploaderIdCandidates(item.user_id).some((candidate) =>
    currentUserCandidates.has(candidate)
  )
}

function collectSkillKeys(item: MarketItem): string[] {
  return [item.name, item.filename].map((value) => normalizeMarketSkillKey(value)).filter(Boolean)
}

async function loadCurrentUserCandidates(): Promise<Set<string>> {
  if (typeof window.api?.models?.getUserInfo !== "function") return new Set()
  const userInfo = (await window.api.models.getUserInfo()) as UserInfoLite | null
  const normalizedIds = [userInfo?.sapId, userInfo?.ystId]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
  return new Set(normalizedIds.flatMap((id) => buildUploaderIdCandidates(id)))
}

/**
 * 计算「当前登录用户在应用市场上传过的技能」集合。
 *
 * 复用 Dashboard「仅我上传的」同一套归属判断：
 * - 当前用户身份候选集 = getUserInfo() 的 sapId / ystId 经 buildUploaderIdCandidates 展开
 * - 市场技能归属 = item.user_id 经 getUploaderIdCandidates 展开后与当前用户候选集求交
 *
 * 返回归一化后的技能 key 集合，便于和 Trace Evolver 候选的 skill_name 直接比对，
 * 从而让创建者只看到自己技能的优化候选。
 */
export function useMyUploadedSkills(): MyUploadedSkills {
  const [ownedSkillKeys, setOwnedSkillKeys] = useState<Set<string>>(EMPTY_KEYS)
  const [ownedSkillItemsByKey, setOwnedSkillItemsByKey] =
    useState<Map<string, MarketItem>>(EMPTY_ITEMS_BY_KEY)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      if (!cancelled) setLoading(true)
      try {
        const [currentUserCandidates, skills] = await Promise.all([
          loadCurrentUserCandidates(),
          marketApi.getSkills()
        ])
        if (cancelled) return
        const keys = new Set<string>()
        const itemsByKey = new Map<string, MarketItem>()
        if (skills.success && skills.data && currentUserCandidates.size > 0) {
          for (const item of skills.data) {
            if (!isUploadedByCurrentUser(item, currentUserCandidates)) continue
            for (const key of collectSkillKeys(item)) {
              keys.add(key)
              if (!itemsByKey.has(key)) itemsByKey.set(key, item)
            }
          }
        }
        setOwnedSkillKeys(keys)
        setOwnedSkillItemsByKey(itemsByKey)
      } catch (error) {
        console.warn("[useMyUploadedSkills] failed to resolve uploaded skills:", error)
        if (!cancelled) {
          setOwnedSkillKeys(EMPTY_KEYS)
          setOwnedSkillItemsByKey(EMPTY_ITEMS_BY_KEY)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const unsubscribeLogin = window.electron?.ipcRenderer?.on?.("notify-login-msg", () => {
      void load()
    })

    return () => {
      cancelled = true
      unsubscribeLogin?.()
    }
  }, [])

  return useMemo(
    () => ({ ownedSkillKeys, ownedSkillItemsByKey, ownedSkillCount: ownedSkillKeys.size, loading }),
    [ownedSkillItemsByKey, ownedSkillKeys, loading]
  )
}
