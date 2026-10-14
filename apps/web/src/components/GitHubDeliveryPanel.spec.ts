import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { SessionDetail } from '@agent-cluster/shared'
import GitHubDeliveryPanel from './GitHubDeliveryPanel.vue'

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), refresh: vi.fn(), devices: [] as Array<{ deviceId: string }> }))
vi.mock('@/api/client', () => ({ apiGet: mocks.apiGet, apiPost: mocks.apiPost }))
vi.mock('@/stores/session', () => ({ useSessionStore: () => ({ refreshSourceSession: mocks.refresh }) }))
vi.mock('@/stores/localRuntime', () => ({ useLocalRuntimeStore: () => ({ connectedDevices: mocks.devices }) }))

const stubs = {
  ElButton: { props: ['disabled'], emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
  ElTag: { template: '<span><slot /></span>' },
  ElDialog: { props: ['modelValue'], template: '<div v-if="modelValue"><slot /><slot name="footer" /></div>' },
  ElCheckbox: { props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
    template: '<label><input type="checkbox" :disabled="disabled" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" /><slot /></label>' },
  ElSelect: { template: '<select><slot /></select>' },
  ElOption: { template: '<option><slot /></option>' },
  ElInput: { template: '<input />' }
}

let wrapper: VueWrapper | undefined
beforeEach(() => {
  mocks.devices.splice(0)
  mocks.apiGet.mockReset().mockResolvedValue({ kind: 'pull_request', sha: 'a'.repeat(40),
    files: [{ path: 'README.md', status: 'modified', additions: 1, deletions: 1, patch: '@@' }],
    page: 1, hasMore: false })
  mocks.apiPost.mockReset().mockResolvedValue({})
  mocks.refresh.mockReset().mockResolvedValue({})
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

it('requires review of the exact PR head before calling merge', async () => {
  const session = { id: 'session-a', delivery: { round: 1, state: 'merge_ready',
    version: 7, commitSha: 'a'.repeat(40), pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/o/r/pull/12' } } as SessionDetail
  wrapper = mount(GitHubDeliveryPanel, { props: { session }, global: { stubs } })
  await wrapper.findAll('button').find((button) => button.text().includes('审查并合并'))!.trigger('click')
  await flushPromises()
  const merge = wrapper.findAll('button').find((button) => button.text().includes('Squash Merge'))!
  expect(merge.attributes('disabled')).toBeDefined()
  expect(mocks.apiPost).not.toHaveBeenCalled()
  await wrapper.get('input[type="checkbox"]').setValue(true)
  await merge.trigger('click')
  await flushPromises()
  expect(mocks.apiPost).toHaveBeenCalledWith('/sessions/session-a/delivery/merge', {
    expectedDeliveryVersion: 7, expectedHeadSha: 'a'.repeat(40)
  }, expect.objectContaining({ headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }) }))
})

it('requires every PR diff page before review can be confirmed', async () => {
  const sha = 'a'.repeat(40)
  mocks.apiGet.mockResolvedValueOnce({ kind: 'pull_request', sha,
    files: [{ path: 'first.ts', status: 'modified', additions: 1, deletions: 0 }],
    page: 1, hasMore: true })
    .mockResolvedValueOnce({ kind: 'pull_request', sha,
      files: [{ path: 'second.ts', status: 'modified', additions: 1, deletions: 0 }],
      page: 2, hasMore: false })
  const session = { id: 'session-pages', delivery: { round: 1, state: 'merge_ready',
    version: 7, commitSha: sha, pullRequestNumber: 12 } } as SessionDetail
  wrapper = mount(GitHubDeliveryPanel, { props: { session }, global: { stubs } })
  await wrapper.findAll('button').find((button) => button.text().includes('审查并合并'))!.trigger('click')
  await flushPromises()
  expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()
  expect(wrapper.findAll('button').find((button) => button.text().includes('Squash Merge'))!.attributes('disabled')).toBeDefined()
  await wrapper.findAll('button').find((button) => button.text().includes('加载更多文件'))!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('second.ts')
  expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeUndefined()
  await wrapper.get('input[type="checkbox"]').setValue(true)
  await wrapper.findAll('button').find((button) => button.text().includes('Squash Merge'))!.trigger('click')
  await flushPromises()
  expect(mocks.apiPost).toHaveBeenCalledWith('/sessions/session-pages/delivery/merge',
    { expectedDeliveryVersion: 7, expectedHeadSha: sha }, expect.anything())
})

it('discards paged review when the PR head changes between requests', async () => {
  const sha = 'a'.repeat(40)
  mocks.apiGet.mockResolvedValueOnce({ kind: 'pull_request', sha,
    files: [{ path: 'first.ts', status: 'modified', additions: 1, deletions: 0 }],
    page: 1, hasMore: true })
    .mockResolvedValueOnce({ kind: 'pull_request', sha: 'b'.repeat(40),
      files: [{ path: 'second.ts', status: 'modified', additions: 1, deletions: 0 }],
      page: 2, hasMore: false })
  const session = { id: 'session-changed-head', delivery: { round: 1, state: 'merge_ready',
    version: 7, commitSha: sha, pullRequestNumber: 12 } } as SessionDetail
  wrapper = mount(GitHubDeliveryPanel, { props: { session }, global: { stubs } })
  await wrapper.findAll('button').find((button) => button.text().includes('审查并合并'))!.trigger('click')
  await flushPromises()
  await wrapper.findAll('button').find((button) => button.text().includes('加载更多文件'))!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('差异版本已变化，请重新加载')
  expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true)
  expect(wrapper.get('input[type="checkbox"]').attributes('disabled')).toBeDefined()
  expect(mocks.apiPost).not.toHaveBeenCalled()
})

it('does not offer merge while the bound local device is offline', async () => {
  const session = { id: 'session-local', sourceBinding: {
    executionLocation: 'local', deviceId: 'device-a', state: 'ready'
  }, delivery: { round: 1, state: 'merge_ready', version: 7,
    commitSha: 'a'.repeat(40), pullRequestNumber: 12,
    pullRequestUrl: 'https://github.com/o/r/pull/12' } } as SessionDetail
  wrapper = mount(GitHubDeliveryPanel, { props: { session }, global: { stubs } })
  await flushPromises()
  expect(wrapper.text()).not.toContain('审查并合并')
  expect(mocks.apiPost).not.toHaveBeenCalled()
})

it('refreshes an interrupted merge after the local device reconnects without merging automatically', async () => {
  const session = { id: 'session-reconnect', sourceBinding: {
    executionLocation: 'local', deviceId: 'device-a', state: 'ready'
  }, delivery: { round: 1, state: 'blocked', version: 8,
    errorCode: 'GITHUB_MERGE_INTERRUPTED', commitSha: 'a'.repeat(40),
    pullRequestNumber: 12, pullRequestUrl: 'https://github.com/o/r/pull/12' } } as SessionDetail
  wrapper = mount(GitHubDeliveryPanel, { props: { session }, global: { stubs } })
  await flushPromises()
  expect(mocks.apiPost).not.toHaveBeenCalled()
  mocks.devices.push({ deviceId: 'device-a' })
  await wrapper.setProps({ session: { ...session } })
  await flushPromises()
  expect(mocks.apiPost).toHaveBeenCalledWith('/sessions/session-reconnect/delivery/refresh',
    { expectedDeliveryVersion: 8 })
  expect(mocks.apiPost).toHaveBeenCalledTimes(1)
});
