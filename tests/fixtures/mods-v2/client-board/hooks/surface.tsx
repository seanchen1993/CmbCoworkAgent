export default function Board(props, surface) {
  const { Box, Text, Button, Input, Select } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ count: 0, ticks: 0, note: "", mode: "a", pointer: "none" })
    surface.every(1000, () =>
      surface.setState({ ...surface.state, ticks: surface.state.ticks + 1 })
    )
    surface.onKey((e) => {
      if (e.key === "up") surface.setState({ ...surface.state, count: surface.state.count + 1 })
    })
    surface.onPointer((e) => {
      if (e.type === "down") surface.setState({ ...surface.state, pointer: `${e.x},${e.y}` })
    })
  }
  const s = surface.state
  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        {props.label} · count:{s.count} · ticks:{s.ticks} · size:{surface.columns}x{surface.rows}
      </Text>
      <Button
        key="increment"
        label="Client +1"
        onPress={() => {
          surface.setState({ ...surface.state, count: surface.state.count + 1 })
          surface.post({ count: surface.state.count })
        }}
      />
      <Input
        key="note"
        label="Client note"
        value={s.note}
        onSubmit={(value) => surface.setState({ ...surface.state, note: value })}
      />
      <Select
        key="mode"
        label="Client mode"
        value={s.mode}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" }
        ]}
        onSelect={(value) => surface.setState({ ...surface.state, mode: value })}
      />
      <Text>
        note:{s.note} · mode:{s.mode} · pointer:{s.pointer}
      </Text>
    </Box>
  )
}
