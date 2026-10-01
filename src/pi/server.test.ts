import assert from "node:assert/strict"
import { request } from "node:http"
import { test } from "node:test"
import { HOOK_PATH } from "../core/protocol.ts"
import { startHookServer } from "./server.ts"

function post(port: number, body: string, headers: Record<string, string>) {
   return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
         { host: "127.0.0.1", port, path: HOOK_PATH, method: "POST", headers },
         (res) => {
            let text = ""
            res.on("data", (chunk) => {
               text += chunk
            })
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }))
         },
      )
      req.on("error", reject)
      req.end(body)
   })
}

const valid = JSON.stringify({
   kind: "session-start",
   ccSessionId: "s",
   source: "startup",
   transcriptPath: "t",
   cwd: "c",
})

test("the hook server answers only valid, authenticated loopback requests", async () => {
   const server = await startHookServer(
      async (req) => ({ systemMessage: `ok ${req.kind}` }),
      "tok",
   )
   const { port } = server
   const auth = { authorization: "Bearer tok", host: `127.0.0.1:${port}` }
   try {
      assert.deepEqual(await post(port, valid, auth), {
         status: 200,
         body: '{"systemMessage":"ok session-start"}',
      })
      assert.equal(
         (await post(port, valid, { ...auth, authorization: "Bearer nope" })).status,
         401,
      )
      assert.equal(
         (await post(port, valid, { ...auth, host: `evil.example:${port}` })).status,
         403,
      )
      assert.equal((await post(port, "{not json", auth)).status, 400)
      assert.equal(
         (await post(port, JSON.stringify({ kind: "prompt" }), auth)).status,
         400,
      )
      assert.equal(
         (
            await post(port, "x".repeat(5 * 1024 * 1024), auth).catch(() => ({
               status: 413,
            }))
         ).status,
         413,
      )
   } finally {
      await server.close()
   }
})
