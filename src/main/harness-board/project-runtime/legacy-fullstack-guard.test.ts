import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const SOURCE_COMMIT = "504e327d2f9a4d9e30e9f541c4432accf8000ad5"

/** Uses immutable upstream code against fabricated task records; never runs a build command. */
it("retains the fixed fullstack guard's production compile exception and Review/UTest boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-fullstack-guard-"))
  try {
    const source = await execute(
      "git",
      [
        "--no-replace-objects",
        "-C",
        process.env.CMB_AUTOBIZ_SOURCE || "C:/ai/autobiz_kanban",
        "show",
        `${SOURCE_COMMIT}:hooks/code_execution_guard.py`
      ],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true }
    )
    const path = join(root, "guard.py")
    await writeFile(path, source.stdout, "utf8")
    const script = String.raw`
import importlib.util, json, os, sys
from pathlib import Path
root, source = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location('fixed_guard', source)
guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
workspace = root / 'synthetic-project'
worktree = root / 'synthetic-code-worktree'; worktree.mkdir()
feature = workspace / '.autobizdevops' / 'features' / 'fixture'
run = feature / '.task-runs' / 'T1' / 'run.json'; run.parent.mkdir(parents=True)
record = {'taskId':'T1','runId':'R1','status':'started','codeWorkspace':str(worktree)}
run.write_text(json.dumps(record), encoding='utf-8')
os.environ.update(PLUGIN_WORKSPACE=str(root), PROJECT_DIR='synthetic-project', FEATURE_ID='fixture')
def check(command):
    return guard.guard({'tool_name':'execute','tool_input':{'command':command,'cwd':str(worktree)}})
results = {'compile':check('mvn compile -DskipTests'), 'test':check('mvn test'), 'frontend':check('npm run build'), 'mixed':check('mvn compile && mvn test')}
record['status'] = 'implemented'; run.write_text(json.dumps(record), encoding='utf-8')
batch = feature / '.parallel-runs' / 'flow' / 'manifest.json'; batch.parent.mkdir(parents=True)
state = {'runId':'flow','batches':{'B1':{'worktreePath':str(worktree),'activeStage':'review','stageStates':{'review':{'status':'running'},'test':{'status':'pending'}}}}}
batch.write_text(json.dumps(state), encoding='utf-8')
results['reviewCompile'] = check('mvn compile')
state['batches']['B1'].update(activeStage='test',stageStates={'review':{'status':'passed'},'test':{'status':'running'}})
batch.write_text(json.dumps(state), encoding='utf-8')
results['utest'] = check('mvn test')
print(json.dumps(results))
`
    const result = await execute(
      process.env.CMB_AUTOBIZ_PYTHON || "python",
      ["-I", "-B", "-c", script, root, path],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true }
    )
    const evidence = JSON.parse(result.stdout)
    expect(evidence.compile).toBeNull()
    expect(evidence.test).toContain("CODE_EXECUTION_VALIDATION_FORBIDDEN")
    expect(evidence.frontend).toContain("CODE_EXECUTION_VALIDATION_FORBIDDEN")
    expect(evidence.mixed).toContain("CODE_EXECUTION_VALIDATION_FORBIDDEN")
    expect(evidence.reviewCompile).toContain("BATCH_STAGE_VALIDATION_FORBIDDEN")
    expect(evidence.utest).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
