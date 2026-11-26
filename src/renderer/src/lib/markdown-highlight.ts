import { common, type LanguageFn } from "lowlight"
import rehypeHighlight from "rehype-highlight"

type GrammarMetadata = Pick<ReturnType<LanguageFn>, "name" | "aliases">
type GrammarIndex = Readonly<Record<string, GrammarMetadata>>
type HighlightTransformer = ReturnType<typeof rehypeHighlight>

declare const __CHAT_HIGHLIGHT_GRAMMARS__: GrammarIndex

// Read the registration metadata in the build so the renderer can register
// supported languages without constructing every grammar on the first code block.
export function collectMarkdownHighlightGrammars(): GrammarIndex {
  const grammars: Record<string, GrammarMetadata> = {}
  const collect =
    (name: string, define: LanguageFn): LanguageFn =>
    (engine) => {
      const grammar = define(engine)
      grammars[name] = { name: grammar.name, aliases: grammar.aliases }
      return grammar
    }
  rehypeHighlight({
    languages: Object.fromEntries(
      Object.entries(common).map(([name, define]) => [
        name,
        collect(name, define)
      ])
    )
  })
  return grammars
}

function deferGrammar(
  name: string,
  metadata: GrammarMetadata,
  define: LanguageFn
): LanguageFn {
  return (engine) => {
    let initialized = false
    const language: Partial<ReturnType<LanguageFn>> = {
      name: metadata.name || name,
      ...(metadata.aliases && { aliases: metadata.aliases })
    }
    function initialize() {
      if (!initialized) {
        Object.assign(language, define(engine))
        initialized = true
      }
      return language
    }

    // Highlight.js needs the name and aliases for registration. It reads the
    // remaining fields when it first highlights a block or an embedded language.
    return new Proxy(language, {
      get(target, property) {
        if (
          property === "name" ||
          property === "aliases" ||
          property === "rawDefinition"
        ) {
          return Reflect.get(target, property)
        }
        return Reflect.get(initialize(), property)
      },
      set(target, property, value) {
        // Keep rawDefinition pointing to the underlying grammar factory.
        if (property === "rawDefinition" && !target.rawDefinition) {
          target.rawDefinition = () => define(engine)
          return true
        }
        return Reflect.set(initialize(), property, value)
      },
      has(_target, property) {
        return Reflect.has(initialize(), property)
      },
      ownKeys() {
        return Reflect.ownKeys(initialize())
      },
      getOwnPropertyDescriptor(_target, property) {
        return Reflect.getOwnPropertyDescriptor(initialize(), property)
      }
    }) as ReturnType<LanguageFn>
  }
}

export function createMarkdownHighlighter(
  grammars?: GrammarIndex
): HighlightTransformer {
  if (!grammars) return rehypeHighlight()
  return rehypeHighlight({
    languages: Object.fromEntries(
      Object.entries(common).map(([name, define]) => [
        name,
        grammars[name] ? deferGrammar(name, grammars[name], define) : define
      ])
    )
  })
}

let transformer: HighlightTransformer | undefined

export function rehypeChatHighlight(): HighlightTransformer {
  const grammars =
    typeof __CHAT_HIGHLIGHT_GRAMMARS__ === "undefined"
      ? undefined
      : __CHAT_HIGHLIGHT_GRAMMARS__
  return (transformer ??= createMarkdownHighlighter(grammars))
}
