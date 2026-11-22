export const THREAD_LIST_PRIORITY_KEYS = [
  "hostProjectRuntime",
  // Remote IM session identity: the sidebar and chat banner classify threads by
  // these, so they must lead the priority queue — priority keys consume the
  // per-row char budget in array order, and a large known key later would
  // otherwise starve them and degrade remote inbox / Feature sessions to plain
  // local threads.
  "targetKind",
  "remoteState",
  "remoteThread",
  "remoteReadOnly",
  "imDeliveryContext",
  "botId",
  "botHostId",
  "botWorkId",
  "botAudienceKey",
  "botLocalConversation",
  "botWorkOrigin",
  "botMockBindingId",
  "botMockTransport",
  "botGroupId",
  "workspacePath",
  "harnessFeature",
  "harnessProjectSession",
  "harnessProjectName",
  "projectName",
  "agentMode",
  "coordinatorMode",
  "subagentsEnabled",
  "model",
  "routingState",
  "memoryEnabled",
  "outputStyle",
  "conciseModeEnabled",
  "isWorktree",
  "worktreeBranch",
  "worktreeBaseBranch",
  "gitRoot",
  "gitContext",
  "scheduledTaskId",
  "isHeartbeat",
  "title"
] as const
