export const meta = {
  name: "harness-project",
  description:
    "Continue a Harness project Feature from feature_status, executing ordinary stages with one agent and managed serial-cycle stages with peer agents.",
  whenToUse:
    "Use only in a Harness project Feature session after interactive planning is complete. The workflow does not support request_user_input.",
  phases: [{ title: "Inspect", detail: "Execute feature_status through a constrained relay" }]
}

const INSPECT_RELAY_SCHEMA = {
  type: "object",
  properties: {
    stdout: { type: "string" },
    stderr: { type: "string" },
    exitCode: { type: "integer" }
  },
  required: ["stdout", "stderr", "exitCode"],
  additionalProperties: false
}

const PREPARE_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["ready", "complete", "blocked"] },
    cycleId: { type: "string" },
    executeUnits: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 128 },
      maxItems: 64
    },
    message: { type: "string" }
  },
  required: ["outcome", "cycleId", "executeUnits", "message"],
  additionalProperties: false
}

const EXECUTE_SCHEMA = {
  type: "object",
  properties: {
    unitId: { type: "string", minLength: 1, maxLength: 128 },
    outcome: { type: "string", enum: ["completed", "blocked", "failed"] },
    result: { type: "string" },
    blockers: { type: "array", items: { type: "string" }, maxItems: 32 }
  },
  required: ["unitId", "outcome", "result", "blockers"],
  additionalProperties: false
}

const FINALIZE_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["complete", "continue", "blocked"] },
    message: { type: "string" },
    blockers: { type: "array", items: { type: "string" }, maxItems: 32 }
  },
  required: ["outcome", "message", "blockers"],
  additionalProperties: false
}

function parseArgs(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value
  if (typeof value !== "string" || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const input = parseArgs(args)
const config = {
  maxStages: positiveInteger(input.maxStages, 32),
  maxStageCycles: positiveInteger(input.maxStageCycles, 32)
}

function fail(message) {
  throw new Error(`[harness-project] ${message}`)
}

function requireResult(value, label) {
  if (value === null || value === undefined) fail(`${label} agent returned no result`)
  return value
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`)
  return value
}

function asArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`)
  return value.trim()
}

function stateKey(status) {
  return JSON.stringify({
    currentNodeId: status.currentNodeId,
    currentNodeStatus: status.currentNodeStatus,
    actionNodeId: status.actionNodeId,
    slashSkill: status.nextAction.slashSkill,
    terminal: status.terminal,
    executionStrategy: status.executionStrategy
  })
}

function nodeState(node, nodeStatus) {
  const states = Array.isArray(node.states) ? node.states : []
  return states.find((state) => {
    if (!state || typeof state !== "object" || Array.isArray(state)) return false
    return state.nodeStatus === nodeStatus || state.id === nodeStatus
  })
}

function stateNextAction(node, nodeStatus) {
  const state = nodeState(node, nodeStatus)
  if (!state || typeof state.nextAction !== "object" || state.nextAction === null) return null
  const slashSkill =
    typeof state.nextAction.slashSkill === "string" ? state.nextAction.slashSkill : ""
  const userMessage =
    typeof state.nextAction.userMessage === "string" ? state.nextAction.userMessage : ""
  if (!slashSkill.trim()) return null
  return { slashSkill: slashSkill.trim(), userMessage }
}

function strategyForNode(node) {
  const execution =
    node && typeof node.execution === "object" && !Array.isArray(node.execution)
      ? node.execution
      : null
  const strategy =
    execution && execution.strategy !== undefined
      ? nonEmptyString(execution.strategy, `${node.id}.execution.strategy`)
      : "single-agent-v1"
  if (strategy !== "single-agent-v1" && strategy !== "serial-cycle-v1") {
    fail(`unsupported execution strategy for ${node.id}: ${strategy}`)
  }
  return strategy
}

function parseFeatureStatus(rawText) {
  let payload
  try {
    payload = JSON.parse(rawText)
  } catch (error) {
    fail(
      `feature_status returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const root = asObject(payload, "feature_status")
  const workflow = asObject(root.workflow, "feature_status.workflow")
  const run = asObject(root.run, "feature_status.run")
  const workflowNodes = asArray(workflow.nodes, "feature_status.workflow.nodes")
  const runNodes = asArray(run.nodes, "feature_status.run.nodes")
  const currentNodeId = nonEmptyString(run.currentNodeId, "feature_status.run.currentNodeId")
  const currentIndex = workflowNodes.findIndex((node) => node && node.id === currentNodeId)
  if (currentIndex < 0) fail(`current node ${currentNodeId} is absent from workflow.nodes`)

  const currentNode = asObject(workflowNodes[currentIndex], `workflow node ${currentNodeId}`)
  const currentRunNode = runNodes.find((node) => node && node.id === currentNodeId)
  const currentNodeStatus = nonEmptyString(
    currentRunNode && currentRunNode.nodeStatus !== undefined
      ? currentRunNode.nodeStatus
      : run.currentNodeStatus,
    `run status for ${currentNodeId}`
  )
  const currentNextAction = stateNextAction(currentNode, currentNodeStatus)
  const terminalStatus = currentNodeStatus === "done" || currentNodeStatus === "archived"
  const remainingNodes = workflowNodes.slice(currentIndex + 1).filter((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false
    const runNode = runNodes.find((candidate) => candidate && candidate.id === node.id)
    return !runNode || (runNode.nodeStatus !== "skipped" && runNode.nodeStatus !== "archived")
  })
  const terminal = terminalStatus && remainingNodes.length === 0

  if (terminal) {
    return {
      currentNodeId,
      currentNodeStatus,
      actionNodeId: "",
      terminal: true,
      runnable: false,
      reason: "",
      nextAction: currentNextAction || { slashSkill: "", userMessage: "" },
      executionStrategy: "single-agent-v1"
    }
  }

  let actionNode = currentNode
  let nextAction = currentNextAction
  if (terminalStatus) {
    if (!currentNextAction) fail(`done node ${currentNodeId} has no nextAction`)
    actionNode = remainingNodes.find((candidate) => {
      const runNode = runNodes.find((node) => node && node.id === candidate.id)
      const status =
        runNode && typeof runNode.nodeStatus === "string" ? runNode.nodeStatus : "not_started"
      const candidateAction =
        stateNextAction(candidate, status) || stateNextAction(candidate, "not_started")
      return candidateAction && candidateAction.slashSkill === currentNextAction.slashSkill
    })
    if (!actionNode) {
      fail(`cannot resolve successor of ${currentNodeId} for ${currentNextAction.slashSkill}`)
    }
    const actionRunNode = runNodes.find((node) => node && node.id === actionNode.id)
    const actionStatus =
      actionRunNode && typeof actionRunNode.nodeStatus === "string"
        ? actionRunNode.nodeStatus
        : "not_started"
    nextAction =
      stateNextAction(actionNode, actionStatus) || stateNextAction(actionNode, "not_started")
  }

  if (!nextAction) fail(`action node ${actionNode.id} has no nextAction for its inspected state`)
  const actionNodeId = nonEmptyString(actionNode.id, "action node id")
  return {
    currentNodeId,
    currentNodeStatus,
    actionNodeId,
    terminal: false,
    runnable: true,
    reason: "",
    nextAction,
    executionStrategy: strategyForNode(actionNode)
  }
}

async function inspectFeatureStatus(inspectSequence) {
  phase("Inspect")
  const relay = requireResult(
    await agent(
      `Harness project inspect relay #${inspectSequence}.

This is a read-only transport operation. Do not modify files, artifacts, checkpoints, or source code.

The following uppercase names are process environment variables already exported to every execute command. They are authoritative runtime context, not prose placeholders:
- PLUGIN_ROOT is the active plugin root.
- PLUGIN_WORKSPACE is the Harness workspace root, not the project directory.
- PROJECT_DIR is the project directory relative to PLUGIN_WORKSPACE.
- FEATURE_ID is the active Feature ID.
- PROJECT_CODE is the active project code when a template needs it.

Do not discover, print, infer, or reconstruct their values. Render config placeholders as quoted environment-variable references using the current shell syntax. On macOS/Linux use exactly:
- \${pluginPath} -> "$PLUGIN_ROOT"
- \${pluginWorkspace} -> "$PLUGIN_WORKSPACE"
- \${project} or \${projectDir} -> "$PROJECT_DIR"
- \${projectCode} -> "$PROJECT_CODE"
- \${feature} -> "$FEATURE_ID"
On Windows PowerShell use the equivalent quoted $env:NAME references.

Perform exactly this protocol:
1. Read PLUGIN_ROOT/board_core/board_config.json.
2. Select inspectCommands for the current operating system. Use workflow_feature_status when it is a non-empty string; otherwise fall back to feature_status for plugins that have not added the compact command.
3. Render and execute the selected command exactly once using only the mapping above.
4. Do not run discovery, printenv, pwd, listing, diagnostics, fallback, or retry commands.
5. Do not read state.json, PROJECT.md, Feature artifacts, inspect_state.py source, checkpoint storage, hooks, Skills, or prior messages.
6. Do not parse or explain stdout. Return stdout, stderr, and exitCode exactly through the required structured result. If execution cannot start, return empty stdout, the exact failure in stderr, and a non-zero exitCode.

Return only the required structured result.`,
      { label: `inspect:${inspectSequence}`, phase: "Inspect", schema: INSPECT_RELAY_SCHEMA }
    ),
    `inspect relay #${inspectSequence}`
  )
  if (relay.exitCode !== 0) {
    fail(
      `workflow status inspect failed with exit ${relay.exitCode}: ${relay.stderr || "no stderr"}`
    )
  }
  return parseFeatureStatus(relay.stdout)
}

function featurePathInstruction() {
  return "Resolve every Feature artifact path referenced by the Skill against FEATURE_DIR from ## Skills Runtime Context. Do not resolve Feature artifacts against the session workspace root."
}

async function runSingleStage(status, stageSequence) {
  phase(status.actionNodeId)
  const result = await agent(
    `Execute exactly one Harness plugin stage.

Action node: ${status.actionNodeId}
Required Skill: ${status.nextAction.slashSkill}
Plugin nextAction message: ${status.nextAction.userMessage}
Stage sequence: ${stageSequence}

Read and follow the required Skill. Preserve its existing prompt rules, hooks, artifacts, validations, write boundaries, and checkpoint transition. Complete only this stage; do not start the next workflow stage even if the Skill suggests opening or continuing a conversation.

${featurePathInstruction()}

This Workflow leaf cannot start nested task agents. If the Skill defines an inline fallback for an unavailable task tool, use that fallback in the original order. This autonomous project Workflow does not provide request_user_input. If a genuine decision cannot be resolved from existing artifacts and rules, stop with a concise blocker; never invent a user decision.`,
    {
      label: `${status.actionNodeId}:Stage:${stageSequence}`,
      phase: status.actionNodeId
    }
  )
  requireResult(result, `stage ${status.actionNodeId}`)
}

function cycleLabel(cycleNumber) {
  return `C${String(cycleNumber).padStart(2, "0")}`
}

function validateCycleProjection(projection, status, cycleNumber) {
  if (projection.outcome === "blocked") {
    fail(`stage ${status.actionNodeId} prepare blocked: ${projection.message || "no reason"}`)
  }
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
  if (!idPattern.test(projection.cycleId)) {
    fail(`stage ${status.actionNodeId} cycle ${cycleNumber} returned unsafe cycleId`)
  }
  if (projection.outcome === "ready" && projection.executeUnits.length === 0) {
    fail(`stage ${status.actionNodeId} cycle ${projection.cycleId} is ready without execute units`)
  }
  if (projection.outcome === "complete" && projection.executeUnits.length > 0) {
    fail(
      `stage ${status.actionNodeId} cycle ${projection.cycleId} is complete but has execute units`
    )
  }
  const seen = new Set()
  for (const unitId of projection.executeUnits) {
    if (!idPattern.test(unitId)) {
      fail(`stage ${status.actionNodeId} cycle ${projection.cycleId} returned unsafe unitId`)
    }
    if (seen.has(unitId)) {
      fail(
        `stage ${status.actionNodeId} cycle ${projection.cycleId} returned duplicate unit ${unitId}`
      )
    }
    seen.add(unitId)
  }
}

async function prepareCycle(status, stageSequence, cycleNumber) {
  const label = cycleLabel(cycleNumber)
  return requireResult(
    await agent(
      `Prepare one managed serial Cycle for a Harness plugin stage.

Action node: ${status.actionNodeId}
Required Skill: ${status.nextAction.slashSkill}
Plugin nextAction message: ${status.nextAction.userMessage}
Stage sequence: ${stageSequence}
Cycle sequence: ${cycleNumber}

Read and follow the required Skill, then apply this control envelope:
<harness-project-workflow protocol="serial-cycle-v1" mode="prepare" cycle-sequence="${cycleNumber}">
Run the Skill's original admission, recovery, and Cycle-selection rules. Project only the current plugin-owned Cycle into a stable cycleId and an ordered list of executeUnits. Do not execute a unit, compile/finalize a Batch, perform stage review, or advance the stage completion checkpoint. executeUnits are Skill-owned identifiers, not PLAN Tasks, and must not contain prompts or dependencies.
</harness-project-workflow>

${featurePathInstruction()}

This Workflow does not provide request_user_input. Return outcome="blocked" for an unresolved human decision. Return only the required structured result.`,
      {
        label: `${status.actionNodeId}:Prepare:${label}`,
        phase: status.actionNodeId,
        schema: PREPARE_SCHEMA
      }
    ),
    `prepare ${status.actionNodeId} ${label}`
  )
}

async function executeUnit(status, projection, unitId, stageSequence, cycleNumber) {
  return requireResult(
    await agent(
      `Execute one plugin-owned unit from a managed serial Cycle.

Action node: ${status.actionNodeId}
Required Skill: ${status.nextAction.slashSkill}
Cycle ID: ${projection.cycleId}
Unit ID: ${unitId}
Stage sequence: ${stageSequence}
Cycle sequence: ${cycleNumber}

Read and follow the required Skill, then apply this control envelope:
<harness-project-workflow protocol="serial-cycle-v1" mode="execute-unit" cycle-id="${projection.cycleId}" unit-id="${unitId}" cycle-sequence="${cycleNumber}">
Execute exactly this Skill-owned unit under the Skill's existing business rules. Preserve its hooks, runner, evidence, artifact, validation, write-boundary, and recovery behavior. Do not execute another unit, do not perform the Cycle Finalize role, and do not advance the stage completion checkpoint unless the Skill explicitly defines that this unit owns it.
</harness-project-workflow>

${featurePathInstruction()}

This Workflow does not provide request_user_input. Return outcome="blocked" for an unresolved human decision. Return only the required structured result, with unitId exactly "${unitId}".`,
      {
        label: `${status.actionNodeId}:Execute:${unitId}:${cycleLabel(cycleNumber)}`,
        phase: status.actionNodeId,
        schema: EXECUTE_SCHEMA
      }
    ),
    `execute ${status.actionNodeId} ${unitId}`
  )
}

function assertExecuteResult(status, unitId, result) {
  if (result.unitId !== unitId) {
    fail(`stage ${status.actionNodeId} unit returned id ${result.unitId}; expected ${unitId}`)
  }
  if (result.outcome !== "completed") {
    const detail = result.blockers.length > 0 ? result.blockers.join("; ") : result.result
    fail(`stage ${status.actionNodeId} unit ${unitId} ${result.outcome}: ${detail}`)
  }
}

function boundedResult(value) {
  const text = typeof value === "string" ? value : ""
  const limit = 16000
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated by workflow]`
}

async function finalizeCycle(status, projection, unitResults, stageSequence, cycleNumber) {
  const compactResults = unitResults.map((result) => ({
    unitId: result.unitId,
    outcome: result.outcome,
    result: boundedResult(result.result),
    blockers: result.blockers
  }))
  return requireResult(
    await agent(
      `Finalize one managed serial Cycle for a Harness plugin stage.

Action node: ${status.actionNodeId}
Required Skill: ${status.nextAction.slashSkill}
Plugin nextAction message: ${status.nextAction.userMessage}
Cycle ID: ${projection.cycleId}
Stage sequence: ${stageSequence}
Cycle sequence: ${cycleNumber}
Ordered peer results: ${JSON.stringify(compactResults)}

Read and follow the required Skill, then apply this control envelope:
<harness-project-workflow protocol="serial-cycle-v1" mode="finalize" cycle-id="${projection.cycleId}" cycle-sequence="${cycleNumber}">
Finalize only this Cycle using the Skill's persisted state and the ordered peer results. Preserve the Skill's original compile/repair, review classification, artifact, validation, handoff, stage-gate, and checkpoint rules. Return outcome="continue" when the current stage intentionally requires a fresh Prepare Cycle, including a next Batch or a fresh independent review. Return outcome="complete" only after the original stage completion checkpoint succeeds. Return outcome="blocked" for an unresolved human decision or non-recoverable condition. Do not consume a next-Batch handoff after completing the current Batch Cycle.
</harness-project-workflow>

${featurePathInstruction()}

This Workflow does not provide request_user_input. Return only the required structured result.`,
      {
        label: `${status.actionNodeId}:Finalize:${projection.cycleId}:${cycleLabel(cycleNumber)}`,
        phase: status.actionNodeId,
        schema: FINALIZE_SCHEMA
      }
    ),
    `finalize ${status.actionNodeId} ${projection.cycleId}`
  )
}

let inspectSequence = 1

async function inspectNext() {
  inspectSequence += 1
  return inspectFeatureStatus(inspectSequence)
}

async function runSerialCycleStage(initialStatus, stageSequence) {
  let before = initialStatus
  phase(before.actionNodeId)
  for (let cycleNumber = 1; cycleNumber <= config.maxStageCycles; cycleNumber += 1) {
    log(
      `Serial Cycle ${cycleNumber}/${config.maxStageCycles} for ${before.actionNodeId} via ${before.nextAction.slashSkill}`
    )
    const projection = await prepareCycle(before, stageSequence, cycleNumber)
    validateCycleProjection(projection, before, cycleNumber)

    const unitResults = []
    for (const unitId of projection.executeUnits) {
      const result = await executeUnit(before, projection, unitId, stageSequence, cycleNumber)
      assertExecuteResult(before, unitId, result)
      unitResults.push(result)
    }

    const finalization = await finalizeCycle(
      before,
      projection,
      unitResults,
      stageSequence,
      cycleNumber
    )
    if (finalization.outcome === "blocked") {
      fail(
        `stage ${before.actionNodeId} cycle ${projection.cycleId} blocked: ${
          finalization.blockers.join("; ") || finalization.message
        }`
      )
    }

    const after = await inspectNext()
    if (after.terminal || after.actionNodeId !== before.actionNodeId) {
      log(
        `Harness progress: ${before.currentNodeId}/${before.currentNodeStatus} -> ${after.currentNodeId}/${after.currentNodeStatus}`
      )
      return after
    }
    if (finalization.outcome === "complete") {
      fail(
        `stage ${before.actionNodeId} cycle ${projection.cycleId} reported complete without inspected state progress`
      )
    }
    log(
      `Stage ${before.actionNodeId} continues after cycle ${projection.cycleId}: ${finalization.message}`
    )
    before = after
    phase(before.actionNodeId)
  }
  fail(`stage ${initialStatus.actionNodeId} exceeded ${config.maxStageCycles} serial cycles`)
}

let status = await inspectFeatureStatus(inspectSequence)

for (let stageSequence = 1; stageSequence <= config.maxStages; stageSequence += 1) {
  if (status.terminal) {
    log(`Harness project workflow reached terminal state at ${status.currentNodeId}`)
    return {
      status: "complete",
      stagesExecuted: stageSequence - 1,
      currentNodeId: status.currentNodeId,
      currentNodeStatus: status.currentNodeStatus
    }
  }
  if (!status.runnable) {
    fail(`inspect marked state unrunnable: ${status.reason || stateKey(status)}`)
  }

  const before = status
  log(
    `Stage ${stageSequence}/${config.maxStages}: ${before.actionNodeId} via ${before.nextAction.slashSkill} (${before.executionStrategy})`
  )

  if (before.executionStrategy === "serial-cycle-v1") {
    status = await runSerialCycleStage(before, stageSequence)
    continue
  }

  await runSingleStage(before, stageSequence)
  status = await inspectNext()
  if (stateKey(before) === stateKey(status)) {
    fail(`stage ${before.actionNodeId} completed without inspected state progress`)
  }
  log(
    `Harness progress: ${before.currentNodeId}/${before.currentNodeStatus} -> ${status.currentNodeId}/${status.currentNodeStatus}`
  )
}

fail(`workflow exceeded ${config.maxStages} stages`)
