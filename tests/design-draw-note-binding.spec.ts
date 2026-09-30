/**
 * Unit tests for binding Draw-mode notes to the stroke they explain.
 *
 * Run:
 *   npx -y tsx tests/design-draw-note-binding.spec.ts
 */

import {
  DRAW_NOTE_ATTACH_PADDING,
  getStrokeBounds,
  pickStrokeIdForNotePoint,
  type StrokeHitCandidate
} from "../src/renderer/src/components/design/drawUtils.ts"
import type { DrawPoint } from "../src/renderer/src/components/design/types.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`)
  }
}

/** A rectangular stroke, as if the user drew a box from (x1,y1) to (x2,y2). */
function boxStroke(
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  anchorElement?: Element | null
): StrokeHitCandidate {
  return {
    id,
    points: [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
      { x: x1, y: y1 }
    ],
    anchorElement
  }
}

function point(x: number, y: number): DrawPoint {
  return { x, y }
}

function testStrokeBounds(): void {
  assertEqual(getStrokeBounds([]), null, "empty point list has no bounds")

  const bounds = getStrokeBounds([
    { x: 50, y: 300 },
    { x: 10, y: 100 },
    { x: 30, y: 200 }
  ])
  assert(bounds !== null, "non-empty point list has bounds")
  assertEqual(bounds?.minX, 10, "minX is the smallest x regardless of point order")
  assertEqual(bounds?.maxX, 50, "maxX is the largest x")
  assertEqual(bounds?.minY, 100, "minY is the smallest y")
  assertEqual(bounds?.maxY, 300, "maxY is the largest y")
}

function testNoMatch(): void {
  assertEqual(
    pickStrokeIdForNotePoint([], point(100, 100)),
    undefined,
    "a note with no strokes on canvas stays unbound"
  )

  const far = [boxStroke("s1", 0, 0, 100, 100)]
  assertEqual(
    pickStrokeIdForNotePoint(far, point(900, 900)),
    undefined,
    "a note far from every stroke stays unbound"
  )

  assertEqual(
    pickStrokeIdForNotePoint([{ id: "empty", points: [] }], point(0, 0)),
    undefined,
    "a stroke with no points can never own a note"
  )
}

function testContainment(): void {
  const strokes = [boxStroke("box", 100, 200, 400, 500)]

  assertEqual(
    pickStrokeIdForNotePoint(strokes, point(250, 350)),
    "box",
    "a note dropped inside the box binds to it"
  )
  assertEqual(
    pickStrokeIdForNotePoint(strokes, point(100, 200)),
    "box",
    "a note exactly on the box corner binds to it"
  )
}

function testPaddingBoundary(): void {
  const strokes = [boxStroke("box", 100, 200, 400, 500)]

  // Just outside the drawn edge but within the forgiving padding — the common case of
  // clicking slightly outside the box you just drew.
  assertEqual(
    pickStrokeIdForNotePoint(strokes, point(400 + DRAW_NOTE_ATTACH_PADDING, 350)),
    "box",
    "a note at the padding limit still binds"
  )
  assertEqual(
    pickStrokeIdForNotePoint(strokes, point(100 - DRAW_NOTE_ATTACH_PADDING, 350)),
    "box",
    "padding applies on the left edge too"
  )
  assertEqual(
    pickStrokeIdForNotePoint(strokes, point(400 + DRAW_NOTE_ATTACH_PADDING + 1, 350)),
    undefined,
    "one pixel past the padding does not bind"
  )
  assertEqual(
    pickStrokeIdForNotePoint(strokes, point(250, 500 + DRAW_NOTE_ATTACH_PADDING + 1)),
    undefined,
    "padding is checked on the y axis as well"
  )
}

function testNestedBoxesPickSmallest(): void {
  // A big section box with a small button box inside it. A note on the button must
  // describe the button, not the whole section.
  const outer = boxStroke("outer", 0, 0, 1000, 1000)
  const inner = boxStroke("inner", 400, 400, 500, 500)

  assertEqual(
    pickStrokeIdForNotePoint([outer, inner], point(450, 450)),
    "inner",
    "a note inside nested boxes binds to the smaller one"
  )
  assertEqual(
    pickStrokeIdForNotePoint([inner, outer], point(450, 450)),
    "inner",
    "smallest-area wins regardless of stroke order"
  )
  assertEqual(
    pickStrokeIdForNotePoint([outer, inner], point(50, 50)),
    "outer",
    "a note only inside the big box binds to the big box"
  )
}

function testAnchorFallback(): void {
  // The note landed nowhere near the stroke's coordinates, but both resolved to the
  // same DOM element — e.g. the page reflowed between drawing and annotating.
  // We use plain objects as mock elements; identity comparison is what matters.
  const sharedElement = { id: "card" } as unknown as Element
  const otherElement = { id: "other" } as unknown as Element

  const strokes = [boxStroke("anchored", 0, 0, 50, 50, sharedElement)]

  assertEqual(
    pickStrokeIdForNotePoint(strokes, point(900, 900), sharedElement),
    "anchored",
    "a distant note sharing the stroke's resolved element binds via anchor"
  )
  assertEqual(
    pickStrokeIdForNotePoint(strokes, point(900, 900), otherElement),
    undefined,
    "a different resolved element does not bind"
  )
  assertEqual(
    pickStrokeIdForNotePoint(strokes, point(900, 900)),
    undefined,
    "no anchor and no containment means unbound"
  )
}

function testContainmentBeatsAnchor(): void {
  const sharedElement = { id: "shared" } as unknown as Element

  const containing = boxStroke("containing", 100, 100, 200, 200)
  const anchorOnly = boxStroke("anchorOnly", 800, 800, 900, 900, sharedElement)

  assertEqual(
    pickStrokeIdForNotePoint([anchorOnly, containing], point(150, 150), sharedElement),
    "containing",
    "geometry wins over the anchor fallback when both could match"
  )
}

function testReEvaluationOnNewStroke(): void {
  // Simulates the P1 fix: when you draw a big box, add a note, then draw a small box
  // inside it, the note should rebind from outer to inner if the inner now encloses it.
  const outer = boxStroke("outer", 0, 0, 1000, 1000)
  const inner = boxStroke("inner", 400, 400, 500, 500)
  const notePoint = point(450, 450)

  // Step 1: only outer exists, note binds to outer.
  assertEqual(
    pickStrokeIdForNotePoint([outer], notePoint),
    "outer",
    "note initially binds to the only available frame"
  )

  // Step 2: inner appears, full re-evaluation gives both as candidates, smallest wins.
  assertEqual(
    pickStrokeIdForNotePoint([outer, inner], notePoint),
    "inner",
    "note rebinds to smaller frame when re-evaluated with all strokes"
  )
}

testStrokeBounds()
testNoMatch()
testContainment()
testPaddingBoundary()
testNestedBoxesPickSmallest()
testAnchorFallback()
testContainmentBeatsAnchor()
testReEvaluationOnNewStroke()

console.log("design-draw-note-binding: all assertions passed")
