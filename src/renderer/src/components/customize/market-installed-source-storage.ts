import type { MarketItemType } from "../../api/market"

/**
 * 记录“某个资源是从哪个市场入口安装”的本地缓存 key。
 *
 * 已安装版本缓存只关心版本号，不能表达安装来源；SkillsPanel 需要知道：
 * - 这是普通应用市场安装的技能；
 * - 还是 OrgSkillMarketTab 安装的组织级技能。
 *
 * 因此这里单独维护一份轻量来源记录，用于 UI 分组，不参与实际安装/启用逻辑。
 */
const INSTALLED_SOURCE_RECORDS_KEY = "marketplace_installed_source_records"

/**
 * 单条安装来源记录。
 *
 * name:
 * 用来和 window.api.skills.list() 返回的 SkillMetadata.name 做匹配。
 * 对组织级技能，安装时会同时记录英文 slug/name 和中文名，兼容下载包实际落盘后的不同命名。
 *
 * type:
 * 来源市场类型，例如 orgSkill。当前主要用于组织级技能分组，保留 MarketItemType 是为了后续
 * MCP / Plugin / 普通技能也能复用同一结构。
 *
 * installedAt:
 * 记录写入时间，便于后续做排序、排查缓存来源或迁移数据。
 */
interface InstalledSourceRecord {
  name: string
  type: MarketItemType
  installedAt: string
}

/**
 * localStorage 中的整体结构：
 *
 * {
 *   [type]: {
 *     [name]: InstalledSourceRecord
 *   }
 * }
 *
 * 第二层用 name 做 key，可以自然去重；重复安装同名资源时会覆盖 installedAt。
 */
type InstalledSourceRecordMap = Partial<
  Record<MarketItemType, Record<string, InstalledSourceRecord>>
>

/**
 * 安装来源缓存工具。
 *
 * 这个工具只负责读写来源标记：
 * - 不判断资源是否真的安装成功；
 * - 不触发技能列表刷新；
 * - 不替代 marketplace_installed_version_records 的版本记录。
 *
 * 调用方应在安装成功后写入，在删除资源后清理。
 */
export const marketInstalledSourceStorage = {
  /**
   * 读取全部来源记录。
   *
   * localStorage 可能被用户清空、被旧版本写入异常内容，或 JSON 解析失败；
   * 这里统一降级为空对象，避免 UI 分组因为缓存脏数据而崩溃。
   */
  getRecords(): InstalledSourceRecordMap {
    try {
      const stored = localStorage.getItem(INSTALLED_SOURCE_RECORDS_KEY)
      if (!stored) return {}
      const parsed = JSON.parse(stored)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  },

  /**
   * 读取某个市场类型下记录过的所有名称。
   *
   * SkillsPanel 会把这些名称归一化后，与本地技能名称匹配，从而把组织级技能放到
   * “我安装的组织级技能”模块。
   */
  getNames(type: MarketItemType): string[] {
    return Object.keys(this.getRecords()[type] || {})
  },

  /**
   * 写入一条安装来源记录。
   *
   * 同一个 type + name 重复写入时会覆盖旧记录，这样可以避免 localStorage 里堆积重复项；
   * name 为空时直接跳过，防止生成无法匹配的空 key。
   */
  addName(name: string, type: MarketItemType): void {
    if (!name) return

    try {
      const records = this.getRecords()
      const typeRecords = records[type] || {}
      typeRecords[name] = {
        name,
        type,
        installedAt: new Date().toISOString()
      }
      records[type] = typeRecords
      localStorage.setItem(INSTALLED_SOURCE_RECORDS_KEY, JSON.stringify(records))
    } catch (error) {
      console.error("Failed to save installed source to localStorage:", error)
    }
  },

  /**
   * 删除一条安装来源记录。
   *
   * 删除技能时同步清理来源标记，避免用户之后手动上传同名技能时，被误分到组织级技能模块。
   */
  removeName(name: string, type: MarketItemType): void {
    try {
      const records = this.getRecords()
      if (records[type]?.[name]) {
        delete records[type][name]
        localStorage.setItem(INSTALLED_SOURCE_RECORDS_KEY, JSON.stringify(records))
      }
    } catch (error) {
      console.error("Failed to remove installed source from localStorage:", error)
    }
  }
}
