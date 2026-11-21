/**
 * Live SOCKS5 + CRS HTTP stability.
 * Does not use slot OAuth. Does not write credential files.
 * Run as root inside a SOCKS-bound Linux slot with KIN_LIVE_NET=1.
 * Set KIN_LIVE_DIRECT_IP to the host's IPv4 as seen by the probe endpoint,
 * and KIN_LIVE_CREDENTIAL_DIR to the slot's .claude directory.
 * KIN_LIVE_IP_URL optionally selects a trusted HTTPS IPv4 probe (default: ipify).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { isIPv4 } from 'node:net'
import path from 'node:path'

const LIVE = process.env.KIN_LIVE_NET === '1'
const UID = 10001
const GID = 987
const ROUNDS = 5

function httpsText({
  hostname,
  port,
  path = '/',
  method = 'GET',
  headers = {},
  body = null,
  uid = UID,
  gid = GID,
  timeoutMs = 15000,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import https from 'node:https'
      const spec = JSON.parse(process.env.KIN_SPEC)
      const req = https.request({
        hostname: spec.hostname,
        port: spec.port,
        path: spec.path,
        method: spec.method,
        headers: spec.headers || {},
        timeout: spec.timeoutMs || 15000,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          process.stdout.write(JSON.stringify({
            status: res.statusCode,
            ip: res.headers['x-forwarded-for'] || null,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 400),
          }))
        })
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (e) => { console.error(e.message); process.exit(2) })
      if (spec.body) req.write(spec.body)
      req.end()
    `,
      ],
      {
        uid,
        gid,
        env: {
          ...process.env,
          KIN_SPEC: JSON.stringify({ hostname, port, path, method, headers, body, timeoutMs }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`uid-https exit ${code}: ${err || out}`))
      try {
        resolve(JSON.parse(out))
      } catch (e) {
        reject(new Error(`bad json: ${out} ${err}`))
      }
    })
  })
}

function credentialFileStats() {
  const dir = process.env.KIN_LIVE_CREDENTIAL_DIR
  assert.ok(dir && path.isAbsolute(dir), 'KIN_LIVE_CREDENTIAL_DIR must name the slot credential directory')
  const stats = {}
  for (const name of ['credentials.json', '.credentials.json']) {
    try {
      const stat = fs.statSync(path.join(dir, name))
      assert.ok(stat.isFile(), `${name} must be a regular file`)
      stats[name] = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  assert.ok(Object.keys(stats).length, 'no credential file found in KIN_LIVE_CREDENTIAL_DIR')
  return stats
}

test('uid 10001 HTTPS egress is SOCKS, not the VPS IP', { skip: !LIVE }, async () => {
  const directIp = process.env.KIN_LIVE_DIRECT_IP || ''
  assert.ok(isIPv4(directIp), 'KIN_LIVE_DIRECT_IP must be the host IPv4 reported by the probe')
  const probe = new URL(process.env.KIN_LIVE_IP_URL || 'https://api.ipify.org/')
  assert.equal(probe.protocol, 'https:', 'the IPv4 probe must use HTTPS')
  const ips = []
  const times = []
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = Date.now()
    const r = await httpsText({
      hostname: probe.hostname,
      port: probe.port,
      path: `${probe.pathname}${probe.search}`,
      headers: { accept: 'text/plain' },
    })
    times.push(Date.now() - t0)
    assert.equal(r.status, 200, `round ${i} IP probe status`)
    const ip = String(r.body || '').trim()
    assert.ok(isIPv4(ip), `round ${i} did not return an IPv4 address`)
    assert.notEqual(ip, directIp, `round ${i} used the host's direct exit`)
    ips.push(ip)
  }
  assert.equal(new Set(ips).size, 1, `egress IPs drifted: ${ips.join(',')}`)
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  assert.ok(avg < 8000, `egress too slow avg=${avg}ms`)
  console.log(JSON.stringify({ socks_egress_ip: ips[0], rtt_ms: times, avg_ms: Math.round(avg) }))
})

test('uid 10001 HTTP to api.anthropic.com is stable (fake token, no cred write)', { skip: !LIVE }, async () => {
  const before = credentialFileStats()
  const statuses = []
  const times = []
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = Date.now()
    const r = await httpsText({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: 'Bearer sk-ant-oat01-INVALID-STABILITY-TEST',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    times.push(Date.now() - t0)
    statuses.push(r.status)
    assert.ok(r.status === 401 || r.status === 403, `round ${i} unexpected ${r.status} ${r.body}`)
  }
  const after = credentialFileStats()
  assert.deepEqual(after, before)
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  assert.equal(new Set(statuses).size, 1)
  console.log(JSON.stringify({ anthropic_http: { statuses, rtt_ms: times, avg_ms: Math.round(avg) } }))
})
