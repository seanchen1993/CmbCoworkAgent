import assert from 'node:assert/strict'
import test from 'node:test'
import { operations, runtime, errorFixtures, dtoFixtures, requests } from '../../contracts/bot/v1/fixtures/positive.mjs'
import { negative } from '../../contracts/bot/v1/fixtures/negative.mjs'
import { documents, openapi, schemas, runtimeSchema, resolveRef, dereference, validateRef, validator, operationDefinitions } from './schema-support.mjs'

test('all references resolve offline and operations are unique and complete', () => {
  const walk = (value,file) => {
    if (!value || typeof value !== 'object') return
    if (value.$ref) resolveRef(value.$ref,file)
    for (const child of Object.values(value)) walk(child,file)
  }
  for (const [file, doc] of Object.entries(documents)) walk(doc,file)
  assert.equal(openapi.openapi,'3.1.0')
  assert.deepEqual(runtimeSchema.$ref,'./schemas.json#/$defs/RuntimeEnvelope')
  const ids = operationDefinitions.map(x => x.operation.operationId)
  assert.equal(new Set(ids).size,ids.length)
  assert.equal(ids.length,26)
  assert.deepEqual(ids.sort(),operations.map(x => x.operationId).sort())
  assert.deepEqual(Object.keys(openapi['x-error-status']).sort(),[...schemas.$defs.ErrorCode.enum].sort())
  const node = operationDefinitions.find(x => x.operation.operationId === 'connectRuntime')
  assert.deepEqual(node.operation.security,[{nodeCredential:[]}])
})

test('each operation request, every declared response status and all DTO variants validate', () => {
  for (const fixture of operations) {
    const definition = operationDefinitions.find(x => x.operation.operationId === fixture.operationId)
    const {operation,parameters} = definition
    for (const location of ['path','header','query']) {
      const data = fixture.request[location === 'header' ? 'headers' : location] ?? {}
      const expected = parameters.filter(p => p.in === location)
      for (const p of expected) {
        if (p.required) assert.ok(Object.hasOwn(data,p.name),`${fixture.operationId} missing ${p.name}`)
        if (Object.hasOwn(data,p.name)) {
          const result = validateRef(p.schema,data[p.name])
          assert.equal(result.valid,true,`${fixture.operationId}/${p.name}: ${JSON.stringify(result.errors)}`)
        }
      }
      for (const key of Object.keys(data)) assert.ok(expected.some(p => p.name === key),`${fixture.operationId} unknown parameter ${key}`)
    }
    if (operation.requestBody) {
      const request = dereference(operation.requestBody)
      for (const content of Object.values(request.content)) {
        const result = validateRef(content.schema,fixture.request.body)
        assert.equal(result.valid,true,`${fixture.operationId} request: ${JSON.stringify(result.errors)}`)
      }
    } else assert.equal(Object.hasOwn(fixture.request,'body'),false)
    const seen = new Set()
    for (const response of fixture.responses) {
      assert.ok(operation.responses[response.status],`${fixture.operationId}: undocumented status ${response.status}`)
      const declared = dereference(operation.responses[response.status])
      for (const content of Object.values(declared.content ?? {})) {
        const result = validateRef(content.schema,response.body)
        assert.equal(result.valid,true,`${fixture.operationId}/${response.status}: ${JSON.stringify(result.errors)}`)
      }
      if (!declared.content) assert.equal(Object.hasOwn(response,'body'),false)
      seen.add(String(response.status))
    }
    // Reuse real safe-error fixtures for every operation's documented error status.
    for (const [status, response] of Object.entries(operation.responses)) {
      if (Number(status) < 400) {assert.ok(seen.has(status),`${fixture.operationId} missing positive ${status}`); continue}
      const declared = dereference(response)
      const fixtures = errorFixtures.filter(f => openapi['x-error-status'][f.error.code] === Number(status))
      assert.ok(fixtures.length,`${fixture.operationId} missing error ${status}`)
      for (const value of fixtures) {
        assert.equal(validateRef(declared.content['application/json'].schema,value).valid,true)
        if (value.error.code === 'OUTCOME_UNKNOWN') assert.equal(value.error.retryable,false)
      }
    }
  }
  for (const [name, value] of dtoFixtures) assert.equal(validator(name)(value),true,`${name}: ${JSON.stringify(validator(name).errors)}`)
  assert.equal(operations.find(f => f.operationId === 'completeUpload').responses.find(f => f.status === 202).body.upload.status,'verifying')
  assert.equal(operations.find(f => f.operationId === 'completeUpload').responses.find(f => f.status === 200).body.upload.status,'committed')
  assert.equal(operations.find(f => f.operationId === 'cancelRun').responses[0].body.run.status,'cancel_requested')
})

test('14 runtime envelope types, all event variants, completion outcomes and inspection zero validate', () => {
  const types = schemas.$defs.RuntimeEnvelope.oneOf.map(s => s.properties.type.const).sort()
  assert.equal(types.length,14)
  assert.deepEqual([...new Set(runtime.map(f => f.type))].sort(),types)
  for (const fixture of runtime) assert.equal(validator('RuntimeEnvelope')(fixture),true,JSON.stringify(validator('RuntimeEnvelope').errors))
  assert.deepEqual([...new Set(runtime.filter(f => f.type === 'event').map(f => f.body.eventType))].sort(),['artifact_committed','completed','progress','waiting_approval'])
  assert.ok(runtime.some(f => f.type === 'inspection' && f.body.lastEventSeq === 0))
})

test('real structural negatives and server identity/credential injection are rejected', () => {
  for (const fixture of negative) assert.equal(validator(fixture.schema)(fixture.value),false,fixture.name)
  for (const [operationId,body] of Object.entries(requests)) {
    const definition = operationDefinitions.find(x => x.operation.operationId === operationId)
    const schema = dereference(definition.operation.requestBody).content['application/json'].schema
    for (const key of ['unknown','actorId','principalId','spaceId','token','authorization','endpoint','path','metadata']) {
      assert.equal(validateRef(schema,{...body,[key]:'synthetic-forged'}).valid,false,`${operationId} ${key}`)
    }
  }
  for (const fixture of runtime) {
    assert.equal(validator('RuntimeEnvelope')({...fixture,actorId:'forged'}),false)
    assert.equal(validator('RuntimeEnvelope')({...fixture,body:{...fixture.body,token:'synthetic'}}),false)
  }
  const nested = structuredClone(requests.createBot)
  nested.config.secret = 'synthetic'
  assert.equal(validator('CreateBotRequest')(nested),false)
  assert.equal(validator('EventLimit')(201),false)
})
