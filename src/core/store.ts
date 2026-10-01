import { createHash } from "node:crypto"

/** The subset of `node:fs` the store touches; `node:fs` itself satisfies it. */
export interface StoreFs {
   mkdirSync(path: string, options: { recursive: true }): unknown
   writeFileSync(path: string, data: string, options: { flag: "wx" }): void
}

export type Hash = (text: string) => string

export function sha256Hex(text: string): string {
   return createHash("sha256").update(text, "utf8").digest("hex")
}

export interface PeerStore {
   /** Stores `text` and returns its path, `<root>/peer/<hash>.txt`. */
   put(text: string): string
}

export function peerStore(root: string, fs: StoreFs, hash: Hash): PeerStore {
   const dir = `${root}/peer`
   return {
      put(text) {
         const path = `${dir}/${hash(text)}.txt`
         fs.mkdirSync(dir, { recursive: true })
         writeOnce(fs, path, text)
         return path
      },
   }
}

/** Creates the runtime state directory, which ignores itself so target projects stay clean. */
export function ensureStateDir(root: string, fs: StoreFs): void {
   fs.mkdirSync(root, { recursive: true })
   writeOnce(fs, `${root}/.gitignore`, "*\n")
}

// Exclusive create: whoever already wrote this content-addressed path wrote the same bytes.
function writeOnce(fs: StoreFs, path: string, data: string): void {
   try {
      fs.writeFileSync(path, data, { flag: "wx" })
   } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error
   }
}
