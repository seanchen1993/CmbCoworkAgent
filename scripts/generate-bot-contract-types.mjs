import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve, basename } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contractRoot = resolve(root, 'contracts/bot/v1')
const output = resolve(root, 'src/shared/bot/contracts.generated.ts')
const files = ['state-transitions.json', 'schemas.json']
const allowed = new Set(['$schema', '$id', '$defs', '$ref', 'description', 'title', 'type', 'properties', 'required', 'additionalProperties', 'unevaluatedProperties', 'enum', 'const', 'oneOf', 'allOf', 'items', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems'])
const rootExtensions = new Set(['x-state-transitions', 'x-reconciliation', 'x-mode-capabilities'])
const formats = new Set(['date-time', 'binary'])

export function generate(documents) {
  const names = new Map()
  for (const [file, doc] of Object.entries(documents)) {
    if (doc.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error(`${file}: unsupported schema dialect`)
    for (const name of Object.keys(doc.$defs ?? {})) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || names.has(name)) throw new Error(`Invalid/duplicate definition ${name}`)
      names.set(name, file)
    }
  }
  function refName(ref, file) {
    const match = /^(.*?)#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/.exec(ref)
    if (!match) throw new Error(`Unsupported/offline-only reference ${ref}`)
    const target = match[1] ? basename(match[1]) : file
    if (match[1] && match[1] !== `./${target}` && match[1] !== target) throw new Error(`Nonlocal reference ${ref}`)
    if (names.get(match[2]) !== target) throw new Error(`Unresolved reference ${file}: ${ref}`)
    return match[2]
  }
  function visit(s, file, location, isRoot = false) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${location}: boolean/nonobject schemas unsupported`)
    for (const key of Object.keys(s)) {
      if (!allowed.has(key) && !(isRoot && rootExtensions.has(key))) throw new Error(`${location}: unsupported keyword ${key}`)
    }
    if (s.additionalProperties !== undefined && s.additionalProperties !== false) throw new Error(`${location}: open maps unsupported`)
    if (s.unevaluatedProperties !== undefined && s.unevaluatedProperties !== false) throw new Error(`${location}: open composition unsupported`)
    if (s.format && !formats.has(s.format)) throw new Error(`${location}: unsupported format ${s.format}`)
    if (s.$ref) {
      if (Object.keys(s).some(k => !['$ref','description','title'].includes(k))) throw new Error(`${location}: $ref siblings unsupported`)
      return refName(s.$ref, file)
    }
    if (isRoot) {
      for (const [name, child] of Object.entries(s.$defs ?? {})) visit(child, file, `${location}/$defs/${name}`)
      return ''
    }
    if (s.oneOf || s.allOf) {
      if (s.oneOf && s.allOf) throw new Error(`${location}: mixed composition unsupported`)
      if (Object.keys(s).some(k => !['oneOf','allOf','description','title','unevaluatedProperties'].includes(k))) throw new Error(`${location}: composition siblings unsupported`)
      const values = s.oneOf ?? s.allOf
      if (!Array.isArray(values) || values.length < 1) throw new Error(`${location}: empty composition`)
      return `(${values.map((c, i) => visit(c, file, `${location}/${i}`)).join(s.oneOf ? ' | ' : ' & ')})`
    }
    if (s.const !== undefined) {
      if (!['string','number','boolean'].includes(typeof s.const)) throw new Error(`${location}: unsupported const`)
      return JSON.stringify(s.const)
    }
    if (s.enum) {
      if (!Array.isArray(s.enum) || !s.enum.length || s.enum.some(v => !['string','number','boolean'].includes(typeof v))) throw new Error(`${location}: unsupported enum`)
      return s.enum.map(v => JSON.stringify(v)).join(' | ')
    }
    switch (s.type) {
      case 'string': return 'string'
      case 'integer': case 'number': return 'number'
      case 'boolean': return 'boolean'
      case 'array':
        if (!s.items || !Number.isInteger(s.maxItems)) throw new Error(`${location}: arrays require items and maxItems`)
        return `Array<${visit(s.items, file, `${location}/items`)}>`
      case 'object': {
        if (s.additionalProperties !== false || !s.properties) throw new Error(`${location}: objects must be closed`)
        const required = new Set(s.required ?? [])
        if ([...required].some(k => !(k in s.properties))) throw new Error(`${location}: invalid required`)
        return `{\n${Object.entries(s.properties).map(([k,v]) => `  ${JSON.stringify(k)}${required.has(k) ? '' : '?'}: ${visit(v, file, `${location}/properties/${k}`)};`).join('\n')}\n}`
      }
      default: throw new Error(`${location}: unsupported/missing type ${JSON.stringify(s.type)}`)
    }
  }
  for (const [file, doc] of Object.entries(documents)) visit(doc, file, file, true)
  const lines = ['// Generated offline from contracts/bot/v1/*.json. DO NOT EDIT.', '// Structural types only: use the JSON Schema validator for bounds and semantic checks.', '']
  for (const name of [...names.keys()].sort()) {
    const file = names.get(name)
    lines.push(`export type ${name} = ${visit(documents[file].$defs[name], file, `${file}/$defs/${name}`)};`, '')
  }
  return lines.join('\n')
}

export function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--check')) throw new Error('Usage: generate-bot-contract-types.mjs [--check]')
  const docs = Object.fromEntries(files.map(file => [file, JSON.parse(readFileSync(resolve(contractRoot, file), 'utf8'))]))
  const result = generate(docs)
  if (args.includes('--check')) {
    if (readFileSync(output, 'utf8') !== result) throw new Error('Generated Bot contract types have drifted; run generate:bot-contracts')
    console.log('Bot contract types match the deterministic schema output')
  } else {
    writeFileSync(output, result)
    console.log('Generated src/shared/bot/contracts.generated.ts')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
