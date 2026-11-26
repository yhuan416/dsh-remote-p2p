/**
 * Dispatch ledger — the in-process bookkeeping for remote work started by this
 * node. It answers three questions the one-shot `remote_subagent` tool cannot:
 *
 *  - did I already start this exact dispatch (idempotency by caller key),
 *  - is it still running, and what did it settle as (receipts),
 *  - and who is holding a slot (per-node and global budgets).
 *
 * The ledger is deliberately pure: no timers, no I/O, no dsh services. Callers
 * inject `now` so the state machine can be tested without a runtime.
 *
 * States: pending -> running -> succeeded | failed | cancelled | unknown.
 * `unknown` is the honest answer when the channel died mid-flight: the remote
 * may or may not have finished, so the caller must inspect rather than retry.
 */

/** @typedef {'pending'|'running'|'succeeded'|'failed'|'cancelled'|'unknown'} DispatchState */

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown'])
const DEFAULT_MAX_TOTAL = 64
const DEFAULT_MAX_PER_NODE = 8
const DEFAULT_RETAIN_TERMINAL = 200

/** @param {string} state */
export function isTerminalState(state) {
  return TERMINAL.has(state)
}

/**
 * Build a ledger.
 * @param {{ now?: () => number, maxTotal?: number, maxPerNode?: number, retainTerminal?: number }} [options]
 */
export function createDispatchLedger(options) {
  const opts = options === undefined || options === null ? {} : options
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const maxTotal = positive(opts.maxTotal, DEFAULT_MAX_TOTAL)
  const maxPerNode = positive(opts.maxPerNode, DEFAULT_MAX_PER_NODE)
  const retainTerminal = positive(opts.retainTerminal, DEFAULT_RETAIN_TERMINAL)

  /** @type {Map<string, any>} */
  const records = new Map()

  function activeCount(nodeId) {
    let total = 0
    let perNode = 0
    for (const record of records.values()) {
      if (isTerminalState(record.state)) continue
      total += 1
      if (record.nodeId === nodeId) perNode += 1
    }
    return { total, perNode }
  }

  function pruneTerminal() {
    const terminal = []
    for (const record of records.values()) {
      if (isTerminalState(record.state)) terminal.push(record)
    }
    if (terminal.length <= retainTerminal) return
    terminal.sort((a, b) => a.updatedAt - b.updatedAt)
    for (const record of terminal.slice(0, terminal.length - retainTerminal)) records.delete(record.id)
  }

  /**
   * Reserve one dispatch. The caller key makes retries safe: the same key and the
   * same fingerprint returns the original record; the same key with different
   * parameters is a conflict, never a silent re-run.
   * @param {{ id: string, nodeId: string, fingerprint: string, sessionId?: string, label?: string }} input
   */
  function begin(input) {
    const existing = records.get(input.id)
    if (existing !== undefined) {
      if (existing.fingerprint !== input.fingerprint) {
        return { ok: false, reason: 'conflict', record: existing }
      }
      return { ok: true, duplicate: true, record: existing }
    }
    const { total, perNode } = activeCount(input.nodeId)
    if (total >= maxTotal) return { ok: false, reason: 'rate-limited', detail: 'total ' + String(maxTotal) }
    if (perNode >= maxPerNode) return { ok: false, reason: 'rate-limited', detail: 'per-node ' + String(maxPerNode) }
    const at = now()
    const record = {
      id: input.id,
      nodeId: input.nodeId,
      fingerprint: input.fingerprint,
      sessionId: input.sessionId,
      label: input.label,
      state: 'pending',
      createdAt: at,
      updatedAt: at,
      settledAt: undefined,
      output: undefined,
      diagnostic: undefined,
      stopReason: undefined,
    }
    records.set(record.id, record)
    return { ok: true, duplicate: false, record }
  }

  function transition(id, state, patch) {
    const record = records.get(id)
    if (record === undefined) return undefined
    if (isTerminalState(record.state)) return record
    const at = now()
    record.state = state
    record.updatedAt = at
    if (patch !== undefined && patch !== null) {
      if (patch.sessionId !== undefined) record.sessionId = patch.sessionId
      if (patch.output !== undefined) record.output = patch.output
      if (patch.diagnostic !== undefined) record.diagnostic = patch.diagnostic
      if (patch.stopReason !== undefined) record.stopReason = patch.stopReason
    }
    if (isTerminalState(state)) {
      record.settledAt = at
      pruneTerminal()
    }
    return record
  }

  return {
    begin,
    /** pending -> running (idempotent while already running). */
    markRunning(id, patch) {
      const record = records.get(id)
      if (record === undefined || isTerminalState(record.state)) return record
      if (record.state === 'running') {
        record.updatedAt = now()
        return record
      }
      return transition(id, 'running', patch)
    },
    /** Terminal settlement; a second settlement is a no-op that returns the first. */
    settle(id, state, patch) {
      if (!isTerminalState(state)) throw new Error('settle requires a terminal state, got ' + String(state))
      return transition(id, state, patch)
    },
    get(id) {
      return records.get(id)
    },
    list() {
      return [...records.values()].sort((a, b) => b.createdAt - a.createdAt)
    },
    /** Compact counters for status endpoints and diagnostics. */
    summary() {
      const byState = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0 }
      for (const record of records.values()) byState[record.state] += 1
      return { total: records.size, byState, active: byState.pending + byState.running }
    },
  }
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}