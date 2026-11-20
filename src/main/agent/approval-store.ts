/**
 * Approval cache and flow control.
 *
 * Manages session-level and permanent approval decisions so that the user
 * is not repeatedly prompted for the same command pattern.
 */

import { createHash } from "crypto"
import type { ReviewDecision } from "../types"
import { getApprovalRules, addApprovalRule } from "../storage"
import { matchesApprovalPattern } from "./exec-policy"

export class ApprovalStore {
  /** Session-level cache (cleared when the process restarts) */
  private sessionCache = new Map<string, ReviewDecision>()
  /** Permanent rules loaded from disk */
  private permanentRules = new Map<string, ReviewDecision>()

  /**
   * Generate a cache key from the command + cwd + sandbox mode.
   *
   * We hash to normalise the key length and avoid storing raw commands.
   */
  makeKey(command: string, cwd: string, sandboxMode: string): string {
    // Normalise whitespace before hashing
    const normalised = `${command.trim()}|${cwd}|${sandboxMode}`
    return createHash("sha256").update(normalised).digest("hex").slice(0, 32)
  }

  /**
   * Generate a human-readable pattern key for permanent rules.
   * Uses the raw command text so users can understand stored rules.
   */
  makePatternKey(command: string): string {
    return command.trim()
  }

  /** Look up a cached decision.  Returns null if no cached entry. */
  get(key: string): ReviewDecision | null {
    return this.sessionCache.get(key) ?? this.permanentRules.get(key) ?? null
  }

  /** Check permanent rules by pattern (command text match). */
  getByPattern(command: string): ReviewDecision | null {
    for (const [rulePattern, decision] of this.permanentRules) {
      if (matchesApprovalPattern(rulePattern, command)) return decision
    }
    return null
  }

  /** Store a decision. */
  put(key: string, decision: ReviewDecision): void {
    if (decision === "approved_permanent") {
      this.permanentRules.set(key, decision)
    } else if (decision === "approved_session") {
      this.sessionCache.set(key, decision)
    }
    // "approved" (one-shot) is not cached
  }

  /**
   * High-level helper: check cache first, and if no cached approval exists,
   * call `fetchApproval` to ask the user.  Caches the result appropriately.
   */
  async withCachedApproval(
    key: string,
    patternKey: string,
    fetchApproval: () => Promise<ReviewDecision>,
    options?: {
      allowPermanentMatch?: boolean
      allowPermanentStore?: boolean
      commandForPatternMatch?: string
    }
  ): Promise<ReviewDecision> {
    const allowPermanentMatch = options?.allowPermanentMatch ?? true
    const allowPermanentStore = options?.allowPermanentStore ?? true
    const commandForPatternMatch = options?.commandForPatternMatch ?? patternKey

    // 1. Check session cache
    const sessionHit = this.sessionCache.get(key)
    if (sessionHit === "approved_session" || sessionHit === "approved") {
      return sessionHit
    }

    // 2. Check permanent rules by pattern
    if (allowPermanentMatch) {
      for (const [rulePattern, decision] of this.permanentRules) {
        if (
          matchesApprovalPattern(rulePattern, commandForPatternMatch) &&
          (decision === "approved_permanent" || decision === "approved")
        ) {
          return decision
        }
      }
    }

    // 3. Ask the user
    const decision = await fetchApproval()

    // 4. Cache the result
    if (decision === "approved_session") {
      this.sessionCache.set(key, decision)
    } else if (decision === "approved_permanent" && allowPermanentStore) {
      this.permanentRules.set(patternKey, decision)
      // Persist to disk
      addApprovalRule(patternKey, decision)
    }

    return decision
  }

  /** Load permanent rules from persistent storage. */
  loadPermanentRules(): void {
    this.permanentRules.clear()
    const rules = getApprovalRules()
    for (const { pattern, decision } of rules) {
      this.permanentRules.set(pattern, decision as ReviewDecision)
    }
  }

  /** Clear session cache (e.g. on thread reset). */
  clearSession(): void {
    this.sessionCache.clear()
  }
}
