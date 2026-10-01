import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
   bearerMatches,
   HOOK_PATH,
   type HookReply,
   type HookRequest,
   hookRequest,
} from "../core/protocol.ts"
import { validate } from "../core/validate.ts"

export interface HookServer {
   readonly port: number
   readonly token: string
   close(): Promise<void>
}

const BODY_LIMIT = 4 * 1024 * 1024

/** Loopback only, bearer-authenticated, Host-checked (DNS rebinding), size-limited, validated. */
export function startHookServer(
   handle: (request: HookRequest) => Promise<HookReply>,
   token: string = randomBytes(24).toString("hex"),
): Promise<HookServer> {
   const server = createServer((req, res) => {
      serve(req, res, port(), token, handle).catch(() =>
         reply(res, 500, { error: "internal" }),
      )
   })
   const port = () => (server.address() as AddressInfo).port
   return new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
         server.unref()
         resolve({
            port: port(),
            token,
            close: () =>
               new Promise((done) => {
                  server.closeAllConnections()
                  server.close(() => done())
               }),
         })
      })
   })
}

async function serve(
   req: IncomingMessage,
   res: ServerResponse,
   port: number,
   token: string,
   handle: (request: HookRequest) => Promise<HookReply>,
) {
   if (req.method !== "POST" || req.url !== HOOK_PATH)
      return reply(res, 404, { error: "not found" })
   const host = req.headers.host
   if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reply(res, 403, { error: "bad host" })
   }
   if (!bearerMatches(req.headers.authorization, token))
      return reply(res, 401, { error: "unauthorized" })

   const body = await readBody(req)
   if (body === undefined) return reply(res, 413, { error: "too large" })
   let json: unknown
   try {
      json = JSON.parse(body)
   } catch {
      return reply(res, 400, { error: "not JSON" })
   }
   const request = validate(hookRequest, json)
   if (!request.ok) return reply(res, 400, { error: request.error })
   return reply(res, 200, await handle(request.value))
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
   return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on("data", (chunk: Buffer) => {
         size += chunk.length
         if (size > BODY_LIMIT) {
            resolve(undefined)
            req.destroy()
         } else chunks.push(chunk)
      })
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      req.on("error", reject)
   })
}

function reply(res: ServerResponse, status: number, body: unknown) {
   if (res.headersSent) return
   res.writeHead(status, { "content-type": "application/json" })
   res.end(JSON.stringify(body))
}
