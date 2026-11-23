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
import os from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'

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

/**
 * Node identity (M2): an ed25519 keypair in `$DSH_HOME/node-identity.json`. The node id is a short fingerprint of the public key,
 * so peers can pin one value, and grants/proofs carry signatures a peer verifies without any shared secret or plaintext token.
 */
export const NODE_IDENTITY_VERSION = 1

export function nodeIdentityPath(dshHome) {
  return path.join(dshHome, 'node-identity.json')
}

export function fingerprintOf(publicKeyBase64) {
  const der = Buffer.from(publicKeyBase64, 'base64')
  return createHash('sha256').update(der).digest('hex').slice(0, 16)
}

export function loadOrCreateNodeIdentity(dshHome) {
  const file = nodeIdentityPath(dshHome)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      return { nodeId: typeof parsed.nodeId === 'string' ? parsed.nodeId : fingerprintOf(parsed.publicKey), publicKey: parsed.publicKey, privateKey: parsed.privateKey, file: file, created: false }
    }
  } catch {}
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  const record = { version: NODE_IDENTITY_VERSION, nodeId: fingerprintOf(publicKey), publicKey: publicKey, privateKey: privateKey, createdAt: Date.now() }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = file + '.tmp-' + String(process.pid)
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {}
  return { nodeId: record.nodeId, publicKey: publicKey, privateKey: privateKey, file: file, created: true }
}

/** `base64url(payloadJson) + "." + base64url(ed25519(payloadJson))` */
export function signPayload(identity, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  const signature = sign(null, body, { key: Buffer.from(identity.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
  return body.toString('base64url') + '.' + signature.toString('base64url')
}

/** Verifies a signed payload against a `base64(spki)` public key; returns the payload or undefined. */
export function verifyPayload(signed, publicKeyBase64) {
  if (typeof signed !== 'string') return undefined
  const at = signed.indexOf('.')
  if (at <= 0) return undefined
  const body = Buffer.from(signed.slice(0, at), 'base64url')
  const signature = Buffer.from(signed.slice(at + 1), 'base64url')
  try {
    const ok = verify(null, body, { key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' }, signature)
    return ok ? JSON.parse(body.toString('utf8')) : undefined
  } catch {
    return undefined
  }
}
