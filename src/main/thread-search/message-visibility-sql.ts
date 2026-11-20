import { IM_REMOTE_TRANSCRIPT_MESSAGE_PREFIXES } from "../../shared/im-remote-transcript"

export const SEARCH_VISIBLE_MESSAGE_ID_SQL = IM_REMOTE_TRANSCRIPT_MESSAGE_PREFIXES
  .map((prefix) => `m.message_id NOT GLOB '${prefix}*'`)
  .join(" AND ")
