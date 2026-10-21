import { describe, expect, it } from "vitest"
import { replace } from "./replace"

const indentationError = /oldString does not preserve.*indentation/

describe("edit_file indentation protection", () => {
  it("rejects the reported two-line Java edit without changing the source", () => {
    const oldString =
      'final String orgLvl = customerDomainService.getOrgLvl();\nif (orgLvl != null && orgLvl.compareTo("30") < 0 && "100".equals(dto.getBbkOrgId())){'
    const newString = oldString.replace(
      'orgLvl.compareTo("30") < 0',
      "Integer.parseInt(orgLvl) < 30"
    )
    const content = oldString
      .split("\n")
      .map((line) => `        ${line}`)
      .join("\n")
    const original = content
    expect(() => replace(content, oldString, newString)).toThrow(indentationError)
    expect(content).toBe(original)
  })

  it("accepts the same edit with the original indentation", () => {
    const content =
      '        final String orgLvl = service.getOrgLvl();\n        if (orgLvl.compareTo("30") < 0) {'
    const replacement = content.replace(
      'orgLvl.compareTo("30") < 0',
      "Integer.parseInt(orgLvl) < 30"
    )
    expect(replace(content, content, replacement)).toEqual({
      newContent: replacement,
      occurrences: 1
    })
  })

  it("rejects internal indentation differences even when the first line matches", () => {
    const content = "    if (ready) {\n        run();\n    }"
    const oldString = "    if (ready) {\n    run();\n    }"
    expect(() => replace(content, oldString, oldString.replace("run", "finish"))).toThrow(
      indentationError
    )
  })

  it("distinguishes tabs from spaces", () => {
    expect(() =>
      replace("\trun();\n\tfinish();", "    run();\n    finish();", "    done();")
    ).toThrow(indentationError)
  })

  it("does not allow anchor matching to bypass indentation checks", () => {
    const content = "    if (ready) {\n        run();\n    }"
    const oldString = "if (ready) {\nrun();\n}"
    expect(() => replace(content, oldString, "if (ready) {\nfinish();\n}")).toThrow(
      indentationError
    )
  })

  it("checks the physical line indentation when a fuzzy match excludes leading spaces", () => {
    expect(() => replace("    run( value ); tail", "run(  value );", "finish(value);")).toThrow(
      indentationError
    )
  })

  it("checks every occurrence before applying a fuzzy replace_all", () => {
    const content = "run( value ); tail\n    run( value ); tail"
    expect(() => replace(content, "run(  value );", "finish(value);", true)).toThrow(
      indentationError
    )
  })

  it.each(["    ", "\t"])("consumes validated %j indentation in a fuzzy match", (indent) => {
    expect(
      replace(`${indent}run( value ); tail`, `${indent}run(  value );`, `${indent}finish(value);`)
    ).toEqual({
      newContent: `${indent}finish(value); tail`,
      occurrences: 1
    })
  })

  it.each(["\n", "\r\n"])(
    "consumes indentation at every fuzzy occurrence with %j endings",
    (ending) => {
      const content = `    run( value ); tail${ending}    run(   value ); tail${ending}`
      expect(replace(content, "    run(  value );", "    finish(value);", true)).toEqual({
        newContent: `    finish(value); tail${ending}    finish(value); tail${ending}`,
        occurrences: 2
      })
    }
  )

  it("preserves non-whitespace prefixes during fuzzy inline replacement", () => {
    expect(replace("    before(); run( value ); tail", "run(  value );", "finish(value);")).toEqual(
      {
        newContent: "    before(); finish(value); tail",
        occurrences: 1
      }
    )
  })

  it("preserves trailing-whitespace tolerance when indentation matches", () => {
    expect(
      replace("    run();  \n    finish();", "    run();\n    finish();", "    done();")
    ).toEqual({
      newContent: "    done();",
      occurrences: 1
    })
  })

  it.each([
    ["tabs", "\trun();", String.raw`\trun();`],
    ["newlines", "    run();\n    finish();", String.raw`    run();\n    finish();`],
    ["tabs and newlines", "\trun();\n\tfinish();", String.raw`\trun();\n\tfinish();`]
  ])("accepts escaped %s when the decoded indentation matches", (_label, content, oldString) => {
    expect(replace(content, oldString, content.replace("run", "done"))).toEqual({
      newContent: content.replace("run", "done"),
      occurrences: 1
    })
  })

  it("rejects escaped text when the decoded indentation differs", () => {
    expect(() => replace(" \trun();", String.raw`\trun();`, "\tdone();")).toThrow(indentationError)
  })

  it("does not decode literal escapes for other matching strategies", () => {
    expect(replace('    log("\\n"); ', '    log("\\n");  ', '    finish("\\n");')).toEqual({
      newContent: '    finish("\\n");',
      occurrences: 1
    })
  })

  it("skips an earlier candidate with different indentation", () => {
    expect(replace("  run();  \n    run(); ", "    run();   ", "    done();")).toEqual({
      newContent: "  run();  \n    done();",
      occurrences: 1
    })
  })

  it("rejects multiple valid candidates with different trailing whitespace", () => {
    expect(() => replace("    run(); \n    run();  ", "    run();   ", "    done();")).toThrow(
      /multiple matches/
    )
  })

  it("rejects multiple locations of the same fuzzy search", () => {
    expect(() => replace("    run(); \n    run(); ", "    run();  ", "    done();")).toThrow(
      /multiple matches/
    )
  })

  it("checks each location of the same fuzzy search before deciding uniqueness", () => {
    expect(
      replace("run( value ); tail\n    run( value ); tail", "run(  value );", "finish(value);")
    ).toEqual({
      newContent: "finish(value); tail\n    run( value ); tail",
      occurrences: 1
    })
  })

  it("checks decoded indentation for every escaped replace_all occurrence", () => {
    expect(replace("\trun();\n\trun();", String.raw`\trun();`, "\tdone();", true)).toEqual({
      newContent: "\tdone();\n\tdone();",
      occurrences: 2
    })
    expect(() => replace("\trun();\n \trun();", String.raw`\trun();`, "\tdone();", true)).toThrow(
      indentationError
    )
  })

  it("continues to a later strategy after rejecting an anchor candidate", () => {
    const firstBlock = '  if (ready) {\n    run("value");\n  }'
    const targetBlock = '    if (ready) {\n        run("value");\n    }'
    const oldString = '    if (ready) {\n        run(\\"value\\");\n    }'
    const newString = targetBlock.replace("run", "finish")
    expect(replace(`${firstBlock}\n${targetBlock}`, oldString, newString)).toEqual({
      newContent: `${firstBlock}\n${newString}`,
      occurrences: 1
    })
  })

  it.each([false, true])("ignores unrelated anchor content with replace_all=%j", (replaceAll) => {
    const unrelated = "  if (ready) {\n      read2(  a );\n  }"
    const target = "if (ready) {\n    read( a );\n}"
    const oldString = "if (ready) {\n    read(  a );\n}"
    const newString = "if (ready) {\n    done( a );\n}"
    expect(replace(`${unrelated}\n${target}`, oldString, newString, replaceAll)).toEqual({
      newContent: `${unrelated}\n${newString}`,
      occurrences: 1
    })
  })

  it("reports missing content instead of an indentation error for an unrelated anchor", () => {
    expect(() =>
      replace(
        "  if (ready) {\n      read2(  a );\n  }",
        "if (ready) {\n    read(  a );\n}",
        "if (ready) {\n    done( a );\n}",
        true
      )
    ).toThrow(/Could not find oldString/)
  })

  it("prefers an exact match over other fuzzy candidates", () => {
    expect(replace("  run();  \n    run(); ", "    run(); ", "    done();")).toEqual({
      newContent: "  run();  \n    done();",
      occurrences: 1
    })
  })

  it.each([
    ["repeated", "    run();\n    run();", "    run();"],
    ["overlapping", "aaa", "aa"]
  ])("rejects %s exact matches", (_label, content, oldString) => {
    expect(() => replace(content, oldString, "done")).toThrow(/multiple matches/)
  })

  it("preserves exact inline matching and explicit indentation changes", () => {
    expect(replace("    run(value);", "value", "other").newContent).toBe("    run(other);")
    expect(replace("    run();", "    run();", "\trun();").newContent).toBe("\trun();")
    expect(replace("    run();\n    run();", "    run();", "    finish();", true).occurrences).toBe(
      2
    )
  })
})

describe("edit_file whitespace and line endings", () => {
  it.each([999, 1000])("bounds mixed-ending alignment for %i lines", (count) => {
    const lines = Array.from({ length: count }, (_, index) => `line ${index}`)
    const content = lines
      .map((line, index) => line + (index === count - 1 ? "" : index % 2 ? "\n" : "\r\n"))
      .join("")
    const oldString = lines.join("\n")
    const newString = oldString.replace("line 0", "changed")
    if (count === 999) {
      expect(replace(content, oldString, newString)).toEqual({
        newContent: content.replace("line 0", "changed"),
        occurrences: 1
      })
    } else {
      expect(() => replace(content, oldString, newString)).toThrow(
        /mixed line endings.*line-alignment limit.*Submit smaller edits/
      )
    }
  })

  it("allows removing a large mixed-ending region without alignment", () => {
    const content = "a\r\nb\n".repeat(20_000)
    expect(replace(content, content, "")).toEqual({ newContent: "", occurrences: 1 })
  })

  it.each(["\n", "\r\n"])("preserves uniform %j endings in a large replacement", (ending) => {
    const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`)
    const content = lines.join(ending)
    const oldString = lines.join("\n")
    lines[0] = "changed"
    expect(replace(content, oldString, lines.join("\n"))).toEqual({
      newContent: lines.join(ending),
      occurrences: 1
    })
  })

  it("preserves surrounding bytes across many replacements that change length", () => {
    const content = "before target after\r\nnext target end\n".repeat(20_000)
    expect(replace(content, "target", "replacement", true)).toEqual({
      newContent: "before replacement after\r\nnext replacement end\n".repeat(20_000),
      occurrences: 40_000
    })
  })

  it("uses file endings when inserting lines into a region without newlines", () => {
    expect(replace("head\r\ntarget\r\ntail", "target", "first\nsecond")).toEqual({
      newContent: "head\r\nfirst\r\nsecond\r\ntail",
      occurrences: 1
    })
  })

  it("uses the region endings even when the rest of the file uses different endings", () => {
    expect(replace("head\r\nmore\r\na\nb\r\ntail", "a\nb", "a\ninserted\nb")).toEqual({
      newContent: "head\r\nmore\r\na\ninserted\nb\r\ntail",
      occurrences: 1
    })
  })

  it.each(["\n", "\r\n"])("matches escaped CRLF against a %j file", (ending) => {
    expect(
      replace(`run();${ending}finish();`, String.raw`run();\r\nfinish();`, "done();\nfinish();")
    ).toEqual({ newContent: `done();${ending}finish();`, occurrences: 1 })
  })

  it("normalizes escaped CRLF with indentation and trailing newlines for replace_all", () => {
    const content = "\trun();\r\n\tfinish();\r\n".repeat(2)
    const oldString = String.raw`\trun();\r\n\tfinish();\r\n`
    expect(replace(content, oldString, "\tdone();\n\tfinish();\n", true)).toEqual({
      newContent: "\tdone();\r\n\tfinish();\r\n".repeat(2),
      occurrences: 2
    })
  })

  it("tolerates spaces and tabs on blank lines", () => {
    expect(
      replace("    run();\n \t \n    finish();", "    run();\n\n    finish();", "    done();")
    ).toEqual({ newContent: "    done();", occurrences: 1 })
  })

  it("preserves CRLF when the edit uses LF", () => {
    expect(
      replace(
        "    run();\r\n    finish();\r\n    tail();\r\n",
        "    run();\n    finish();",
        "    done();\n    finish();"
      )
    ).toEqual({
      newContent: "    done();\r\n    finish();\r\n    tail();\r\n",
      occurrences: 1
    })
  })

  it("preserves LF when the edit uses CRLF", () => {
    expect(replace("run();\nfinish();\n", "run();\r\nfinish();", "done();\r\nfinish();")).toEqual({
      newContent: "done();\nfinish();\n",
      occurrences: 1
    })
  })

  it("matches inline text spanning CRLF without changing surrounding bytes", () => {
    expect(
      replace("    run(value);\r\n    next();", "value);\n    next", "other);\n    next")
    ).toEqual({ newContent: "    run(other);\r\n    next();", occurrences: 1 })
  })

  it("preserves mixed line endings across changed and unchanged lines", () => {
    expect(
      replace("before\r\nrun();\r\nfinish();\ntail\r\n", "run();\nfinish();", "done();\nfinish();")
    ).toEqual({
      newContent: "before\r\ndone();\r\nfinish();\ntail\r\n",
      occurrences: 1
    })
  })

  it("keeps unchanged context line endings when inserting lines", () => {
    expect(replace("a\r\nb\nc\r\n", "a\nb\nc", "a\nb\nadded\nc")).toEqual({
      newContent: "a\r\nb\nadded\r\nc\r\n",
      occurrences: 1
    })
  })

  it("does not add an extra newline during trailing-whitespace matching", () => {
    expect(replace("    run();  \nnext();", "    run();\n", "    done();\n")).toEqual({
      newContent: "    done();\nnext();",
      occurrences: 1
    })
  })

  it("does not accept a missing final newline", () => {
    expect(() => replace("run();  ", "run();\n", "done();\n")).toThrow()
  })

  it("replaces all trailing-whitespace variants by their actual positions", () => {
    expect(replace("run();  \r\nrun(); \n", "run();   ", "done();", true)).toEqual({
      newContent: "done();\r\ndone();\n",
      occurrences: 2
    })
  })

  it("uses non-overlapping positions for fuzzy replace_all", () => {
    expect(replace("a  \na \na\n", "a\na", "x", true)).toEqual({
      newContent: "x\na\n",
      occurrences: 1
    })
  })

  it("rejects replace_all when a different candidate has inconsistent indentation", () => {
    expect(() => replace("    run();  \n  run(); ", "    run();   ", "    done();", true)).toThrow(
      indentationError
    )
  })

  it("allows explicit line-ending edits to change the original bytes", () => {
    expect(replace("a\r\nb\r\n", "\r", "", true)).toEqual({
      newContent: "a\nb\n",
      occurrences: 2
    })
    expect(replace("a\nb\n", "a\nb", "a\r\nb").newContent).toBe("a\r\nb\n")
  })

  it("rejects an edit that leaves the file unchanged after matching line endings", () => {
    expect(() => replace("a\r\nb", "a\nb", "a\r\nb ")).not.toThrow()
    expect(() => replace("a\r\nb", "a  \nb", "a\r\nb")).toThrow(/No changes/)
  })

  it.each([
    ["quotes", "const message = “hello”;", 'const message = "hello";'],
    ["dashes", "value — other", "value - other"],
    ["spaces", "value\u00a0other", "value other"],
    ["trailing Unicode spaces", "run();\u00a0", "run(); "]
  ])("does not normalize Unicode %s", (_label, content, oldString) => {
    expect(() => replace(content, oldString, "done();")).toThrow()
  })

  it("does not let anchor matching accept different quote characters", () => {
    expect(() =>
      replace(
        "if (ready) {\n    log(“hello”);\n}",
        'if (ready) {\n    log("hello");\n}',
        'if (ready) {\n    log("bye");\n}'
      )
    ).toThrow()
  })

  it("does not remove whitespace inside text to manufacture an anchor match", () => {
    expect(() =>
      replace(
        'if (ready) {\n    log("hello world");\n}',
        'if (ready) {\n    log("helloworld");\n}',
        'if (ready) {\n    log("bye");\n}'
      )
    ).toThrow()
  })

  it.each(["\n", "\r\n"])("still rejects the reported Java edit with %j endings", (ending) => {
    const oldString =
      'final String orgLvl = customerDomainService.getOrgLvl();\nif (orgLvl != null && orgLvl.compareTo("30") < 0 && "100".equals(viewModelQueryDTO.getBbkOrgId())){'
    const source = oldString
      .split("\n")
      .map((line) => `        ${line}`)
      .join(ending)
    expect(() =>
      replace(
        source,
        oldString,
        oldString.replace('orgLvl.compareTo("30") < 0', "Integer.parseInt(orgLvl) < 30")
      )
    ).toThrow(indentationError)
  })
})
