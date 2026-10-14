import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { SessionDetail } from '@/types/contracts'
import GitHubSourcePreparation from './GitHubSourcePreparation.vue'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  refreshSourceSession: vi.fn()
}))
vi.mock('@/api/client', () => ({ apiGet: mocks.apiGet, apiPost: mocks.apiPost }))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ refreshSourceSession: mocks.refreshSourceSession })
}))

const stubs = {
  ElButton: { props: ['disabled'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
  ElInput: { props: ['modelValue'], emits: ['update:modelValue'], template: '<input type="password" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
  ElDialog: { props: ['modelValue'], template: '<div v-if="modelValue"><slot /><slot name="footer" /></div>' },
  ElSelect: { props: ['modelValue'], template: '<select :value="modelValue"><slot /></select>' },
  ElOption: { props: ['label', 'value'], template: '<option :value="value">{{ label }}</option>' }
}

function session(state: 'awaiting_auth' | 'awaiting_base_branch'): SessionDetail {
  return {
    id: 'session-1',
    codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: 'https://github.com/a/b' },
    sourceBinding: {
      sessionId: 'session-1', provider: 'github', repositoryUrl: 'https://github.com/a/b',
      repositoryId: 'a/b', executionLocation: 'server', state, version: 7,
      createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z'
    }
  } as SessionDetail
}

function render(state: 'awaiting_auth' | 'awaiting_base_branch') {
  return mount(GitHubSourcePreparation, { props: { session: session(state) }, global: { stubs } })
}

let wrapper: VueWrapper | undefined
beforeEach(() => {
  mocks.apiGet.mockReset()
  mocks.apiPost.mockReset().mockResolvedValue({})
  mocks.refreshSourceSession.mockReset().mockResolvedValue(session('awaiting_auth'))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

describe('GitHub source preparation', () => {
  it('sends a PAT through the dedicated endpoint and clears the input', async () => {
    wrapper = render('awaiting_auth')
    await wrapper.get('input[type="password"]').setValue('ghp_secret')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.apiPost).toHaveBeenCalledWith('/code-hosts/github/tokens', {
      sessionId: 'session-1', token: 'ghp_secret'
    })
    expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('')
    expect(mocks.refreshSourceSession).toHaveBeenCalledWith('session-1')
  })

  it('loads the actual default branch and submits its source version', async () => {
    mocks.apiGet.mockResolvedValue({
      defaultBranch: 'main', branches: [{ name: 'main', sha: 'abc' }, { name: 'release', sha: 'def' }], version: 7
    })
    wrapper = render('awaiting_base_branch')
    await flushPromises()
    expect(mocks.apiGet).toHaveBeenCalledWith('/sessions/session-1/source/branches')
    const confirm = wrapper.findAll('button').find((button) => button.text() === '确认分支')
    expect(confirm).toBeDefined()
    await confirm!.trigger('click')
    await flushPromises()
    expect(mocks.apiPost).toHaveBeenCalledWith('/sessions/session-1/source/base-branch', {
      branch: 'main', expectedSourceVersion: 7
    })
  })
})
