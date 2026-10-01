import assert from "node:assert/strict"
import { test } from "node:test"
import { ensureStateDir, peerStore, type StoreFs, sha256Hex } from "./store.ts"

function memoryFs() {
   const files = new Map<string, string>()
   const dirs = new Set<string>()
   let writes = 0
   const fs: StoreFs = {
      mkdirSync(path) {
         dirs.add(path)
      },
      writeFileSync(path, data, options) {
         writes++
         if (options.flag === "wx" && files.has(path)) {
            throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" })
         }
         files.set(path, data)
      },
   }
   return { fs, files, dirs, writeCount: () => writes }
}

const fakeHash = (text: string) => `h${text.length}`

test("stores text under <root>/peer/<hash>.txt and returns that path", () => {
   const mem = memoryFs()
   const store = peerStore(".spiderman", mem.fs, fakeHash)
   const path = store.put("hello")
   assert.equal(path, ".spiderman/peer/h5.txt")
   assert.equal(mem.files.get(".spiderman/peer/h5.txt"), "hello")
   assert.ok(mem.dirs.has(".spiderman/peer"))
})

test("storing the same text twice is idempotent", () => {
   const mem = memoryFs()
   const store = peerStore("root", mem.fs, fakeHash)
   const first = store.put("same")
   const second = store.put("same")
   assert.equal(first, second)
   assert.equal(mem.files.size, 1)
})

test("a file already written by another process counts as stored", () => {
   const mem = memoryFs()
   mem.files.set("root/peer/h4.txt", "same")
   const store = peerStore("root", mem.fs, fakeHash)
   assert.equal(store.put("same"), "root/peer/h4.txt")
   assert.equal(mem.files.get("root/peer/h4.txt"), "same")
})

test("other write failures propagate", () => {
   const fs: StoreFs = {
      mkdirSync() {},
      writeFileSync() {
         throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      },
   }
   const store = peerStore("root", fs, fakeHash)
   assert.throws(() => store.put("x"), /EACCES/)
})

test("sha256Hex is lowercase hex of the UTF-8 bytes", () => {
   assert.equal(
      sha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
   )
   assert.notEqual(sha256Hex("é"), sha256Hex("é"))
})

test("ensureStateDir writes a self-ignoring .gitignore once", () => {
   const mem = memoryFs()
   ensureStateDir("proj/.spiderman", mem.fs)
   ensureStateDir("proj/.spiderman", mem.fs)
   assert.equal(mem.files.get("proj/.spiderman/.gitignore"), "*\n")
   assert.ok(mem.dirs.has("proj/.spiderman"))
})
