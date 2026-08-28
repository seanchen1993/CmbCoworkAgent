import "./lib/console-gate"
import ReactDOM from "react-dom/client"
import App from "./App"
import { CloseToTrayDialog } from "./components/app/CloseToTrayDialog"
import { applyThemePreference, getThemePreference } from "./lib/theme-preference"
import "./index.css"

applyThemePreference(getThemePreference())

ReactDOM.createRoot(document.getElementById("root")!).render(
  // <React.StrictMode>
  <>
    <App />
    <CloseToTrayDialog />
  </>
  // </React.StrictMode>
)
