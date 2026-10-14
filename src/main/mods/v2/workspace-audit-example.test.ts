import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

it.each(["answer", "error", "aborted"] as const)(
  "runs the shipped role-review example with the selected role, diff and %s result",
  async (reason) => {
    const project = await mkdtemp(join(tmpdir(), "mods-review-example-"))
    const root = resolve("examples/mods-review-agent")
    const compiled = await compileFunctionPlugin(root)
    const guest = await FunctionGuestRuntime.create(compiled.code)
    const selections: string[] = []
    const session = new FunctionSession(
      [{ name: compiled.name, root, tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
      {
        workspace: project,
        threadId: "review-example",
        assertLive() {
          /* This fixture retains its grant until teardown. */
        },
        publish: async (value) => value,
        authorizeProcess: async () => undefined,
        prepareAgent: async (_plugin, args) => args,
        spawnAgent: async (_plugin, input) => {
          const name = String(input.subagentType)
          selections.push(name)
          expect(input.prompt).toContain("+changed code")
          expect(session.registeredAgent(name)!.spec.tools).toEqual([])
          return {
            value: { agentId: "review-child", model: "fixture" },
            completion: Promise.resolve({
              turnId: "child-turn",
              agentId: "review-child",
              answer: "review result",
              reason,
              isAborted: reason === "aborted",
              durationMs: 1
            })
          }
        }
      }
    )
    try {
      execFileSync("git", ["init", project], { windowsHide: true })
      await writeFile(join(project, "example.txt"), "original\n")
      execFileSync("git", ["-C", project, "add", "example.txt"], { windowsHide: true })
      await writeFile(join(project, "example.txt"), "changed code\n")
      const reply = (await session.run("claw-review", "concise working")) as { text: string }
      expect(reply.text).toContain("review-child")
      expect(selections).toEqual(["review-agent:concise"])
      const { vi } = await import("vitest")
      await vi.waitFor(async () => {
        const status = (await session.run("claw-review-status", "")) as { text: string }
        expect(JSON.parse(status.text)).toMatchObject([
          {
            role: "concise",
            scope: "working",
            status: reason === "answer" ? "complete" : reason === "aborted" ? "aborted" : "failed",
            answer: "review result"
          }
        ])
      })
    } finally {
      await session.close()
      if (
        resolve(project).startsWith(resolve(tmpdir())) &&
        project.includes("mods-review-example-")
      )
        await rm(project, { recursive: true, force: true })
    }
  },
  30000
)

it("releases the audit's active marker when timer creation fails synchronously", async () => {
  const root = resolve("examples/mods-workspace-audit")
  const compiled = await compileFunctionPlugin(root)
  const guest = await FunctionGuestRuntime.create(
    compiled.code +
      `
    const originalModule=__cmbFunctionMod;
    __cmbFunctionMod={register(on,options){originalModule.register((event,matcher,handler)=>{
      if(event==="command.run"&&matcher?.command==="claw-audit"){
        const original=handler;
        handler=($,...args)=>original({...$,clock:{...$.clock,every(){throw Error("MODS_RESOURCE_LIMIT")}}},...args);
      }
      return on(event,matcher,handler);
    },options)}};
  `
  )
  const session = new FunctionSession(
    [{ name: compiled.name, root, tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
    {
      workspace: process.cwd(),
      threadId: "audit-timer-failure",
      publish: async (value) => value,
      assertLive() {
        /* This fixture remains live until teardown. */
      }
    }
  )
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = (await session.run("claw-audit", "status")) as { text: string }
      expect(JSON.parse(result.text)).toMatchObject({ results: [], error: "AUDIT_FAILED" })
    }
    expect(await session.run("claw-audit-stop", "")).toEqual({ text: "No audit is running." })
  } finally {
    await session.close()
  }
})

it("runs the shipped DIY example in selected order and stops after a real failed gate", async () => {
  const project = await mkdtemp(join(tmpdir(), "mods-audit-example-"))
  const root = resolve("examples/mods-workspace-audit")
  const compiled = await compileFunctionPlugin(root)
  const guest = await FunctionGuestRuntime.create(compiled.code)
  const approved: string[][] = []
  const session = new FunctionSession(
    [{ name: compiled.name, root, tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
    {
      workspace: project,
      threadId: "audit-example",
      assertLive() {
        /* This fixture retains its grant until teardown. */
      },
      publish: async (v) => v,
      authorizeProcess: async (_plugin, request) => {
        approved.push([...request.argv])
      }
    }
  )
  try {
    execFileSync("git", ["init", project], { windowsHide: true })
    await writeFile(join(project, "example.txt"), "clean\n")
    execFileSync("git", ["-C", project, "add", "example.txt"], { windowsHide: true })
    await writeFile(join(project, "example.txt"), "trailing whitespace   \n")
    const first = (await session.run("claw-audit", "summary,status")) as { text: string }
    expect(JSON.parse(first.text).results).toEqual([
      { step: "summary", code: 0 },
      { step: "status", code: 0 }
    ])
    expect(approved).toEqual([
      ["git", "diff", "--stat"],
      ["git", "status", "--short"]
    ])
    approved.length = 0
    const second = (await session.run("claw-audit", "whitespace,summary")) as { text: string }
    expect(JSON.parse(second.text).results).toEqual([{ step: "whitespace", code: 2 }])
    expect(approved).toEqual([["git", "diff", "--check"]])
    expect(await session.run("claw-audit-stop", "")).toEqual({ text: "No audit is running." })
  } finally {
    await session.close()
    if (resolve(project).startsWith(resolve(tmpdir())) && project.includes("mods-audit-example-"))
      await rm(project, { recursive: true, force: true })
  }
}, 30000)
