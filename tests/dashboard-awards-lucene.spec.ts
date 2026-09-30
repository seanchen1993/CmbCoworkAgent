/**
 * Checks generated ES regex queries against the real Lucene automaton engine.
 * JavaScript RegExp accepts trailing '-' in classes; Lucene does not.
 *
 * Run with a JDK and the Lucene core jar matching the target ES version:
 * LUCENE_CORE_JAR=/path/to/lucene-core.jar node --import tsx tests/dashboard-awards-lucene.spec.ts
 * JAVA_HOME is optional when java/javac are already on PATH. No ES connection needed.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import {
  buildAwardSkillMatchFilter,
  groupAwardSkillCandidates
} from "../src/main/ipc/dashboard-awards-skill"

const jar = process.env.LUCENE_CORE_JAR
assert(jar && existsSync(jar), "Set LUCENE_CORE_JAR to the target ES Lucene core jar")
const scratch = mkdtempSync(join(tmpdir(), "award-lucene-"))
const javaCommand = (name: string): string =>
  process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? `${name}.exe` : name)
    : name
function run(name: string, args: string[]): string {
  const result = spawnSync(javaCommand(name), args, { encoding: "utf8", timeout: 30_000 })
  assert.equal(
    result.status,
    0,
    `${name}: ${result.error?.message || result.stderr || result.stdout}`
  )
  return result.stdout
}
try {
  writeFileSync(
    join(scratch, "AwardSkillRegexpProbe.java"),
    String.raw`
import org.apache.lucene.util.automaton.RegExp;
import org.apache.lucene.util.automaton.CharacterRunAutomaton;
public class AwardSkillRegexpProbe {
  public static void main(String[] args) {
    if (args[0].equals("reject")) {
      try { new RegExp(args[1]).toAutomaton(); }
      catch (IllegalArgumentException error) {
        if (!error.getMessage().contains("expected ']'") || !error.getMessage().contains("position 60")) throw error;
        System.out.println("PASS reproduced production parse error"); return;
      }
      throw new AssertionError("Original pattern unexpectedly parsed");
    }
    CharacterRunAutomaton matcher = new CharacterRunAutomaton(new RegExp(args[0]).toAutomaton());
    for (int i = 1; i < args.length; i += 2) {
      boolean expected = Boolean.parseBoolean(args[i + 1]);
      if (matcher.run(args[i]) != expected) throw new AssertionError("Unexpected match: " + args[i]);
    }
    System.out.println("PASS Lucene version matches and exclusions");
  }
}
`
  )
  run("javac", ["-cp", resolve(jar), join(scratch, "AwardSkillRegexpProbe.java")])
  const javaArgs = ["-cp", `${scratch}${delimiter}${resolve(jar)}`, "AwardSkillRegexpProbe"]
  process.stdout.write(
    run("java", [
      ...javaArgs,
      "reject",
      String.raw`code\.review-[vV]?[0-9]+(\.[0-9]+){0,3}([-+][0-9A-Za-z.-]+)?`
    ])
  )
  for (const base of [
    "code.review",
    "code-review",
    "code+review",
    "code[review]",
    'code"review',
    "code@review",
    "code#review",
    "code&review",
    "代码评审"
  ]) {
    const [candidate] = groupAwardSkillCandidates([base])
    const filter = buildAwardSkillMatchFilter(candidate, [
      "usedSkills",
      "properties.usedSkills"
    ]) as {
      bool: { should: Array<{ regexp?: Record<string, string> }> }
    }
    for (const clause of filter.bool.should) {
      if (!clause.regexp) continue
      const pattern = Object.values(clause.regexp)[0]
      const accepted = [
        base,
        `${base}-v1`,
        `${base}-V2.3`,
        `${base}-1.2.3`,
        `${base}-v3.1.2.0`,
        `${base}-v3.1.2-beta-fix`,
        `${base}-v1.0+build.7`
      ]
      const rejected = [
        `${base}-helper-v1`,
        `${base}-vendor`,
        `${base}-v1.2.3.4.5`,
        `${base}-v`,
        `${base}-v1/invalid`
      ]
      // The regex clause matches versioned identifiers; the term clause matches the bare name.
      const cases = accepted
        .map((name) => [name, String(name !== base)])
        .concat(rejected.map((name) => [name, "false"]))
      process.stdout.write(run("java", [...javaArgs, pattern, ...cases.flat()]))
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
