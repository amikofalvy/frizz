import type { QueryClient } from "@tanstack/react-query"
import type { TranscriptPage } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import type { TranscriptData } from "../hooks.ts"
import { showToast } from "../store.ts"
import { prependEarlierPage } from "./transcriptPagination.ts"

/** THE PAGE BEFORE A THREAD'S LOADED WINDOW, fetched and prepended to its transcript cache — for every
 *  surface that pages back through a transcript (the queue card's "Load earlier messages" and the thread
 *  view's earlier-history row). Each wrote this out for itself until 2026-10-14.
 *
 *  A session REPLACED while the page was in flight (a restart swaps the transcript out from under it) has
 *  a different `transcriptKey`, and its page cannot be spliced onto the old window: the transcript is
 *  refetched whole instead, the human is told, and the answer is null. `beforePrepend` runs with the page
 *  just before the cache takes it — where a surface captures the viewport it has to hold still. A failed
 *  request throws, and the surface says so in its own place. */
export async function fetchEarlierPage({ slug, cursor, expectedKey, queryClient, refetch, beforePrepend }: {
  slug: string
  cursor: string
  expectedKey: string
  queryClient: QueryClient
  refetch: () => Promise<unknown>
  beforePrepend?: (page: TranscriptPage) => void
}): Promise<TranscriptPage | null> {
  const earlier = await rpc.threadTranscriptEarlier({ slug, cursor })
  const current = queryClient.getQueryData<TranscriptData>(["transcript", slug])
  if (!current?.transcriptKey || current.transcriptKey !== expectedKey || earlier.transcriptKey !== expectedKey) {
    await refetch()
    showToast("Transcript changed while loading history; refreshed the current session")
    return null
  }
  beforePrepend?.(earlier)
  queryClient.setQueryData(["transcript", slug], prependEarlierPage(current as Parameters<typeof prependEarlierPage>[0], earlier))
  return earlier
}
