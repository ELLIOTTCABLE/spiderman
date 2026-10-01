import assert from "node:assert/strict"
import { test } from "node:test"
import { classify, subagentBrief } from "./tools.ts"

test("names are exact per harness: CC capitalised, pi lowercase", () => {
   assert.equal(classify("Read").kind, "read")
   assert.equal(classify("read").kind, "read")
   assert.equal(classify("TodoWrite").kind, "noise")
   assert.equal(classify("todowrite").kind, "generic")
})

test("MCP tools are remote; object-prototype names are not tools", () => {
   assert.equal(classify("mcp__github__get_file").kind, "remote")
   assert.equal(classify("constructor").kind, "generic")
   assert.equal(classify("__proto__").kind, "generic")
})

test("a subagent brief is complete only when it is the whole instruction", () => {
   assert.deepEqual(subagentBrief({ description: "List files", prompt: "Glob *.md" }), {
      who: undefined,
      what: "List files",
      complete: false,
   })
   assert.deepEqual(subagentBrief({ agent: "scout", task: "find x" }), {
      who: "scout",
      what: "find x",
      complete: true,
   })
   assert.deepEqual(
      subagentBrief({
         tasks: [
            { agent: "a", task: "t1" },
            { agent: "b", task: "t2" },
         ],
      }),
      {
         who: "a",
         what: "t1 (+1 more)",
         complete: false,
      },
   )
})
