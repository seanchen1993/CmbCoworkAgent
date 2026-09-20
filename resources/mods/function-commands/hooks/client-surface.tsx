/** This module has local state and input, but no engine SDK. post talks to the hooks module. */
export default function Workbench(props, surface) {
  const { Box, Text, Button, Input, Select } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ count: 0, ticks: 0, note: "", mode: "review", point: "未点击" })
    surface.every(1000, () =>
      surface.setState({ ...surface.state, ticks: surface.state.ticks + 1 })
    )
    surface.onKey((event) => {
      if (event.key === "up") surface.setState({ ...surface.state, count: surface.state.count + 1 })
    })
    surface.onPointer((event) => {
      if (event.type === "down")
        surface.setState({ ...surface.state, point: `${event.x}, ${event.y}` })
    })
  }
  const state = surface.state
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {props.label} · 本地计数：{state.count}
      </Text>
      <Text dimColor>
        时钟：{state.ticks} · 尺寸：{surface.columns} × {surface.rows} · 指针：{state.point}
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button
          key="increment"
          label="本地加一"
          onPress={() => {
            surface.setState({ ...surface.state, count: surface.state.count + 1 })
            surface.post({ kind: "count", count: surface.state.count })
          }}
        />
        <Button key="redraw" label="重绘面板" onPress={() => surface.post({ kind: "redraw" })} />
      </Box>
      <Input
        key="note"
        label="组件备注"
        value={state.note}
        submitLabel="确认"
        onSubmit={(note) => surface.setState({ ...surface.state, note })}
      />
      <Select
        key="mode"
        label="组件模式"
        value={state.mode}
        options={[
          { value: "review", label: "检视" },
          { value: "build", label: "构建" }
        ]}
        onSelect={(mode) => surface.setState({ ...surface.state, mode })}
      />
      <Text>
        备注：{state.note || "空"} · 模式：{state.mode === "review" ? "检视" : "构建"}
      </Text>
      <Text dimColor>
        点击空白区域后，↑ 增加本地计数，Esc 释放键盘焦点。关闭组件后本地状态重置。
      </Text>
    </Box>
  )
}
