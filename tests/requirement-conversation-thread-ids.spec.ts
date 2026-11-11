import assert from "node:assert/strict"
import { getRequirementConversationThreadIds } from "../src/renderer/src/components/requirement/requirement-data"

assert.deepEqual(
  getRequirementConversationThreadIds({
    threadIds: ["conversation-1", "development-1", "conversation-2", "development-1"],
    developmentThreadIds: ["development-1"]
  }),
  ["conversation-1", "conversation-2"],
  "project-mode development sessions must not be shown as requirement conversations"
)

assert.deepEqual(
  getRequirementConversationThreadIds({
    threadIds: [" conversation-1 ", "conversation-1", "conversation-2"],
    developmentThreadIds: []
  }),
  ["conversation-1", "conversation-2"],
  "ordinary requirement conversations remain normalized and deduplicated"
)

console.log("requirement-conversation-thread-ids: all assertions passed")
