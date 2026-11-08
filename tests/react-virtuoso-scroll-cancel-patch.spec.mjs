import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import vm from "node:vm"
import { transformSync } from "esbuild"
import {
  checkReactVirtuosoScrollCancel,
  installReactVirtuosoScrollCancel
} from "../scripts/apply-react-virtuoso-scroll-cancel.mjs"
import { applyNativeTextPatch } from "../scripts/langchain-native-patch-text.mjs"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const artifact = resolve(repository, "patches/react-virtuoso-scroll-cancel")
const manifest = JSON.parse(readFileSync(resolve(artifact, "manifest.json")))
const patch = readFileSync(resolve(artifact, "react-virtuoso-4.18.12.patch"), "utf8")
checkReactVirtuosoScrollCancel({ workspaceRoot: repository })
const synchronousCheck = execFileSync(
  process.execPath,
  [
    "-e",
    `const assert = require("node:assert/strict")
     const { checkReactVirtuosoScrollCancel } = require(process.argv[2])
     assert.equal(typeof checkReactVirtuosoScrollCancel, "function")
     const result = checkReactVirtuosoScrollCancel({ workspaceRoot: process.argv[3] })
     assert.deepEqual(result, { status: "installed", targets: 3 })
     process.stdout.write(JSON.stringify(result))`,
    "cjs-candidate-loader-regression",
    resolve(repository, "scripts/apply-react-virtuoso-scroll-cancel.mjs"),
    repository
  ],
  { encoding: "utf8" }
)
assert.deepEqual(
  JSON.parse(synchronousCheck),
  { status: "installed", targets: 3 },
  "CJS candidate loaders can require the installer without a top-level-await module boundary"
)
const installed = new Map(
  manifest.files.map((file) => [
    file.path,
    readFileSync(resolve(repository, "node_modules/react-virtuoso", file.path))
  ])
)
const reverse = patch
  .split("\n")
  .map((line) => {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) return line
    const hunk = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/.exec(line)
    if (hunk) return `@@ -${hunk[2]} +${hunk[1]} @@${hunk[3]}`
    return line[0] === "+" ? `-${line.slice(1)}` : line[0] === "-" ? `+${line.slice(1)}` : line
  })
  .join("\n")
const originals = applyNativeTextPatch(reverse, installed)
for (const file of manifest.files) assert.equal(hash(originals.get(file.path)), file.beforeSha256)

const fixtureRoot = mkdtempSync(resolve(tmpdir(), "virtuoso-patch-"))
const targetRoot = resolve(fixtureRoot, "node_modules/react-virtuoso")
mkdirSync(resolve(targetRoot, "dist"), { recursive: true })
const locked = JSON.parse(readFileSync(resolve(repository, "package-lock.json"))).packages[
  "node_modules/react-virtuoso"
]
const rootPackage = { dependencies: { "react-virtuoso": "4.18.12" } }
writeFileSync(resolve(fixtureRoot, "package.json"), JSON.stringify(rootPackage))
writeFileSync(
  resolve(fixtureRoot, "package-lock.json"),
  JSON.stringify({
    packages: {
      "": rootPackage,
      "node_modules/react-virtuoso": locked
    }
  })
)
for (const file of ["package.json", "LICENSE"])
  writeFileSync(
    resolve(targetRoot, file),
    readFileSync(resolve(repository, "node_modules/react-virtuoso", file))
  )
const restoreOriginal = () => {
  for (const [path, bytes] of originals) writeFileSync(resolve(targetRoot, path), bytes)
}
const snapshot = () =>
  manifest.files.map((file) => hash(readFileSync(resolve(targetRoot, file.path))))
try {
  restoreOriginal()
  const originalHashes = snapshot()
  assert.throws(
    () => checkReactVirtuosoScrollCancel({ workspaceRoot: fixtureRoot }),
    /NOT_INSTALLED/
  )
  assert.deepEqual(snapshot(), originalHashes, "Read-only check never patches originals")
  assert.equal(
    (await installReactVirtuosoScrollCancel({ workspaceRoot: fixtureRoot })).status,
    "applied"
  )
  const targetHashes = snapshot()
  assert.deepEqual(
    targetHashes,
    manifest.files.map((file) => file.afterSha256)
  )
  assert.equal(
    (await installReactVirtuosoScrollCancel({ workspaceRoot: fixtureRoot })).status,
    "installed"
  )
  assert.deepEqual(snapshot(), targetHashes, "Repeated application is byte-idempotent")
  assert.equal(checkReactVirtuosoScrollCancel({ workspaceRoot: fixtureRoot }).targets, 3)
  for (const mode of ["unknown", "mixed"]) {
    restoreOriginal()
    const path = manifest.files[0].path
    writeFileSync(
      resolve(targetRoot, path),
      mode === "mixed" ? installed.get(path) : Buffer.from("unknown")
    )
    const before = snapshot()
    await assert.rejects(
      installReactVirtuosoScrollCancel({ workspaceRoot: fixtureRoot }),
      /MIXED_OR_UNKNOWN_FILES/
    )
    assert.deepEqual(snapshot(), before, `${mode} files must be rejected without partial patching`)
  }
  restoreOriginal()
  const untouchedBefore = ["index.cjs", "index.d.ts"].map((name) => {
    const info = statSync(resolve(targetRoot, "dist", name))
    return { name, ino: info.ino, mtimeMs: info.mtimeMs }
  })
  const faultResult = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict"
    import fs from "node:fs"
    import { createHash } from "node:crypto"
    import { syncBuiltinESMExports } from "node:module"
    import { dirname, resolve } from "node:path"
    const [workspaceRoot, installerUrl, firstTargetHash] = process.argv.slice(1)
    const rename = fs.renameSync
    let injected = false, committed = false, rolledBack = false
    const destinations = []
    fs.renameSync = (source, target) => {
      destinations.push(target)
      if (!injected && source.endsWith(".tmp") && target.endsWith("index.cjs")) {
        const first = fs.readFileSync(resolve(dirname(target), "index.mjs"))
        assert.equal(createHash("sha256").update(first).digest("hex"), firstTargetHash)
        committed = true
        injected = true
        throw Error("INJECTED_SECOND_TARGET_RENAME")
      }
      const result = rename(source, target)
      if (source.endsWith(".rollback") && target.endsWith("index.mjs")) rolledBack = true
      return result
    }
    syncBuiltinESMExports()
    const { installReactVirtuosoScrollCancel } = await import(installerUrl)
    await assert.rejects(installReactVirtuosoScrollCancel({ workspaceRoot }),
      /INJECTED_SECOND_TARGET_RENAME/)
    assert(injected && committed && rolledBack)
    assert(!destinations.some(path => path.endsWith("index.d.ts")))
    process.stdout.write(JSON.stringify({ injected, committed, rolledBack }))
  `,
      fixtureRoot,
      pathToFileURL(resolve(repository, "scripts/apply-react-virtuoso-scroll-cancel.mjs")).href,
      manifest.files[0].afterSha256
    ],
    { encoding: "utf8" }
  )
  assert.deepEqual(JSON.parse(faultResult), { injected: true, committed: true, rolledBack: true })
  assert.deepEqual(snapshot(), originalHashes, "A mid-commit failure restores the committed target")
  for (const before of untouchedBefore) {
    const after = statSync(resolve(targetRoot, "dist", before.name))
    assert.equal(after.ino, before.ino, `${before.name} was never replaced`)
    assert.equal(after.mtimeMs, before.mtimeMs, `${before.name} was never rewritten`)
  }
  assert.deepEqual(readdirSync(resolve(targetRoot, "dist")).sort(), [
    "index.cjs",
    "index.d.ts",
    "index.mjs"
  ])
  assert.deepEqual(
    readdirSync(resolve(fixtureRoot, "node_modules")),
    ["react-virtuoso"],
    "Rollback removes the install lock and all temporary/rollback files"
  )
  writeFileSync(
    resolve(fixtureRoot, "package.json"),
    JSON.stringify({ dependencies: { "react-virtuoso": "^4.18.12" } })
  )
  await assert.rejects(
    installReactVirtuosoScrollCancel({ workspaceRoot: fixtureRoot }),
    /DEPENDENCY_LOCK_INVALID/
  )
  assert.deepEqual(snapshot(), originalHashes)
} finally {
  assert(relative(tmpdir(), fixtureRoot).startsWith("virtuoso-patch-"))
  rmSync(fixtureRoot, { recursive: true, force: true })
}

function clock() {
  let time = 0,
    sequence = 0
  const timers = new Map()
  return {
    setTimeout(callback, delay = 0) {
      const id = ++sequence
      timers.set(id, { callback, at: time + delay })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(delta) {
      const end = time + delta
      while (true) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
        if (!next) break
        time = next[1].at
        timers.delete(next[0])
        next[1].callback()
      }
      time = end
    }
  }
}

function engine(format, bytes, { smooth = false, initial = false } = {}) {
  const timer = clock()
  const context = vm.createContext({
    console,
    require: createRequire(import.meta.url),
    exports: {},
    module: { exports: {} },
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    requestAnimationFrame: (callback) => timer.setTimeout(callback, 16),
    // The bundled normalizer checks browser support before preserving behavior: smooth.
    ...(smooth
      ? {
          document: {
            documentElement: { style: { scrollBehavior: "" } },
            createElement: () => ({ style: {} })
          }
        }
      : {})
  })
  // Expose the actual bundled URX definitions only inside this test VM. No runtime test export is shipped.
  const expose =
    format === "esm"
      ? "globalThis.testInternals={scroll:fe,size:Lt,dom:It,initial:me,mount:At,publish:M,subscribe:Y,value:it};"
      : "globalThis.testInternals={scroll:ae,size:Ot,dom:xt,initial:de,mount:Mt,publish:A,subscribe:Y,value:it};"
  const source = bytes.toString("utf8") + "\n" + expose
  const code =
    format === "esm" ? transformSync(source, { format: "cjs", platform: "node" }).code : source
  vm.runInContext(code, context)
  const api = context.testInternals
  const instances = new Map()
  const init = (definition) => {
    if (instances.has(definition.id)) return instances.get(definition.id)
    const value = definition.constructor(definition.dependencies.map(init))
    instances.set(definition.id, value)
    return value
  }
  const streams = {
    ...init(api.scroll),
    ...init(api.size),
    ...init(api.dom),
    ...(initial ? { ...init(api.initial), ...init(api.mount) } : {})
  }
  const moves = [],
    reached = []
  const initialUpdates = []
  if (initial) {
    api.subscribe(streams.scrolledToInitialItem, (value) =>
      initialUpdates.push(["scrolled", value])
    )
    api.subscribe(streams.initialItemFinalLocationReached, (value) =>
      initialUpdates.push(["final", value])
    )
  }
  api.publish(streams.totalCount, 100)
  api.publish(streams.viewportHeight, 200)
  api.subscribe(streams.scrollTo, (value) => moves.push(value))
  api.subscribe(streams.scrollTargetReached, (value) => reached.push(value))
  return {
    timer,
    moves,
    reached,
    initialUpdates,
    initialState: () => [
      api.value(streams.scrolledToInitialItem),
      api.value(streams.initialItemFinalLocationReached)
    ],
    send: (name, value = true) => api.publish(streams[name], value),
    scrolling: () => api.value(streams.scrollingInProgress)
  }
}

function compensationEngine(format, bytes, { ios = false } = {}) {
  const timer = clock()
  const context = vm.createContext({
    console,
    require: createRequire(import.meta.url),
    exports: {},
    module: { exports: {} },
    navigator: { userAgent: ios ? "iPhone AppleWebKit" : "Windows Chrome" },
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
    requestAnimationFrame: (callback) => timer.setTimeout(callback, 16)
  })
  const expose =
    format === "esm"
      ? "globalThis.testInternals={compensation:sr,stream:U,state:T,publish:M,subscribe:Y,value:it};"
      : "globalThis.testInternals={compensation:or,stream:$,state:T,publish:A,subscribe:Y,value:it};"
  const source = bytes.toString("utf8") + "\n" + expose
  vm.runInContext(
    format === "esm" ? transformSync(source, { format: "cjs", platform: "node" }).code : source,
    context
  )
  const api = context.testInternals
  // Exercise the shipped compensation constructor and real URX operators. Inputs isolate
  // resize/scroll/prepend transactions from the unrelated renderer and size-tree producer.
  const streams = {
    deviation: api.state(0),
    scrollBy: api.stream(),
    scrollingInProgress: api.state(false),
    scrollTop: api.state(500),
    isAtBottom: api.state(false),
    isScrolling: api.state(false),
    lastJumpDueToItemResize: api.state(0),
    scrollDirection: api.state("up"),
    listState: api.stream(),
    beforeUnshiftWith: api.stream(),
    gap: api.state(0),
    shiftWithOffset: api.stream(),
    sizes: api.state({ groupIndices: [], lastSize: 50, sizeTree: null }),
    log: api.state(() => {}),
    recalcInProgress: api.state(false)
  }
  Object.assign(streams, api.compensation.constructor(Array(6).fill(streams)))
  const moves = []
  api.subscribe(streams.scrollBy, (value) => moves.push(value.top))
  const send = (name, value) => api.publish(streams[name], value)
  let height = 1000
  const resize = (delta) => {
    height += delta
    send("listState", {
      bottom: height,
      offsetBottom: 100,
      totalCount: 100,
      items: [{ originalIndex: 10 }]
    })
  }
  resize(0)
  return { timer, moves, send, resize, deviation: () => api.value(streams.deviation) }
}

function checkNativeMeasurement(format, bytes) {
  const require = createRequire(import.meta.url)
  const react = require("react")
  const events = [],
    dimensions = []
  const style = (node) => ({ rowGap: "5px", columnGap: "7px", direction: node.direction ?? "ltr" })
  const context = vm.createContext({
    console,
    exports: {},
    module: { exports: {} },
    getComputedStyle: style,
    require: (name) =>
      name === "react"
        ? {
            ...react,
            useRef: (value) => ({ current: value }),
            useMemo: (factory) => factory(),
            useCallback: (callback) => callback
          }
        : require(name),
    ResizeObserver: class {
      observe() {
        /* Delivery is explicit in this hook-level regression. */
      }
      unobserve() {
        /* No observer delivery is scheduled by this fixture. */
      }
    },
    setTimeout,
    clearTimeout
  })
  const source = bytes.toString() + "\nglobalThis.nativeMeasurement=Gn;"
  vm.runInContext(
    format === "esm" ? transformSync(source, { format: "cjs", platform: "node" }).code : source,
    context
  )
  const viewport = {
    dataset: { virtuosoScroller: "true" },
    scrollHeight: 3000,
    offsetHeight: 600,
    scrollTop: 100,
    scrollWidth: 4000,
    offsetWidth: 620,
    scrollLeft: 123,
    ownerDocument: { defaultView: { getComputedStyle: style } }
  }
  const makeList = (sizes) => {
    const children = sizes.map(([index, known, size]) => ({
      dataset: { index: String(index), knownSize: String(known) },
      size
    }))
    children.item = (index) => children[index]
    return { children, parentElement: viewport, offsetParent: viewport }
  }
  const create = (horizontal = false, track = true) =>
    context.nativeMeasurement(
      (ranges) => events.push(["sizes", JSON.parse(JSON.stringify(ranges))]),
      (element, dimension) => {
        dimensions.push(dimension)
        return element.size
      },
      track,
      (value) => events.push(["viewport", JSON.parse(JSON.stringify(value))]),
      () => {},
      (gap) => events.push(["gap", gap]),
      viewport,
      horizontal,
      true
    )
  const hook = create()
  const list = makeList([
    [80, 400, 2600],
    [81, 400, 400],
    [83, 2400, 200]
  ])
  hook.callbackRef(list)
  assert.equal(events.length, 0, "Mounting adds no explicit measurement work")
  hook.measureCurrentItems()
  assert.deepEqual(
    events.map(([kind]) => kind),
    ["viewport", "gap", "sizes"]
  )
  assert.deepEqual(
    events[2][1],
    [
      { startIndex: 80, endIndex: 80, size: 2600 },
      { startIndex: 83, endIndex: 83, size: 200 }
    ],
    `${format}: native scan detects balanced changes despite unchanged total height`
  )
  assert(dimensions.every((dimension) => dimension === "offsetHeight"))
  events.length = 0
  for (const child of list.children) child.dataset.knownSize = String(child.size)
  viewport.offsetHeight = 450
  viewport.scrollTop = 175
  hook.measureCurrentItems()
  assert.deepEqual(events[2], ["sizes", []], "Unchanged items retain the native empty change set")
  assert.deepEqual(
    events[0][1],
    { scrollHeight: 3000, scrollTop: 175, viewportHeight: 450 },
    "Refresh includes current viewport geometry before a browser scroll/resize event"
  )
  const captured = hook.measureCurrentItems
  hook.callbackRef(makeList([[2, 10, 20]]))
  events.length = 0
  captured()
  assert.equal(
    events[2][1][0].startIndex,
    2,
    "The callback reads the current ref, never saved items"
  )
  hook.callbackRef(null)
  events.length = 0
  captured()
  assert.equal(events.length, 0, "Old unmounted refs cannot feed a replacement system")
  const horizontal = create(true)
  horizontal.callbackRef(makeList([[0, 1, 50]]))
  horizontal.measureCurrentItems()
  assert.equal(
    dimensions.at(-1),
    "offsetWidth",
    "Native custom itemSize receives horizontal dimension"
  )
  assert.deepEqual(events[0][1], { scrollHeight: 4000, scrollTop: 123, viewportHeight: 620 })
  assert.deepEqual(events[1], ["gap", 7])
  events.length = 0
  const hidden = makeList([[0, 1, 50]])
  hidden.offsetParent = null
  horizontal.callbackRef(hidden)
  horizontal.measureCurrentItems()
  assert.equal(events.length, 0, "Nonmeasurable lists do not publish zero measurements")
  const fixed = create(false, false)
  fixed.callbackRef(list)
  fixed.measureCurrentItems()
  assert.equal(events.length, 0, "Fixed item sizing retains the native tracking policy")
}

for (const [format, path] of [
  ["esm", "dist/index.mjs"],
  ["cjs", "dist/index.cjs"]
]) {
  checkNativeMeasurement(format, installed.get(path))
  {
    const e = compensationEngine(format, installed.get(path))
    const old = compensationEngine(format, originals.get(path))
    e.resize(100)
    old.resize(100)
    assert.deepEqual(e.moves, old.moves, `${format}: default resize compensation is unchanged`)
    const first = {},
      second = {}
    e.send("setExternalScrollAnchor", { owner: first, active: true })
    e.send("setExternalScrollAnchor", { owner: first, active: true })
    e.resize(3795)
    e.send("setExternalScrollAnchor", { owner: second, active: true })
    e.send("setExternalScrollAnchor", { owner: first, active: false })
    e.send("setExternalScrollAnchor", { owner: first, active: false })
    e.resize(-592)
    assert.deepEqual(e.moves, [100], `${format}: stale release cannot end another owner's lease`)
    e.send("setExternalScrollAnchor", { owner: second, active: false })
    e.timer.advance(100)
    assert.deepEqual(e.moves, [100], "Releasing ownership never replays suppressed deltas")
    e.resize(25)
    assert.deepEqual(e.moves, [100, 25], "Resize scan kept the latest baseline during ownership")
    e.send("setExternalScrollAnchor", { owner: first, active: true })
    e.send("shiftWithOffset", 225)
    assert.equal(e.moves.at(-1), -225, "Trim compensation remains active during external ownership")
    e.send("recalcInProgress", true)
    e.send("beforeUnshiftWith", 2)
    assert.equal(e.deviation(), 100)
    e.timer.advance(32)
    assert.equal(e.moves.at(-1), 100, "Prepend compensation retains both frame callbacks")
    assert.equal(e.deviation(), 0)
  }
  for (const queued of [false, true]) {
    const e = compensationEngine(format, installed.get(path), { ios: true })
    const owner = {}
    e.send("isScrolling", true)
    e.resize(100)
    assert.equal(e.deviation(), -100, "iOS accumulates resize deviation while scrolling")
    if (queued) e.send("isScrolling", false)
    e.send("setExternalScrollAnchor", { owner, active: true })
    assert.equal(e.deviation(), 0, "Acquisition removes only the pending upward contribution")
    e.send("setExternalScrollAnchor", { owner, active: false })
    e.send("isScrolling", false)
    e.timer.advance(10)
    assert.deepEqual(
      e.moves,
      [],
      `${format}: cancelled iOS pending/queued compensation cannot replay`
    )
    e.resize(25)
    assert.deepEqual(e.moves, [25])
  }
  {
    const e = compensationEngine(format, installed.get(path), { ios: true })
    const old = compensationEngine(format, originals.get(path), { ios: true })
    for (const instance of [e, old]) {
      instance.send("isScrolling", true)
      instance.resize(100)
      instance.send("isScrolling", false)
      instance.timer.advance(1)
    }
    assert.deepEqual(e.moves, old.moves, `${format}: default iOS delayed compensation is unchanged`)
    assert.deepEqual(e.moves, [100])
    assert.equal(e.deviation(), 0)
  }
  for (const acquire of [false, true]) {
    const e = compensationEngine(format, installed.get(path), { ios: true })
    e.send("isScrolling", true)
    e.resize(100)
    e.send("isScrolling", false) // Queue the old upward flush for the next millisecond.
    e.send("recalcInProgress", true)
    e.send("beforeUnshiftWith", 2) // Prepend now owns the shared deviation value.
    if (acquire) e.send("setExternalScrollAnchor", { owner: {}, active: true })
    assert.equal(e.deviation(), 100, "External acquisition cannot clear prepend-owned deviation")
    e.timer.advance(1)
    assert.deepEqual(
      e.moves,
      [],
      "An old upward flush cannot overwrite the newer prepend transaction"
    )
    assert.equal(e.deviation(), 100)
    e.timer.advance(31)
    assert.deepEqual(e.moves, [100])
    assert.equal(e.deviation(), 0)
  }
  const mountInitial = (e) => {
    e.send("initialTopMostItemIndex", { index: "LAST", align: "end" })
    e.send("defaultItemSize", 50)
    e.send("propsReady")
    e.send("listRefresh")
  }
  for (const elapsed of [16, 80]) {
    const e = engine(format, installed.get(path), { initial: true })
    mountInitial(e)
    // More than one initial refresh can queue work; cancellation must retire every listener/job.
    e.send("listRefresh")
    e.timer.advance(elapsed)
    assert.deepEqual(e.initialState(), [false, false])
    const issued = e.moves.length
    assert(elapsed < 64 ? issued === 0 : issued > 0)
    e.send("cancelScrollToIndex")
    e.send("cancelScrollToIndex")
    assert.deepEqual(
      e.initialState(),
      [true, true],
      `${format}: cancellation releases initial visibility`
    )
    assert.equal(e.reached.length, 0, "Releasing initial visibility is not successful navigation")
    const initialUpdateCount = e.initialUpdates.length
    e.send("listRefresh")
    e.send("scrollTop", 100)
    e.timer.advance(30000)
    assert.equal(
      e.moves.length,
      issued,
      `${format}: cancelled four-frame work never steals the position`
    )
    assert.equal(e.reached.length, 0)
    assert.equal(
      e.initialUpdates.length,
      initialUpdateCount,
      "Cancelled initial scroll listeners are removed"
    )
    e.send("scrollToIndex", 20)
    e.timer.advance(200)
    assert.equal(e.moves.length, issued + 1)
    assert.equal(e.reached.length, 1, "A later explicit navigation can finish normally")
    assert.equal(
      e.initialUpdates.length,
      initialUpdateCount,
      "Old initial completion listeners are removed"
    )
  }
  let normalInitialMoves
  for (const cancelBeforeMount of [false, true]) {
    const e = engine(format, installed.get(path), { initial: true })
    if (cancelBeforeMount) {
      e.send("cancelScrollToIndex")
      e.send("cancelScrollToIndex")
    }
    mountInitial(e)
    assert.deepEqual(e.initialState(), [false, false])
    e.timer.advance(64)
    assert(e.moves.length > 0, `${format}: actual mount retains its initial positioning`)
    if (cancelBeforeMount) assert.equal(e.moves.length, normalInitialMoves)
    else normalInitialMoves = e.moves.length
    e.send("scrollTop", 100)
    e.timer.advance(200)
    assert.deepEqual(e.initialState(), [true, true])
    assert.equal(e.reached.length, 1)
    const completedUpdates = e.initialUpdates.length
    for (let index = 0; index < 3; index++) e.send("cancelScrollToIndex")
    assert.equal(
      e.initialUpdates.length,
      completedUpdates,
      `${format}: completed initial flags do not broadcast duplicate values on cancellation`
    )
    assert.deepEqual(e.initialState(), [true, true])
    e.send("scrollToIndex", 20)
    e.timer.advance(200)
    assert.equal(e.reached.length, 2, "Repeated cancellation does not block later navigation")
  }
  {
    const e = engine(format, installed.get(path), { smooth: true })
    e.send("scrollToIndex", 0)
    e.timer.advance(50)
    e.send("scrollToIndex", { index: 10, behavior: "smooth" })
    assert.equal(e.moves.at(-1).behavior, "smooth", `${format}: exercise the actual smooth branch`)
    e.send("listRefresh")
    e.send("cancelScrollToIndex")
    assert.equal(e.scrolling(), false)
    e.send("smoothScrollTargetReached")
    assert.equal(e.moves.length, 2, `${format}: cancelled smooth listener cannot retry`)
    assert.equal(e.reached.length, 0)
    e.send("scrollToIndex", { index: 20, behavior: "smooth" })
    // The first auto navigation's orphaned 150 ms watch callback now fires during this smooth one.
    e.timer.advance(110)
    assert.equal(
      e.scrolling(),
      true,
      `${format}: old watch cannot clean up a new smooth navigation`
    )
    assert.equal(e.reached.length, 0)
    e.send("listRefresh")
    e.send("smoothScrollTargetReached")
    assert.equal(
      e.moves.length,
      4,
      `${format}: the new smooth navigation retains its retry listener`
    )
    assert.equal(e.moves.at(-1).behavior, "smooth")
    assert.equal(e.scrolling(), true)
    e.send("smoothScrollTargetReached")
    assert.equal(e.moves.length, 4)
    assert.equal(e.reached.length, 1, `${format}: the current smooth navigation alone completes`)
    assert.equal(e.scrolling(), false)
    e.timer.advance(1400)
    assert.equal(e.reached.length, 1)
  }
  {
    const e = engine(format, installed.get(path))
    e.send("scrollToIndex", 10)
    assert.equal(e.scrolling(), true)
    e.send("cancelScrollToIndex")
    assert.equal(e.scrolling(), false)
    assert.equal(e.moves.length, 1, "Cancel itself never moves the viewport")
    e.timer.advance(100)
    e.send("listRefresh")
    e.timer.advance(1400)
    assert.equal(e.moves.length, 1, `${format}: cancelled navigation never retries`)
    assert.equal(e.reached.length, 0, `${format}: cancelled watch timer never reports completion`)
  }
  {
    const e = engine(format, installed.get(path))
    e.send("scrollToIndex", 0)
    e.timer.advance(50)
    e.send("cancelScrollToIndex")
    e.send("scrollToIndex", 10)
    e.timer.advance(110)
    assert.equal(
      e.scrolling(),
      true,
      `${format}: cancelled old watch timer cannot clear the new navigation`
    )
    assert.equal(e.reached.length, 0)
    e.send("listRefresh")
    assert.equal(e.moves.length, 3, `${format}: navigation after cancellation still retries`)
  }
  {
    const e = engine(format, installed.get(path))
    e.send("scrollToIndex", 0)
    e.timer.advance(50)
    e.send("scrollToIndex", 10)
    e.timer.advance(110)
    assert.equal(
      e.scrolling(),
      true,
      `${format}: superseded old timer cannot clear the new navigation`
    )
    e.send("listRefresh")
    assert.equal(e.moves.length, 3)
    // Prove this regression actually detects the unpatched 4.18.12 behavior.
    const old = engine(format, originals.get(path))
    old.send("scrollToIndex", 0)
    old.timer.advance(50)
    old.send("scrollToIndex", 10)
    old.timer.advance(110)
    old.send("listRefresh")
    assert.equal(old.moves.length, 2, `${format}: original package exposes the stale timer bug`)
  }
}
assert.equal(
  (
    installed
      .get("dist/index.d.ts")
      .toString()
      .match(/cancelScrollToIndex\(\): void;/g) ?? []
  ).length,
  3
)
assert.equal(
  (
    installed
      .get("dist/index.d.ts")
      .toString()
      .match(/setExternalScrollAnchor\(lease:/g) ?? []
  ).length,
  3,
  "All list/table handle declarations expose tokenized external ownership"
)
assert.equal(
  (
    installed
      .get("dist/index.d.ts")
      .toString()
      .match(/refreshItemSizes\(\): void;/g) ?? []
  ).length,
  3,
  "All list/table handle declarations expose current-ref measurement refresh"
)

const cacheParent = resolve(repository, "node_modules/.cache")
mkdirSync(cacheParent, { recursive: true })
const optimizerRoot = mkdtempSync(resolve(cacheParent, "virtuoso-digest-"))
try {
  const { resolveConfig, optimizeDeps } = await import("vite")
  const optimize = async (digest) => {
    const config = await resolveConfig(
      {
        configFile: false,
        root: optimizerRoot,
        cacheDir: resolve(optimizerRoot, ".vite"),
        logLevel: "silent",
        optimizeDeps: {
          noDiscovery: true,
          include: ["react-virtuoso"],
          esbuildOptions: { define: { __REACT_VIRTUOSO_PATCH_SHA256__: JSON.stringify(digest) } }
        }
      },
      "serve"
    )
    return optimizeDeps(config)
  }
  const first = await optimize(manifest.patchSha256)
  const receipt = resolve(optimizerRoot, ".vite/deps/_metadata.json")
  const firstStat = statSync(receipt)
  const second = await optimize(manifest.patchSha256)
  assert.equal(second.configHash, first.configHash)
  assert.equal(
    statSync(receipt).mtimeMs,
    firstStat.mtimeMs,
    "The same patch reuses the existing Vite dependency receipt without rewriting it"
  )
  const changed = await optimize(hash("different verified patch fixture"))
  assert.notEqual(
    changed.configHash,
    first.configHash,
    "The optimizer digest changes configHash even though package and lockfile are unchanged"
  )
  assert.notEqual(changed.hash, first.hash)
} finally {
  assert(relative(cacheParent, optimizerRoot).startsWith("virtuoso-digest-"))
  rmSync(optimizerRoot, { recursive: true, force: true })
}
await (
  await import("./support/react-virtuoso-native-refresh-browser.mjs")
).runNativeRefreshBrowserRegression()
console.log(
  "PASS Virtuoso installer, ESM/CJS cancellation/ownership/native measurements, and Vite patch-digest cache reuse/invalidation"
)
