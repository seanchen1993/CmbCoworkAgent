export default function Vector(_props, surface) {
  const { Svg } = surface.elements
  return (
    <Svg
      source={
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="30"><circle cx="15" cy="15" r="10" fill="purple"/></svg>'
      }
      alt="Client vector"
      width={80}
      height={30}
    />
  )
}
