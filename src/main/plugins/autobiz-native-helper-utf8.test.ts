import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"

function snippet(stage: string, tag: string): string {
  const source = readFileSync(
    resolve(`resources/native-compositions/autobiz/modules/${stage}/SKILL.md`),
    "utf8"
  ).replace(/\r\n/g, "\n")
  const start = `<!-- ${tag}:start -->\n\`\`\`python\n`
  const end = `\n\`\`\`\n<!-- ${tag}:end -->`
  const offset = source.indexOf(start)
  if (offset < 0 || source.indexOf(end, offset) < 0) throw Error(`HELPER_SNIPPET_MISSING:${tag}`)
  return source.slice(offset + start.length, source.indexOf(end, offset))
}

it.each([
  ["design", false],
  ["design", true],
  ["plan", false],
  ["plan", true]
] as const)(
  "keeps original %s hashes through the documented child transport (bytes=%s)",
  (stage, asBytes) => {
    const output = execFileSync(
      "python",
      [
        "-I",
        "-B",
        "-X",
        "utf8",
        "-c",
        `import json,os,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from hooks.artifact_ref_validator import load_design_contract,design_contract_snapshot
from hooks.parallel_validation_ownership import build_pipeline_contract
case=json.load(sys.stdin)
assert sys.flags.utf8_mode == 1 and sys.stdin.encoding.lower() == "utf-8"
launcher={"__name__":"documented_launcher"}
exec(case["launcher"],launcher)
# Adversarial host settings reproduce the environment that must not control the child.
os.environ["PYTHONIOENCODING"]="gbk"
os.environ["PYTHONUTF8"]="0"
os.environ["LC_ALL"]="C"
with tempfile.TemporaryDirectory(prefix="autobiz-unicode-") as directory:
    root=Path(directory)
    helper=root/"pure_helper.py"
    helper.write_bytes(case["helper"].encode("utf-8"))
    if case["stage"] == "design":
        text="# 中文设计😀\\n## API Decisions\\nx-auto-no-http-api: true\\n## Data Decisions\\nx-auto-no-sql: true\\n| D-001 | 保留首尾及中文 𠮷 |\\n"
        (root/"design.md").write_bytes(text.encode("utf-8"))
        contract,errors=load_design_contract(root)
        assert not errors,errors
        payload={"feature":"unicode-design","lockedAt":"2026-10-26T00:00:00Z","design":text}
        expected=design_contract_snapshot(contract)
        result=launcher["run_utf8_helper"](helper,payload,case["asBytes"])
        actual=result["designContract"]
    else:
        plan={"batches":[{"id":"B001","path":"plans/B001/plan.json","deps":[],"taskIds":["T001"],"workspaceRef":"default"}]}
        batches={"B001":{"tasks":[{"id":"T001","executionMode":"code","scope":{"paths":["src/订单😀.java","src/𠮷.java"]},"testPoints":["保留中文与实际换行\\n第二行"],"verificationIntent":" 不丢首尾空白 ","acceptanceCriteria":["80码点边界😀","不能替换为问号"]}]}}
        payload={"feature":"unicode-plan","stage":"plan","files":{"plan.json":json.dumps(plan,ensure_ascii=False),"plans/B001/plan.json":json.dumps(batches["B001"],ensure_ascii=False)}}
        expected=build_pipeline_contract(plan,batches)
        actual=launcher["run_utf8_helper"](helper,payload,case["asBytes"])
    assert actual == expected,(actual,expected)
    assert helper.read_bytes() == case["helper"].encode("utf-8")
    assert not list(root.glob("__pycache__"))
    print(json.dumps({"matchedOriginal":True,"stage":case["stage"],"asBytes":case["asBytes"],"digest":actual.get("sha256",actual.get("planRevision"))}))`,
        resolve("resources/native-compositions/autobiz-rules/checks")
      ],
      {
        input: JSON.stringify({
          stage,
          asBytes,
          launcher: snippet(stage, `autobiz-${stage}-utf8-launcher`),
          helper: snippet(
            stage,
            stage === "design" ? "autobiz-design-lock-helper" : "autobiz-pipeline-helper"
          )
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000
      }
    )
    expect(JSON.parse(output)).toMatchObject({ matchedOriginal: true, stage, asBytes })
  }
)
