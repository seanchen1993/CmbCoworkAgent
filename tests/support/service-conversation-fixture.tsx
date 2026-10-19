import { createRoot } from "react-dom/client"
import { ServiceExpertConversation } from "../../src/renderer/src/components/bots/ServiceExpertConversation"
import "../../src/renderer/src/components/bots/bots.css"
let root = createRoot(document.getElementById("root")!)
const render = () => root.render(<ServiceExpertConversation />)
;(window as unknown as { remountService: () => void }).remountService = () => {
  root.unmount()
  root = createRoot(document.getElementById("root")!)
  render()
}
render()
