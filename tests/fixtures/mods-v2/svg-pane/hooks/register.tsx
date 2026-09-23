const drawing = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">
<style>rect:hover { fill: blue }</style><rect id="shape" width="120" height="60" fill="green"><title>Safe shape</title></rect>
<style>@import url(https://mods-svg-invalid.example/style);</style>
<style><![CDATA[</style><meta http-equiv="refresh" content="0;url=https://mods-svg-invalid.example/navigation"/>]]></style>
<script>parent.__modsSvgEscaped = true; fetch('https://mods-svg-invalid.example/script')</script>
<image href="https://mods-svg-invalid.example/image"/>
<foreignObject><iframe src="https://mods-svg-invalid.example/frame"/></foreignObject>
<a href="https://mods-svg-invalid.example/link"><text x="2" y="30" onclick="parent.__modsSvgEscaped=true">Untrusted link</text></a>
</svg>`
export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "svg-pane",
      description: "Show isolated SVG",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "svg-pane" }, async ($) => {
    await $.ui.open({ id: "vectors", title: "Vector isolation", rows: 10 })
    return { text: "VECTOR_OPEN" }
  })
  on("ui.render", { component: "Pane", requestId: "vectors" }, ($, e) => {
    const { Box, Svg, Client } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Svg source={drawing} alt="Static vector" width={120} height={60} />
        <Svg source={drawing} alt="Interactive vector" width={120} height={60} isInteractive />
        <Client key="vector-client" module="./surface.tsx" />
      </Box>
    )
  })
}
