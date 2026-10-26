import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"

const rulesRoot = resolve("resources/native-compositions/autobiz-rules/checks")
const reference = resolve(
  "tests/fixtures/native-compositions/legacy-reference/performance_checker.py"
)
const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const cases = [
  ["FRONT-RULE001", "setTimeout(() => {\n fetch('fixture-private-url')\n}, 10)"],
  ["FRONT-RULE002", "const timer = setTimeout(work, 10)"],
  ["FRONT-RULE003", "items.forEach(item => { new WebSocket('fixture-private-url') })"],
  ["FRONT-RULE004", "window.addEventListener('scroll', handler)"],
  ["FRONT-RULE005", "onMounted(startWork)"],
  ["FRONT-RULE006", "setInterval(poll, 10)"],
  ["FRONT-RULE007", "fetch('fixture-private-url')\nfetch('fixture-private-url')"]
]

const exceptions = [
  ["FRONT-RULE001", "setTimeout(() => {\n // fetch('comment-only')\n localWork()\n}, 10)"],
  ["FRONT-RULE002", "const timer = setTimeout(work, 10); clearTimeout(timer)"],
  ["FRONT-RULE003", "items.forEach(item => { consume(item) })"],
  ["FRONT-RULE004", "window.addEventListener('scroll', debounce(handler, 100))"],
  [
    "FRONT-RULE005",
    "useEffect(() => { const timer = setTimeout(work, 10); return () => { clearTimeout(timer) } })"
  ],
  ["FRONT-RULE006", "setInterval(poll, 10); // visibilitychange backoff"],
  ["FRONT-RULE007", "fetch('fixture-first-url')\nfetch('fixture-second-url')"]
]

it("preserves all seven original rule predicates without executing the old checkpoint entry", () => {
  expect(createHash("sha256").update(readFileSync(reference)).digest("hex")).toBe(
    "2f314041ae5a8ac0146f33d85cacecc693191d6b62be6b3a40ef181fd4b23ae6"
  )
  const result = spawnSync(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      "-c",
      `import ast,json,re,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from hooks.performance_rules import run_check
tree=ast.parse(Path(sys.argv[2]).read_text(encoding="utf-8"))
names={"RULES","_find_lines","_get_line_snippet","_is_in_string","run_check"}
nodes=[node for node in tree.body if (isinstance(node,ast.FunctionDef) and (node.name in names or node.name.startswith("_check_"))) or (isinstance(node,ast.AnnAssign) and isinstance(node.target,ast.Name) and node.target.id=="RULES")]
scope={"re":re,"List":list,"Dict":dict,"Tuple":tuple}
exec(compile(ast.Module(body=nodes,type_ignores=[]),"original-performance","exec"),scope)
def normalize(fn,text): return [{"code":r["rule_id"],"line":r["line"]} for r in fn(text)]
print(json.dumps([{ "original":normalize(scope["run_check"],text),"retained":normalize(run_check,text)} for text in json.loads(sys.stdin.read())]))`,
      rulesRoot,
      reference
    ],
    {
      input: JSON.stringify([
        ...cases.map(([, text]) => text),
        ...exceptions.map(([, text]) => text),
        "export const value = 42"
      ]),
      encoding: "utf8"
    }
  )
  expect(result.status, result.stderr).toBe(0)
  const compared = JSON.parse(result.stdout) as Array<{
    original: Array<{ code: string; line: number }>
    retained: Array<{ code: string; line: number }>
  }>
  for (const [index, [code]] of cases.entries()) {
    expect(compared[index].retained).toEqual(compared[index].original)
    expect(compared[index].retained.some((finding) => finding.code === code)).toBe(true)
  }
  for (const [index, [code]] of exceptions.entries()) {
    const row = compared[cases.length + index]
    expect(row.retained).toEqual(row.original)
    expect(row.retained.some((finding) => finding.code === code)).toBe(false)
  }
  expect(compared.at(-1)).toEqual({ original: [], retained: [] })
})

function repository() {
  const root = mkdtempSync(join(tmpdir(), "autobiz-performance-"))
  temporary.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Native Fixture")
  git("config", "user.email", "native-fixture@example.invalid")
  git("config", "core.autocrlf", "false")
  git("commit", "--allow-empty", "-m", "fixture base")
  const baselineCommit = git("rev-parse", "HEAD")
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const commit = () => {
    git("add", "--all")
    git("commit", "-m", "fixture change")
    return git("rev-parse", "HEAD")
  }
  const check = (expectedCommit: string, base = baselineCommit) => {
    const result = spawnSync(
      "python",
      [
        "-I",
        "-B",
        "-X",
        "utf8",
        "-c",
        "import sys,json;sys.path.insert(0,sys.argv[1]);from performance import check;print(json.dumps(check(json.loads(sys.stdin.read()))))",
        rulesRoot
      ],
      {
        cwd: root,
        input: JSON.stringify({ expectedCommit, baselineCommit: base }),
        encoding: "utf8"
      }
    )
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  return { root, git, write, commit, check, baselineCommit }
}

it("checks actual changed commit blobs, rejects all original violations, and never returns source", () => {
  const fixture = repository()
  for (const [index, [, text]] of cases.entries()) fixture.write(`src/规则 ${index}.ts`, text)
  const head = fixture.commit()
  // A benign working-tree replacement must not substitute for the committed candidate.
  fixture.write("src/规则 0.ts", "export const safe = true")
  const result = fixture.check(head)
  expect(result.passed).toBe(false)
  expect(result.errors.map((error: { code: string }) => error.code)).toEqual(
    expect.arrayContaining(cases.map(([code]) => code))
  )
  expect(result.files).toHaveLength(7)
  expect(JSON.stringify(result)).not.toContain("fixture-private-url")
  expect(JSON.stringify(result)).not.toContain("snippet")
  expect(result.files[0].sha256).toBe(createHash("sha256").update(cases[0][1]).digest("hex"))
})

it("accepts clean changed sources and checks renamed blobs while excluding deleted files", () => {
  const fixture = repository()
  fixture.write("old.js", "setInterval(poll, 10)")
  const old = fixture.commit()
  fixture.git("mv", "old.js", "renamed.ts")
  const renamed = fixture.commit()
  expect(fixture.check(renamed, old).passed).toBe(false)
  fixture.git("rm", "renamed.ts")
  fixture.write("src/clean.ts", "export const value = 42")
  const clean = fixture.commit()
  expect(fixture.check(clean, renamed)).toMatchObject({
    passed: true,
    errors: [],
    files: [{ path: "src/clean.ts" }]
  })
})

it("fails closed on wrong HEAD and source byte limits", () => {
  const fixture = repository()
  fixture.write("too-large.js", "x".repeat(64 * 1024 + 1))
  const head = fixture.commit()
  expect(fixture.check(head)).toMatchObject({
    passed: false,
    errors: [{ code: "PERFORMANCE_SOURCE_LIMIT" }]
  })
  expect(fixture.check(fixture.baselineCommit)).toMatchObject({
    passed: false,
    errors: [{ code: "PERFORMANCE_HEAD_CHANGED" }]
  })
})

it("rejects excessive file counts and aggregate bytes without treating a partial scan as success", () => {
  const fixture = repository()
  for (let index = 0; index < 65; index++)
    fixture.write(`source-${index}.ts`, "export const value = 1")
  const tooMany = fixture.commit()
  expect(fixture.check(tooMany)).toMatchObject({
    passed: false,
    errors: [{ code: "PERFORMANCE_FILE_COUNT_LIMIT" }]
  })
  fixture.git("rm", "--", ...Array.from({ length: 65 }, (_, index) => `source-${index}.ts`))
  for (let index = 0; index < 5; index++) fixture.write(`large-${index}.js`, " ".repeat(64 * 1024))
  const tooLarge = fixture.commit()
  expect(fixture.check(tooLarge, tooMany)).toMatchObject({
    passed: false,
    errors: [{ code: "PERFORMANCE_SOURCE_LIMIT" }]
  })
})

it("rejects a symlink blob rather than accepting its target spelling as JavaScript", () => {
  const fixture = repository()
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: fixture.root,
    input: "outside-source.js",
    encoding: "utf8"
  }).trim()
  fixture.git("update-index", "--add", "--cacheinfo", `120000,${blob},linked.js`)
  fixture.git("commit", "-m", "fixture symlink blob")
  expect(fixture.check(fixture.git("rev-parse", "HEAD"))).toMatchObject({
    passed: false,
    errors: [{ code: "PERFORMANCE_REGULAR_BLOB_REQUIRED" }]
  })
})
