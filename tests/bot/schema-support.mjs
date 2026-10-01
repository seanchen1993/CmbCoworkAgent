import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

export const base = new URL('../../contracts/bot/v1/', import.meta.url)
export function readContract(file) { return JSON.parse(readFileSync(new URL(file, base), 'utf8')) }
export const states = readContract('state-transitions.json')
export const schemas = readContract('schemas.json')
export const runtimeSchema = readContract('runtime.schema.json')
export const openapi = readContract('openapi.json')
export const ajv = new Ajv2020({strict:true, allErrors:true, validateFormats:true})
addFormats(ajv)
ajv.addFormat('binary', {type:'string', validate: () => true})
for (const keyword of ['x-state-transitions','x-reconciliation','x-mode-capabilities']) ajv.addKeyword({keyword, valid:true})
ajv.addSchema(states, fileURLToPath(new URL('state-transitions.json', base)))
ajv.addSchema(schemas, fileURLToPath(new URL('schemas.json', base)))
ajv.addSchema(runtimeSchema, fileURLToPath(new URL('runtime.schema.json', base)))
export function validator(name) { return ajv.getSchema(`${fileURLToPath(new URL('schemas.json', base))}#/$defs/${name}`) }
export const documents = {'schemas.json':schemas,'state-transitions.json':states,'runtime.schema.json':runtimeSchema,'openapi.json':openapi}
export function resolveRef(ref, file = 'openapi.json') {
  const [relative, pointer = ''] = ref.split('#')
  const target = relative ? relative.replace(/^\.\//, '') : file
  if (!(target in documents) || (relative && ![target,`./${target}`].includes(relative))) throw new Error(`Nonlocal/unresolved reference ${ref}`)
  if (pointer && !pointer.startsWith('/')) throw new Error(`Unsupported pointer ${ref}`)
  let value = documents[target]
  for (const part of pointer ? pointer.slice(1).split('/') : []) {
    const key = part.replace(/~1/g,'/').replace(/~0/g,'~')
    if (!Object.hasOwn(value,key)) throw new Error(`Unresolved pointer ${ref}`)
    value = value[key]
  }
  return {value,file:target}
}
export function dereference(value, file = 'openapi.json') {
  const seen = new Set()
  while (value.$ref) {
    const key = `${file}:${value.$ref}`
    if (seen.has(key)) throw new Error(`Reference cycle ${key}`)
    seen.add(key)
    ;({value,file} = resolveRef(value.$ref,file))
  }
  return value
}
export function validateRef(schema, value, file = 'openapi.json') {
  if (!schema.$ref) throw new Error('OpenAPI DTOs must reference the single field source')
  const resolved = resolveRef(schema.$ref,file)
  const pointer = schema.$ref.split('#')[1] ?? ''
  if (resolved.file === 'openapi.json') throw new Error('DTO cannot be defined inside OpenAPI')
  const check = ajv.getSchema(`${fileURLToPath(new URL(resolved.file,base))}${pointer ? `#${pointer}` : ''}`)
  if (!check) throw new Error(`Missing compiled schema ${schema.$ref}`)
  return {valid:check(value),errors:check.errors}
}
export const operationDefinitions = Object.entries(openapi.paths).flatMap(([path,item]) => Object.entries(item).filter(([method]) => ['get','post','put'].includes(method)).map(([method,operation]) => ({path,method,operation,parameters:[...(item.parameters ?? []),...(operation.parameters ?? [])].map(value => dereference(value))})))
