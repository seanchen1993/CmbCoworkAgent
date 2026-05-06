/**
 * Unit tests for coordinator mode prompt and tool wiring.
 *
 * Run:
 *   npx -y tsx tests/coordinator-mode.spec.ts
 */

import {
  adaptCoordinatorSkillUseForWorkerDelegation,
  buildCoordinatorSystemPrompt,
  buildCoordinatorTaskPrompt,
  buildCoordinatorWorkerSubagents,
  createCoordinatorWorkerTools,
  extractCoordinatorSelectedSkill,
  getAgentModeFromMetadata,
  resolveCoordinatorModeRequest
} from "../src/main/agent/coordinator-mode.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function assertIncludes(value: string, expected: string, label: string): void {
  assert(value.includes(expected), `${label}: expected to include "${expected}"`)
}

function assertNotIncludes(value: string, unexpected: string, label: string): void {
  assert(!value.includes(unexpected), `${label}: expected not to include "${unexpected}"`)
}

async function invokeTool(tool: unknown, input: Record<string, unknown>): Promise<string> {
  const result = await (tool as { invoke: (args: unknown) => Promise<unknown> }).invoke(input)
  return typeof result === "string" ? result : JSON.stringify(result)
}

async function testModeDetection(): Promise<void> {
  const oldCoordinatorEnv = process.env.CMB_COORDINATOR_MODE
  delete process.env.CMB_COORDINATOR_MODE

  assert(getAgentModeFromMetadata({}) === "normal", "empty metadata should default to normal")
  assert(
    getAgentModeFromMetadata({ agentMode: "coordinator" }) === "coordinator",
    "agentMode metadata should enable coordinator"
  )
  assert(
    getAgentModeFromMetadata({ coordinatorMode: "true" }) === "coordinator",
    "string coordinatorMode metadata should enable coordinator"
  )
  assert(
    getAgentModeFromMetadata({ agentMode: "normal", coordinatorMode: false }) === "normal",
    "normal metadata should stay normal"
  )
  assert(
    getAgentModeFromMetadata({ agentMode: "normal", coordinatorMode: true }) === "normal",
    "explicit normal metadata should override legacy coordinatorMode"
  )

  const prefixed = resolveCoordinatorModeRequest("[coordinator] build a todo app", {})
  assert(prefixed.enabled === true, "message prefix should enable coordinator")
  assert(prefixed.shouldPersist === true, "message prefix should request persistence")
  assert(prefixed.message === "build a todo app", "message prefix should be stripped")

  const hashPrefixed = resolveCoordinatorModeRequest("  #coordinator: add auth", {})
  assert(hashPrefixed.enabled === true, "#coordinator prefix should enable coordinator")
  assert(hashPrefixed.message === "add auth", "#coordinator prefix should be stripped")

  const metadata = resolveCoordinatorModeRequest("build a todo app", {
    agentMode: "coordinator"
  })
  assert(metadata.enabled === true, "metadata should enable coordinator")
  assert(metadata.shouldPersist === false, "metadata mode should not force a metadata rewrite")

  const legacyHarnessPrefix = resolveCoordinatorModeRequest("[harness] build a todo app", {})
  assert(legacyHarnessPrefix.enabled === false, "legacy harness prefix should not enable coordinator")
  assert(
    legacyHarnessPrefix.message === "[harness] build a todo app",
    "legacy harness prefix should remain normal text"
  )

  const legacyHarnessMetadata = resolveCoordinatorModeRequest("build a todo app", {
    harnessMode: true
  })
  assert(
    legacyHarnessMetadata.enabled === false,
    "legacy harnessMode metadata should not enable coordinator"
  )

  const normal = resolveCoordinatorModeRequest("build a todo app", { agentMode: "normal" })
  assert(normal.enabled === false, "normal metadata should not enable coordinator")
  assert(normal.message === "build a todo app", "normal message should be unchanged")

  process.env.CMB_COORDINATOR_MODE = "1"
  const envEnabled = resolveCoordinatorModeRequest("build a todo app", {})
  assert(envEnabled.enabled === true, "env var should enable coordinator")
  assert(envEnabled.shouldPersist === false, "env var should not persist mode")
  assert(envEnabled.source === "environment", "env var should be marked as environment source")
  const envBeatsMetadata = resolveCoordinatorModeRequest("build a todo app", {
    agentMode: "coordinator"
  })
  assert(
    envBeatsMetadata.source === "environment",
    "env var should be treated as a forced coordinator source before metadata"
  )

  if (oldCoordinatorEnv === undefined) delete process.env.CMB_COORDINATOR_MODE
  else process.env.CMB_COORDINATOR_MODE = oldCoordinatorEnv
}

async function testPromptContracts(): Promise<void> {
  const threadId = "thread-123"
  const timeContext = {
    timezone: "Asia/Shanghai",
    currentTime: "2026-04-28T16:30:00+08:00"
  }
  const prompt = buildCoordinatorSystemPrompt({
    threadId,
    workspacePath: "/tmp/workspace",
    platform: "macOS",
    shell: "zsh",
    ...timeContext,
    projectInstructions: "PROJECT_RULE",
    turnContext: "TURN_CONTEXT_RULE",
    hasBrowserTool: true,
    hasCodeExecTool: true,
    deferredToolIds: ["github.search"]
  })

  assertIncludes(prompt, "CmbCowork Coordinator Mode", "coordinator prompt")
  assertIncludes(prompt, "Every message you send is to the user", "coordinator prompt")
  assertIncludes(prompt, "internal signals", "coordinator prompt")
  assertIncludes(prompt, "Answer directly when possible", "coordinator prompt")
  assertIncludes(prompt, "start_worker", "coordinator prompt")
  assertIncludes(prompt, "continue_worker", "coordinator prompt")
  assertIncludes(prompt, "cancel_worker", "coordinator prompt")
  assertIncludes(prompt, "read_worker_state", "coordinator prompt")
  assertIncludes(prompt, "read_worker_result", "coordinator prompt")
  assertIncludes(
    prompt,
    "coordinator main thread does not load full skill instructions",
    "coordinator prompt"
  )
  assertIncludes(prompt, "delegate skill invocations to workers", "coordinator prompt")
  assertIncludes(prompt, "summary is insufficient", "coordinator prompt")
  assertIncludes(prompt, "Worker Notifications", "coordinator prompt")
  assertIncludes(prompt, "Use the task-id as the worker_id", "coordinator prompt")
  assertIncludes(prompt, "notification_id", "coordinator prompt")
  assertIncludes(prompt, "consumed_notification_ids", "coordinator prompt")
  assertIncludes(prompt, "mark_notifications_handled", "coordinator prompt")
  assertIncludes(prompt, "Do not call read_worker_state repeatedly", "coordinator prompt")
  assertIncludes(
    prompt,
    'workload="verify" for independent verification',
    "coordinator prompt should distinguish verifier command workers from read-only research"
  )
  assertIncludes(
    prompt,
    'Never combine role="verifier" with workload="write"',
    "coordinator prompt should keep verifier workers independent"
  )
  assertIncludes(
    prompt,
    "verify workers can run validation commands",
    "coordinator prompt should allow verifier runtime checks"
  )
  assertIncludes(
    prompt,
    "may write only to /tmp or $TMPDIR",
    "coordinator prompt should align verifier command execution with Claude Code tmp-only write guidance"
  )
  assertIncludes(
    prompt,
    "omitted for a write worker, it is treated as owning the whole workspace",
    "coordinator prompt should explain omitted owned_files write-worker semantics"
  )
  assertIncludes(
    prompt,
    "If the same write worker must run build/test/browser checks itself, omit owned_files",
    "coordinator prompt should distinguish scoped editors from unrestricted writers"
  )
  assertIncludes(
    prompt,
    "shell execution, browser_playwright, and deferred execution are disabled",
    "coordinator prompt should explain why owned_files writers cannot self-run runtime checks"
  )
  assertIncludes(prompt, "Launch independent read-only workers in parallel", "coordinator prompt")
  assertIncludes(prompt, "Keep write-heavy workers one at a time", "coordinator prompt")
  assertIncludes(prompt, "Workers cannot see your conversation", "coordinator prompt")
  assertIncludes(prompt, "Never write lazy prompts", "coordinator prompt")
  assertIncludes(prompt, "Do not report success from implementer output alone", "coordinator prompt")
  assertIncludes(prompt, "concrete evidence", "coordinator prompt")
  assertIncludes(prompt, "Current time: 2026-04-28T16:30:00+08:00", "coordinator prompt")
  assertIncludes(prompt, "Do not invent dates or timestamps", "coordinator prompt")
  assertIncludes(prompt, "browser_playwright", "coordinator prompt")
  assertIncludes(prompt, "github.search", "coordinator prompt")
  assertIncludes(prompt, "PROJECT_RULE", "coordinator prompt")
  assertIncludes(prompt, "## Current Turn Internal Context", "coordinator prompt")
  assertIncludes(prompt, "TURN_CONTEXT_RULE", "coordinator prompt")
  assertIncludes(prompt, 'subagent_type="worker"', "coordinator prompt")
  assertIncludes(
    prompt,
    "If the user selected a skill",
    "coordinator prompt should delegate selected skills to workers"
  )
  assertIncludes(
    prompt,
    "Use the /<skill name> skill",
    "coordinator prompt should match Claude Code skill delegation wording"
  )
  assertNotIncludes(prompt, "worker_type", "coordinator prompt should not expose old worker_type API")
  assertNotIncludes(prompt, "Call task", "coordinator prompt should not tell model to use task")
  assertNotIncludes(prompt, "read_harness_state", "coordinator prompt should not expose old state tools")
  assertNotIncludes(prompt, "write_harness_state", "coordinator prompt should not expose old state tools")
  assertNotIncludes(prompt, "check_verification_gate", "coordinator prompt should not expose old gate")
  assertNotIncludes(prompt, "spec.md", "coordinator prompt should not require old spec file")
  assertNotIncludes(prompt, "contract.json", "coordinator prompt should not require old contract file")
  assertNotIncludes(prompt, "progress.md", "coordinator prompt should not require old progress file")
  assertNotIncludes(
    prompt,
    "reports/implementer-latest.json",
    "coordinator prompt should not require old implementer report"
  )
  assertNotIncludes(
    prompt,
    "reports/latest-verification.json",
    "coordinator prompt should not require old verifier report"
  )

  const fallbackPrompt = buildCoordinatorSystemPrompt({
    threadId,
    workspacePath: "/tmp/workspace",
    platform: "Linux",
    shell: "bash",
    ...timeContext,
    hasBrowserTool: false,
    hasCodeExecTool: false,
    deferredToolIds: []
  })
  assertIncludes(
    fallbackPrompt,
    "Browser/runtime verification may not be available",
    "coordinator prompt fallback"
  )
  assertIncludes(fallbackPrompt, "code_exec is not available", "coordinator prompt fallback")
  assertIncludes(
    fallbackPrompt,
    "No deferred worker tools are currently registered",
    "coordinator prompt fallback"
  )
  assertNotIncludes(fallbackPrompt, "## Project Instructions", "coordinator prompt fallback")

  const taskPrompt = buildCoordinatorTaskPrompt(threadId)
  assertIncludes(taskPrompt, "coordinator worker launcher", "task prompt")
  assertIncludes(taskPrompt, "async worker tools", "task prompt")
  assertIncludes(taskPrompt, "Answer directly when possible", "task prompt")
  assertIncludes(taskPrompt, 'subagent_type="worker"', "task prompt")
  assertIncludes(taskPrompt, 'role="verifier"', "task prompt")
  assertIncludes(taskPrompt, "Launch independent read-only workers in parallel", "task prompt")
  assertIncludes(
    taskPrompt,
    "If the same write worker must run build/test/browser checks itself, omit owned_files",
    "task prompt should tell the coordinator when to use unrestricted write workers"
  )
  assertIncludes(taskPrompt, "Do not poll workers", "task prompt")
  assertIncludes(taskPrompt, "end the turn", "task prompt")
  assertNotIncludes(taskPrompt, "worker_type", "task prompt should not expose old worker_type API")
  assertNotIncludes(taskPrompt, "spec.md", "task prompt should not require old spec file")
  assertNotIncludes(taskPrompt, "check_verification_gate", "task prompt should not expose old gate")
}

async function testSkillUseDelegation(): Promise<void> {
  const message =
    "请按这个技能整理发布说明。\n\n" +
    "<CMBDEVCLAW-SKILL-USE-V1>\n" +
    "<instruction>请先读技能。</instruction>\n" +
    "<name>release-notes</name>\n" +
    "<description>Generate release notes from project changes.</description>\n" +
    "<when_to_use>When the user asks for release notes.</when_to_use>\n" +
    "<allowed_tools>read_file, grep</allowed_tools>\n" +
    "<path>/tmp/skills/release-notes/SKILL.md</path>\n" +
    "</CMBDEVCLAW-SKILL-USE-V1>"

  const adapted = adaptCoordinatorSkillUseForWorkerDelegation(message)
  assertIncludes(adapted, "请按这个技能整理发布说明。", "coordinator skill delegation")
  assertIncludes(
    adapted,
    'The user selected the "release-notes" skill',
    "coordinator skill delegation"
  )
  assertIncludes(
    adapted,
    "Description: Generate release notes from project changes.",
    "coordinator skill delegation"
  )
  assertIncludes(
    adapted,
    "When to use: When the user asks for release notes.",
    "coordinator skill delegation"
  )
  assertIncludes(
    adapted,
    "additional tool permissions: read_file, grep",
    "coordinator skill delegation"
  )
  assertIncludes(adapted, "MUST start or continue a worker", "coordinator skill delegation")
  assertIncludes(
    adapted,
    "The user explicitly selected the /release-notes skill",
    "coordinator skill delegation"
  )
  assertIncludes(
    adapted,
    "First use read_file to read /tmp/skills/release-notes/SKILL.md",
    "coordinator skill delegation"
  )
  assertIncludes(
    adapted,
    "strictly follow that SKILL.md",
    "coordinator skill delegation"
  )
  assertIncludes(
    adapted,
    "Worker runtimes receive enabled skills",
    "coordinator skill delegation"
  )
  assertNotIncludes(adapted, "<CMBDEVCLAW-SKILL-USE-V1>", "coordinator skill delegation")

  const literalText = "用户正文里提到 <CMBDEVCLAW-SKILL-USE-V1> 但没有尾部协议块"
  assert(
    adaptCoordinatorSkillUseForWorkerDelegation(literalText) === literalText,
    "non-protocol skill text should stay unchanged"
  )
}

async function testSelectedSkillPromptInjection(): Promise<void> {
  const selectedSkill = extractCoordinatorSelectedSkill(
    "请按技能执行。\n\n" +
      "<CMBDEVCLAW-SKILL-USE-V1>\n" +
      "<name>release-notes</name>\n" +
      "<description>Generate release notes from project changes.</description>\n" +
      "<when_to_use>When the user asks for release notes.</when_to_use>\n" +
      "<allowed_tools>read_file, grep</allowed_tools>\n" +
      "<path>/tmp/skills/release-notes/SKILL.md</path>\n" +
      "</CMBDEVCLAW-SKILL-USE-V1>"
  )
  assert(selectedSkill, "selected skill should be parsed from coordinator skill marker")

  const delegatedPrompts: string[] = []
  const tools = createCoordinatorWorkerTools({
    workspacePath: "/tmp/workspace",
    threadId: "thread-123",
    selectedSkill: selectedSkill ?? undefined,
    workerTools: {
      async startWorker(input) {
        delegatedPrompts.push(input.prompt)
        return {
          worker_id: "implementer-1",
          worker_thread_id: "thread-123__worker__implementer-1",
          parent_thread_id: "thread-123",
          role: input.role,
          workload: input.workload ?? "write",
          owned_files: input.ownedFiles ?? [],
          description: input.description,
          status: "running",
          turns: 1,
          created_at: "2026-04-28T16:30:00+08:00",
          updated_at: "2026-04-28T16:30:00+08:00",
          tool_call_count: 0,
          last_event: "Worker started."
        } as never
      },
      async continueWorker(input) {
        delegatedPrompts.push(input.prompt)
        return {
          worker_id: input.workerId,
          worker_thread_id: `thread-123__worker__${input.workerId}`,
          parent_thread_id: "thread-123",
          role: "implementer",
          workload: input.workload ?? "write",
          owned_files: input.ownedFiles ?? [],
          description: "continued",
          status: "running",
          turns: 2,
          created_at: "2026-04-28T16:30:00+08:00",
          updated_at: "2026-04-28T16:31:00+08:00",
          tool_call_count: 0,
          last_event: "Worker continued."
        } as never
      },
      async readWorkerState() {
        return [] as never
      },
      async readWorkerResult() {
        throw new Error("unused")
      },
      async cancelWorker() {
        return [] as never
      }
    }
  })

  const startTool = tools.find((tool) => tool.name === "start_worker")
  const continueTool = tools.find((tool) => tool.name === "continue_worker")
  assert(startTool && continueTool, "selected skill injection test requires worker tools")

  await invokeTool(startTool, {
    subagent_type: "worker",
    role: "implementer",
    description: "Implement feature",
    prompt: "Do the work"
  })
  await invokeTool(continueTool, {
    worker_id: "implementer-1",
    prompt: "Finish the task"
  })
  await invokeTool(startTool, {
    subagent_type: "worker",
    role: "implementer",
    description: "Implement feature with partial skill hint",
    prompt: "Use the /release-notes skill and then do the work."
  })

  const notificationDelegatedPrompts: string[] = []
  const notificationTools = createCoordinatorWorkerTools({
    workspacePath: "/tmp/workspace",
    threadId: "thread-123",
    notificationSelectedSkills: {
      "implementer-1@turn-1": selectedSkill ?? undefined
    },
    workerTools: {
      async startWorker(input) {
        notificationDelegatedPrompts.push(input.prompt)
        return {
          worker_id: "verifier-1",
          worker_thread_id: "thread-123__worker__verifier-1",
          parent_thread_id: "thread-123",
          role: input.role,
          workload: input.workload ?? "verify",
          owned_files: input.ownedFiles ?? [],
          description: input.description,
          status: "running",
          turns: 1,
          created_at: "2026-04-28T16:32:00+08:00",
          updated_at: "2026-04-28T16:32:00+08:00",
          tool_call_count: 0,
          last_event: "Worker started."
        } as never
      },
      async continueWorker(input) {
        notificationDelegatedPrompts.push(input.prompt)
        return {
          worker_id: input.workerId,
          worker_thread_id: `thread-123__worker__${input.workerId}`,
          parent_thread_id: "thread-123",
          role: "implementer",
          workload: input.workload ?? "write",
          owned_files: input.ownedFiles ?? [],
          description: "continued",
          status: "running",
          turns: 2,
          created_at: "2026-04-28T16:30:00+08:00",
          updated_at: "2026-04-28T16:33:00+08:00",
          tool_call_count: 0,
          last_event: "Worker continued."
        } as never
      },
      async readWorkerState() {
        return [] as never
      },
      async readWorkerResult() {
        throw new Error("unused")
      },
      async cancelWorker() {
        return [] as never
      }
    }
  })
  const notificationStartTool = notificationTools.find((tool) => tool.name === "start_worker")
  assert(notificationStartTool, "notification selected skill injection test requires start_worker")
  await invokeTool(notificationStartTool, {
    subagent_type: "worker",
    role: "verifier",
    consumed_notification_ids: ["implementer-1@turn-1"],
    description: "Verify feature",
    prompt: "Double-check the result"
  })

  assert(
    delegatedPrompts.length === 3,
    "selected skill should be injected for direct worker start/continue"
  )
  for (const prompt of [...delegatedPrompts, ...notificationDelegatedPrompts]) {
    assertIncludes(
      prompt,
      "[[CMB_COORDINATOR_SELECTED_SKILL_V1]]",
      "selected skill worker prompt"
    )
    assertIncludes(
      prompt,
      "The user explicitly selected the /release-notes skill",
      "selected skill worker prompt"
    )
    assertIncludes(
      prompt,
      "First use read_file to read /tmp/skills/release-notes/SKILL.md",
      "selected skill worker prompt"
    )
  }
  assert(
    notificationDelegatedPrompts.length === 1,
    "notification-selected skill should also inject when the coordinator does not carry a turn-global selected skill"
  )

  const explicitFallbackPrompts: string[] = []
  const explicitFallbackTools = createCoordinatorWorkerTools({
    workspacePath: "/tmp/workspace",
    threadId: "thread-123",
    explicitSelectedSkill: selectedSkill ?? undefined,
    notificationSelectedSkills: {
      "implementer-1@turn-1": selectedSkill ?? undefined,
      "implementer-2@turn-1": undefined
    },
    workerTools: {
      async startWorker(input) {
        explicitFallbackPrompts.push(input.prompt)
        return {
          worker_id: "implementer-4",
          worker_thread_id: "thread-123__worker__implementer-4",
          parent_thread_id: "thread-123",
          role: input.role,
          workload: input.workload ?? "write",
          owned_files: input.ownedFiles ?? [],
          description: input.description,
          status: "running",
          turns: 1,
          created_at: "2026-04-28T16:36:00+08:00",
          updated_at: "2026-04-28T16:36:00+08:00",
          tool_call_count: 0,
          last_event: "Worker started."
        } as never
      },
      async continueWorker() {
        return [] as never
      },
      async readWorkerState() {
        return [] as never
      },
      async readWorkerResult() {
        throw new Error("unused")
      },
      async cancelWorker() {
        return [] as never
      }
    }
  })
  const explicitFallbackStartTool = explicitFallbackTools.find((tool) => tool.name === "start_worker")
  assert(explicitFallbackStartTool, "explicit selected skill fallback test requires start_worker")
  await invokeTool(explicitFallbackStartTool, {
    subagent_type: "worker",
    role: "implementer",
    consumed_notification_ids: ["implementer-2@turn-1"],
    description: "Handle plain notification with explicit selected skill",
    prompt: "Handle the plain worker result with the requested skill"
  })
  await invokeTool(explicitFallbackStartTool, {
    subagent_type: "worker",
    role: "implementer",
    consumed_notification_ids: ["implementer-1@turn-1", "implementer-2@turn-1"],
    description: "Handle mixed notifications with explicit selected skill",
    prompt: "Handle both worker results with the requested skill"
  })
  assert(
    explicitFallbackPrompts.length === 2,
    "explicit selected skill fallback test should launch two workers"
  )
  for (const prompt of explicitFallbackPrompts) {
    assertIncludes(
      prompt,
      "[[CMB_COORDINATOR_SELECTED_SKILL_V1]]",
      "explicit selected skill should survive notification-driven worker launches"
    )
  }

  const mixedNotificationPrompts: string[] = []
  const mixedNotificationTools = createCoordinatorWorkerTools({
    workspacePath: "/tmp/workspace",
    threadId: "thread-123",
    selectedSkill: selectedSkill ?? undefined,
    notificationSelectedSkills: {
      "implementer-1@turn-1": selectedSkill ?? undefined,
      "implementer-2@turn-1": undefined
    },
    workerTools: {
      async startWorker(input) {
        mixedNotificationPrompts.push(input.prompt)
        return {
          worker_id: "implementer-3",
          worker_thread_id: "thread-123__worker__implementer-3",
          parent_thread_id: "thread-123",
          role: input.role,
          workload: input.workload ?? "write",
          owned_files: input.ownedFiles ?? [],
          description: input.description,
          status: "running",
          turns: 1,
          created_at: "2026-04-28T16:34:00+08:00",
          updated_at: "2026-04-28T16:34:00+08:00",
          tool_call_count: 0,
          last_event: "Worker started."
        } as never
      },
      async continueWorker(input) {
        mixedNotificationPrompts.push(input.prompt)
        return {
          worker_id: input.workerId,
          worker_thread_id: `thread-123__worker__${input.workerId}`,
          parent_thread_id: "thread-123",
          role: "implementer",
          workload: input.workload ?? "write",
          owned_files: input.ownedFiles ?? [],
          description: "continued",
          status: "running",
          turns: 2,
          created_at: "2026-04-28T16:34:00+08:00",
          updated_at: "2026-04-28T16:35:00+08:00",
          tool_call_count: 0,
          last_event: "Worker continued."
        } as never
      },
      async readWorkerState() {
        return [] as never
      },
      async readWorkerResult() {
        throw new Error("unused")
      },
      async cancelWorker() {
        return [] as never
      }
    }
  })
  const mixedNotificationStartTool = mixedNotificationTools.find((tool) => tool.name === "start_worker")
  assert(mixedNotificationStartTool, "mixed notification test requires start_worker")
  await invokeTool(mixedNotificationStartTool, {
    subagent_type: "worker",
    role: "implementer",
    consumed_notification_ids: ["implementer-2@turn-1"],
    description: "Handle plain notification",
    prompt: "Handle the plain worker result"
  })
  await invokeTool(mixedNotificationStartTool, {
    subagent_type: "worker",
    role: "implementer",
    consumed_notification_ids: ["implementer-1@turn-1", "implementer-2@turn-1"],
    description: "Handle mixed notifications",
    prompt: "Handle both worker results together"
  })
  assert(mixedNotificationPrompts.length === 2, "mixed notification test should launch two workers")
  for (const prompt of mixedNotificationPrompts) {
    assertNotIncludes(
      prompt,
      "[[CMB_COORDINATOR_SELECTED_SKILL_V1]]",
      "mixed notification worker prompt should not inherit an unrelated selected skill"
    )
  }
}

async function testSubagentDefinitions(): Promise<void> {
  const timeContext = {
    timezone: "Asia/Shanghai",
    currentTime: "2026-04-28T16:30:00+08:00"
  }
  const subagents = buildCoordinatorWorkerSubagents(
    "PROJECT_RULE",
    ["/skills/project"],
    "thread-123",
    timeContext
  )
  assert(subagents.length === 2, "coordinator mode should expose exactly two workers")
  assert(
    subagents.map((agent) => agent.name).join(",") === "implementer,verifier",
    "worker role names should be stable"
  )

  const implementer = subagents[0]
  const verifier = subagents[1]

  assertIncludes(implementer.systemPrompt, "implementer worker", "implementer prompt")
  assertIncludes(implementer.systemPrompt, "You are not the final evaluator", "implementer prompt")
  assertIncludes(implementer.systemPrompt, "OUTPUT_FILES or ANSWER_DRAFT", "implementer prompt")
  assertIncludes(implementer.systemPrompt, "HANDOFF_FOR_VERIFIER", "implementer prompt")
  assertIncludes(
    implementer.systemPrompt,
    "Run appropriate checks when your available tools permit it",
    "implementer prompt should avoid promising checks a scoped writer cannot run"
  )
  assertIncludes(
    implementer.systemPrompt,
    "do not claim checks you could not run",
    "implementer prompt should require honest handoffs from scoped writers"
  )
  assertIncludes(implementer.systemPrompt, "PROJECT_RULE", "implementer prompt")
  assertIncludes(implementer.systemPrompt, "Current time: 2026-04-28T16:30:00+08:00", "implementer prompt")
  assertNotIncludes(implementer.systemPrompt, "spec.md", "implementer prompt")
  assertNotIncludes(implementer.systemPrompt, "contract.json", "implementer prompt")
  assertNotIncludes(implementer.systemPrompt, "progress.md", "implementer prompt")
  assertNotIncludes(implementer.systemPrompt, "implementer-latest.json", "implementer prompt")

  assertIncludes(verifier.systemPrompt, "verifier worker", "verifier prompt")
  assertIncludes(verifier.systemPrompt, "strict, skeptical", "verifier prompt")
  assertIncludes(verifier.systemPrompt, "project workspace", "verifier prompt")
  assertIncludes(verifier.systemPrompt, "/tmp or $TMPDIR", "verifier prompt")
  assertIncludes(verifier.systemPrompt, "STATUS (PASS/FAIL/BLOCKED)", "verifier prompt")
  assertIncludes(verifier.systemPrompt, "CHECKED_FILES", "verifier prompt")
  assertIncludes(verifier.systemPrompt, "PROJECT_RULE", "verifier prompt")
  assertIncludes(verifier.systemPrompt, "Current time: 2026-04-28T16:30:00+08:00", "verifier prompt")
  assertNotIncludes(verifier.systemPrompt, "latest-verification.json", "verifier prompt")
  assertNotIncludes(verifier.systemPrompt, "check_verification_gate", "verifier prompt")

  assert(Array.isArray(implementer.skills), "implementer should inherit skill sources")
  assert(Array.isArray(verifier.skills), "verifier should inherit skill sources")

  const subagentsWithoutSkills = buildCoordinatorWorkerSubagents()
  assert(
    !("skills" in subagentsWithoutSkills[0]) && !("skills" in subagentsWithoutSkills[1]),
    "workers should omit skills property when no skill sources exist"
  )
}

async function testAsyncWorkerTools(): Promise<void> {
  const stateOnlyTools = createCoordinatorWorkerTools({
    workspacePath: "/tmp/workspace",
    threadId: "thread-123"
  })
  assert(stateOnlyTools.length === 0, "coordinator should expose no legacy state tools")

  const calls: string[] = []
  const consumedNotificationIds: string[][] = []
  const workers = new Map<string, Record<string, unknown>>()
  workers.set("implementer-2", {
    worker_id: "implementer-2",
    status: "running",
    role: "implementer"
  })
  workers.set("verifier-1", {
    worker_id: "verifier-1",
    status: "failed",
    role: "verifier"
  })
  workers.set("verifier-2", {
    worker_id: "verifier-2",
    status: "cancelled",
    role: "verifier"
  })

  const tools = createCoordinatorWorkerTools({
    workspacePath: "/tmp/workspace",
    threadId: "thread-123",
    onNotificationsConsumed: (notificationIds) => {
      consumedNotificationIds.push(notificationIds)
    },
    workerTools: {
      async startWorker(input) {
        calls.push(
          `start:${input.role}:${input.workload ?? ""}:${(input.ownedFiles ?? []).join(",")}:${input.description}:${input.prompt}`
        )
        const worker = {
          worker_id: "implementer-1",
          status: "completed",
          role: input.role,
          workload: input.workload ?? "write",
          turns: 1
        }
        workers.set("implementer-1", worker)
        return worker as never
      },
      async continueWorker(input) {
        calls.push(
          `continue:${input.workerId}:${input.workload ?? ""}:${(input.ownedFiles ?? []).join(",")}:${input.prompt}`
        )
        const worker = {
          worker_id: input.workerId,
          status: "completed",
          role: "implementer",
          workload: input.workload ?? "write",
          turns: 2
        }
        workers.set(input.workerId, worker)
        return worker as never
      },
      async readWorkerState(input) {
        calls.push(
          `read:${input.workerId ?? "all"}:${String(input.block ?? "")}:${String(input.timeoutMs ?? "")}`
        )
        if (input.workerId) {
          const worker = workers.get(input.workerId)
          return worker ? ([worker] as never) : []
        }
        return Array.from(workers.values()) as never
      },
      async readWorkerResult(input) {
        calls.push(
          `result:${input.workerId}:${String(input.includeTranscript ?? "")}:${String(input.maxChars ?? "")}`
        )
        const worker = workers.get(input.workerId)
        if (!worker) throw new Error(`Unknown worker: ${input.workerId}`)
        return {
          worker,
          result_path: `.cmbdevclaw/coordinator/thread-123/reports/workers/${input.workerId}.json`,
          result_text: "full worker output",
          result_chars: 18,
          result_truncated: false,
          transcript_text: input.includeTranscript ? "transcript output" : undefined,
          transcript_chars: input.includeTranscript ? 17 : undefined,
          transcript_truncated: input.includeTranscript ? false : undefined
        } as never
      },
      async cancelWorker(input) {
        calls.push(`cancel:${input.workerId ?? "all"}:${input.reason ?? ""}`)
        const targetIds = input.workerId ? [input.workerId] : Array.from(workers.keys())
        const cancelled = targetIds.map((workerId) => {
          const existing = workers.get(workerId) ?? { worker_id: workerId, role: "implementer" }
          const worker = { ...existing, status: "cancelled" }
          workers.set(workerId, worker)
          return worker
        })
        return cancelled as never
      }
    }
  })

  const names = tools.map((tool) => tool.name)
  assert(
    names.join(",") ===
      "start_worker,continue_worker,read_worker_state,read_worker_result,mark_notifications_handled,cancel_worker",
    "coordinator should expose only async worker tools"
  )

  const startTool = tools.find((tool) => tool.name === "start_worker")
  const continueTool = tools.find((tool) => tool.name === "continue_worker")
  const readTool = tools.find((tool) => tool.name === "read_worker_state")
  const resultTool = tools.find((tool) => tool.name === "read_worker_result")
  const markHandledTool = tools.find((tool) => tool.name === "mark_notifications_handled")
  const cancelTool = tools.find((tool) => tool.name === "cancel_worker")
  assert(
    startTool && continueTool && readTool && resultTool && markHandledTool && cancelTool,
    "all worker tools should exist"
  )

  const started = JSON.parse(
    await invokeTool(startTool, {
      subagent_type: "worker",
      role: "implementer",
      workload: "write",
      owned_files: ["src/app.ts"],
      consumed_notification_ids: ["implementer-0@turn-1"],
      description: "Implement feature",
      prompt: "Do the work"
    })
  )
  assert(started.worker.worker_id === "implementer-1", "start_worker should return worker id")
  assert(started.worker.role === "implementer", "start_worker should preserve explicit role")
  assertIncludes(
    calls[0],
    "start:implementer:write:src/app.ts:Implement feature:Do the work",
    "start call"
  )
  assert(
    consumedNotificationIds[0]?.join(",") === "implementer-0@turn-1",
    "start_worker should report consumed notification ids"
  )

  const verifierStarted = JSON.parse(
    await invokeTool(startTool, {
      subagent_type: "worker",
      role: "verifier",
      workload: "verify",
      description: "Verify feature",
      prompt: "Verify the work independently"
    })
  )
  assert(verifierStarted.worker.role === "verifier", "start_worker should accept verifier role")
  assertIncludes(
    calls[1],
    "start:verifier:verify::Verify feature:Verify the work independently",
    "verifier start call"
  )

  const implicitVerifierStarted = JSON.parse(
    await invokeTool(startTool, {
      subagent_type: "worker",
      workload: "verify",
      description: "Verify without explicit role",
      prompt: "Run verification"
    })
  )
  assert(
    implicitVerifierStarted.worker.role === "verifier",
    'start_worker should default workload="verify" to verifier role'
  )
  assertIncludes(
    calls[2],
    "start:verifier:verify::Verify without explicit role:Run verification",
    "implicit verifier start call"
  )

  const continued = JSON.parse(
    await invokeTool(continueTool, {
      worker_id: "implementer-1",
      workload: "write",
      owned_files: ["src/app.ts"],
      consumed_notification_ids: ["implementer-1@turn-1"],
      prompt: "Fix verifier feedback"
    })
  )
  assert(
    continued.worker.turns === 2,
    "continue_worker should preserve worker and increment turn"
  )
  assertIncludes(
    calls[3],
    "continue:implementer-1:write:src/app.ts:Fix verifier feedback",
    "continue call"
  )
  assert(
    consumedNotificationIds[3]?.join(",") === "implementer-1@turn-1",
    "continue_worker should report consumed notification ids"
  )

  const read = JSON.parse(
    await invokeTool(readTool, {
      worker_id: "implementer-1",
      block: true,
      timeout_ms: 1000
    })
  )
  assert(read.completed === 1, "read_worker_state should summarize completed workers")
  assert(read.retrieval_status === "complete", "read_worker_state should report completion")
  assertIncludes(calls[4], "read:implementer-1:true:1000", "read call")

  const missingWorkerRead = JSON.parse(
    await invokeTool(readTool, {
      worker_id: "missing-worker",
      block: false
    })
  )
  assert(
    missingWorkerRead.retrieval_status === "not_found",
    "read_worker_state should explicitly report unknown worker ids"
  )
  assertIncludes(
    missingWorkerRead.message,
    "Use the full worker_id",
    "unknown worker read should explain recovery"
  )
  assertIncludes(calls[5], "read:missing-worker:false:", "missing worker read call")

  const allWorkers = JSON.parse(await invokeTool(readTool, { block: false }))
  assert(allWorkers.running === 1, "read_worker_state should count running workers")
  assert(allWorkers.completed === 1, "read_worker_state should count completed workers")
  assert(allWorkers.failed === 1, "read_worker_state should count failed workers")
  assert(allWorkers.cancelled === 1, "read_worker_state should count cancelled workers")
  assert(allWorkers.retrieval_status === "running", "read_worker_state should report running")
  assertIncludes(calls[6], "read:all:false:", "read all call")

  const allWorkersDefault = JSON.parse(await invokeTool(readTool, {}))
  assert(
    allWorkersDefault.retrieval_status === "running",
    "read_worker_state without worker_id should still summarize running workers"
  )
  assertIncludes(
    calls[7],
    "read:all:false:",
    "read_worker_state should default to non-blocking when listing all workers"
  )

  const workerResult = JSON.parse(
    await invokeTool(resultTool, {
      worker_id: "implementer-1",
      include_transcript: true,
      max_chars: 2000
    })
  )
  assert(workerResult.result_text === "full worker output", "read_worker_result should return full result text")
  assert(workerResult.transcript_text === "transcript output", "read_worker_result should optionally include transcript")
  assertIncludes(calls[8], "result:implementer-1:true:2000", "read result call")

  const markedHandled = JSON.parse(
    await invokeTool(markHandledTool, {
      notification_ids: ["verifier-1@turn-2", "implementer-1@turn-2"]
    })
  )
  assert(
    markedHandled.notification_ids.join(",") === "verifier-1@turn-2,implementer-1@turn-2",
    "mark_notifications_handled should echo handled notification ids"
  )
  assert(
    consumedNotificationIds[4]?.join(",") === "verifier-1@turn-2,implementer-1@turn-2",
    "mark_notifications_handled should report handled notification ids"
  )

  const cancelledOne = JSON.parse(
    await invokeTool(cancelTool, {
      worker_id: "implementer-1",
      reason: "stop one",
      consumed_notification_ids: ["verifier-1@turn-2"]
    })
  )
  assert(
    cancelledOne.workers[0].worker_id === "implementer-1",
    "cancel_worker should delegate a specific worker id"
  )
  assertIncludes(calls[9], "cancel:implementer-1:stop one", "cancel one call")
  assert(
    consumedNotificationIds[5]?.join(",") === "verifier-1@turn-2",
    "cancel_worker should report consumed notification ids"
  )

  const cancelled = JSON.parse(await invokeTool(cancelTool, { reason: "stop all" }))
  assert(
    cancelled.workers.every((worker: { status: string }) => worker.status === "cancelled"),
    "cancel_worker should return cancelled workers"
  )
  assertIncludes(calls[10], "cancel:all:stop all", "cancel all call")

  workers.set("implementer-running", {
    worker_id: "implementer-running",
    status: "running",
    role: "implementer"
  })
  const firstRunningRead = JSON.parse(
    await invokeTool(readTool, { worker_id: "implementer-running", block: true })
  )
  assert(firstRunningRead.retrieval_status === "running", "first running read should report running")
  assert(
    firstRunningRead.message?.includes("Worker is still running"),
    "first running read should give a running message"
  )
  workers.set("implementer-running", {
    worker_id: "implementer-running",
    status: "completed",
    role: "implementer"
  })
  const completedAfterSuppressedRead = JSON.parse(
    await invokeTool(readTool, { worker_id: "implementer-running", block: true })
  )
  assert(
    completedAfterSuppressedRead.retrieval_status === "complete",
    "completed worker should report complete even after a previous running read"
  )
  assert(
    completedAfterSuppressedRead.polling_suppressed === false,
    "completed worker should not report polling_suppressed after repeated read"
  )
  assert(
    completedAfterSuppressedRead.message === undefined,
    "completed worker should not keep the stale suppressed/running message"
  )

  const startedWithDefaultRole = JSON.parse(
    await invokeTool(startTool, {
      subagent_type: "worker",
      description: "Default role",
      prompt: "Do read-only research"
    })
  )
  assert(
    startedWithDefaultRole.worker.role === "implementer",
    "start_worker should default omitted role to implementer"
  )

  let rejectedBadSubagentType = false
  try {
    await invokeTool(startTool, {
      subagent_type: "implementer",
      description: "Invalid subagent type",
      prompt: "bad"
    })
  } catch {
    rejectedBadSubagentType = true
  }
  assert(rejectedBadSubagentType, "start_worker should reject non-worker subagent types")

  let rejectedLegacyWorkerTypeOnly = false
  try {
    await invokeTool(startTool, {
      worker_type: "implementer",
      description: "Legacy API",
      prompt: "bad"
    })
  } catch {
    rejectedLegacyWorkerTypeOnly = true
  }
  assert(
    rejectedLegacyWorkerTypeOnly,
    "start_worker should reject legacy worker_type-only calls"
  )

  let rejectedBadRole = false
  try {
    await invokeTool(startTool, {
      subagent_type: "worker",
      role: "general-purpose",
      description: "Invalid role",
      prompt: "bad"
    })
  } catch {
    rejectedBadRole = true
  }
  assert(rejectedBadRole, "start_worker should reject unsupported optional worker roles")

  let rejectedEmptyWorkerPrompt = false
  try {
    await invokeTool(startTool, {
      subagent_type: "worker",
      role: "implementer",
      description: "Invalid empty prompt",
      prompt: "   "
    })
  } catch {
    rejectedEmptyWorkerPrompt = true
  }
  assert(rejectedEmptyWorkerPrompt, "start_worker should reject empty prompts")

  let rejectedEmptyContinueWorkerId = false
  try {
    await invokeTool(continueTool, {
      worker_id: "   ",
      prompt: "continue"
    })
  } catch {
    rejectedEmptyContinueWorkerId = true
  }
  assert(rejectedEmptyContinueWorkerId, "continue_worker should reject empty worker ids")

  let rejectedBadReadTimeout = false
  try {
    await invokeTool(readTool, {
      timeout_ms: 120_001
    })
  } catch {
    rejectedBadReadTimeout = true
  }
  assert(rejectedBadReadTimeout, "read_worker_state should reject unsafe timeout values")

  let rejectedTooSmallReadTimeout = false
  try {
    await invokeTool(readTool, {
      timeout_ms: 999
    })
  } catch {
    rejectedTooSmallReadTimeout = true
  }
  assert(rejectedTooSmallReadTimeout, "read_worker_state should reject tiny wait timeouts")

  let rejectedEmptyCancelReason = false
  try {
    await invokeTool(cancelTool, {
      reason: "   "
    })
  } catch {
    rejectedEmptyCancelReason = true
  }
  assert(rejectedEmptyCancelReason, "cancel_worker should reject empty cancellation reasons")
}

async function run(): Promise<void> {
  await testModeDetection()
  console.log("PASS coordinator mode detection")
  await testPromptContracts()
  console.log("PASS coordinator prompt contracts")
  await testSkillUseDelegation()
  console.log("PASS coordinator skill delegation")
  await testSelectedSkillPromptInjection()
  console.log("PASS coordinator selected skill prompt injection")
  await testSubagentDefinitions()
  console.log("PASS coordinator worker definitions")
  await testAsyncWorkerTools()
  console.log("PASS coordinator async worker tools")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
