// Codex reports items, not steps. The harness stream has `finish-step`
// boundaries, so they are inferred here: a step opens on the first model or
// tool item and closes once every tool item opened inside it has completed.
//
// The inference is marked as such on the wire — `harnessMetadata.codex.
// inferredStep` — because it is this host's reading of the item stream rather
// than something Codex said.

import type { BridgeEvent } from '@amond-ai/harness-bridge-runtime'

type Emit = (msg: BridgeEvent) => void

export interface CodexStepTrackerItem {
  type: string
}

export interface CodexStepTrackerEvent {
  type: string
  item?: CodexStepTrackerItem
}

export interface CodexStepTracker {
  observeEvent: (input: {
    event: CodexStepTrackerEvent
    itemId: string | undefined
  }) => void
  finishTurn: () => void
}

export function createCodexStepTracker(input: {
  send: Emit
}): CodexStepTracker {
  let stepOpen = false
  const pendingToolItemIds = new Set<string>()
  /*
   * Tool items Codex sent with no id of their own. There is nothing to match a
   * start to its completion by, so they are paired by count instead — one
   * completion closes one of them. Identity is what the set above needs and
   * what these do not have; leaving them out of it entirely would close the
   * step while such a tool was still running.
   */
  let pendingAnonymousTools = 0

  const finishStep = (): void => {
    if (!stepOpen || pendingToolItemIds.size > 0 || pendingAnonymousTools > 0) {
      return
    }
    input.send({
      type: 'finish-step',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: defaultUsage(),
      harnessMetadata: { codex: { inferredStep: true } },
    })
    stepOpen = false
  }

  return {
    observeEvent({ event, itemId }) {
      const item = event.item
      if (!item || !isStepItem(item)) {
        return
      }

      stepOpen = true

      if (isToolStepItem(item)) {
        if (event.type === 'item.started') {
          if (itemId) {
            pendingToolItemIds.add(itemId)
          }
          else {
            pendingAnonymousTools += 1
          }
        }
        else if (event.type === 'item.completed') {
          if (itemId) {
            pendingToolItemIds.delete(itemId)
          }
          else if (pendingAnonymousTools > 0) {
            pendingAnonymousTools -= 1
          }
          finishStep()
        }
      }
    },
    finishTurn() {
      pendingToolItemIds.clear()
      pendingAnonymousTools = 0
      finishStep()
    },
  }
}

function isStepItem(item: CodexStepTrackerItem): boolean {
  return isModelStepItem(item) || isToolStepItem(item)
}

function isModelStepItem(item: CodexStepTrackerItem): boolean {
  return item.type === 'reasoning' || item.type === 'agent_message'
}

function isToolStepItem(item: CodexStepTrackerItem): boolean {
  return (
    item.type === 'command_execution'
    || item.type === 'mcp_tool_call'
    || item.type === 'web_search'
    || item.type === 'file_change'
    || item.type === 'todo_list'
  )
}

export function defaultUsage(): Record<string, unknown> {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0 },
  }
}
