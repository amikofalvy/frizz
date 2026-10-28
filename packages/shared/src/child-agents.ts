import { z } from "zod"

export const ChildRequest = z.object({
  version: z.literal(1),
  action: z.enum(["start", "list", "status", "message", "wait", "stop", "resume"]),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  runtime: z.enum(["claude", "codex"]).optional(),
  model: z.string().min(1).optional(), effort: z.string().min(1).optional(),
  permissions: z.enum(["read-only", "workspace-write", "full"]).optional(),
  prompt: z.string().min(1).optional(), label: z.string().optional(),
  cwd: z.string().min(1).optional(), helper: z.string().min(1).optional(),
  request_id: z.string().min(1).optional(), text: z.string().min(1).optional(),
  after: z.number().int().nonnegative().optional(), run_dir: z.string().optional(),
  parent_agent_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  host_argv: z.array(z.string().min(1)).nonempty().optional(),
  config_dir: z.string().nullable().optional(),
  executable: z.string().min(1).optional(),
}).strict()
export type ChildAgentRequest = z.infer<typeof ChildRequest>
