import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

export const base = new URL('../../contracts/bot/v1/', import.meta.url)
export function readContract(file) { return JSON.parse(readFileSync(new URL(file, base), 'utf8')) }
export const states = readContract('state-transitions.json')
export const schemas = readContract('schemas.json')
export const ajv = new Ajv2020({strict:true, allErrors:true, validateFormats:true})
addFormats(ajv)
ajv.addFormat('binary', {type:'string', validate: () => true})
for (const keyword of ['x-state-transitions','x-reconciliation','x-mode-capabilities']) ajv.addKeyword({keyword, valid:true})
ajv.addSchema(states, fileURLToPath(new URL('state-transitions.json', base)))
ajv.addSchema(schemas, fileURLToPath(new URL('schemas.json', base)))
export function validator(name) { return ajv.getSchema(`${fileURLToPath(new URL('schemas.json', base))}#/$defs/${name}`) }
