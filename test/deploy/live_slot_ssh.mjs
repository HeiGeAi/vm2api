import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import ssh2 from 'ssh2'
import { remoteSlotOwner } from '../../src/lib/cluster/placement.mjs'
import { pushSlotBinaries, pushSlotFiles } from '../../src/lib/cluster/remote-slot-files.mjs'

const { LIVE_SLOT_SSH_DIR: sshDir, LIVE_SLOT_SSH_HOST: hostname } = process.env

test('publish slot files and payload over root OpenSSH', { timeout: 30_000 }, async (t) => {
  const client = new ssh2.Client()
  t.after(() => client.end())
  const knownHostKey = (await readFile(path.join(sshDir, 'host.pub'), 'utf8')).split(/\s+/)[1]
  const privateKey = await readFile(path.join(sshDir, 'client'))
  const ready = once(client, 'ready')
  client.connect({
    host: hostname,
    port: 18222,
    username: 'root',
    privateKey,
    hostVerifier: (key) => key.toString('base64') === knownHostKey,
    readyTimeout: 10_000,
  })
  await ready

  const host = { root: sshDir, uid: 0, gid: 0 }
  const local = path.join(sshDir, 'slot-source')
  const projectRoot = process.cwd()
  const kernelConfig = '{"fixture":true}\n'
  await mkdir(path.join(local, 'run'), { recursive: true })
  await writeFile(path.join(local, 'run', 'kernel.json'), kernelConfig)

  for (const [id, state] of [
    ['vm-07', 'new'],
    ['vm-08', 'existing'],
  ]) {
    await t.test(`root SSH prepares ${state} slot`, async () => {
      const vm = { id }
      const slot = path.join(sshDir, 'vms', id)
      const privateDirs = [
        slot,
        ...['run', 'claude', 'claude/telemetry', 'cli-home'].map((name) => path.join(slot, name)),
      ]
      const binDir = path.join(slot, 'slot-bin')
      if (state === 'existing') {
        for (const dir of privateDirs) await mkdir(dir, { recursive: true, mode: 0o755 })
        await mkdir(binDir, { mode: 0o700 })
      }

      const owner = remoteSlotOwner(host, vm)
      assert.deepEqual((await pushSlotFiles(vm, local, ['run'], { host, client })).pushed, ['run/kernel.json'])
      const { pushed } = await pushSlotBinaries(vm, projectRoot, { host, client })
      assert.deepEqual(pushed, ['kin-worker', 'kin-egress'])
      for (const [file, mode] of [
        ...privateDirs.map((dir) => [dir, 0o700]),
        [binDir, 0o755],
        ...pushed.map((name) => [path.join(binDir, name), 0o755]),
        [path.join(slot, 'run', 'kernel.json'), 0o600],
      ]) {
        const stats = await stat(file)
        assert.equal(stats.mode & 0o777, mode, file)
        assert.equal(stats.uid, owner.uid, file)
        assert.equal(stats.gid, owner.gid, file)
      }
      assert.equal(await readFile(path.join(slot, 'run', 'kernel.json'), 'utf8'), kernelConfig)
      for (const name of pushed) {
        assert.deepEqual(await readFile(path.join(binDir, name)), await readFile(path.join(projectRoot, 'bin', name)))
      }
    })
  }
})
