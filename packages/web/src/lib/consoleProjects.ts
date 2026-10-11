import { useEffect, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ProjectCard } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { setConsoleProjects } from "../api/consoleFeed.ts"

// WHICH PROJECTS THE CONSOLE SHOWS — every project the server has OPEN, in the rail's order.
//
// "Open" is the rail's own reading (`projectsRailCounts` answers for exactly the projects with a board
// on the server, keyed by id), so the Console never opens a project's connection out of the server's
// paced start-up (server/tenant-prime.ts): a project it has not opened yet joins on the next poll. A
// project whose directory is gone has no board worth showing and is left out. Both reads are machine-wide
// (lib/queryKeyScope.ts), so the rail and the Console share one copy of each.

export interface ConsoleProjects {
  /** Open projects in rail order. */
  projects: ProjectCard[]
  bySlug: ReadonlyMap<string, ProjectCard>
  /** False until both reads have answered once. */
  ready: boolean
}

/** `enabled` false reads nothing — for a component that renders on a project's page too. */
export function useConsoleProjectList(enabled = true): ConsoleProjects {
  const list = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList(), enabled })
  const counts = useQuery({ queryKey: ["projectsRailCounts"], queryFn: () => rpc.projectsRailCounts(), refetchInterval: 5_000, enabled })
  const openIds = counts.data ? Object.keys(counts.data).sort().join("\n") : null
  return useMemo(() => {
    const open = new Set(openIds ? openIds.split("\n") : [])
    const projects = (list.data ?? []).filter((project) => !project.stale && open.has(project.id))
    return { projects, bySlug: new Map(projects.map((project) => [project.slug, project])), ready: list.data !== undefined && openIds !== null }
    // `openIds` is the set as a string, so a poll that answers the same projects keeps the same list.
  }, [list.data, openIds])
}

/** The Console's list, and the one place that points its feed at it. Mounted once, by the Console's route. */
export function useConsoleFeedProjects(): ConsoleProjects {
  const projects = useConsoleProjectList()
  const slugs = projects.projects.map((project) => project.slug).join("\n")
  useEffect(() => {
    if (projects.ready) setConsoleProjects(slugs ? slugs.split("\n") : [])
  }, [projects.ready, slugs])
  return projects
}
