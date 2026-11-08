# react-virtuoso 4.18.12 scroll cancellation backport

This independent three-file patch backports the cancellation stream and navigation-id
guard from upstream [PR #1551](https://github.com/petyosi/react-virtuoso/pull/1551):
`90269d2` (ignore superseded watch timers) and `768f9a4` (expose cancellation).
The PR was **open and unmerged when checked on 2026-11-08**. This is a local
backport, not a released upstream API or a dependency upgrade.

The original npm tarball is react-virtuoso 4.18.12 under the MIT license.
`manifest.json` records its official URL, integrity and SHA256, the existing lockfile
mirror URL, and the unchanged installed package metadata/LICENSE hashes. The installed
ESM, CJS and declarations were compared byte for byte with the official tarball before
generating this patch. Their complete original/target SHA256 values and the patch hash
are recorded in the manifest. The upstream diff hash records the retrieved review source.

The retry cancellation follows the upstream algorithm: each navigation captures an increasing
id, a stale retry returns before cleanup, and cancellation advances the id then releases
the active subscriptions/timer and scrolling flag. `cancelScrollToIndex()` does not move
the viewport. It is exposed on Virtuoso, GroupedVirtuoso, TableVirtuoso and
GroupedTableVirtuoso handles, including matching declarations; the grid API is unchanged.
Readable identifier names in the distributed bundles keep the small backport auditable.

The patch additionally includes a **local initial-presentation lifecycle extension**, not
present in that upstream PR. In 4.18.12, initial positioning can keep the item list hidden
until `scrollTargetReached`; cancelling its watch must not leave that gate waiting forever.
The initial-position system therefore observes cancellation separately, invalidates its
queued four-frame callbacks, unsubscribes all of its pending completion/scroll listeners,
then releases both initial-presentation flags. It never publishes a fake successful
`scrollTargetReached` event and never issues the cancelled initial navigation afterward.
Normal initial scheduling is unchanged; subsequent explicit navigation still works.
Cancellation always retires the old generation and listeners, but only publishes an initial
flag when it is still false. Repeated cancellation after initialization therefore does not
broadcast duplicate true values into Virtuoso's list calculation stream.

A second **local extension**, `setExternalScrollAnchor({ owner, active })`, coordinates
ordinary upward resize compensation with an application that preserves an exact DOM row
offset. Each owner is an object token. Acquire before measuring/correcting the DOM anchor,
and release the same token on handoff, cancellation or cleanup; overlapping owners are
supported and a stale release cannot release another owner. The method is exposed on the
same list/table handles as cancellation. With no owners, ordinary native resize compensation
keeps its original behavior. While owned, its height scan continues updating but its resize output
is suppressed. Releasing an owner does not replay suppressed deltas. This does not cancel
explicit navigation, change item measurements, or disable prepend/trim compensation.

On iOS, native upward resize compensation can accumulate a deferred deviation. The patch
tracks that contribution separately from the shared prepend deviation. Acquisition retires
queued upward work and removes only its pending contribution. Deferred callbacks carry
their source and generation; prepend also retires an older queued upward callback before
taking over the shared deviation. Thus neither an external acquisition nor a stale upward
flush can erase a newer prepend transaction. The stale upward/prepend race guard also applies
without an external owner; this is a narrow additional correction to the original behavior.
Existing prepend frame callbacks remain intact.
The standalone patch suite exercises both bundle formats, default behavior against the
original bundles, overlapping owners, release without replay, iOS deferred cancellation,
and prepend/trim preservation. These ownership APIs are local additions, not upstream PR APIs.

The local `refreshItemSizes(): void` method explicitly runs the current mounted list's
native measurement callback, including its configured `itemSize`, horizontal direction,
viewport and gap measurements. It accepts no saved ranges or indices, so a caller cannot
accidentally feed measurements from an older virtual window into a new handle. List and
table bodies subscribe to their own system's signal; an unmounted or nonmeasurable body
does nothing. Without an explicit call, the original ResizeObserver path remains unchanged;
there is no polling or additional observer. This addresses balanced row growth/shrink that
leaves the observed list's total height unchanged and therefore need not trigger a resize.

An external anchor acquires ownership, calls `refreshItemSizes()` **before** cancelling
index positioning, then finds its current DOM target and measures its offset again. The
method synchronously publishes native measurements; returning does **not** mean React has
committed new spacers or rows. Existing cross-frame correction and cancellation still apply.
After an actual scroll-position change during that correction (including a native index
retry inside the first refresh), the owner refreshes once more to publish the final native
scroll state. In ResizeObserver delivery, the DOM scroll event may arrive after the next
range commit; relying on that event alone can briefly recycle the preserved row. Stable
frames do not request these measurements, and an active correction uses at most two scans.
Cancelling an initial hidden probe first can expose a range calculated from stale sizes.
The application lets outstanding hidden item measurements commit before that handoff.
Session restoration cancels only when it has an actual destination to take over; a cold
mounted row alone is insufficient because its batched placeholder sizes may still change.
Until then, native positioning retains its existing measurement retries and independent
completion. User cancellation and the original restoration deadline remain immediate and
bounded; there is no additional visibility gate or authorization wait. Mounted chat anchors
use the native index model plus their in-item offset, with subpixel `itemSize` precision,
rather than correcting against potentially stale absolute spacer geometry. Those requests cancel
their own retry immediately; deliberate missing-item reveals keep normal navigation.
The API is exposed on the same list/table handles; grid behavior is unchanged.

The chat host retains native deferred ResizeObserver measurement. Its existing layout
observer also serves active session/history anchors, correcting mounted geometry before
the queued native range update can recycle readable rows. That path does not advance the
restoration frame budget, issue missing-item navigation, or schedule another frame.
Only current mounted rows are observed during restoration; user takeover and cleanup
release them. Detached native anchors can refresh explicitly, so their mutation path no
longer needs the legacy two-frame measurement barrier. DOM-only users retain that barrier.

The renderer optimizer includes this patch's verified SHA256 in
`optimizeDeps.esbuildOptions.define`. Vite includes those options in its dependency cache
hash, whereas arbitrary renderer `define` entries are not sufficient in this Vite version.
An unchanged patch reuses the prebundle; changed patch bytes invalidate it without forcing
optimization on every launch or changing the application's version.

Run `node scripts/apply-react-virtuoso-scroll-cancel.mjs` to apply. All three files must
be original, or all three must already match the targets (idempotent). Unknown bytes,
mixed original/patched files, or an unpinned dependency fail before target writes.
`--check` and the synchronous `checkReactVirtuosoScrollCancel({ workspaceRoot })` API
are read-only and reject an unpatched installation. Installation stages all outputs and
retains rollback files, validates ownership, then replaces targets; failures attempt to
restore only files still owned by this invocation. No network access or patch evaluation
occurs during installation/checking.

The patch has its own installer/receipt and does not extend the existing 31-file
LangChain native-foundation collection. `postinstall` applies it; predev/prebuild/pretest,
the Electron Vite entry and source-candidate verification only check. Linux CI explicitly
applies it after `npm ci --ignore-scripts`. Application version 2.0.0 is unchanged.

For an upstream upgrade, regenerate and review this complete receipt against the new
tarball and upstream implementation; do not bypass unknown-file checks. Reinstalling the
locked package restores originals for reproduction, after which this installer can reapply.

## License

The upstream code is MIT licensed. The original `node_modules/react-virtuoso/LICENSE`
is preserved and verified, including its copyright and permission notice. The upstream
MIT license applies to this derived patch as well; `LICENSE` alongside this README is a
verbatim copy from the verified 4.18.12 tarball.
