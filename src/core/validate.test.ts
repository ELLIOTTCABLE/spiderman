import assert from "node:assert/strict"
import { test } from "node:test"
import {
   array,
   integer,
   literal,
   object,
   optional,
   string,
   tagged,
   validate,
} from "./validate.ts"

const point = object({ name: string, x: integer, label: optional(string) })

test("unknown keys are dropped rather than rejected", () => {
   assert.deepEqual(validate(point, { name: "a", x: 1, extra: true }), {
      ok: true,
      value: { name: "a", x: 1 },
   })
})

test("null and absent optionals are omitted, so exactOptionalPropertyTypes holds", () => {
   const result = validate(point, { name: "a", x: 1, label: null })
   assert.ok(result.ok)
   assert.equal("label" in result.value, false)
})

test("a wrongly-typed optional is still an error", () => {
   assert.deepEqual(validate(point, { name: "a", x: 1, label: 5 }), {
      ok: false,
      error: "$.label: expected a string, got number",
   })
})

test("errors name the path into nested arrays", () => {
   const list = object({ points: array(point) })
   assert.deepEqual(
      validate(list, {
         points: [
            { name: "a", x: 1 },
            { name: "b", x: 1.5 },
         ],
      }),
      {
         ok: false,
         error: "$.points[1].x: expected an integer, got number",
      },
   )
})

test("tagged unions dispatch on the tag and keep it", () => {
   const shape = tagged("kind", {
      circle: object({ r: integer }),
      square: object({ side: integer }),
   })
   assert.deepEqual(validate(shape, { kind: "square", side: 2, r: 9 }), {
      ok: true,
      value: { kind: "square", side: 2 },
   })
   assert.equal(validate(shape, { kind: "toString" }).ok, false)
   assert.equal(validate(shape, { side: 2 }).ok, false)
})

test("literal rejects values outside the set", () => {
   assert.equal(validate(literal("a", "b"), "c").ok, false)
   assert.deepEqual(validate(literal("a", "b"), "b"), { ok: true, value: "b" })
})
