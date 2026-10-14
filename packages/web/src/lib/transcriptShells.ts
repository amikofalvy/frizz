import type { BgShellView, TranscriptToolCall } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"
import type { TranscriptShellRecord } from "./childOps.ts"

function isLiveTranscriptBackgroundTool(tool: TranscriptToolCall): boolean {
  return tool.status === "pending" && tool.backgroundState === "background"
}

// Codex's deliberate `yield_control()` shell lifecycle is transcript-native, while the older board
// telemetry still reports bgShells:[]. Present those calls through the EXISTING anchored ops strip and
// remove only their live copy from the conversation. Once a shell resolves, its completed historical
// card returns at its canonical transcript position.
export function transcriptBackgroundShells(messages: readonly ChatMessage[]): (BgShellView & TranscriptShellRecord)[] {
  const shells: (BgShellView & TranscriptShellRecord)[] = []
  for (const message of messages) {
    for (const tool of message.tools) {
      if (!isLiveTranscriptBackgroundTool(tool)) continue
      if (!message.at) continue
      shells.push({
        label: tool.desc ?? tool.detail ?? tool.command ?? "Background command",
        // The projected MESSAGE's instant, which is the only one this side has — and is NOT the launch
        // record's, so it can never be reconciled against the board's row. `launchId` is what does that.
        startedAt: message.at,
        state: "running",
        ...(tool.shellId ? { launchId: tool.shellId } : {}),
        // The reconciliation key for a CODEX shell, whose board row and transcript row share nothing
        // else (see mergeBackgroundShells). Carried separately from `label`, which for a codex row is
        // the model's description of the step rather than the command it ran.
        ...(tool.command ? { command: tool.command } : {}),
      })
    }
  }
  return shells
}

export function withoutLiveTranscriptBackgroundTools(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.tools.some(isLiveTranscriptBackgroundTool)) return message
    const tools = message.tools.filter((tool) => !isLiveTranscriptBackgroundTool(tool))
    const parts = message.parts?.map((part) =>
      part.kind === "tools"
        ? { ...part, tools: part.tools.filter((tool) => !isLiveTranscriptBackgroundTool(tool)) }
        : part,
    ).filter((part) => part.kind !== "tools" || part.tools.length > 0)
    return { ...message, tools, parts }
  })
}
