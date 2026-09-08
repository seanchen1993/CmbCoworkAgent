import "./lib/console-gate"
import ReactDOM from "react-dom/client"
import App from "./App"
import { CloseToTrayDialog } from "./components/app/CloseToTrayDialog"
import { initializeThemePreference } from "./lib/theme-preference"
import "./index.css"

initializeThemePreference()

ReactDOM.createRoot(document.getElementById("root")!).render(
  // <React.StrictMode>
  <>
    <App />
    <CloseToTrayDialog />
  </>
  // </React.StrictMode>
)
