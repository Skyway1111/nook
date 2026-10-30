// What the mod keeps in $.state for the session.
export type Undone = string[]
/** The main agent's last finished turn that edited files: its edits, by tool_use_id. */
export type Turn = { ids: string[] }

declare module 'claude-code' {
  interface PluginState {
    nook: {
      /** The edits undone with their row's Undo, by tool_use_id. */
      undone: Undone
      /** The last turn that edited files, until the next prompt or its band is closed. */
      lastTurn: Turn | null
    }
  }
}
