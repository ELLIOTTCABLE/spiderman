import assert from "node:assert/strict"
import { test } from "node:test"
import { ensureStateDir, type PeerStoreFs, peerStore, sha256Hex } from "./store.ts"

function memoryFs() {
   const files = new Map<string, string>()
   const dirs = new Set<string>()
   let writes = 0
   const fs: PeerStoreFs = {
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
      readText: (path) => files.get(path),
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
   const fs: PeerStoreFs = {
      mkdirSync() {},
      writeFileSync() {
         throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      },
      readText: () => undefined,
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

test("a stored file is named by the first 16 hex chars of its hash", () => {
   const mem = memoryFs()
   const path = peerStore("root", mem.fs, sha256Hex).put("abc")
   assert.equal(path, "root/peer/ba7816bf8f01cfea.txt")
})

test("a short name already holding other content grows until it is free", () => {
   const mem = memoryFs()
   const sharedPrefix = (text: string) => `${"c".repeat(16)}${text.repeat(48)}`
   const store = peerStore("root", mem.fs, sharedPrefix)
   const first = store.put("1")
   const second = store.put("2")
   assert.equal(first, `root/peer/${"c".repeat(16)}.txt`)
   assert.equal(second, `root/peer/${"c".repeat(16)}${"2".repeat(16)}.txt`)
   assert.equal(mem.files.get(second), "2")
   assert.equal(store.put("2"), second)
})

test("other content under the full hash is an error, never an overwrite", () => {
   const mem = memoryFs()
   const store = peerStore("root", mem.fs, () => "d".repeat(64))
   const names = ["first", "second", "third"].map((text) => store.put(text))
   assert.deepEqual(
      names.map((name) => name.length - "root/peer/.txt".length),
      [16, 32, 64],
   )
   assert.throws(() => store.put("fourth"), /holds other content/)
   assert.equal(mem.files.get(`root/peer/${"d".repeat(64)}.txt`), "third")
})
