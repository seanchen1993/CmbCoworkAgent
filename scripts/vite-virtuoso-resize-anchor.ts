import type { Plugin } from "vite"

// react-virtuoso 4.18.12 has no override for its upward resize compensation.
// Patch the renderer's ESM during bundling, including installs with --ignore-scripts.
export function virtuosoResizeAnchor(): Plugin {
  const packageModule = /\/react-virtuoso\/dist\/index\.mjs(?:\?.*)?$/

  return {
    name: "virtuoso-resize-anchor",
    enforce: "pre",
    transform(source, id) {
      if (!packageModule.test(id.replaceAll("\\", "/"))) return

      function replaceOnce(original: string, replacement: string): void {
        const first = source.indexOf(original)
        if (first === -1 || source.indexOf(original, first + original.length) !== -1) {
          throw new Error("The Virtuoso resize anchor patch requires react-virtuoso 4.18.12")
        }
        source = source.replace(original, () => replacement)
      }

      replaceOnce(
        "{ deviation: t, scrollBy: e, scrollingInProgress: n, scrollTop: o },\n    { isAtBottom:",
        "{ deviation: t, headerHeight, scrollBy: e, scrollContainerState,\n" +
          "      scrollingInProgress: n, scrollTop: o,\n" +
          "      statefulScrollTop },\n    { isAtBottom:"
      )
      replaceOnce(
        `    const R = Tt(
      x(
        c,
        $(i),
        Ot(
          ([, f, a, S], [{ bottom: H, items: y, offsetBottom: k, totalCount: u }, g]) => {
            const C = H + k;
            let L = 0;
            return a === u && f.length > 0 && y.length > 0 && (y[0].originalIndex === 0 && f[0].originalIndex === 0 || (L = C - S, L !== 0 && (L += g))), [L, y, u, C];
          },
          [0, [], 0, 0]`,
        `    let resizeClamp, nativeViewport;
    Y(scrollContainerState, (next) => {
      if (it(resizeContext)?.anchorUpwardResize !== true) return;
      const previous = nativeViewport;
      if (previous && previous.scrollTop === next.scrollTop &&
          previous.scrollHeight === next.scrollHeight &&
          previous.viewportHeight === next.viewportHeight) return;
      nativeViewport = next;
      // Bind a clamp to this native geometry. The next distinct scroll or
      // viewport change replaces it, even if the reader returns to this offset.
      resizeClamp = previous && previous.scrollHeight > next.scrollHeight &&
        previous.viewportHeight === next.viewportHeight &&
        previous.scrollTop > next.scrollTop &&
        next.scrollHeight - next.viewportHeight - next.scrollTop < 1
        ? { amount: previous.scrollTop - next.scrollTop, top: next.scrollTop }
        : undefined;
    });
    const R = Tt(
      x(
        c,
        $(i),
        Ot(
          ([, previousItems, previousCount, previousTotal, previousAnchor],
           [{ bottom, firstItemIndex, items, offsetBottom, totalCount }, jump]) => {
            const total = bottom + offsetBottom;
            // listState can publish synchronously while the size stream is notifying subscribers.
            // Read its state directly so this transaction uses the same fresh offset tree.
            const nextAnchor = it(resizeContext)?.anchorUpwardResize === true && {
              firstItemIndex, offsets: it(p).offsetTree, gap: it(m)
            };
            const modelChanged = nextAnchor && previousAnchor &&
              (previousAnchor.offsets !== nextAnchor.offsets ||
               previousAnchor.gap !== nextAnchor.gap);
            const clamp = resizeClamp;
            if (modelChanged || !nextAnchor || previousCount !== totalCount ||
                previousAnchor?.firstItemIndex !== firstItemIndex) resizeClamp = undefined;
            let delta = 0;
            if (previousCount === totalCount && previousItems.length && items.length) {
              if (nextAnchor) {
                if (modelChanged && previousAnchor.firstItemIndex === firstItemIndex &&
                    previousAnchor.offsets.length && nextAnchor.offsets.length) {
                  // A native clamp may have already moved the viewport during this shrink.
                  // Consume its jump once for the new size model, never for later growth.
                  const measuredTop = it(statefulScrollTop);
                  const alreadyMoved = total < previousTotal && clamp?.top === measuredTop
                    ? clamp.amount
                    : 0;
                  // Virtuoso's scrollTop is relative to the list root. Remove its header and
                  // any pending deviation to locate the reading row in the *old* size model.
                  const top = Math.max(0, measuredTop + alreadyMoved - it(headerHeight) - it(t));
                  const segment = Un(previousAnchor.offsets, top, Vo);
                  const stride = segment.size + previousAnchor.gap;
                  const index = Math.min(totalCount - 1, segment.index +
                    (stride > 0 ? Math.floor((top - segment.offset) / stride) : 0));
                  delta = ce(index, nextAnchor.offsets, nextAnchor.gap) -
                    ce(index, previousAnchor.offsets, previousAnchor.gap);
                  // A clamped viewport is already at its new bottom. Keep only
                  // a remaining upward correction.
                  if (alreadyMoved > 0) delta = Math.min(0, delta + alreadyMoved);
                }
              } else if (items[0].originalIndex !== 0 || previousItems[0].originalIndex !== 0) {
                delta = total - previousTotal;
                if (delta !== 0) delta += jump;
              }
            }
            return [delta, items, totalCount, total, nextAnchor];
          },
          [0, [], 0, 0, null]`
      )
      replaceOnce(
        "    { log: I },\n    { recalcInProgress: w }\n  ]) => {",
        "    { log: I },\n    { recalcInProgress: w },\n    { context: resizeContext }\n  ]) => {"
      )
      replaceOnce("  rt(It, pe, Kt, Lt, Gt, Ue)", "  rt(It, pe, Kt, Lt, Gt, Ue, Qn)")

      return { code: source, map: null }
    }
  }
}
