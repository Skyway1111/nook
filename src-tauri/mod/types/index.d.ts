// What the mod keeps in $.state for the session.
export type Undone = string[]

declare module 'claude-code' {
  interface PluginState {
    nook: {
      /** The edits undone with their row's Undo, by tool_use_id. */
      undone: Undone
    }
  }
}
