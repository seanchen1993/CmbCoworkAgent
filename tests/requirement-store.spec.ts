import assert from "node:assert/strict"
import {
  ALL_REQUIREMENT_SYSTEMS_VALUE,
  getRequirementSystemName,
  useRequirementStore
} from "../src/renderer/src/components/requirement/requirement-store"

const store = useRequirementStore
const systems = [
  {
    id: "brand-tesla",
    name: "Tesla",
    description: "Tesla design system",
    category: "Automotive",
    path: "/tmp/design-systems/brand-tesla/DESIGN.md"
  },
  {
    id: "brand-vercel",
    name: "Vercel",
    description: "Vercel design system",
    category: "Developer Tools & IDEs",
    path: "/tmp/design-systems/brand-vercel/DESIGN.md"
  }
]

store.setState({ selectedSystemId: null, systemList: systems })

assert.equal(ALL_REQUIREMENT_SYSTEMS_VALUE, "all")
assert.ok(
  store.getState().systemList.length > 0,
  "the system list should be available in the store"
)
assert.equal(store.getState().selectedSystemId, null, "the default selection is all systems")

store.getState().setSelectedSystemId("brand-tesla")
assert.equal(store.getState().selectedSystemId, "brand-tesla")
store.getState().setSelectedSystemId("brand-vercel")
assert.equal(store.getState().selectedSystemId, "brand-vercel")

store.getState().setSelectedSystemId("unknown-system")
assert.equal(store.getState().selectedSystemId, null, "unknown systems fall back to all systems")

const custom = store.getState().addCustomSystem("全新业务系统")
assert.equal(custom.name, "全新业务系统")
assert.equal(custom.theme, "", "custom systems have an empty theme")
assert.equal(
  getRequirementSystemName(custom.id),
  "全新业务系统",
  "requirement list labels resolve custom system names instead of displaying their ids"
)
assert.ok(store.getState().systemList.some((system) => system.id === custom.id))

store.getState().setSystemList(systems)
assert.ok(
  store.getState().systemList.some((system) => system.id === custom.id),
  "custom systems remain selectable after remote systems reload"
)

console.log("requirement-store: all assertions passed")
