import { withPartnerHttpFixture } from "../../deploy/dev/service/partner-http.mjs"
const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 240000)
try {
  await withPartnerHttpFixture(async (fixture) => {
    console.log(JSON.stringify({ stage: "m03-text-database-proof", proof: await fixture.deliveryProbe("exercise") }))
  }, { signal: abort.signal, upgradeV7: true })
  await withPartnerHttpFixture(async () => { console.log(JSON.stringify({ stage: "m03-new-v8-catalog", schemaReady: true, migrations: 8, noForeignKeys: true })) }, { signal: abort.signal })
} finally { clearTimeout(timer) }
