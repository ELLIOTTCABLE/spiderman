import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { HOOKS, type HookReply, type HookRequest } from "../../src/core/protocol.ts"
import { STANDING_FOR_A } from "../../src/core/standing.ts"
import { startHookServer } from "../../src/pi/server.ts"

const script = fileURLToPath(new URL("./hook.ts", import.meta.url))

function runHook(args: string[], stdin: unknown, projectDir: string) {
   const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE")),
   )
   return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
         env: { ...env, CLAUDE_PROJECT_DIR: projectDir },
      })
      let stdout = ""
      child.stdout.on("data", (chunk) => {
         stdout += chunk
      })
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, stdout }))
      child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin))
   })
}

const input = (projectDir: string, extra: Record<string, unknown>) => ({
   session_id: "cc",
   transcript_path: join(projectDir, "t.jsonl"),
   cwd: projectDir,
   ...extra,
})

async function withPeer(
   reply: HookReply,
   run: (projectDir: string, seen: HookRequest[]) => Promise<void>,
) {
   const projectDir = mkdtempSync(join(tmpdir(), "spiderman-hook-"))
   const seen: HookRequest[] = []
   const server = await startHookServer(async (request) => {
      seen.push(request)
      return reply
   })
   try {
      mkdirSync(join(projectDir, ".spiderman"))
      writeFileSync(
         join(projectDir, ".spiderman", "peer.json"),
         JSON.stringify({
            version: 1,
            port: server.port,
            token: server.token,
            pid: 1,
            piSessionId: "pi",
         }),
      )
      await run(projectDir, seen)
   } finally {
      await server.close()
      rmSync(projectDir, { recursive: true, force: true })
   }
}

test("a prompt hook forwards its part and prints the context as hook JSON", async () => {
   await withPeer({ additionalContext: "[peer 2/4] …" }, async (dir, seen) => {
      const out = await runHook(
         ["UserPromptSubmit", "2", "4"],
         input(dir, {
            hook_event_name: "UserPromptSubmit",
            prompt: "hi",
            prompt_id: "p1",
         }),
         dir,
      )
      assert.equal(out.code, 0)
      assert.deepEqual(JSON.parse(out.stdout), {
         hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "[peer 2/4] …",
         },
      })
      const { budgetMs, ...forwarded } = seen[0] as HookRequest & { budgetMs?: number }
      assert.ok(
         budgetMs !== undefined && budgetMs > 30_000 && budgetMs <= 37_000,
         String(budgetMs),
      )
      assert.deepEqual(forwarded, {
         kind: "prompt",
         ccSessionId: "cc",
         prompt: "hi",
         promptId: "p1",
         transcriptPath: join(dir, "t.jsonl"),
         cwd: dir,
         part: { index: 2, count: 4 },
      })
   })
})

test("a Stop hook prints only the display message, never context that would continue A", async () => {
   await withPeer(
      { systemMessage: "peer says", additionalContext: "no" },
      async (dir) => {
         const out = await runHook(
            ["Stop", "1", "2"],
            input(dir, {
               hook_event_name: "Stop",
               last_assistant_message: "A",
               stop_hook_active: false,
            }),
            dir,
         )
         assert.deepEqual(JSON.parse(out.stdout), { systemMessage: "peer says" })
      },
   )
})

test("with no peer, one notice from part 1, then silence; always exit 0 with JSON", async () => {
   const dir = mkdtempSync(join(tmpdir(), "spiderman-hook-"))
   try {
      const prompt = input(dir, { hook_event_name: "UserPromptSubmit", prompt: "hi" })
      const first = await runHook(["UserPromptSubmit", "1", "4"], prompt, dir)
      assert.equal(first.code, 0)
      assert.match(JSON.parse(first.stdout).systemMessage, /no peer is running/)
      const second = await runHook(["UserPromptSubmit", "1", "4"], prompt, dir)
      assert.deepEqual(JSON.parse(second.stdout), {})
      const other = await runHook(["UserPromptSubmit", "2", "4"], prompt, dir)
      assert.deepEqual(JSON.parse(other.stdout), {})
   } finally {
      rmSync(dir, { recursive: true, force: true })
   }
})

test("garbage on stdin is ignored, not an error", async () => {
   const dir = mkdtempSync(join(tmpdir(), "spiderman-hook-"))
   try {
      const out = await runHook(["UserPromptSubmit", "1", "4"], "{not json", dir)
      assert.equal(out.code, 0)
      assert.deepEqual(JSON.parse(out.stdout), {})
   } finally {
      rmSync(dir, { recursive: true, force: true })
   }
})

test("SessionStart gives Claude the standing instructions even with no peer running", async () => {
   const dir = mkdtempSync(join(tmpdir(), "spiderman-hook-"))
   try {
      const out = await runHook(
         ["SessionStart", "1", "1"],
         input(dir, { hook_event_name: "SessionStart", source: "startup" }),
         dir,
      )
      const printed = JSON.parse(out.stdout)
      assert.deepEqual(printed.hookSpecificOutput, {
         hookEventName: "SessionStart",
         additionalContext: STANDING_FOR_A,
      })
   } finally {
      rmSync(dir, { recursive: true, force: true })
   }
})

test("hooks.json registers exactly the parts and timeouts the hook script budgets for", () => {
   const config = JSON.parse(
      readFileSync(new URL("./hooks.json", import.meta.url), "utf8"),
   )
   for (const [event, { parts, timeoutS }] of Object.entries(HOOKS)) {
      const hooks = config.hooks[event].flatMap(
         (group: { hooks: unknown[] }) => group.hooks,
      )
      assert.deepEqual(
         hooks.map((h: { args: string[]; timeout: number }) => [
            h.args.slice(1),
            h.timeout,
         ]),
         Array.from({ length: parts }, (_, i) => [
            [event, String(i + 1), String(parts)],
            timeoutS,
         ]),
         event,
      )
   }
})
