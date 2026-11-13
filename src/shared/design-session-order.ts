import type { SessionMeta } from "./managed-design-session"

/** Freeze the legacy update time once; later output must not move the session. */
export function withDesignSessionOrder(
  meta: SessionMeta,
  previousLastSubmittedAt?: number
): SessionMeta {
  return {
    ...meta,
    lastSubmittedAt: meta.lastSubmittedAt ?? previousLastSubmittedAt ?? meta.updatedAt ?? meta.createdAt
  }
}

export function compareDesignSessionOrder(left: SessionMeta, right: SessionMeta): number {
  return (
    (right.lastSubmittedAt ?? right.createdAt) - (left.lastSubmittedAt ?? left.createdAt) ||
    right.createdAt - left.createdAt ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}
