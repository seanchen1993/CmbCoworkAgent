import type { AutobizSdk, RegisterFunction } from "./sdk-types"
import {
  commandFeature,
  featureId,
  readState,
  recordSummary,
  selectedRecord,
  sourceDescription,
  type StateSnapshot
} from "./shared"

const PANE = "autobiz-fullstack-board"
const PAGE_SIZE = 198

export function register(on: RegisterFunction): void {
  let snapshot: StateSnapshot | null = null
  let selected = ""
  let notice = "请刷新真实状态，并明确选择 Feature。"
  let busy = false
  let page = 0

  async function refresh($: AutobizSdk): Promise<void> {
    if (busy) throw Error("AUTOBIZ_BOARD_BUSY")
    busy = true
    try {
      snapshot = await readState($)
      page = Math.min(
        page,
        Math.max(0, Math.ceil(Object.keys(snapshot.records).length / PAGE_SIZE) - 1)
      )
      if (selected && !Object.hasOwn(snapshot.records, selected)) {
        selected = ""
        notice = "原来选择的 Feature 已不存在，请重新选择；没有自动选择其他记录。"
      } else notice = "已通过原分支入口刷新。这里只展示记录，不判断完成或推进阶段。"
    } catch (error) {
      snapshot = null
      selected = ""
      notice = `状态读取失败：${error instanceof Error ? error.message : "AUTOBIZ_STATE_FAILED"}`
    } finally {
      busy = false
      await $.ui.invalidate("ui.render")
    }
  }

  on("session.start", {}, async ($, event, next) => {
    await $.command.register({
      name: "autobiz-fullstack-board",
      description: "打开 fullstack 0920 的只读交互看板",
      argumentHint: "[明确的 Feature ID]"
    })
    return next(event)
  })
  on("command.run", { command: "autobiz-fullstack-board" }, async ($, event) => {
    if (busy) throw Error("AUTOBIZ_BOARD_BUSY")
    const feature = commandFeature(event.args)
    busy = true
    try {
      const loaded = await readState($)
      if (feature) selectedRecord(loaded, feature)
      snapshot = loaded
      selected = feature ?? ""
      page = 0
      notice = "原分支规范状态已读取。请选择 Feature；没有默认选择第一条。"
      await $.ui.open({
        id: PANE,
        title: "Autobiz fullstack · 真实状态",
        rows: 20,
        closeOnEscape: true
      })
      return { text: selected ? recordSummary(selectedRecord(loaded, selected)) : notice }
    } finally {
      busy = false
    }
  })
  on("ui.render", { component: "Pane", requestId: PANE }, ($, event) => {
    const { Box, Text, Select, Button } = $.ui.resolve(event)
    const rows = snapshot ? Object.keys(snapshot.records).sort() : []
    // Native Select accepts at most 200 options. Keep every record reachable without truncating state.
    const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    if (selected && !visible.includes(selected)) visible.push(selected)
    return Box({
      flexDirection: "column",
      gap: 1,
      children: [
        Text({ bold: true, children: "Autobiz fullstack · 真实状态" }),
        Text({ children: sourceDescription() }),
        Text({ children: "只显示原状态入口提供的 checkpoint、阶段和选定节点。不验证、不推进。" }),
        Select({
          key: "feature",
          label: "明确选择 Feature",
          value: selected,
          options: [
            { value: "", label: "请选择 Feature" },
            ...visible.map((value) => ({ value, label: value }))
          ],
          onSelect: async (value: unknown) => {
            if (value === "") selected = ""
            else {
              const id = featureId(value)
              if (!snapshot) throw Error("AUTOBIZ_STATE_REQUIRED")
              selectedRecord(snapshot, id)
              selected = id
            }
            await $.ui.invalidate("ui.render")
          }
        }),
        ...(rows.length > PAGE_SIZE
          ? [
              Text({ children: `记录页 ${page + 1} / ${Math.ceil(rows.length / PAGE_SIZE)}` }),
              Button({
                key: "previous",
                label: "上一页 Feature",
                onPress: async () => {
                  page = Math.max(0, page - 1)
                  await $.ui.invalidate("ui.render")
                }
              }),
              Button({
                key: "next",
                label: "下一页 Feature",
                onPress: async () => {
                  page = Math.min(Math.ceil(rows.length / PAGE_SIZE) - 1, page + 1)
                  await $.ui.invalidate("ui.render")
                }
              })
            ]
          : []),
        Button({
          key: "refresh",
          label: "刷新真实状态（保留执行审批）",
          onPress: () => refresh($)
        }),
        Text({ children: busy ? "正在读取原状态入口。" : notice }),
        Text({
          children:
            snapshot && selected
              ? recordSummary(selectedRecord(snapshot, selected))
              : "尚未选定 Feature。没有推断当前流程、验证结果或完成状态。"
        })
      ]
    })
  })
}
