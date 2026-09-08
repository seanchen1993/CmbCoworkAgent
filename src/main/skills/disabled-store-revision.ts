let revision = 0

/**
 * Monotonic main-process epoch for the persisted disabled-skill store.
 *
 * Catalog workers attach the captured epoch to their canonical projection and
 * the synchronous persistence edge compares it immediately before writing.
 * Every in-process writer advances the epoch, so a slow worker scan can never
 * overwrite a newer toggle, delete cleanup, restore, or evolution mutation.
 */
export function getDisabledSkillStoreRevision(): number {
  return revision
}

export function bumpDisabledSkillStoreRevision(): number {
  revision += 1
  return revision
}

export function resetDisabledSkillStoreRevisionForTests(): void {
  revision = 0
}
