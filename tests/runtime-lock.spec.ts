/** The state directory lock: its refresh, a takeover that stops the Runtime, and its release on shutdown. */
import { existsSync, mkdirSync, rmdirSync, rmSync } from 'node:fs'
import { lockSync } from 'proper-lockfile'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

/** The shortest stale threshold `proper-lockfile` accepts, so the tests wait only seconds. */
const STALE = 2000
let h: Host
const lockPath = () => `${h.directory}.lock`
beforeEach(async () => { h = await startRuntime(undefined, { lockStale: STALE }) })
afterEach(async () => {
  await h.stop()
  rmSync(lockPath(), { recursive: true, force: true })
})

it('keeps its lock fresh past the stale threshold, so a second process cannot take it over', async () => {
  await new Promise(resolve => setTimeout(resolve, STALE + 500))
  expect(() => lockSync(h.directory, { stale: STALE })).toThrow(/already being held/)
  expect(h.runtime.lifetime.aborted).toBe(false)
})

it('stops the Runtime that lost its lock, refusing passes and management work beside the new owner', async () => {
  // A second instance takes the lock over by replacing its directory; the owner's next refresh reports the takeover.
  rmdirSync(lockPath())
  mkdirSync(lockPath())
  await vi.waitFor(() => expect(h.runtime.lifetime.aborted).toBe(true), { timeout: 4000 })
  await h.runtime.stop()
  expect(h.runtime.health.runtime).toMatchObject({ state: 'error' })
  expect(() => h.runtime.receive(feishu('1', '@bot 修一下'))).toThrow('Orchestrator is stopping')
  expect(await h.api('POST', 'threads/feishu:oc_team:om_1/unsubscribe')).toMatchObject({ status: 503 })
  // It no longer owns the lock, so it leaves the new owner's lock alone.
  expect(existsSync(lockPath())).toBe(true)
})

it('records a takeover during shutdown without releasing the new owner\'s lock', async () => {
  // Hold shutdown inside its wait for the agents, so the lock's next refresh reports the takeover while it runs.
  const master = h.agents.get(h.runtime.masterId)!
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  master.whenIdle = () => held
  const stopping = h.runtime.stop()
  await Promise.resolve()
  rmdirSync(lockPath())
  mkdirSync(lockPath())
  await vi.waitFor(() => expect(h.runtime.health.runtime).toMatchObject({ state: 'error' }), { timeout: 4000 })
  release()
  await stopping
  expect(h.runtime.closing()).toBe(true)
  expect(existsSync(lockPath())).toBe(true)
})

it('releases the lock once on shutdown and can acquire the directory again', async () => {
  const internals = h.runtime as unknown as { releaseLock?: () => Promise<void> }
  const release = internals.releaseLock!
  let releases = 0
  internals.releaseLock = async () => { releases++; await release() }
  await h.runtime.stop()
  await h.runtime.stop()
  expect(releases).toBe(1)
  expect(existsSync(lockPath())).toBe(false)
  const acquired = lockSync(h.directory, { stale: STALE })
  acquired()
})
