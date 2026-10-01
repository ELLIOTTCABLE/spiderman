import { PEER_FILE, type PeerFile, peerFile } from "../core/protocol.ts"
import { ensureStateDir, type StoreFs } from "../core/store.ts"
import { validate } from "../core/validate.ts"

export interface PeerFileFs extends StoreFs {
   writeFileSync(path: string, data: string, options?: { flag: "wx" }): void
   renameSync(from: string, to: string): void
   readFileSync(path: string, encoding: "utf8"): string
   rmSync(path: string, options: { force: true }): void
}

// write-then-rename: a hook never reads a half-written file
export function writePeerFile(stateDir: string, info: PeerFile, fs: PeerFileFs): void {
   ensureStateDir(stateDir, fs)
   const path = `${stateDir}/${PEER_FILE}`
   const temp = `${path}.${info.pid}.tmp`
   fs.writeFileSync(temp, JSON.stringify(info))
   fs.renameSync(temp, path)
}

/** Another pi session may have taken over the file since; only ours is removed. */
export function removePeerFile(stateDir: string, token: string, fs: PeerFileFs): void {
   const path = `${stateDir}/${PEER_FILE}`
   try {
      const current = validate(peerFile, JSON.parse(fs.readFileSync(path, "utf8")))
      if (current.ok && current.value.token === token) fs.rmSync(path, { force: true })
   } catch {}
}
