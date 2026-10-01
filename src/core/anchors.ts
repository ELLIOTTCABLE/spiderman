export type AnchorParse =
   | { readonly kind: "ok"; readonly anchors: readonly string[] }
   | { readonly kind: "unparseable"; readonly reason: string }

export function parseAnchors(output: string): AnchorParse {
   const candidates = jsonObjectsIn(output).filter(
      (value): value is Record<string, unknown> =>
         typeof value === "object" &&
         value !== null &&
         !Array.isArray(value) &&
         "elide" in value,
   )
   const [first, ...rest] = candidates
   if (first === undefined) return unparseable('no JSON object with an "elide" key')

   const firstJson = JSON.stringify(first)
   if (rest.some((other) => JSON.stringify(other) !== firstJson))
      return unparseable('several different "elide" objects')

   const elide = first.elide
   if (!Array.isArray(elide)) return unparseable('"elide" is not an array')
   const badIndex = elide.findIndex((anchor) => typeof anchor !== "string")
   if (badIndex !== -1) return unparseable(`"elide"[${badIndex}] is not a string`)
   return { kind: "ok", anchors: elide as string[] }
}

function unparseable(reason: string): AnchorParse {
   return { kind: "unparseable", reason }
}

// an unparseable span is rescanned from its next char, so stray prose braces can't hide a later object
function jsonObjectsIn(text: string): unknown[] {
   const found: unknown[] = []
   let from = text.indexOf("{")
   while (from !== -1) {
      const end = balancedEnd(text, from)
      let next = from + 1
      if (end !== undefined) {
         try {
            found.push(JSON.parse(text.slice(from, end + 1)))
            next = end + 1
         } catch {}
      }
      from = text.indexOf("{", next)
   }
   return found
}

function balancedEnd(text: string, start: number): number | undefined {
   let depth = 0
   let inString = false
   for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
         if (ch === "\\") i++
         else if (ch === '"') inString = false
      } else if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}") {
         depth--
         if (depth === 0) return i
      }
   }
   return undefined
}
