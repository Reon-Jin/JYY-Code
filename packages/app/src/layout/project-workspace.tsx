import type { DesktopBootstrap } from "../platform/types"
import { DataProvider } from "../data/context"
import { WorkspaceLayout } from "./workspace-layout"

export default function ProjectWorkspace(props: {
  bootstrap: DesktopBootstrap
  directory: string
  activeSessionID?: string
}) {
  return (
    <DataProvider
      bootstrap={props.bootstrap}
      generation={0}
      directory={props.directory}
      activeSessionID={() => props.activeSessionID}
    >
      <WorkspaceLayout activeSessionID={props.activeSessionID} />
    </DataProvider>
  )
}
