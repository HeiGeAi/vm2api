#!/usr/bin/env node
/**
 * Slot payloads (closed-source kernels, wrap CLIs, glibc shim) live in a GitHub
 * release or a pinned OCI layer. deploy/payload.json pins every file by size and sha256.
 *
 *   node scripts/fetch-payload.mjs [--dest DIR]   download missing / stale files
 *   node scripts/fetch-payload.mjs --check        verify local files, no network
 *   node scripts/fetch-payload.mjs --stage DIR    copy local files out under their
 *                                                 asset names, for `gh release upload`
 *   node scripts/fetch-payload.mjs --pin TAG      re-hash local files into the
 *                                                 manifest and point it at release TAG
 *
 * VM2API_PAYLOAD_BASE_URL overrides https://github.com/<repo>/releases/download.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const root = path.resolve(import.meta.dirname, '..')
const { values: opts } = parseArgs({
  options: {
    dest: { type: 'string', default: root },
    manifest: { type: 'string', default: path.join(root, 'deploy', 'payload.json') },
    check: { type: 'boolean', default: false },
    stage: { type: 'string' },
    pin: { type: 'string' },
  },
})

const manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf8'))
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function readLocal(file) {
  try {
    return fs.readFileSync(path.join(opts.dest, file.path))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function matches(buf, file) {
  return buf !== null && buf.length === file.size && sha256(buf) === file.sha256
}

async function fetchBytes(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function fetchLayerMember(file) {
  const { digest, size, member } = file.oci
  const repo = manifest.repo.toLowerCase()
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo) || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Invalid OCI repository or layer digest for ${file.path}`)
  }
  const tokenUrl = new URL('https://ghcr.io/token')
  tokenUrl.searchParams.set('service', 'ghcr.io')
  tokenUrl.searchParams.set('scope', `repository:${repo}:pull`)
  const { token } = JSON.parse(await fetchBytes(tokenUrl))
  if (typeof token !== 'string' || !token) throw new Error(`GHCR returned no pull token for ${repo}`)
  const layerUrl = `https://ghcr.io/v2/${repo}/blobs/${digest}`
  const bytes = await fetchBytes(layerUrl, { headers: { Authorization: `Bearer ${token}` } })
  if (bytes.length !== size || `sha256:${sha256(bytes)}` !== digest) {
    throw new Error(`OCI layer size or digest mismatch for ${file.path}`)
  }
  try {
    return execFileSync('tar', ['-xOzf', '-', '--', member], {
      input: bytes,
      maxBuffer: file.size + 1024 * 1024,
    })
  } catch {
    throw new Error(`Cannot read ${member} from the verified OCI layer for ${file.path}`)
  }
}

if (opts.pin) {
  for (const file of manifest.files) {
    const buf = readLocal(file)
    if (buf === null) throw new Error(`${file.path} is missing; cannot pin`)
    file.size = buf.length
    file.sha256 = sha256(buf)
    delete file.release
    delete file.oci
  }
  manifest.release = opts.pin
  fs.writeFileSync(opts.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`pinned ${manifest.files.length} files to ${opts.pin}`)
} else if (opts.stage) {
  fs.mkdirSync(opts.stage, { recursive: true })
  const staged = new Map()
  for (const file of manifest.files) {
    const buf = readLocal(file)
    if (!matches(buf, file)) throw new Error(`${file.path} does not match the manifest; run --pin first`)
    // One asset may back several paths (bin/kin-kernel = share/wrap-cli/kin-kernel.bin).
    if (staged.has(file.asset)) {
      if (staged.get(file.asset) !== file.sha256) throw new Error(`asset ${file.asset} maps to different files`)
      continue
    }
    fs.writeFileSync(path.join(opts.stage, file.asset), buf, { mode: 0o755 })
    staged.set(file.asset, file.sha256)
  }
  console.log(`staged ${staged.size} assets in ${opts.stage}`)
} else if (opts.check) {
  const bad = manifest.files.filter((file) => !matches(readLocal(file), file)).map((file) => file.path)
  if (bad.length) {
    console.error(`payload mismatch (${manifest.release}): ${bad.join(', ')}`)
    process.exit(1)
  }
  console.log(`payload ok (${manifest.release}, ${manifest.files.length} files)`)
} else {
  const mirror = process.env.VM2API_PAYLOAD_BASE_URL
  const base = (mirror || `https://github.com/${manifest.repo}/releases/download`).replace(/\/+$/, '')
  const downloads = new Map()
  for (const file of manifest.files) {
    const target = path.join(opts.dest, file.path)
    if (matches(readLocal(file), file)) continue
    const release = mirror ? manifest.release : (file.release ?? manifest.release)
    const useLayer = !mirror && file.oci
    const source = useLayer ? `${file.oci.digest}:${file.oci.member}` : `${base}/${release}/${file.asset}`
    if (!downloads.has(source)) {
      downloads.set(source, useLayer ? await fetchLayerMember(file) : await fetchBytes(source))
    }
    const buf = downloads.get(source)
    if (!matches(buf, file)) {
      throw new Error(`${source} does not match ${file.path} (size ${buf.length}, sha256 ${sha256(buf)})`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.download`
    fs.writeFileSync(tmp, buf, { mode: 0o755 })
    fs.renameSync(tmp, target)
    console.log(`fetched ${file.path}`)
  }
  console.log(`payload ready (${manifest.release}, ${manifest.files.length} files)`)
}
