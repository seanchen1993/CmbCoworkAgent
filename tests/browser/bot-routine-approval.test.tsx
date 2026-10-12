import { expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { BotApprovalContent } from "../../src/renderer/src/components/bots/BotApprovalContent"

// Unrelated image attachment branch depends on browser visibility at import time.
// The routine approval renderer itself remains the actual production component.
vi.mock("../../src/renderer/src/components/bots/BotPeerImages", () => ({
  BotPeerImages: () => null
}))

const routine = {
  operation: "create",
  before: null,
  after: {
    botId: "owner",
    name: "日报",
    prompt: "核对原件后交付",
    timezone: "UTC",
    enabled: false,
    schedule: { kind: "interval", everyMs: 60_000, anchor: 1_800_000_000_000 },
    skills: [{ botId: "owner", id: "verified", version: 3 }]
  },
  skillReferences: [{ botId: "owner", id: "verified", version: 3, name: "项目核对 <script>" }]
}

it("renders the frozen trusted skill name and exact version without interpreting it as markup", () => {
  const html = renderToStaticMarkup(<BotApprovalContent prompt={JSON.stringify({ routine })} />)
  expect(html).toContain("绑定技能")
  expect(html).toContain("项目核对 &lt;script&gt;")
  expect(html).toContain("v3")
  expect(html).not.toContain("<script>")
  expect(html).toContain("暂停")
  // Static rendering has no catalog/transport provider: this must remain a snapshot-only display.
})

it("keeps legacy routine approvals readable without inventing a binding from after.skills", () => {
  const legacy = { ...routine, skillReferences: undefined }
  const html = renderToStaticMarkup(
    <BotApprovalContent prompt={JSON.stringify({ routine: legacy })} />
  )
  expect(html).toContain("创建例程")
  expect(html).toContain("核对原件后交付")
  expect(html).not.toContain("绑定技能")
})

it("rejects invalid display metadata while retaining the reviewed routine and its paused state", () => {
  const html = renderToStaticMarkup(
    <BotApprovalContent
      prompt={JSON.stringify({
        routine: {
          ...routine,
          skillReferences: [{ ...routine.skillReferences[0], version: 0 }]
        }
      })}
    />
  )
  expect(html).toContain("暂停")
  expect(html).toContain("每 1 分钟")
  expect(html).not.toContain("绑定技能")
})
