import HomeFooter from "../feature-plugins/home/footer"
import HomeTips from "../feature-plugins/home/tips"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import SidebarLsp from "../feature-plugins/sidebar/lsp"
import SidebarFiles from "../feature-plugins/sidebar/files"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import PluginManager from "../feature-plugins/system/plugins"
import Notifications from "../feature-plugins/system/notifications"
import WhichKey from "../feature-plugins/system/which-key"
import DiffViewer from "../feature-plugins/system/diff-viewer"
import McpManage from "../feature-plugins/system/mcp-manage"
import type { TuiPlugin, TuiPluginModule } from "@jyycode-ai/plugin/tui"

export type InternalTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

export function internalTuiPlugins(): InternalTuiPlugin[] {
  return [
    HomeFooter,
    HomeTips,
    SidebarContext,
    SidebarMcp,
    SidebarLsp,
    SidebarFiles,
    SidebarFooter,
    Notifications,
    PluginManager,
    WhichKey,
    DiffViewer,
    McpManage,
  ]
}
