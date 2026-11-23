/**
 * Backend half of dsh-remote-p2p: publish this process's launch token and basic
 * identity to a 0600 file, so a paired peer can mint a browser cookie without
 * reading logs. The default path stays `$DSH_HOME/remote-agent.json`, which is
 * what dsh-remote-hub and dsh-remote-agent wrote, so existing hubs keep working
 * after the merge; `identityFile` overrides it when several instances share a
 * DSH_HOME.
 *
 * The file is removed on shutdown, so a missing file means "that dsh is not
 * running".
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const IDENTITY_FILE_VERSION = 1
const MAX_ATTEMPTS = 50
const RETRY_MS = 200
const HEARTBEAT_MS = 60 * 1000

/** Resolved identity file path for one plugin instance. */
export function identityPath(file, dshHome) {
  if (typeof file === 'string' && file !== '') return file
  return path.join(dshHome, 'remote-agent.json')
}

/** A pure builder for the identity document, kept separate so it can be tested without a dsh runtime. */
export function identityPayload(options) {
  return {
    version: IDENTITY_FILE_VERSION,
    hostname: options.hostname,
    pid: options.pid,
    startedAt: options.startedAt,
    updatedAt: options.updatedAt,
    token: options.token,
    webPort: options.webPort,
    dshHome: options.dshHome,
  }
}

function writeAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = file + '.tmp-' + String(process.pid)
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * Publish this process's identity file and keep it fresh until the plugin unloads.
 * Registers its own ctx.effect, so the caller does not manage the disposer.
 */
export function applyIdentity(ctx, options) {
  const dshHome = options !== null && typeof options === 'object' && typeof options.dshHome === 'string' ? options.dshHome : path.join(os.homedir(), '.dsh')
  const target = identityPath(options !== null && typeof options === 'object' ? options.file : undefined, dshHome)
  let timer
  let heartbeat
  let attempts = 0
  let stopped = false

  function stop() {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    if (heartbeat !== undefined) clearInterval(heartbeat)
    try { fs.unlinkSync(target) } catch {}
  }

  function publish(startedAt) {
    if (stopped) return
    let origin
    let token
    try {
      origin = new URL(ctx.webServer.getOrigin())
      const authed = new URL(ctx.connection.authenticatedUrl(origin.origin + '/'))
      const value = authed.searchParams.get('token')
      token = value === null ? undefined : value
    } catch {
      token = undefined
    }
    if (token === undefined || token === '') {
      attempts += 1
      if (!stopped && attempts < MAX_ATTEMPTS) timer = setTimeout(function () { publish(startedAt) }, RETRY_MS)
      return
    }
    const payload = identityPayload({
      hostname: os.hostname(),
      pid: process.pid,
      startedAt: startedAt,
      updatedAt: Date.now(),
      token: token,
      webPort: Number(origin.port === '' ? 80 : origin.port),
      dshHome: dshHome,
    })
    try {
      writeAtomic(target, JSON.stringify(payload, null, 2) + '\n')
    } catch (error) {
      if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('remote-p2p: cannot write ' + target + ': ' + error.message)
      }
    }
  }

  const startedAt = Date.now()
  timer = setTimeout(function () { publish(startedAt) }, 0)
  heartbeat = setInterval(function () { publish(startedAt) }, HEARTBEAT_MS)

  ctx.effect(function () { return stop }, 'remote-p2p: identity file')

  if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
    ctx.logger.info('remote-p2p: publishing identity to ' + target)
  }
  return stop
}
