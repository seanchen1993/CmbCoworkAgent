import assert from "node:assert/strict"
import { createHash } from "node:crypto"

/** Carry the existing native feature identity into the original completion gate. */
export function repairOriginalAutobizCompletionContext(bytes: Buffer): Buffer {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "8014cc7bccf7fdad5c9c9b63c08560c1c97ac10eb47817ba2a5bf339c7af4f26",
    "Exact original completion gate required"
  )
  let text = bytes.toString("utf8")
  const recipes = [
    [
      "    errors.extend(_check_completion(plan, records))",
      "    errors.extend(_check_completion(plan, records, feature_dir=target_feature_dir))"
    ],
    [
      '    records: tuple[dict[str, Any], ...],\n) -> list[str]:\n    """Validate Code completion evidence for deferred validation."""',
      '    records: tuple[dict[str, Any], ...],\n    *,\n    feature_dir: Path,\n) -> list[str]:\n    """Validate Code completion evidence for deferred validation."""'
    ]
  ]
  for (const [from, to] of recipes) {
    assert.equal(text.split(from).length, 2, "Exact completion context anchor required")
    text = text.replace(from, to)
  }
  return Buffer.from(text)
}

/** Explicit author-side repair for the supplied 1.0.87 source, never a runtime patch. */
export function repairOriginalAutobizPreparationBase(path: string, bytes: Buffer): Buffer {
  const recipes = {
    "hooks/parallel_batch_stage.py": {
      sha256: "e4da4a3552786177be121a195513777583d1e5df2a238792b887ca330e2601c0",
      before: '            "batchCommit": repository.get("headSha") or repository.get("baseSha"),',
      after: `            "batchCommit": (batch.get("startSha") if manifest.get("integrationMode") == "isolated"
                            else repository.get("headSha") or repository.get("baseSha")),`
    },
    "hooks/parallel_evidence_aggregate.py": {
      sha256: "031a92659cd48cfb2cbf4eb0c3da7973b38a084bcfcc2b1b0e37b27505e1263c",
      before:
        '            expected_commit = repository.get("headSha") or repository.get("baseSha")',
      after: `            expected_commit = (batch.get("startSha") if manifest.get("integrationMode") == "isolated"
                               else repository.get("headSha") or repository.get("baseSha"))`
    }
  }
  const recipe = recipes[path as keyof typeof recipes]
  assert(recipe, "No compatibility transform declared for this resource")
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  assert.equal(sha256, recipe.sha256, "Exact original preparation protocol required")
  const text = bytes.toString("utf8")
  assert.equal(text.split(recipe.before).length, 2, "Exact single preparation binding required")
  let transformed = text.replace(recipe.before, recipe.after)
  if (path === "hooks/parallel_evidence_aggregate.py") {
    const anchor = '        manifest["finalEvidenceAggregate"] = report'
    assert.equal(transformed.split(anchor).length, 2)
    transformed = transformed.replace(
      anchor,
      `${anchor}
        # Retain the strict legacy Code completion reader while using current staged evidence.
        # A failed/deferred aggregate must never leave an earlier successful projection.
        if report["passed"] and not report["hasDeferredIssues"]:
            manifest["finalVerification"] = report
        else:
            manifest.pop("finalVerification", None)`
    )
  }
  return Buffer.from(transformed)
}

export function repairOriginalAutobizPlanProjection(
  bytes: Buffer,
  reviewedProjection: string
): Buffer {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "dcd23b64e69f403c3a5946eebc826dec9b0ea55dc104ba6c81730cbeeb41d323",
    "Exact original Plan Writer required"
  )
  const oldRepo = '        repo = Path(binding["gitRoot"])'
  assert.equal(reviewedProjection.split(oldRepo).length, 2)
  let projection = reviewedProjection.replace(
    oldRepo,
    `        from hooks.parallel_integration import isolated, assert_integration
        repo = assert_integration(binding) if isolated(manifest) else Path(binding["gitRoot"])`
  )
  const oldStages = `        if not isinstance(states, dict) or any(
                not isinstance(states.get(stage), dict) or states[stage].get("status") != "passed"
                for stage in ("prepare", "implement", "review", "test")):
            return False`
  assert.equal(projection.split(oldStages).length, 2)
  projection = projection.replace(
    oldStages,
    `        if not isinstance(states, dict) or any(
                not isinstance(states.get(stage), dict) or states[stage].get("status") != "passed"
                for stage in ("prepare", "implement", "review")):
            return False
        test = states.get("test")
        if not isinstance(test, dict):
            return False
        from hooks.parallel_batch_stage import FRONTEND_UTEST_SKIP_REASON
        if test.get("status") != "passed" and not (
                test.get("status") == "skipped" and batch.get("executionLane") == "frontend"
                and test.get("skipReason") == FRONTEND_UTEST_SKIP_REASON):
            return False`
  )
  const recipes = [
    [
      "def _project_batches(data: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:",
      projection +
        "def _project_batches(data: dict[str, Any], *, workspace: Path | None = None, feature: str | None = None) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:"
    ],
    [
      "        status = _batch_status(batch_tasks)",
      '        status = ("done" if _verified_parallel_batch_merge(workspace, feature, batch_id, previous, batch_tasks) else _batch_status(batch_tasks))'
    ],
    [
      '"completedAt": previous.get("completedAt") if status == "done" else None,',
      '"completedAt": previous.get("mergedAt") if status == "done" else None,'
    ],
    [
      "    root, batch_plans = _project_batches(data)",
      "    root, batch_plans = _project_batches(data, workspace=workspace, feature=feature)"
    ]
  ]
  let text = bytes.toString("utf8")
  for (const [from, to] of recipes) {
    assert.equal(text.split(from).length, 2, "Exact original Plan projection anchor required")
    text = text.replace(from, to)
  }
  return Buffer.from(text)
}
