// unknown object keys are dropped, not rejected, so new upstream fields don't break us

export type Result<T> =
   | { readonly ok: true; readonly value: T }
   | { readonly ok: false; readonly error: string }

export type Validator<T> = (input: unknown, at: string) => T

export class ValidationError extends Error {}

export function validate<T>(validator: Validator<T>, input: unknown): Result<T> {
   try {
      return { ok: true, value: validator(input, "$") }
   } catch (error) {
      if (error instanceof ValidationError) return { ok: false, error: error.message }
      throw error
   }
}

function fail(at: string, expected: string, input: unknown): never {
   const got = input === null ? "null" : Array.isArray(input) ? "array" : typeof input
   throw new ValidationError(`${at}: expected ${expected}, got ${got}`)
}

export const string: Validator<string> = (input, at) =>
   typeof input === "string" ? input : fail(at, "a string", input)

export const boolean: Validator<boolean> = (input, at) =>
   typeof input === "boolean" ? input : fail(at, "a boolean", input)

export const integer: Validator<number> = (input, at) =>
   Number.isSafeInteger(input) ? (input as number) : fail(at, "an integer", input)

export function literal<const L extends readonly (string | number | boolean)[]>(
   ...values: L
): Validator<L[number]> {
   return (input, at) =>
      values.includes(input as L[number])
         ? (input as L[number])
         : fail(at, values.map((v) => JSON.stringify(v)).join(" | "), input)
}

export function array<T>(item: Validator<T>): Validator<T[]> {
   return (input, at) =>
      Array.isArray(input)
         ? input.map((x, i) => item(x, `${at}[${i}]`))
         : fail(at, "an array", input)
}

export function refine<T>(
   base: Validator<T>,
   check: (value: T) => boolean,
   expected: string,
): Validator<T> {
   return (input, at) => {
      const value = base(input, at)
      return check(value) ? value : fail(at, expected, input)
   }
}

export interface Optional<T> {
   readonly optional: Validator<T>
}

// absent, undefined, and null all mean "not given"; the key is omitted
export function optional<T>(validator: Validator<T>): Optional<T> {
   return { optional: validator }
}

type Field = Validator<unknown> | Optional<unknown>
type Shape = Record<string, Field>
type RequiredKeys<S extends Shape> = {
   [K in keyof S]: S[K] extends Optional<unknown> ? never : K
}[keyof S]
type OptionalKeys<S extends Shape> = Exclude<keyof S, RequiredKeys<S>>
type Out<F> = F extends Optional<infer T> ? T : F extends Validator<infer T> ? T : never
type Simplify<T> = { [K in keyof T]: T[K] } & {}
export type ObjectOf<S extends Shape> = Simplify<
   { [K in RequiredKeys<S>]: Out<S[K]> } & { [K in OptionalKeys<S>]?: Out<S[K]> }
>

export function isRecord(input: unknown): input is Record<string, unknown> {
   return typeof input === "object" && input !== null && !Array.isArray(input)
}

export function object<S extends Shape>(shape: S): Validator<ObjectOf<S>> {
   return (input, at) => {
      if (!isRecord(input)) fail(at, "an object", input)
      const out: Record<string, unknown> = {}
      for (const [key, field] of Object.entries(shape)) {
         const value = input[key]
         if ("optional" in field) {
            if (value !== undefined && value !== null)
               out[key] = field.optional(value, `${at}.${key}`)
         } else {
            out[key] = field(value, `${at}.${key}`)
         }
      }
      return out as ObjectOf<S>
   }
}

export function tagged<K extends string, M extends Record<string, Validator<object>>>(
   tag: K,
   variants: M,
): Validator<{ [T in keyof M]: ReturnType<M[T]> & { [_ in K]: T } }[keyof M]> {
   return (input, at) => {
      if (!isRecord(input)) fail(at, "an object", input)
      const kind = input[tag]
      const variant =
         typeof kind === "string" && Object.hasOwn(variants, kind)
            ? variants[kind]
            : undefined
      if (variant === undefined)
         fail(`${at}.${tag}`, Object.keys(variants).join(" | "), kind)
      return { ...variant(input, at), [tag]: kind } as never
   }
}
