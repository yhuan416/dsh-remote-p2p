/**
 * Async dispatch tool definitions — start / observe / steer / stop remote work.
 *
 * Why these exist: `remote_subagent` blocks inside one tool call, so the caller
 * cannot do anything else while the remote works, cannot redirect it, and gets
 * no receipt when the channel dies. A dispatch returns an id immediately; the
 * remote session keeps running and can be observed or steered later.
 *
 * The definitions are plain data + functions with injected dependencies, so the
 * whole surface can be exercised without a dsh runtime or a live peer.
 *
 * @typedef {object} DispatchDeps
 * @property {object} ledger - createDispatchLedger() instance.
 * @property {Map<string, any>} handles - live run handles by dispatch id.
 * @property {() => any[]} listHosts - configured remotes, in config order.
 * @property {(id: string) => any} getHost - remote by id.
 * @property {(host: any, spec: string|undefined) => Promise<string|undefined>} resolveWorkspace
 * @property {(host: any, options: object) => Promise<{ id: string, result: Promise<any> }>} start
 * @property {(host: any, method: string, params: object, timeoutMs?: number) => Promise<any>} rpc
 * @property {() => string} newId
 */

import { isTerminalState } from './dispatch.js'

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const MAX_OUTPUT_CHARS = 8000

/** @param {unknown} error */
function errorText(error) {
  return error !== null && typeof error === 'object' && error.message !== undefined ? String(error.message) : String(error)
}

/** @param {any} result */
function resultText(result) {
  if (result === null || typeof result !== 'object' || !Array.isArray(result.output)) return ''
  return result.output
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** @param {any} record */
export function renderDispatch(record) {
  if (record === undefined) return 'unknown dispatch'
  const lines = [
    'dispatch ' + record.id,
    '  node: ' + record.nodeId + (record.sessionId === undefined ? '' : '  session: ' + record.sessionId),
    '  state: ' + record.state + (record.stopReason === undefined ? '' : ' (stop=' + record.stopReason + ')'),
  ]
  if (record.state === 'unknown') lines.push('  note: outcome cannot be confirmed — inspect the remote session before retrying')
  if (record.diagnostic !== undefined) lines.push('  diagnostic: ' + String(record.diagnostic).slice(0, 2000))
  if (record.output !== undefined && record.output !== '') {
    const text = record.output.length > MAX_OUTPUT_CHARS ? record.output.slice(0, MAX_OUTPUT_CHARS) + '\n…(truncated)' : record.output
    lines.push('', text)
  }
  return lines.join('\n')
}

/**
 * Build the four tool definitions.
 * @param {DispatchDeps} deps
 */
export function createDispatchTools(deps) {
  const { ledger, handles } = deps

  function settleFromResult(id, result) {
    const stopReason = result !== null && typeof result === 'object' && result.stopReason !== undefined ? String(result.stopReason) : 'error'
    const state = stopReason === 'completed' ? 'succeeded' : stopReason === 'aborted' ? 'cancelled' : 'failed'
    ledger.settle(id, state, {
      output: resultText(result),
      diagnostic: result !== null && typeof result === 'object' ? result.diagnostic : undefined,
      stopReason,
    })
  }

  function target(args) {
    const wanted = args !== null && typeof args === 'object' && typeof args.host === 'string' ? args.host : ''
    return wanted === '' ? deps.listHosts()[0] : deps.getHost(wanted)
  }

  return [
    {
      name: 'remote_dispatch',
      description: 'Start a task on a remote dsh backend WITHOUT waiting for it. Returns a dispatch id immediately; the remote session keeps working in the background. Use remote_wait to observe it, remote_steer to send a follow-up, remote_interrupt to stop it. Prefer this over remote_subagent when the work is long, when you want to do something else meanwhile, or when you may need to redirect the remote agent. The remote agent has its own dsh tools, model and filesystem and cannot see this conversation.',
      parameters: {
        host: { type: 'string', description: 'Remote host id registered in dsh-remote-p2p (for example n100). Omit to use the first registered host.' },
        task: { type: 'string', description: 'Complete instructions for the remote agent; make it self-contained.' },
        cwd: { type: 'string', description: 'Absolute directory on the remote machine for a new session. Exclusive with workspace.' },
        workspace: { type: 'string', description: 'Remote workspace a new session joins (id or absolute path). Exclusive with cwd.' },
        session: { type: 'string', description: 'Existing remote dsh session id to continue instead of creating a new one.' },
        key: { type: 'string', description: 'Idempotency key (16-128 letters, digits, "_" or "-"). Repeating the same key returns the same dispatch instead of starting a second remote session. Omit to generate one.' },
        timeoutMs: { type: 'number', description: 'Hard cap for the remote run in milliseconds (default 3600000, max 3600000).' },
      },
      execute(args) {
        const host = target(args)
        if (host === undefined) return Promise.resolve('remote_dispatch: unknown remote host; registered: ' + deps.listHosts().map(item => item.id).join(', '))
        const task = args !== null && typeof args === 'object' && typeof args.task === 'string' ? args.task : ''
        if (task === '') return Promise.resolve('remote_dispatch: task is required')
        const cwd = args !== null && typeof args === 'object' && typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined
        const workspaceSpec = args !== null && typeof args === 'object' && typeof args.workspace === 'string' && args.workspace !== '' ? args.workspace : undefined
        if (workspaceSpec !== undefined && cwd !== undefined) return Promise.resolve('remote_dispatch: pass either workspace or cwd, not both')
        const sessionId = args !== null && typeof args === 'object' && typeof args.session === 'string' && args.session !== '' ? args.session : undefined
        const rawKey = args !== null && typeof args === 'object' && typeof args.key === 'string' ? args.key : ''
        const key = KEY_PATTERN.test(rawKey) ? rawKey : 'dispatch-' + deps.newId()
        const rawTimeout = args !== null && typeof args === 'object' && typeof args.timeoutMs === 'number' ? args.timeoutMs : 3600000
        const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(Math.floor(rawTimeout), 3600000) : 3600000
        const fingerprint = [host.id, task, cwd === undefined ? '' : cwd, workspaceSpec === undefined ? '' : workspaceSpec, sessionId === undefined ? '' : sessionId].join('\u0000')
        const begun = ledger.begin({ id: key, nodeId: host.id, fingerprint, sessionId })
        if (begun.ok !== true) return Promise.resolve('remote_dispatch: ' + String(begun.reason) + (begun.detail === undefined ? '' : ' (' + String(begun.detail) + ')') + ' — existing ' + renderDispatch(begun.record))
        if (begun.duplicate === true) return Promise.resolve('remote_dispatch: already started\n' + renderDispatch(begun.record))
        const resolve = sessionId === undefined ? deps.resolveWorkspace(host, workspaceSpec) : Promise.resolve(undefined)
        resolve.then(workspaceId => deps.start(host, { task, cwd, workspaceId, sessionId, timeoutMs })).then(handle => {
          handles.set(key, handle)
          ledger.markRunning(key, { sessionId: handle.id })
          handle.result.then(result => {
            settleFromResult(key, result)
            handles.delete(key)
          }, error => {
            // The run started but its outcome never arrived: the remote may have
            // finished. `unknown` is the only honest state; retrying the same key
            // is refused and the caller is told to inspect the session.
            ledger.settle(key, 'unknown', { diagnostic: errorText(error) })
            handles.delete(key)
          })
        }, error => {
          ledger.settle(key, 'failed', { diagnostic: errorText(error) })
        })
        return Promise.resolve('remote_dispatch started: ' + key + ' → ' + host.id + '\nobserve with remote_wait dispatchId="' + key + '"; act with remote_steer / remote_interrupt')
      },
    },
    {
      name: 'remote_wait',
      description: 'Observe one remote_dispatch receipt: current state (pending / running / succeeded / failed / cancelled / unknown), the remote session id, and, once settled, the final answer. With timeoutMs > 0 it waits up to that long for settlement. A timeout is not a failure — the remote keeps working; call again. "unknown" means the outcome could not be confirmed: inspect the remote session rather than retrying the same work.',
      parameters: {
        dispatchId: { type: 'string', description: 'The id returned by remote_dispatch.' },
        timeoutMs: { type: 'number', description: 'Wait budget in milliseconds (default 20000, max 60000; 0 returns the receipt immediately).' },
      },
      execute(args) {
        const id = args !== null && typeof args === 'object' && typeof args.dispatchId === 'string' ? args.dispatchId : ''
        if (id === '') return Promise.resolve('remote_wait: dispatchId is required')
        const record = ledger.get(id)
        if (record === undefined) return Promise.resolve('remote_wait: unknown dispatchId "' + id + '"')
        const rawTimeout = args !== null && typeof args === 'object' && typeof args.timeoutMs === 'number' ? args.timeoutMs : 20000
        const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(Math.floor(rawTimeout), 60000) : 0
        if (isTerminalState(record.state) || timeoutMs === 0) return Promise.resolve(renderDispatch(record))
        const handle = handles.get(id)
        if (handle === undefined) return Promise.resolve(renderDispatch(ledger.get(id)))
        return Promise.race([
          handle.result.then(() => 'settled', () => 'settled'),
          new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMs)),
        ]).then(() => renderDispatch(ledger.get(id)))
      },
    },
    {
      name: 'remote_steer',
      description: 'Send a follow-up message to the remote session behind a dispatch. While the remote agent is running this queues the message for its next turn; after it settled it continues the same remote session (its memory is intact). This does not change the dispatch receipt.',
      parameters: {
        dispatchId: { type: 'string', description: 'The id returned by remote_dispatch.' },
        message: { type: 'string', description: 'What to tell the remote agent.' },
      },
      execute(args) {
        const id = args !== null && typeof args === 'object' && typeof args.dispatchId === 'string' ? args.dispatchId : ''
        const message = args !== null && typeof args === 'object' && typeof args.message === 'string' ? args.message : ''
        if (id === '' || message === '') return Promise.resolve('remote_steer: dispatchId and message are required')
        const record = ledger.get(id)
        if (record === undefined) return Promise.resolve('remote_steer: unknown dispatchId "' + id + '"')
        const host = deps.getHost(record.nodeId)
        if (host === undefined) return Promise.resolve('remote_steer: remote "' + record.nodeId + '" is no longer configured')
        if (record.sessionId === undefined) return Promise.resolve('remote_steer: the remote session is still being created; call remote_wait first')
        return deps.rpc(host, 'session/prompt', {
          request: {
            requestId: 'hub-steer-' + deps.newId(),
            sessionId: record.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: message }],
            clientTimeZone: 'Asia/Shanghai',
          },
        }, 30000).then(result => {
          if (result === undefined || result.ok !== true) return 'remote_steer: remote rejected the message'
          const accepted = !(result.value !== undefined && result.value.accepted === false)
          return 'remote_steer: ' + (accepted ? 'queued' : 'rejected') + ' on ' + record.nodeId + ' session ' + record.sessionId
        }, error => 'remote_steer failed: ' + errorText(error))
      },
    },
    {
      name: 'remote_interrupt',
      description: 'Ask the remote agent behind a dispatch to stop its current execution. It does not undo edits or delete queued messages, and the dispatch settles as cancelled once the remote acknowledges. Use remote_wait afterwards to confirm.',
      parameters: {
        dispatchId: { type: 'string', description: 'The id returned by remote_dispatch.' },
      },
      execute(args) {
        const id = args !== null && typeof args === 'object' && typeof args.dispatchId === 'string' ? args.dispatchId : ''
        if (id === '') return Promise.resolve('remote_interrupt: dispatchId is required')
        const record = ledger.get(id)
        if (record === undefined) return Promise.resolve('remote_interrupt: unknown dispatchId "' + id + '"')
        const host = deps.getHost(record.nodeId)
        if (host === undefined) return Promise.resolve('remote_interrupt: remote "' + record.nodeId + '" is no longer configured')
        if (record.sessionId === undefined) return Promise.resolve('remote_interrupt: the remote session is still being created; call remote_wait first')
        return deps.rpc(host, 'session/cancel', { request: { sessionId: record.sessionId } }, 15000).then(result => {
          if (result === undefined || result.ok !== true) return 'remote_interrupt: remote did not acknowledge the cancel'
          return 'remote_interrupt: requested on ' + record.nodeId + ' session ' + record.sessionId + '; call remote_wait to confirm'
        }, error => 'remote_interrupt failed: ' + errorText(error))
      },
    },
  ]
}