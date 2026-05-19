const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const crypto = require("crypto")
const { StringDecoder } = require("string_decoder")

function findRepoRoot(startDir) {
  let current = startDir
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) return current
    current = path.dirname(current)
  }
  return path.resolve(startDir, "..", "..", "..")
}

const repoRoot = findRepoRoot(__dirname)

function safeId(value) {
  return String(value || "case")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "case"
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJsonlLast(filePath) {
  const raw = fs.readFileSync(filePath, "utf8")
  const lines = raw.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) throw new Error(`Trace fixture is empty: ${filePath}`)
  let last = null
  for (let index = 0; index < lines.length; index += 1) {
    try {
      last = JSON.parse(lines[index])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid trace JSON at ${filePath}:${index + 1}: ${message}`)
    }
  }
  return last
}

function copyFixtureTrace(fixturePath, runDir) {
  const resolvedFixture = path.resolve(repoRoot, fixturePath)
  const trace = readJsonlLast(resolvedFixture)
  const traceDir = path.join(runDir, "traces", trace.threadId || "fixture-thread")
  ensureDir(traceDir)
  const tracePath = path.join(traceDir, `${trace.traceId || "fixture-trace"}.jsonl`)
  fs.copyFileSync(resolvedFixture, tracePath)
  return { trace, tracePath }
}

function newestTrace(traceRoot, startMs) {
  if (!fs.existsSync(traceRoot)) return null
  const candidates = []
  const stack = [traceRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = fs.statSync(full)
        if (stat.mtimeMs >= startMs - 1000) candidates.push({ filePath: full, mtimeMs: stat.mtimeMs })
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.filePath || null
}

function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(value)}`)
  }
  return Math.floor(parsed)
}

function killProcessGroup(child, signal) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    try {
      child.kill(signal)
    } catch (_) {
      // The process may already be gone.
    }
  }
}

function runCommand(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell || false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    const stdoutDecoder = new StringDecoder("utf8")
    const stderrDecoder = new StringDecoder("utf8")
    const timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      killProcessGroup(child, "SIGTERM")
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 3000).unref?.()
    }, options.timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += stdoutDecoder.write(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += stderrDecoder.write(chunk)
    })
    child.on("close", (code, signal) => {
      settled = true
      clearTimeout(timeout)
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      resolve({ code, signal, stdout, stderr, timedOut })
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      resolve({ code: 1, signal: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut })
    })
  })
}

const SHELL_TEMPLATE_PATTERN = /\{\{(?:prompt|runDir|traceRoot|workspace)\}\}/

function applyArgTemplates(value, replacements) {
  return String(value)
    .replaceAll("{{prompt}}", replacements.prompt)
    .replaceAll("{{runDir}}", replacements.runDir)
    .replaceAll("{{traceRoot}}", replacements.traceRoot)
    .replaceAll("{{workspace}}", replacements.workspace)
}

function buildCommand(prompt, vars, runDir, traceRoot, config) {
  const promptText = String(prompt ?? "")
  const workspacePath = path.resolve(repoRoot, String(vars.workspace || config.workspace || "."))
  const agentHome = path.join(runDir, "agent-home")
  ensureDir(agentHome)

  const replacements = {
    prompt: promptText,
    runDir,
    traceRoot,
    workspace: workspacePath
  }
  const env = {
    ...process.env,
    SKILL_EVAL: "1",
    SKILL_EVAL_CASE_ID: vars.case_id || "",
    SKILL_EVAL_RUN_DIR: runDir,
    CMB_COWORK_TRACES_DIR: traceRoot,
    CMB_COWORK_AGENT_HOME: agentHome,
    SKILL_EVAL_PROMPT: promptText,
    SKILL_EVAL_WORKSPACE: workspacePath
  }
  if (vars.expected_skill) env.SKILL_EVAL_EXPECTED_SKILL = vars.expected_skill

  const argvSpec = vars.agent_argv || vars.agentArgv || config.agentArgv || config.agent_argv
  if (argvSpec !== undefined) {
    if (!Array.isArray(argvSpec) || argvSpec.length === 0) {
      throw new Error("agent_argv must be a non-empty array")
    }
    const argv = argvSpec.map((item) => applyArgTemplates(item, replacements))
    if (!argv[0]) throw new Error("agent_argv[0] must be an executable")
    return {
      command: argv[0],
      args: argv.slice(1),
      env,
      shell: false,
      displayCommand: argv
    }
  }

  const commandTemplate =
    vars.agent_command ||
    config.agent_command ||
    config.agentCommand ||
    process.env.SKILL_EVAL_AGENT_COMMAND ||
    ""
  if (!commandTemplate) return null
  const commandText = String(commandTemplate)
  if (SHELL_TEMPLATE_PATTERN.test(commandText)) {
    throw new Error(
      "agent_command does not support {{prompt}}, {{workspace}}, {{runDir}}, or {{traceRoot}} shell templates. Read SKILL_EVAL_* env vars instead, or use agent_argv for safe argv templating."
    )
  }

  return {
    command: commandText,
    args: [],
    env,
    shell: true,
    displayCommand: commandText
  }
}

function tailText(value, maxChars = 4000) {
  const text = String(value || "")
  return text.length > maxChars ? text.slice(-maxChars) : text
}

function writeCommandLog(runDir, commandResult) {
  if (!commandResult) return ""
  const logPath = path.join(runDir, "agent.log")
  const content = [
    "# stdout",
    commandResult.stdout || "",
    "",
    "# stderr",
    commandResult.stderr || ""
  ].join("\n")
  fs.writeFileSync(logPath, content, "utf8")
  return logPath
}

module.exports = class AgentTraceProvider {
  constructor(options = {}) {
    this.providerId = options.id || "cmb-agent-trace"
    this.config = options.config || {}
  }

  id() {
    return this.providerId
  }

  async callApi(prompt, context = {}) {
    const vars = context?.vars || {}
    const config = {
      ...this.config,
      ...(context?.provider?.config || {}),
      ...(context?.config || {})
    }
    const caseId = safeId(vars.case_id || context?.test?.description || crypto.randomUUID())
    const runId = `${caseId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
    const outputRoot = path.resolve(repoRoot, config.outputRoot || ".cmbdevclaw/evals/skill-quality/runs")
    const runDir = path.join(outputRoot, runId)
    const traceRoot = path.join(runDir, "traces")
    ensureDir(runDir)
    ensureDir(traceRoot)

    let commandResult = null
    let commandSpec = null
    let commandLogPath = ""
    let tracePath = ""
    let trace = null
    let providerStatus = "ok"
    const startedAt = Date.now()

    try {
      if (vars.trace_fixture) {
        const copied = copyFixtureTrace(vars.trace_fixture, runDir)
        trace = copied.trace
        tracePath = copied.tracePath
      } else {
        commandSpec = buildCommand(prompt, vars, runDir, traceRoot, config)
        if (!commandSpec) {
          providerStatus = "no_agent_command"
        } else {
          const timeoutValue = vars.timeout_ms !== undefined ? vars.timeout_ms : config.timeoutMs
          const timeoutMs = parsePositiveInt(timeoutValue, 600000, "timeout_ms")
          commandResult = await runCommand(commandSpec.command, commandSpec.args, {
            cwd: repoRoot,
            env: commandSpec.env,
            shell: commandSpec.shell,
            timeoutMs
          })
          commandLogPath = writeCommandLog(runDir, commandResult)
          tracePath = newestTrace(traceRoot, startedAt) || ""
          if (tracePath) trace = readJsonlLast(tracePath)
          if (commandResult.timedOut) providerStatus = "agent_command_timeout"
          else if (commandResult.code !== 0) providerStatus = "agent_command_failed"
          else if (!tracePath) providerStatus = "trace_not_found"
        }
      }
    } catch (error) {
      providerStatus = "provider_error"
      commandResult = {
        code: 1,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.stack || error.message : String(error)
      }
    }

    const summary = {
      caseId,
      runId,
      providerStatus,
      prompt: String(prompt ?? ""),
      runDir,
      traceRoot,
      tracePath,
      traceId: trace?.traceId || null,
      threadId: trace?.threadId || null,
      expectedSkill: vars.expected_skill || null,
      usedSkills: Array.isArray(trace?.usedSkills) ? trace.usedSkills : [],
      totalToolCalls: typeof trace?.totalToolCalls === "number" ? trace.totalToolCalls : null,
      outcome: trace?.outcome || null,
      durationMs: typeof trace?.durationMs === "number" ? trace.durationMs : null,
      command: commandResult
        ? {
            code: commandResult.code,
            signal: commandResult.signal,
            timedOut: commandResult.timedOut,
            command: commandSpec?.displayCommand || null,
            logPath: commandLogPath || null,
            stdoutTail: tailText(commandResult.stdout),
            stderrTail: tailText(commandResult.stderr)
          }
        : null
    }

    const summaryPath = path.join(runDir, "run_summary.json")
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8")

    return {
      output: JSON.stringify({
        ...summary,
        summaryPath
      })
    }
  }
}
