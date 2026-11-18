import { isAbsolute, join, sep } from "node:path"
import type { Message, ThreadMessagesPage, ToolCall } from "../types"
import type { ForegroundCommandEvidence } from "../agent/foreground-command-evidence"
import { redactAndTruncateSensitiveText } from "../log-redaction"
import { isBotRoutineSilent } from "../../shared/bots/routine-silence"
import { botContinuationTaskId } from "../../shared/bots/task-continuation"
import { isVisibleTranscriptMessage } from "../../shared/checkpoint-transcript"
import { projectCoordinatorTranscriptNoise } from "../../shared/internal-notification-turn"
import { botHistoryMessageBody } from "./work-history"
import type { BotWorkResultExecutionEvidence } from "./work-result-settlement"

const MAX_PROCESS_CHARS = 4000
const MAX_STEP_TEXT = 600
const MAX_INTERACTION_TEXT = 240
type ForegroundCommand = NonNullable<BotWorkResultExecutionEvidence["foregroundCommands"]>[number]

function insideWorkspace(path: string): boolean {
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function projectForegroundCommand(evidence: ForegroundCommandEvidence): Omit<ForegroundCommand, "callId"> {
  const requested = evidence.command.trim()
  // Keep common task names and relative script paths. Arbitrary arguments can
  // contain credentials, so other commands receive a label only.
  const label = /^(?<program>[\w.-]{1,40})(?:\s+(?<mode>test|run|--test|check|build|verify|lint|typecheck)(?=\s|$))?/i.exec(requested)
  const script = /^(?:npm|pnpm|yarn|bun)\s+run\s+((?:test|check|build|verify|lint|typecheck)(?:[:.-][\w.-]{1,40})?)(?=\s|$)/i.exec(requested)?.[1]
  const scriptPath = /^(?:node|python3?|ruby)\s+(?:--test\s+)?((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:[cm]?[jt]s|py|rb))$/i.exec(requested)?.[1]
  const localDirectory = insideWorkspace(evidence.directory)
  const exact = scriptPath && !scriptPath.startsWith("-") && localDirectory &&
    insideWorkspace(join(evidence.directory, scriptPath)) && requested.length <= 160
  const command = /[;|&<>\r\n`]|\$\(/.test(requested) ? "Compound shell command"
    : exact ? redactAndTruncateSensitiveText(requested, 160, "…")
    : label ? [label.groups?.program, label.groups?.mode, script].filter(Boolean).join(" ") : "Shell command"
  return { command, ...(exact && command === requested ? { exactCommand: true as const } : {}),
    directory: localDirectory ? redactAndTruncateSensitiveText(evidence.directory, 160, "…") : undefined,
    exitCode: evidence.exitCode, output: redactAndTruncateSensitiveText(evidence.output, 2_000, "…"),
    excerpt: evidence.truncated || evidence.output.length > 2_000 }
}

type ProcessTool = {
  name: string
  status: "returned" | "error" | "unconfirmed"
  file?: string
  interaction?: { status: string; answers: { question: string; answer: string }[] }
  commandResult?: Pick<ForegroundCommand, "command" | "exactCommand" | "directory" | "exitCode">
}

type ProcessStep = { text?: string; tools?: ProcessTool[] }

export type BotWorkResultProcess = {
  coverage: "complete" | "partial" | "unavailable"
  steps: ProcessStep[]
}

const unavailableWorkResultProcess: BotWorkResultProcess = { coverage: "unavailable", steps: [] }

function submittedAnswer(
  tool: ProcessTool
): tool is ProcessTool & { interaction: NonNullable<ProcessTool["interaction"]> } {
  return tool.name === "request_user_input" && tool.status === "returned" &&
    tool.interaction?.status === "submitted"
}

/** Keep actual user choices before progress prose, then retain the newest
 * evidence that fits. Output remains chronological, within the same budget. */
function boundedSteps(steps: ProcessStep[]) {
  if (JSON.stringify(steps).length <= MAX_PROCESS_CHARS) return { steps, truncated: false }

  // A long batch can exceed the budget as a whole. Keep individual answers
  // and command receipts eligible without requiring the surrounding progress.
  const units = steps.flatMap((step): ProcessStep[] => {
    if (!step.tools?.some(tool => submittedAnswer(tool) || tool.commandResult)) return [step]
    return [
      ...(step.text ? [{ text: step.text }] : []),
      ...step.tools.flatMap(tool => submittedAnswer(tool)
        ? tool.interaction.answers.map(answer => ({
            tools: [{ ...tool, interaction: { status: "submitted", answers: [answer] } }]
          }))
        : [{ tools: [tool] }])
    ]
  })
  // Each step is charged one comma, so only one more character is needed for the array.
  let remaining = MAX_PROCESS_CHARS - 1
  const retained = new Set<number>()
  for (const answersFirst of [true, false]) {
    for (let index = units.length - 1; index >= 0; index--) {
      const step = units[index]
      if (Boolean(step.tools?.some(submittedAnswer)) !== answersFirst) continue
      const size = JSON.stringify(step).length + 1
      if (size > remaining) continue
      remaining -= size
      retained.add(index)
    }
  }
  return { steps: units.filter((_, index) => retained.has(index)), truncated: retained.size < units.length }
}

/** Carry actual submitted choices across a task's terminal callback, retaining
 * the same total budget and without treating earlier work as current proof. */
export function includeWorkResultAnswers(
  current: BotWorkResultProcess | undefined,
  previous: readonly BotWorkResultProcess[]
): BotWorkResultProcess | undefined {
  const answers = previous.flatMap(process => process.steps.flatMap(step => {
    const tools = step.tools?.filter(submittedAnswer)
    return tools?.length ? [{ tools }] : []
  }))
  if (!answers.length) return current
  return { coverage: "partial", steps: boundedSteps([...answers, ...(current?.steps ?? [])]).steps }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function selectedAnswer(value: unknown, options: unknown): string {
  const answer = record(value)
  if (!answer) return ""
  if (answer.type === "other") return typeof answer.text === "string" ? answer.text : ""
  const selectedOption = (value: unknown): string => {
    const option = record(value)
    if (typeof option?.label !== "string") return ""
    // Only carry the description of the selected, actually offered choice.
    // Legacy label-only receipts remain readable, without inventing a choice.
    const description = typeof option.description === "string" && Array.isArray(options) &&
      options.some(item => {
        const offered = record(item)
        return offered?.label === option.label && offered?.description === option.description
      }) ? option.description : undefined
    return [option.label, option.additionalText, description]
      .filter(part => typeof part === "string" && part.length > 0).join(" · ")
  }
  if (answer.type === "option" && typeof answer.label === "string")
    return selectedOption(answer)
  if (answer.type === "options" && Array.isArray(answer.options)) {
    const selected = answer.options.map(record).filter(option => typeof option?.label === "string")
    // Prioritize selected labels within the existing answer budget before
    // descriptions. Keep the label with each expanded detail as well.
    const labels = selected.map(option => option!.label).join("、")
    const details = selected.map(option => selectedOption(option))
      .filter((detail, index) => detail !== selected[index]!.label)
    return [labels, ...details].filter(Boolean).join(" · ")
  }
  return ""
}

function questionReceipt(call: ToolCall, result: Message) {
  const content = typeof result.content === "string" ? result.content :
    result.content.every(part => part?.type === "text" && typeof part.text === "string")
      ? result.content.map(part => part.text).join("") : ""
  try {
    const receipt = record(JSON.parse(content))
    const status = receipt?.status
    if (typeof receipt?.requestId !== "string" || !receipt.requestId ||
        (status !== "submitted" && status !== "ignored" && status !== "auto_resolved")) return
    const answers = record(receipt.answers)
    const questions = call.args?.questions
    if (!answers || !Array.isArray(questions)) return
    const submitted = status === "submitted" ? questions.flatMap(item => {
      const question = record(item)
      if (typeof question?.id !== "string" || typeof question.question !== "string") return []
      const answer = record(answers[question.id])
      const text = answer?.questionId === question.id ? selectedAnswer(answer, question.options) : ""
      return text.trim() ? [{ question: question.question, answer: text }] : []
    }) : []
    if (status === "submitted" && (!submitted.length || submitted.length !== questions.length)) return
    return { status, answers: submitted }
  } catch {
    return
  }
}

/** Read only an exact final message's physical execution. Earlier turns, raw
 * user input and reasoning cannot enter the review. */
export function projectWorkResultProcess(
  page: ThreadMessagesPage,
  execution: {
    taskId: string
    requestId: string
    supplementRequestIds: readonly string[]
    finalMessageId: string
    earlierExecutions: boolean
    foregroundCommands?: readonly ForegroundCommand[]
  },
  answersOnly = false
): BotWorkResultProcess {
  const final = page.messages.at(-1)
  if (final?.id !== execution.finalMessageId || final.role !== "assistant") return unavailableWorkResultProcess
  if (isBotRoutineSilent(botHistoryMessageBody(final)?.text)) answersOnly = true

  const supplements = new Set(execution.supplementRequestIds)
  const start = page.messages.findLastIndex(message => message.role === "user" &&
    isVisibleTranscriptMessage(message.role, message.content) && !supplements.has(message.id))
  const request = page.messages[start]
  if (!request || (request.id !== execution.requestId && botContinuationTaskId(request.id) !== execution.taskId))
    return unavailableWorkResultProcess

  const messages = page.messages.slice(start + 1, -1)
  const currentScopeStart = messages.findLastIndex(message => message.role === "user" && supplements.has(message.id))
  const foregroundCommands = new Map(execution.foregroundCommands?.map(command => [command.callId, command]))
  const truncated = new Set(page.truncatedMessageIds)
  let partial = answersOnly || execution.earlierExecutions || request.id !== execution.requestId ||
    messages.some(message => truncated.has(message.id)) || truncated.has(final.id) ||
    Boolean(final.tool_calls?.length)
  const calls = new Set<string>()
  const repeated = new Set<string>()
  const results = new Map<string, { message: Message; index: number }>()
  messages.forEach((message, index) => {
    for (const call of message.role === "assistant" ? message.tool_calls ?? [] : []) {
      if (calls.has(call.id)) repeated.add(call.id)
      calls.add(call.id)
    }
    if (message.role === "tool" && message.tool_call_id) {
      if (results.has(message.tool_call_id)) repeated.add(message.tool_call_id)
      results.set(message.tool_call_id, { message, index })
    }
  })
  if ([...results.keys()].some(id => !calls.has(id))) partial = true

  const steps: ProcessStep[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant" || !isVisibleTranscriptMessage(message.role, message.content)) continue
    const projection = projectCoordinatorTranscriptNoise(message.role, message.content, message.tool_calls)
    if (projection.hidden) continue
    const body = botHistoryMessageBody(message)
    const text = !answersOnly && !isBotRoutineSilent(body?.text) ? body?.text.slice(0, MAX_STEP_TEXT) : undefined
    if (body && (body.truncated || body.text.length > MAX_STEP_TEXT)) partial = true
    let tools = projection.visibleToolCalls?.map((call): ProcessTool => {
      const result = results.get(call.id)
      const confirmed = result && result.index > index && !repeated.has(call.id) &&
        !truncated.has(message.id) && !truncated.has(result.message.id) &&
        (!result.message.name || result.message.name === call.name)
      if (!confirmed) partial = true
      const file = typeof call.args?.file_path === "string"
        ? call.args.file_path.split(/[/\\]/).at(-1)?.slice(0, 160) : undefined
      const interaction = confirmed && !result.message.is_error && call.name === "request_user_input"
        ? questionReceipt(call, result.message) : undefined
      if (call.name === "request_user_input" && !interaction) partial = true
      const foreground = !answersOnly && call.name === "execute" && call.args?.run_in_background !== true
      const observed = foreground && confirmed && index > currentScopeStart && !result.message.is_error
        ? foregroundCommands.get(call.id) : undefined
      const commandResult = observed ? {
        command: observed.command, exactCommand: observed.exactCommand, directory: observed.directory, exitCode: observed.exitCode
      } : undefined
      if (foreground && !commandResult && !result?.message.is_error) partial = true
      const answers = interaction?.answers.map(({ question, answer }) => {
        if (question.length > MAX_INTERACTION_TEXT || answer.length > MAX_INTERACTION_TEXT) partial = true
        return { question: question.slice(0, MAX_INTERACTION_TEXT), answer: answer.slice(0, MAX_INTERACTION_TEXT) }
      })
      const status = !confirmed ? "unconfirmed"
        : result.message.is_error || (commandResult && commandResult.exitCode !== 0) ? "error"
        : foreground && !commandResult ? "unconfirmed" : "returned"
      return {
        name: call.name.slice(0, 100),
        status,
        ...(file ? { file } : {}),
        ...(interaction && answers ? { interaction: { status: interaction.status, answers } } : {}),
        ...(commandResult ? { commandResult } : {})
      }
    })
    // Historical progress is not current evidence and must not consume the
    // answer budget before the submitted receipts have been selected.
    if (answersOnly) tools = tools?.filter(submittedAnswer)
    if (!text && !tools?.length) continue
    const step = { ...(text ? { text } : {}), ...(tools?.length ? { tools } : {}) }
    steps.push(step)
  }
  const bounded = boundedSteps(steps.reverse())
  return { coverage: partial || bounded.truncated ? "partial" : "complete", steps: bounded.steps }
}
