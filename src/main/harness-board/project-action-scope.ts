import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

export interface SettledProjectSkillBinding {
  projectId: string
  operationId: string
  stageId: string
  threadId: string
  pluginDigest: string
  inputFingerprint: string
}

interface SettledSkillProof {
  identity: string
  nonce: string
  assertCurrent(): void
  assertContentCurrent?: () => void
}

const skillIdentity = (binding: SettledProjectSkillBinding) => JSON.stringify([
  binding.projectId, binding.operationId, binding.stageId, binding.threadId,
  binding.pluginDigest, binding.inputFingerprint
])

const scope = new AsyncLocalStorage<{
  threadId: string
  binding: string
  assertCurrent: () => void
  assertContentCurrent?: () => void
  active: boolean
  settledSkill?: SettledSkillProof
}>()

/** Host orchestration only: never accept this scope through IPC or model arguments. */
export async function withProjectActionScope<T>(
  threadId: string,
  binding: unknown,
  assertCurrent: () => void,
  run: () => Promise<T>,
  assertContentCurrent?: () => void,
  settledSkillBinding?: SettledProjectSkillBinding
): Promise<T> {
  assertCurrent()
  const parent = scope.getStore()
  const entry = { threadId, binding: JSON.stringify(binding), assertCurrent, assertContentCurrent,
    active: true, settledSkill: undefined as SettledSkillProof | undefined }
  if (settledSkillBinding) {
    const declared = binding as Partial<SettledProjectSkillBinding> | null
    if (!declared || threadId !== settledSkillBinding.threadId ||
      ["projectId", "operationId", "stageId", "pluginDigest"].some(key =>
        declared[key as keyof SettledProjectSkillBinding] !==
        settledSkillBinding[key as keyof SettledProjectSkillBinding]) ||
      Object.values(settledSkillBinding).some(value => typeof value !== "string" || !value))
      throw Error("PROJECT_SKILL_SETTLEMENT_SCOPE_CHANGED")
    entry.settledSkill = { identity: skillIdentity(settledSkillBinding), nonce: randomUUID(),
      assertCurrent: () => {
        if (!entry.active) throw Error("PROJECT_SKILL_SETTLEMENT_SCOPE_CHANGED")
        entry.assertCurrent()
      },
      assertContentCurrent: entry.assertContentCurrent }
  } else if (parent?.active && parent.threadId === threadId && parent.binding === entry.binding) {
    entry.settledSkill = parent.settledSkill
  }
  try {
    return await scope.run(entry, run)
  } finally {
    entry.active = false
  }
}

/** Ephemeral main-only proof, never a persisted PASS or a guest/model supplied field. */
export function captureSettledProjectSkill(binding: SettledProjectSkillBinding):
  { nonce: string; assertCurrent(): void; assertContentCurrent(): void } | undefined {
  const current = scope.getStore()
  const proof = current?.settledSkill
  if (!current?.active || !proof || proof.identity !== skillIdentity(binding)) return undefined
  const assertCurrent = () => {
    if (!current.active) throw Error("PROJECT_SKILL_SETTLEMENT_SCOPE_CHANGED")
    proof.assertCurrent()
    current.assertCurrent()
  }
  // Every explicit content boundary reads again. Only identical callbacks within
  // this synchronous check are deduplicated; no result survives an await or call.
  const contentGuards = new Set([proof.assertContentCurrent, current.assertContentCurrent])
  const assertContentCurrent = () => {
    assertCurrent()
    for (const guard of contentGuards) guard?.()
  }
  assertCurrent()
  return { nonce: proof.nonce, assertCurrent, assertContentCurrent }
}

/** Capture once at original executor preparation, retain the real owner after ALS exits. */
export function captureProjectActionContentGuard(threadId?: string): (() => void) | undefined {
  const current = scope.getStore()
  if (!current || (threadId !== undefined && current.threadId !== threadId)) return undefined
  return () => {
    if (!current.active) throw Error("PROJECT_ACTION_SCOPE_CHANGED")
    current.assertCurrent()
    current.assertContentCurrent?.()
  }
}

/** Project conversations remain read-only outside their own admitted action execution. */
export function projectActionFlowMetadata(threadId: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const metadata = value as Record<string, unknown>
  if (!metadata.hostProjectRuntime) return value
  const current = scope.getStore()
  if (
    !current?.active ||
    current.threadId !== threadId ||
    current.binding !== JSON.stringify(metadata.hostProjectRuntime)
  )
    return value
  current.assertCurrent()
  const ordinary = { ...metadata }
  delete ordinary.hostProjectRuntime
  // A stage's model mode does not change its admitted declarative action scope.
  // Only this live Host projection adapts the mode; the persisted thread stays workflow.
  if (ordinary.agentMode === "workflow") ordinary.agentMode = "normal"
  return ordinary
}
