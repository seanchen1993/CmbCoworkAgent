import { isBotCommunicationTurn } from "./prompt"

/** Execution capacity cannot consume the slots reserved for talking to the user. */
export interface BotAdmission {
  readonly execution: number
  readonly communication: number
}
export const BOT_ADMISSION: BotAdmission = Object.freeze({ execution: 4, communication: 2 })
export const botAdmissionLane = (task: Parameters<typeof isBotCommunicationTurn>[0]) =>
  isBotCommunicationTurn(task) ? "communication" : "execution"

// Keep this equivalent to isBotCommunicationTurn; tested against all origin kinds.
export const BOT_COMMUNICATION_TASK_SQL = `(t.work_id IS NULL AND (
  (t.mock_source_json IS NULL AND COALESCE(json_extract(t.origin_json,'$.kind'),'user') IN ('user','introduction'))
  OR (json_extract(t.mock_source_json,'$.transport')='im' AND COALESCE(json_extract(t.origin_json,'$.kind'),'user') IN ('mock','user'))
  OR json_extract(t.origin_json,'$.kind')='work_result'))`
