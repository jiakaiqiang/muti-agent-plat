import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import GitHubConflictEditor from './GitHubConflictEditor.vue'

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn(), apiPost: vi.fn(), refresh: vi.fn() }))
vi.mock('@/api/client', () => ({ apiGet: mocks.apiGet, apiPut: mocks.apiPut, apiPost: mocks.apiPost }))
vi.mock('@/stores/session', () => ({ useSessionStore: () => ({ refreshSourceSession: mocks.refresh }) }))

const stubs = {
  ElButton: { props: ['disabled'], emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
  ElInput: { props: ['modelValue'], emits: ['update:modelValue'],
    template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
  ElRadioGroup: { template: '<div><slot /></div>' },
  ElRadio: { template: '<label><slot /></label>' }
}
const conflict = { id: 'conflict-a', sessionId: 'session-a', deliveryRound: 1,
  source: 'git', targetOperation: 'merge_pull_request', version: 3,
  createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
  files: [{ fileId: 'file-a', path: 'README.md', kind: 'text', status: 'unresolved', version: 1,
    oursContent: 'left\n', theirsContent: 'right\n', resultContent: '<<<<<<< HEAD\n' }] }

let wrapper: VueWrapper | undefined
beforeEach(() => {
  mocks.apiGet.mockReset().mockResolvedValue(structuredClone(conflict))
  mocks.apiPut.mockReset().mockResolvedValue({ ...structuredClone(conflict), version: 4,
    files: [{ ...conflict.files[0], resultContent: 'left\n', status: 'draft' }] })
  mocks.apiPost.mockReset().mockResolvedValue({})
  mocks.refresh.mockReset().mockResolvedValue({})
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

it('adopts the left version and saves a versioned draft without completing the conflict', async () => {
  wrapper = mount(GitHubConflictEditor, { props: { sessionId: 'session-a', conflictId: 'conflict-a' },
    global: { stubs } })
  await flushPromises()
  await wrapper.findAll('button').find((button) => button.text().includes('采用左侧'))!.trigger('click')
  await wrapper.findAll('button').find((button) => button.text().includes('保存草稿'))!.trigger('click')
  await flushPromises()
  expect(mocks.apiPut).toHaveBeenCalledWith(
    '/sessions/session-a/conflicts/conflict-a/files/file-a',
    { expectedConflictVersion: 3, confirm: false, resultContent: 'left\n' })
  expect(mocks.apiPost).not.toHaveBeenCalled()
})

it('shows the original path for a rename conflict', async () => {
  mocks.apiGet.mockResolvedValue({ ...structuredClone(conflict), files: [{
    fileId: 'rename-a', path: 'new-name.txt', previousPath: 'old-name.txt',
    kind: 'renamed', status: 'unresolved', version: 1,
    oursObjectId: 'a'.repeat(40), theirsObjectId: 'b'.repeat(40)
  }] })
  wrapper = mount(GitHubConflictEditor, { props: { sessionId: 'session-a', conflictId: 'conflict-a' },
    global: { stubs } })
  await flushPromises()
  expect(wrapper.text()).toContain('old-name.txt → new-name.txt')
  expect(wrapper.text()).toContain('改名冲突')
})

it('labels workspace writeback sides and completion without implying a GitHub PR', async () => {
  mocks.apiGet.mockResolvedValue({ ...structuredClone(conflict), source: 'workspace_writeback',
    targetOperation: 'writeback', files: [{ ...conflict.files[0], status: 'confirmed',
      resultContent: 'resolved\n' }] })
  wrapper = mount(GitHubConflictEditor, { props: { sessionId: 'session-a', conflictId: 'conflict-a' },
    global: { stubs } })
  await flushPromises()
  expect(wrapper.text()).toContain('会话候选版本')
  expect(wrapper.text()).toContain('当前工作区版本')
  expect(wrapper.text()).toContain('应用到工作区')
  expect(wrapper.text()).not.toContain('更新 PR')
})
