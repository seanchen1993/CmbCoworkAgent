import type { UiGuideConfig, UiGuideState } from "../../shared/ui-guides"
import type { NativeSqliteAdapter } from "./native-sqlite-adapter"

export function ensureUiGuideSchema(database: NativeSqliteAdapter): void {
  database.run(`CREATE TABLE IF NOT EXISTS ui_guide_records (
    guide_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL,
    shown_count INTEGER NOT NULL DEFAULT 0 CHECK (shown_count >= 0),
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1))
  )`)
}

function validateConfig(config: UiGuideConfig): void {
  if (
    !config ||
    typeof config.guideId !== "string" ||
    !config.guideId.trim() ||
    !Number.isSafeInteger(config.revision) ||
    config.revision < 1 ||
    !Number.isSafeInteger(config.maxShowCount) ||
    config.maxShowCount < 1
  ) {
    throw new Error("引导配置无效")
  }
}

export function getUiGuideState(
  database: NativeSqliteAdapter,
  config: UiGuideConfig
): UiGuideState {
  validateConfig(config)
  database.run(
    `INSERT INTO ui_guide_records (guide_id, revision) VALUES (?, ?)
     ON CONFLICT(guide_id) DO UPDATE SET
       revision = excluded.revision, shown_count = 0, acknowledged = 0
     WHERE ui_guide_records.revision != excluded.revision`,
    [config.guideId, config.revision]
  )
  const [shownCount, acknowledged] = database.exec(
    "SELECT shown_count, acknowledged FROM ui_guide_records WHERE guide_id = ?",
    [config.guideId]
  )[0].values[0]
  return {
    shownCount: Number(shownCount),
    acknowledged: acknowledged === 1,
    shouldShow: acknowledged === 0 && Number(shownCount) < config.maxShowCount
  }
}

export function recordUiGuideDisplay(
  database: NativeSqliteAdapter,
  config: UiGuideConfig
): boolean {
  validateConfig(config)
  database.run(
    `UPDATE ui_guide_records SET shown_count = shown_count + 1
     WHERE guide_id = ? AND revision = ? AND acknowledged = 0 AND shown_count < ?`,
    [config.guideId, config.revision, config.maxShowCount]
  )
  return database.getRowsModified() === 1
}

export function acknowledgeUiGuide(database: NativeSqliteAdapter, config: UiGuideConfig): void {
  validateConfig(config)
  database.run("UPDATE ui_guide_records SET acknowledged = 1 WHERE guide_id = ? AND revision = ?", [
    config.guideId,
    config.revision
  ])
}
