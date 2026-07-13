import { createContext, useContext, type ParentProps } from "solid-js"
import type { ProjectController } from "./project-controller"

const ProjectContext = createContext<ProjectController>()

export function ProjectProvider(props: ParentProps<{ controller: ProjectController }>) {
  return <ProjectContext.Provider value={props.controller}>{props.children}</ProjectContext.Provider>
}

export function useProjects() {
  const controller = useContext(ProjectContext)
  if (!controller) throw new Error("ProjectProvider is missing")
  return controller
}
