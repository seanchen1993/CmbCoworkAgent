import test from "node:test"
import assert from "node:assert/strict"
import { groupMemoryProbe, groupMemoryBoundaryClassification } from "../../../deploy/dev/service/group-memory-java.mjs"
import { withPartnerHttpFixture } from "../../../deploy/dev/service/partner-http.mjs"

test("memory probe selects only fixed owned-test actions and cancelled work sends nothing", async () => {
  for (const action of ["sql", "drop", "repair", "migrate", "com.devclaw.botcontrol.http.PartnerHttpMain"]) await assert.rejects(groupMemoryProbe(null, null, action), /GROUP_MEMORY_SELECTION/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(groupMemoryProbe(null, null, "facts", {}, controller.signal))
})
test("Partner V5 upgrade test option is closed before private files or Docker work", async () => {
  for (const upgradeV5 of [1, "5", {}, null]) await assert.rejects(withPartnerHttpFixture(() => { throw Error("MUST_NOT_RUN") }, { upgradeV5 }), /PARTNER_SELECTION/)
})
test("probe boundary diagnostics retain all strict checks without returning private child bytes", () => {
  const base = {stdout:'{"status":"verified"}',stderr:"",code:0,spawnError:null,overflow:false}
  assert.equal(groupMemoryBoundaryClassification(base,"synthetic-secret").rejected,false)
  for (const patch of [{stderr:"PRIVATE_LOG"},{code:null},{code:137},{overflow:true},{spawnError:{message:"PRIVATE_ARGV"}},{stdout:""},{stdout:"{}\n{}"},{stdout:"jdbc:mysql:PRIVATE"},{stdout:"Exception PRIVATE"},{stdout:"at com.devclaw.PRIVATE"},{stdout:"synthetic-secret"}]) {
    const value=groupMemoryBoundaryClassification({...base,...patch},"synthetic-secret")
    assert.equal(value.rejected,true)
    assert.ok(!JSON.stringify(value).includes("PRIVATE"))
    assert.ok(!JSON.stringify(value).includes("synthetic-secret"))
  }
  assert.equal(groupMemoryBoundaryClassification(base,"synthetic-secret",true).flags.timeout,true)
})
