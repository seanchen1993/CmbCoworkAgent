# AutoBiz Plan merge projection compatibility revision

This reviewed plugin revision fixes a Plan Writer projection defect. The upstream
writer always projected completed tasks as an `in_progress` Batch, including
after the original Merge Train had promoted the delivery. Consequently the
unchanged `code_done` check correctly rejected the root and Batch plans.

The compatibility source retains all original Hooks, required checks, workflows,
knowledge rules, and business module definitions. `hooks/plan_writer.py` and
`hooks/parallel_evidence_aggregate.py` are transformed, each against an exact input
SHA256 and exact expected output SHA256.
Metadata identifies a distinct plugin and kernel version `1.0.1`. User-installed
sources and the external upstream checkout are never patched automatically.

Completion is projected only when every Task is done and the original runtime
manifest proves that the same Batch and Task identities passed prepare,
implementation, review, and real tests with valid original evidence. The original
promotion/recovery receipt must bind the delivery commit, candidate, promoted
commit, run, repository, and Batch. Git must confirm the recorded repository HEAD
and both the promoted and delivered commits' ancestry. Missing, fabricated,
mismatched, failed, or deferred receipts do not complete the Batch. `completedAt`
comes from the original `mergedAt`; the original root-plan reduction then marks
the plan done. No new completion evidence is manufactured and no stage check is
relaxed. The normal original `needs_resolution` promotion checkpoint is supported
so Git/Plan crash recovery remains possible.

The second compatibility correction addresses an original field mismatch: the
current strict aggregator writes `finalEvidenceAggregate`, while the unchanged
legacy `code_done` gate consumes `finalVerification`. In the same original manifest
write, a successful actual aggregate with no deferred findings is projected to
that legacy field. This is the same verified fact, not another state machine or
approval. Failed, missing, corrupted, or deferred evidence removes any earlier
successful legacy projection while preserving the actual aggregate diagnostics.
The original `code_done` gate is not modified.

Later successful waves may advance the original HEAD; prior merges remain valid
only as ancestors with their own exact original promotion receipts. This is a
plugin-side compatibility fix, not a platform grant or proof of model quality.
