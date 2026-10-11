import { createContext, useContext, type ReactNode } from "react"
import { rpcFor, type Api } from "../api/rpc.ts"

// WHICH PROJECT A SURFACE BELONGS TO, when the page does not say.
//
// A project's page names its project in the URL, and every call it makes goes there (lib/base-path.ts
// apiBase). The Console names none: each card, drawer and prompt box on it belongs to ONE project, and
// a project procedure it calls — the models a prompt box offers, a file a card links, a dispatch — has to
// be addressed to that project (api/rpc.ts refuses it otherwise). So the Console wraps each such surface
// in <ProjectScope>, and the surface asks `useRpc()` for its API instead of importing `rpc`. On a
// project's page there is no scope and `useRpc()` is plain `rpc`, so a component written this way works
// on both without knowing which it is on.
//
// A project-scoped READ is cached per project too: its key carries the project (`scopedKey`), since the
// Console's cache is one scope shared by every project it shows (lib/queryKeyScope.ts).

const ProjectScopeContext = createContext<string | undefined>(undefined)

export function ProjectScope({ project, children }: { project: string | undefined; children: ReactNode }) {
  return <ProjectScopeContext.Provider value={project}>{children}</ProjectScopeContext.Provider>
}

/** The project this surface belongs to on the Console, or undefined on a project's own page. */
export function useProjectScope(): string | undefined {
  return useContext(ProjectScopeContext)
}

/** The API this surface's project answers on. */
export function useRpc(): Api {
  return rpcFor(useProjectScope())
}

/** A query key that names its project when there is one to name. */
export function scopedKey<K extends readonly unknown[]>(key: K, project: string | undefined): readonly unknown[] {
  return project ? [...key, { project }] : key
}
