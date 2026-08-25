import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

async function main(): Promise<void> {
  const source = (
    await readFile(resolve(__dirname, "../src/renderer/src/lib/thread-context.tsx"), "utf8")
  ).replace(/\r\n/g, "\n")
  const sidebarSource = (
    await readFile(
      resolve(__dirname, "../src/renderer/src/components/sidebar/ThreadSidebar.tsx"),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")
  const kanbanSource = (
    await readFile(
      resolve(__dirname, "../src/renderer/src/components/kanban/KanbanView.tsx"),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")
  const kanbanHeaderSource = (
    await readFile(
      resolve(__dirname, "../src/renderer/src/components/kanban/KanbanHeader.tsx"),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")
  const harnessSource = (
    await readFile(
      resolve(
        __dirname,
        "../src/renderer/src/components/harness-board/HarnessBoardView.tsx"
      ),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")
  const dehydrationHelperSource = (
    await readFile(
      resolve(__dirname, "../src/renderer/src/lib/thread-dehydration.ts"),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")
  const modelSwitcherSource = (
    await readFile(
      resolve(__dirname, "../src/renderer/src/components/chat/ModelSwitcher.tsx"),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")
  const workspacePickerSource = (
    await readFile(
      resolve(__dirname, "../src/renderer/src/components/chat/WorkspacePicker.tsx"),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")
  const rightPanelSource = (
    await readFile(
      resolve(__dirname, "../src/renderer/src/components/panels/RightPanel.tsx"),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")
  const lspPanelSource = (
    await readFile(
      resolve(__dirname, "../src/renderer/src/components/customize/LspPanel.tsx"),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")

  for (const [name, consumerSource] of [
    ["model switcher", modelSwitcherSource],
    ["workspace picker", workspacePickerSource]
  ] as const) {
    assert.doesNotMatch(
      consumerSource,
      /useCurrentThread\(/,
      `${name} must not re-render for every unrelated content token`
    )
    assert.match(
      consumerSource,
      /useThreadStateSelector\(/,
      `${name} must subscribe only to the fields it renders`
    )
    assert.match(
      consumerSource,
      /useThreadActions\(/,
      `${name} must read stable actions without subscribing to the whole ThreadState`
    )
  }
  assert.match(
    harnessSource,
    /windowHarnessProjectGroups\(activeSystemGroups, PROJECT_CATALOG_PAGE_SIZE\)/,
    "project-mode first paint must keep one global hard budget for mounted project cards"
  )
  assert.match(
    harnessSource,
    /projectLimit: PROJECT_CATALOG_PAGE_SIZE/,
    "the catalog IPC page must bound active and archived project rows before rendering"
  )
  assert.match(
    harnessSource,
    /const PROJECT_CATALOG_PAGE_SIZE = 24/,
    "the project-mode page must retain a small fixed mount budget"
  )

  assert.match(
    rightPanelSource,
    /const refreshLspConfig = useCallback/,
    "the collapsed LSP header may only load its lightweight config summary"
  )
  assert.doesNotMatch(
    rightPanelSource,
    /window\.api\.lsp\.getStatus\(/,
    "the right-panel header must reuse expanded LSP data instead of duplicating runtime probes"
  )
  assert.match(
    rightPanelSource,
    /\{lspOpen && \([\s\S]{0,500}<LspPanel/,
    "the runtime-probing LSP panel must remain unmounted while its section is closed"
  )
  assert.match(lspPanelSource, /window\.api\.lsp\.getStatus\(/)
  assert.match(
    lspPanelSource,
    /requestId === loadRequestIdRef\.current/,
    "late LSP responses from a previous task must not replace the current status"
  )
  const hooksEffectsStart = rightPanelSource.indexOf("if (!hooksOpen) return undefined")
  assert.ok(hooksEffectsStart >= 0, "the Hooks section must have a closed-state hydration gate")
  assert.ok(
    rightPanelSource.match(/if \(!hooksOpen\) return undefined/g)?.length === 1,
    "full Hooks hydration must stay dormant while closed"
  )
  assert.match(
    rightPanelSource,
    /requestScope: RIGHT_PANEL_HOOK_SUMMARY_SCOPE[\s\S]{0,250}limit: 1/,
    "collapsed Hooks may only request one bounded Worker summary page"
  )
  assert.match(
    rightPanelSource,
    /window\.setTimeout\([\s\S]{0,120}RIGHT_PANEL_HOOK_REFRESH_DEBOUNCE_MS/,
    "full Hook hydration must coalesce adjacent skill and hook invalidations"
  )
  assert.match(
    rightPanelSource.slice(
      rightPanelSource.indexOf("const loadMarketSkills") - 180,
      rightPanelSource.indexOf("const loadMarketSkills") + 800
    ),
    /if \(!skillsOpen\) return undefined/,
    "market skill hydration must follow the Skills section rather than the unrelated LSP section"
  )

  assert.match(
    sidebarSource,
    /useThreadStateSummaries\(\)/,
    "the permanently mounted sidebar must subscribe to lightweight summaries"
  )
  assert.doesNotMatch(
    sidebarSource,
    /useAllThreadStates\(\)/,
    "content-only frames must not materialize every ThreadState for the sidebar"
  )
  for (const [name, consumerSource] of [
    ["Kanban", kanbanSource],
    ["Kanban header", kanbanHeaderSource],
    ["Harness board", harnessSource]
  ] as const) {
    assert.match(
      consumerSource,
      /useThreadStateSummaries\(\)/,
      `${name} must subscribe to lightweight task summaries`
    )
    assert.doesNotMatch(
      consumerSource,
      /useAllThreadStates\(\)/,
      `${name} must stay off ordinary content-token ThreadState notifications`
    )
  }

  const holderStart = source.indexOf("const ThreadStreamHolder = memo(")
  const holderEnd = source.indexOf("export function ThreadProvider", holderStart)
  assert.ok(holderStart >= 0 && holderEnd > holderStart, "ThreadStreamHolder must remain memoized")
  const holderSource = source.slice(holderStart, holderEnd)

  assert.equal(
    holderSource.split("onStreamUpdateRef.current(threadId").length - 1,
    1,
    "one observable stream snapshot must be forwarded exactly once"
  )
  assert.match(
    holderSource,
    /\}, \[stream\.messages, stream\.isLoading, threadId\]\)/,
    "snapshot forwarding must depend on observable fields, not the unstable stream wrapper"
  )
  assert.match(
    holderSource,
    /updateFallbackIndexBaselineCache\(cache, nextMessages\)/,
    "fallback counters must advance from the holder's prior immutable message prefix"
  )

  const providerRender = source.slice(source.indexOf("  return (", holderEnd))
  assert.doesNotMatch(
    providerRender,
    /fallbackIndexBaselinesFromMessages\(state\.messages\)/,
    "a provider render must not scan every active thread transcript"
  )
  assert.doesNotMatch(
    providerRender,
    /onStreamUpdate=\{\(data\)/,
    "holders must receive stable callbacks instead of per-render closures"
  )

  assert.match(
    source,
    /subscribeToThreadState:[\s\S]*useSyncExternalStore\(subscribe, getSnapshot, getSnapshot\)/,
    "thread consumers must subscribe to their own external-store bucket"
  )
  assert.match(
    source,
    /const getThreadState = useCallback\([\s\S]*threadStatesRef\.current\[threadId\][\s\S]*\[\]\s*\)/,
    "getThreadState must not capture the whole threadStates object"
  )

  assert.equal(
    source.match(/\bsetThreadStates\(/g)?.length ?? 0,
    0,
    "ThreadState writes must not clone a React record snapshot"
  )
  assert.doesNotMatch(
    source,
    /setThreadRegistryRevision/,
    "ordinary token updates must not re-render the provider and enumerate every active holder"
  )
  assert.match(
    source,
    /messageStructureChanged[\s\S]*setHolderRegistryRevision/,
    "holder reconciliation must wake only for structural baseline changes"
  )
  const stateNotificationStart = source.indexOf("const commitThreadStateChanges = useCallback")
  const stateNotificationEnd = source.indexOf("const updateThreadState = useCallback", stateNotificationStart)
  const stateNotificationSource = source.slice(stateNotificationStart, stateNotificationEnd)
  assert.match(
    stateNotificationSource,
    /applyThreadStateRegistryChanges\(threadStatesRef\.current, changes\)/,
    "the registry must mutate only explicitly supplied thread buckets"
  )
  assert.doesNotMatch(
    stateNotificationSource,
    /Object\.(?:keys|entries|values)\(threadStatesRef\.current\)/,
    "one ThreadState write must not enumerate the complete state record"
  )
  assert.match(
    stateNotificationSource,
    /previous\?\.coordinatorWorkers !== state\?\.coordinatorWorkers[\s\S]*unresolvedCoordinatorThreadIdsRef/,
    "coordinator notification tracking must be incremental on worker-array identity changes"
  )
  assert.doesNotMatch(
    source.slice(stateNotificationEnd, source.indexOf("const refreshGoalUi", stateNotificationEnd)),
    /Object\.entries\(threadStatesRef\.current\)/,
    "ordinary ThreadState updates must not rebuild the unresolved coordinator set"
  )

  const accumulateStart = source.indexOf("const accumulateLiveStreamMessages")
  const accumulateEnd = source.indexOf("const flushLiveStreamAccumulator", accumulateStart)
  assert.ok(accumulateStart >= 0 && accumulateEnd > accumulateStart, "live accumulator must exist")
  const accumulateSource = source.slice(accumulateStart, accumulateEnd)
  assert.doesNotMatch(
    accumulateSource,
    /getCurrentThreadMessageIds\(threadId\)/,
    "a token frame must not rebuild ids from the complete durable transcript"
  )
  assert.match(
    accumulateSource,
    /getLiveStreamTranscriptIndex\(committedMessages\)/,
    "a token frame must reuse the immutable transcript index"
  )
  assert.match(
    accumulateSource,
    /accumulator\.normalizeMessageIds\(\s*\(\) =>/,
    "the expensive occurrence baseline must be supplied lazily"
  )
  assert.match(
    accumulateSource,
    /accumulator\.projectCumulativeFrame\(/,
    "cumulative SDK frames must project only changed source-reference slots"
  )
  assert.match(
    accumulateSource,
    /accumulator\.mergeMessages\(accumulator\.messages, incoming\)/,
    "already-normalized current-turn frames must use the stateful merger"
  )
  assert.doesNotMatch(
    accumulateSource,
    /mergeLiveStreamMessages\(accumulator\.messages, incoming\)/,
    "ordinary token frames must not repeat the canonical full-turn normalization"
  )
  assert.match(
    source.slice(source.indexOf("const liveMessagesWithTimes"), accumulateStart),
    /accumulator\.projectTimedMessages\(accumulator\.messages, accumulator\.messageTimes\)/,
    "timed live messages must reuse stable prefix objects"
  )

  const flushStart = source.indexOf("const flushLiveStreamAccumulator", accumulateEnd)
  const flushEnd = source.indexOf("const flushGoalSubturnComplete", flushStart)
  assert.ok(flushStart >= 0 && flushEnd > flushStart, "live completion flush must exist")
  const flushSource = source.slice(flushStart, flushEnd)
  assert.match(
    flushSource,
    /mergeLiveStreamCommitMessagesDetailed\(/,
    "one completion merge must return canonical incoming rows for persistence"
  )
  assert.match(
    flushSource,
    /canonicalMessagesToPersist[\s\S]*pendingVisibleMessageCommitsRef/,
    "the persistence queue must retain canonical rows instead of raw per-row re-normalization"
  )

  const pendingCommitStart = source.indexOf("// Persist visible stream messages")
  const pendingCommitEnd = source.indexOf("const getOrCreateLiveStreamAccumulator", pendingCommitStart)
  const pendingCommitSource = source.slice(pendingCommitStart, pendingCommitEnd)
  assert.match(
    pendingCommitSource,
    /resolveCommittedLiveStreamMessages\(/,
    "pending persistence must resolve the whole completion batch through one index"
  )
  assert.doesNotMatch(
    pendingCommitSource,
    /for \(const pendingCommit[\s\S]*normalizeAppendedMessageIds\(/,
    "pending persistence must not normalize the complete transcript once per row"
  )
  assert.doesNotMatch(
    pendingCommitSource,
    /for \(const pendingCommit[\s\S]*messages\.find\(/,
    "pending persistence must not search the complete transcript once per row"
  )

  const toolBatchStart = source.indexOf("function upsertToolCallStatesFromMessages")
  const toolBatchEnd = source.indexOf("const ThreadContext", toolBatchStart)
  const toolBatchSource = source.slice(toolBatchStart, toolBatchEnd)
  assert.match(
    toolBatchSource,
    /nextStates \?\?= \{ \.\.\.states \}/,
    "a tool-heavy completion must clone the tool-state record at most once"
  )
  assert.doesNotMatch(
    toolBatchSource,
    /nextStates = upsertToolCallState\(/,
    "a tool-heavy completion must not spread the growing tool-state map per tool call"
  )

  const streamUpdateStart = source.indexOf("const handleStreamUpdate")
  const streamUpdateEnd = source.indexOf("// Subscribe to stream updates", streamUpdateStart)
  assert.ok(streamUpdateStart >= 0 && streamUpdateEnd > streamUpdateStart, "stream handler must exist")
  const streamUpdateSource = source.slice(streamUpdateStart, streamUpdateEnd)
  assert.match(
    streamUpdateSource,
    /getLiveStreamTranscriptIndex\([\s\S]*\)\.providerOccurrenceIdentities/,
    "retained-live filtering must reuse the cached durable identity set"
  )
  assert.doesNotMatch(
    streamUpdateSource,
    /new Set\(\s*\(threadStatesRef\.current\[threadId\]\?\.messages/,
    "retained-live filtering must not map the durable transcript per token"
  )
  assert.match(
    streamUpdateSource,
    /transitionalLiveMessagesRef\.current\[threadId\]/,
    "only the small post-flush React commit bridge may be retained between frames"
  )
  assert.doesNotMatch(
    streamUpdateSource,
    /streamDataRef\.current\[threadId\]\?\.liveMessages[^;]*\.filter/,
    "the prior full accumulator snapshot must never be treated as transitional live state"
  )

  const coordinatorSnapshotStart = source.indexOf(
    "const applyCoordinatorAssistantSnapshotMessage"
  )
  const coordinatorSnapshotEnd = source.indexOf(
    "const applyMessageIdAlias",
    coordinatorSnapshotStart
  )
  assert.ok(
    coordinatorSnapshotStart >= 0 && coordinatorSnapshotEnd > coordinatorSnapshotStart,
    "the coordinator assistant snapshot handler must exist"
  )
  const coordinatorSnapshotSource = source.slice(
    coordinatorSnapshotStart,
    coordinatorSnapshotEnd
  )
  assert.match(
    coordinatorSnapshotSource,
    /getLiveStreamTranscriptIndex\(committedMessages\)/,
    "reasoning snapshots must reuse the immutable durable transcript index"
  )
  assert.match(
    coordinatorSnapshotSource,
    /accumulator\.normalizeMessageIds\([\s\S]*transcriptIndex/,
    "reasoning snapshots must reuse the run-scoped identity normalizer"
  )
  assert.match(
    coordinatorSnapshotSource,
    /transcriptIndex\.messageRoleIds\.has/,
    "committed snapshot detection must use the cached role/id set"
  )
  assert.doesNotMatch(
    coordinatorSnapshotSource,
    /committedMessages\.(?:map|some)\(/,
    "ordinary reasoning snapshots must not traverse the complete durable transcript"
  )
  const customEventStart = source.indexOf("const handleCustomEvent")
  const customEventEnd = source.indexOf("const getThreadActions", customEventStart)
  const customEventSource = source.slice(customEventStart, customEventEnd)
  assert.match(
    customEventSource,
    /import\.meta\.env\.DEV && data\.type !== "coordinator_ai_snapshot_message"/,
    "token-level reasoning snapshots must never accumulate renderer console entries"
  )

  const subagentAppendStart = source.indexOf("const appendSubagentTranscriptMessages")
  const subagentAppendEnd = source.indexOf("useEffect(() => {", subagentAppendStart)
  const subagentAppendSource = source.slice(subagentAppendStart, subagentAppendEnd)
  assert.match(
    subagentAppendSource,
    /mergeSubagentTranscripts\([\s\S]*pendingBySubagent\[subagentId\] = upsertTranscriptMessages\(/,
    "live and pending-persistence subagent buckets must share the optimized upsert path"
  )
  assert.match(
    subagentAppendSource,
    /subagentTranscriptContentVersions:[\s\S]*\[subagentId\]:/,
    "in-place subagent tail updates must publish a per-subagent content version"
  )

  const schedulerStart = source.indexOf("const processSchedulerEvent")
  const schedulerEnd = source.indexOf("const initializeThread", schedulerStart)
  assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart, "scheduler handler must exist")
  const schedulerSource = source.slice(schedulerStart, schedulerEnd)
  const turnMessagesStart = schedulerSource.indexOf('case "turn-messages"')
  const fullMessagesStart = schedulerSource.indexOf('case "full-messages"')
  assert.ok(
    turnMessagesStart >= 0 && fullMessagesStart > turnMessagesStart,
    "projected turn snapshots must have a dedicated branch"
  )
  const turnMessagesSource = schedulerSource.slice(turnMessagesStart, fullMessagesStart)
  assert.match(
    turnMessagesSource,
    /mergeSchedulerTurnMessageSnapshot\(\s*state\.messages/,
    "projected turn snapshots must merge against the latest durable history"
  )
  assert.match(
    turnMessagesSource,
    /upsertToolCallStatesFromMessages\(\s*state\.toolCallStates/,
    "projected turn snapshots must incrementally retain historical tool state"
  )
  const fullMessagesSource = schedulerSource.slice(fullMessagesStart)
  assert.match(
    fullMessagesSource,
    /upsertToolCallStatesFromMessages\(\{\}, messages\)/,
    "a full tool-heavy snapshot must build tool state with one record clone"
  )
  assert.doesNotMatch(
    fullMessagesSource,
    /messages\.reduce<Record<string, ToolCallState>>/,
    "a full tool-heavy snapshot must not spread a growing tool-state record per row"
  )
  const messageDeltaStart = schedulerSource.indexOf('case "message-delta"')
  const toolMessageStart = schedulerSource.indexOf('case "tool-message"')
  const messageDeltaSource = schedulerSource.slice(messageDeltaStart, toolMessageStart)
  assert.match(
    messageDeltaSource,
    /replaceTrustedMessageTailInPlace\([\s\S]*messagesContentVersion:/,
    "scheduler token frames must use the trusted O(1) tail path and publish its version"
  )
  assert.doesNotMatch(
    schedulerSource,
    /Object\.keys\(schedulerStreamingRef\.current\)/,
    "clearing one scheduler task must not enumerate streaming trackers for every task"
  )

  const loadHistoryStart = source.indexOf("const loadThreadHistory = useCallback")
  const loadHistoryEnd = source.indexOf("// Track passive scheduler", loadHistoryStart)
  const loadHistorySource = source.slice(loadHistoryStart, loadHistoryEnd)
  assert.match(
    loadHistorySource,
    /const initialPageOptions = \{[\s\S]*?limit: INITIAL_THREAD_MESSAGES_PAGE_LIMIT,[\s\S]*?byteBudget: INITIAL_THREAD_MESSAGES_PAGE_BYTE_BUDGET,[\s\S]*?foregroundToken \? \{ requestScope: "foreground-hydration" as const \} : \{\}[\s\S]*?getMessagesPage\(threadId, initialPageOptions\)/,
    "opening a 10k-message task must request only the bounded cold-start page"
  )
  assert.match(
    source,
    /const INITIAL_THREAD_MESSAGES_PAGE_LIMIT = 128/,
    "cold task switching must keep the first structured-clone payload near one MiB"
  )
  assert.match(
    source,
    /const INITIAL_THREAD_MESSAGES_PAGE_BYTE_BUDGET = 1024 \* 1024/,
    "cold task switching must cap the first worker payload at one MiB"
  )
  const firstPageAwait = loadHistorySource.indexOf(
    "const messagePageResult = await durableMessagePageLoad"
  )
  const metadataAwait = loadHistorySource.indexOf(
    "const threadDetailsResult = await threadDetailsLoad"
  )
  const goalAwait = loadHistorySource.indexOf("const goalEventsResult = await goalEventsLoad")
  const subagentAwait = loadHistorySource.indexOf(
    "const subagentTranscriptResult = await subagentTranscriptLoad"
  )
  assert.ok(
    firstPageAwait >= 0 &&
      metadataAwait > firstPageAwait &&
      goalAwait > firstPageAwait &&
      subagentAwait > firstPageAwait,
    "the bounded main page must be consumed before metadata, goals and subagent hydration"
  )
  const firstPagePublishSource = loadHistorySource.slice(firstPageAwait, metadataAwait)
  assert.match(
    firstPagePublishSource,
    /actions\.setMessages\(visiblePersistedThreadMessages\)/,
    "a non-empty durable page must be published on its first continuation"
  )
  assert.match(
    firstPagePublishSource,
    /historyLoading: keepMainTranscriptLoading/,
    "only main transcript publication may release first-screen history loading"
  )
  assert.match(
    loadHistorySource,
    /foregroundHydrationGeneration\.capture\(threadId\)[\s\S]*foregroundHydrationGeneration\.isCurrent\(foregroundToken\)/,
    "A -> B -> C foreground navigation must fence stale renderer hydration generations"
  )
  const subagentHydrationSource = loadHistorySource.slice(subagentAwait)
  assert.doesNotMatch(
    subagentHydrationSource,
    /historyLoading: false/,
    "subagent and goal readiness must not hold or release main transcript readiness"
  )
  assert.doesNotMatch(
    loadHistorySource,
    /getMessages\(threadId\)|getHistory\(threadId\)/,
    "task switching must not hydrate a full transcript or checkpoint history list"
  )
  assert.match(
    loadHistorySource,
    /messagePageResult\.succeeded &&\s*messagePageResult\.page\.total === 0[\s\S]*bootstrapLegacyCheckpointTranscript\(threadId\)[\s\S]*getLatestCheckpointRuntimeState\(threadId\)/,
    "an empty legacy transcript must be imported through the bounded worker bridge"
  )
  assert.doesNotMatch(
    loadHistorySource,
    /getLatestCheckpoint\(threadId\)/,
    "cold task switching must never clone a complete checkpoint into the renderer"
  )
  assert.match(
    source,
    /loadEarlierMessages: async \(\)[\s\S]*getMessagesPage\(threadId, \{[\s\S]*limit: 500[\s\S]*prependThreadMessagePage/,
    "older durable pages must be reachable through a bounded prepend action"
  )

  const durableSyncStart = source.indexOf("const applyDurableTranscriptSnapshot")
  const durableSyncEnd = source.indexOf(
    "const syncPersistedThreadMessagesAfterStreamStop",
    durableSyncStart
  )
  const durableSyncSource = source.slice(durableSyncStart, durableSyncEnd)
  assert.match(
    durableSyncSource,
    /getMessagesPage\(threadId, \{ limit: 500 \}\)/,
    "stream completion must refresh only the latest bounded durable page"
  )
  assert.doesNotMatch(
    durableSyncSource,
    /getMessages\(threadId\)/,
    "stream completion must never rehydrate the lifetime durable transcript"
  )
  assert.match(
    durableSyncSource,
    /mergeLatestThreadMessagePage\(\s*state\.messages/,
    "latest durable rows must merge into the loaded page window without replacing older pages"
  )
  assert.match(
    durableSyncSource,
    /indexDurableTranscriptRequirements\([\s\S]*requiredMessageIdentities[\s\S]*if \(!durableRequirements\.satisfied\) return false/,
    "a slow durable page must not acknowledge a post-flush live row before its append lands"
  )
  const stoppedSyncStart = source.indexOf(
    "const syncPersistedThreadMessagesAfterStreamStop",
    durableSyncEnd
  )
  const stoppedSyncEnd = source.indexOf(
    "const finalizeRunningSubagentsForStoppedStream",
    stoppedSyncStart
  )
  const stoppedSyncSource = source.slice(stoppedSyncStart, stoppedSyncEnd)
  assert.match(
    stoppedSyncSource,
    /const requiredMessageIdentities =[\s\S]*transitionalLiveMessagesRef\.current\[threadId\]/,
    "stream-stop sync must capture every transitional provider occurrence"
  )
  assert.match(
    stoppedSyncSource,
    /applyDurableTranscriptSnapshot\([\s\S]*requiredMessageIdentities/,
    "stream-stop retries must require every transitional provider occurrence"
  )
  assert.match(
    source,
    /appendMessages\(threadId, messagesToPersist\)[\s\S]*\.then\(\(\) => \{[\s\S]*releaseDurableTransitionalLiveMessages/,
    "a successful append must release the live bridge without waiting for a racing page read"
  )
  assert.match(
    source,
    /const releaseDurableTransitionalLiveMessages[\s\S]*setDehydrationEligibilityRevision/,
    "releasing a ref-only bridge must wake the idle-holder LRU"
  )

  const safeDehydrateStart = source.indexOf("const canDehydrateThread")
  const dehydrateStart = source.indexOf("const dehydrateThread", safeDehydrateStart)
  const holderLruStart = source.indexOf("const evictableIdleHolderIds", dehydrateStart)
  const holderLruEnd = source.indexOf("// 运行态电平校正", holderLruStart)
  assert.ok(
    safeDehydrateStart >= 0 &&
      dehydrateStart > safeDehydrateStart &&
      holderLruStart > dehydrateStart &&
      holderLruEnd > holderLruStart,
    "idle thread dehydration and its LRU must exist"
  )
  const safeDehydrateSource = source.slice(safeDehydrateStart, dehydrateStart)
  const dehydrateSource = source.slice(dehydrateStart, holderLruStart)
  const holderLruSource = source.slice(holderLruStart, holderLruEnd)
  assert.doesNotMatch(
    holderLruSource,
    /threadRegistryRevision/,
    "content-only registry revisions must not rescan holder dehydration eligibility"
  )
  for (const requiredGuard of [
    "threadStateSubscribersRef.current[threadId]",
    "streamSubscribersRef.current[threadId]",
    "hookLogsSubscribersRef.current[threadId]",
    "hasBlockingSpecialThreadActivity",
    "state.historyPageLoading",
    "state.pendingApprovals.length",
    "state.pendingUserInput",
    "state.queuedMessages.length",
    "workflowProgressBufferRef.current.has(threadId)",
    "subagentTranscriptDirtyIdsRef.current[threadId]",
    "subagentTranscriptPendingMessagesRef.current[threadId]",
    "subagentTranscriptPersistChainsRef.current[threadId]",
    "workflowNotificationRetryOnIdleRef.current[threadId]",
    "coordinatorNotificationRetryOnIdleRef.current[threadId]"
  ]) {
    assert.ok(
      safeDehydrateSource.includes(requiredGuard),
      `idle thread dehydration must guard ${requiredGuard}`
    )
  }
  assert.doesNotMatch(
    safeDehydrateSource,
    /isThreadMetadataExplicitNormalMode|environmentCoordinatorThreadIdsRef|state\.scheduledTaskId|state\.draftInput|state\.draftSkill|state\.error\b/,
    "terminal special-task metadata, drafts and error UI must not prevent safe dehydration"
  )
  assert.match(
    safeDehydrateSource,
    /isThreadHistoryHydrationAttemptActive\([\s\S]*hydrationAttemptIsActive &&[\s\S]*state\.historyLoading/,
    "a cancelled foreground hydration shell must not remain permanently outside the idle LRU"
  )
  assert.match(
    dehydrateSource,
    /initializedThreadsRef\.current\.delete\(threadId\)/,
    "a dehydrated thread must reopen through initialization"
  )
  assert.match(
    dehydrateSource,
    /delete actionsCache\.current\[threadId\]/,
    "stale per-thread action closures must be released"
  )
  assert.match(
    dehydrateSource,
    /releaseThreadListeners\(threadId\)/,
    "a dehydrated thread must release its durable IPC listeners"
  )
  assert.match(
    dehydrateSource,
    /createDehydratedThreadStatePatch\(\{[\s\S]*openFiles: state\.openFiles,[\s\S]*activeTab: state\.activeTab/,
    "the holder eviction must apply the shared heavy-state release patch"
  )
  for (const releasedField of [
    "messages: []",
    "toolCallStates: {}",
    "workspaceFiles: []",
    "subagentTranscripts: {}",
    "goalUi: { goal: null",
    "todos: []",
    "subagents: []",
    "coordinatorWorkers: []",
    "subagentInternalLogs: []",
    "fileContents: {}",
    "workflowRun: null"
  ]) {
    assert.ok(
      dehydrationHelperSource.includes(releasedField),
      `dehydration must release the heavy ${releasedField} field`
    )
  }
  assert.match(
    dehydrationHelperSource,
    /openFiles: retainedUi \? \[\.\.\.retainedUi\.openFiles\] : \[\]/,
    "dehydration must retain only lightweight file-tab paths while releasing file contents"
  )
  assert.match(
    source,
    /state\.dehydrated && previousSummary[\s\S]*previousSummary\.kanbanSubagents/,
    "idle eviction must not erase terminal subagent cards from the lightweight Kanban summary"
  )
  assert.doesNotMatch(
    dehydrateSource,
    /\n\s{12}(?:draftInput|draftSkill|error)\s*:/,
    "dehydration must preserve drafts and error UI through the state spread"
  )
  assert.match(
    holderLruSource,
    /MAX_RETAINED_IDLE_STREAM_HOLDERS[\s\S]*dehydrateThread\(threadId\)/,
    "the holder LRU must dehydrate excess safe idle threads, not only normal tasks"
  )

  const initializeStart = source.indexOf("const initializeThread = useCallback")
  const initializeEnd = source.indexOf("const releaseThreadListeners", initializeStart)
  const initializeSource = source.slice(initializeStart, initializeEnd)
  assert.match(
    initializeSource,
    /initializedThreadsRef\.current\.add\(threadId\)[\s\S]*loadThreadHistory\(threadId\)/,
    "reopening a dehydrated thread must reload its durable history"
  )
  assert.match(
    initializeSource,
    /attemptMatchesForeground[\s\S]*!attemptIsCurrent[\s\S]*loadThreadHistory\(threadId\)/,
    "revisiting A after its old foreground generation was cancelled must start a fresh load"
  )
  assert.match(
    initializeSource,
    /threadListenerEpochRef\.current\[threadId\] === listenerEpoch/,
    "queued callbacks from an old listener generation must not mutate a reopened thread"
  )
  assert.match(
    source,
    /new CoordinatorWorkerRequestCache<CoordinatorWorkerView\[\]>\(\)/,
    "history restore and foreground binding must share coordinator worker requests"
  )
  assert.equal(
    dehydrationHelperSource.match(/historyLoading: true/g)?.length ?? 0,
    1,
    "a dehydrated task must not expose a false empty transcript before rehydration"
  )

  console.log("thread context performance contracts passed")
}

void main()
