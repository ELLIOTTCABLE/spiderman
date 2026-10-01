import { createHash } from "node:crypto"

// `node:fs` satisfies this
export interface StoreFs {
   mkdirSync(path: string, options: { recursive: true }): unknown
   writeFileSync(path: string, data: string, options: { flag: "wx" }): void
}

export interface PeerStoreFs extends StoreFs {
   /** undefined when unreadable */
   readText(path: string): string | undefined
}

export type Hash = (text: string) => string

export function sha256Hex(text: string): string {
   return createHash("sha256").update(text, "utf8").digest("hex")
}

export interface PeerStore {
   put(text: string): string
}

// pointers are replayed in context; 64 bits suffices per session, and a taken name grows
const SHORT_HASH = 16

export function peerStore(root: string, fs: PeerStoreFs, hash: Hash): PeerStore {
   const dir = `${root}/peer`
   return {
      put(text) {
         const digest = hash(text)
         fs.mkdirSync(dir, { recursive: true })
         for (let length = SHORT_HASH; ; length *= 2) {
            const path = `${dir}/${digest.slice(0, length)}.txt`
            if (writeOnce(fs, path, text) || fs.readText(path) === text) return path
            if (length >= digest.length)
               throw new Error(`store: ${path} holds other content`)
         }
      },
   }
}

// self-ignoring, so target projects stay clean
export function ensureStateDir(root: string, fs: StoreFs): void {
   fs.mkdirSync(root, { recursive: true })
   writeOnce(fs, `${root}/.gitignore`, "*\n")
}

/** false when the file already exists */
function writeOnce(fs: StoreFs, path: string, data: string): boolean {
   try {
      fs.writeFileSync(path, data, { flag: "wx" })
      return true
   } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error
      return false
   }
}
