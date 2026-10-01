import { type Interaction, type PeerPackage, packageText } from "./package.ts"
import type { Trail } from "./trail.ts"

export interface PackageMeasure {
   /** what forwarding the whole trail verbatim would cost */
   readonly rawChars: number
   readonly packageChars: number
   readonly unreachable: readonly {
      readonly interaction: Interaction
      readonly pointer: string
   }[]
   /** calls in the trail the package says nothing about */
   readonly unaccounted: readonly string[]
}

export function measurePackage(
   trail: Trail,
   pkg: PeerPackage,
   resolves: (path: string) => boolean,
): PackageMeasure {
   let rawChars = 0
   for (const item of trail.items) {
      if (item.kind === "call") rawChars += JSON.stringify(item.input ?? {}).length
      else if (item.kind !== "halt") rawChars += item.text.length
   }

   const unreachable = pkg.interactions.flatMap((interaction) =>
      interaction.pointers
         .filter((p) => !resolves(p))
         .map((pointer) => ({ interaction, pointer })),
   )

   const accounted = pkg.interactions.filter(
      (i) => i.kind !== "orphan" && i.kind !== "report",
   )
   const calls = trail.items.flatMap((i) => (i.kind === "call" ? [i] : []))
   const unaccounted = calls
      .filter(
         (call, n) => accounted[n]?.id !== call.id || accounted[n]?.tool !== call.name,
      )
      .map((call) => `${call.name} ${call.id ?? "(no id)"}`)

   return { rawChars, packageChars: packageText(pkg).length, unreachable, unaccounted }
}
