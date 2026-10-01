import assert from 'node:assert/strict'
import test from 'node:test'
import { generate } from '../../scripts/generate-bot-contract-types.mjs'
import { schemas, states, validator } from './schema-support.mjs'

test('closed core schema and single state table compile offline', () => {
  for (const name of Object.keys(schemas.$defs)) assert.equal(typeof validator(name), 'function', name)
  for (const [name, status] of Object.entries(states.$defs)) {
    const table = states['x-state-transitions'][name]
    assert.deepEqual(Object.keys(table).sort(), [...status.enum].sort(), name)
    for (const next of Object.values(table)) for (const value of next) assert.ok(status.enum.includes(value))
    for (const [from, next] of Object.entries(states['x-reconciliation'][name] ?? {})) {
      assert.equal(from, 'outcome_unknown')
      assert.deepEqual(table[from], [])
      for (const value of next) assert.ok(status.enum.includes(value))
    }
  }
  assert.equal(validator('Version')(0), false)
  assert.equal(validator('CredentialBinding')({credentialRef:'cred-1',purpose:'repository_read',token:'synthetic-secret'}), false)
  assert.equal(validator('ModeRef')({id:'requirement',version:1}), true)
})

test('deterministic generator rejects unsupported keyword, remote refs and open maps', () => {
  const docs = {'schemas.json':schemas, 'state-transitions.json':states}
  assert.equal(generate(docs), generate(docs))
  for (const mutation of [s => {s.$defs.Id.not = {}}, s => {s.$defs.Id = {$ref:'https://invalid.example/x#/$defs/Id'}}, s => {s.$defs.Bot.additionalProperties = true}]) {
    const changed = structuredClone(docs)
    mutation(changed['schemas.json'])
    assert.throws(() => generate(changed))
  }
})
