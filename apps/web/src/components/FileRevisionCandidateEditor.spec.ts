import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import FileRevisionCandidateEditor from './FileRevisionCandidateEditor.vue'
import type { FileRevisionCandidate, FileRevisionEditorDraftContent } from '@/types/contracts'

const hash = (value: string) => ({ algorithm: 'sha256' as const, value: value.repeat(64).slice(0, 64) })

function candidate(): FileRevisionCandidate {
  return {
    revisionId: 'revision-1',
    chainId: 'chain-1',
    iteration: 1,
    candidateHash: hash('a'),
    content: '# Final candidate\n\nG1 only\n',
    sizeBytes: 30,
    status: 'awaiting_confirmation',
    stateVersion: 2
  }
}

describe('FileRevisionCandidateEditor', () => {
  it('shows only the final candidate and submits a saved user draft only on explicit action', async () => {
    const wrapper = mount(FileRevisionCandidateEditor, {
      props: {
        filePath: 'result.md',
        iteration: 1,
        status: 'awaiting_confirmation',
        candidate: candidate()
      },
      global: { stubs: { UiIcon: true } }
    })

    expect(wrapper.text()).toContain('G1 only')
    expect(wrapper.text()).not.toContain('Diff')
    expect(wrapper.text()).not.toContain('W0')
    expect(wrapper.find('textarea').exists()).toBe(false)

    await wrapper.findAll('button').find((button) => button.text().includes('继续编辑'))!.trigger('click')
    const textarea = wrapper.get('textarea')
    const submitButton = wrapper.findAll('button').find((button) => button.text().includes('提交修改'))!
    expect((submitButton.element as HTMLButtonElement).disabled).toBe(true)

    await textarea.setValue('# User draft\n\nU2\n')
    await wrapper.findAll('button').find((button) => button.text().includes('保存草稿'))!.trigger('click')
    expect(wrapper.emitted('save')).toEqual([['# User draft\n\nU2\n']])
    expect(wrapper.emitted('submit')).toBeUndefined()

    const draft: FileRevisionEditorDraftContent = {
      chainId: 'chain-1',
      sourceRevisionId: 'revision-1',
      sourceCandidateHash: hash('a'),
      contentRef: 'sha256:draft',
      contentHash: hash('b'),
      sizeBytes: 17,
      updatedBy: { type: 'user', id: 'user-1' },
      updatedAt: '2026-07-29T00:00:00.000Z',
      content: '# User draft\n\nU2\n'
    }
    await wrapper.setProps({ draft })
    expect((submitButton.element as HTMLButtonElement).disabled).toBe(false)
    await submitButton.trigger('click')
    expect(wrapper.emitted('submit')).toEqual([['# User draft\n\nU2\n']])
  })

  it('requires an explicit retry, continue, or abandon decision after a partial Agent failure', async () => {
    const wrapper = mount(FileRevisionCandidateEditor, {
      props: {
        filePath: 'result.md',
        iteration: 2,
        status: 'failed',
        error: 'REVISION_PARTIAL_AGENT_FAILURE: 1/2 Agents completed.',
        partialFailure: true,
        successfulAgentCount: 1
      },
      global: { stubs: { UiIcon: true } }
    })

    expect(wrapper.text()).toContain('重试全部 Agent')
    expect(wrapper.text()).toContain('使用成功结果继续')
    expect(wrapper.text()).toContain('放弃修订')
    const buttons = wrapper.findAll('button')
    await buttons.find((button) => button.text().includes('使用成功结果继续'))!.trigger('click')
    expect(wrapper.emitted('failureDecision')).toEqual([['continue_with_successful']])
  })

  it('keeps a saved draft when editing is cancelled and disables continue when no Agent succeeded', async () => {
    const savedDraft: FileRevisionEditorDraftContent = {
      chainId: 'chain-1',
      sourceRevisionId: 'revision-1',
      sourceCandidateHash: hash('a'),
      contentRef: 'sha256:saved-draft',
      contentHash: hash('b'),
      sizeBytes: 18,
      updatedBy: { type: 'user', id: 'user-1' },
      updatedAt: '2026-07-29T00:00:00.000Z',
      content: '# Saved draft\n\nU2\n'
    }
    const wrapper = mount(FileRevisionCandidateEditor, {
      props: {
        filePath: 'result.md',
        iteration: 1,
        status: 'awaiting_confirmation',
        candidate: candidate(),
        draft: savedDraft
      },
      global: { stubs: { UiIcon: true } }
    })

    await wrapper.findAll('button').find((button) => button.text().includes('放弃编辑'))!.trigger('click')
    await wrapper.findAll('button').find((button) => button.text().includes('继续编辑'))!.trigger('click')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(savedDraft.content)

    await wrapper.setProps({
      status: 'failed',
      candidate: undefined,
      draft: undefined,
      partialFailure: true,
      successfulAgentCount: 0,
      error: 'REVISION_PARTIAL_AGENT_FAILURE'
    })
    const continueButton = wrapper.findAll('button').find((button) => button.text().includes('使用成功结果继续'))
    expect(continueButton).toBeDefined()
    expect((continueButton!.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers an explicit retry after a process restart interrupts the revision', async () => {
    const wrapper = mount(FileRevisionCandidateEditor, {
      props: {
        filePath: 'result.md',
        iteration: 2,
        status: 'interrupted'
      },
      global: { stubs: { UiIcon: true } }
    })

    const retry = wrapper.findAll('button').find((button) => button.text().includes('重试本轮修订'))
    expect(retry).toBeDefined()
    await retry!.trigger('click')
    expect(wrapper.emitted('retryInterrupted')).toEqual([[]])
  })

  it('restores keyboard focus while editing and when revision state changes', async () => {
    const wrapper = mount(FileRevisionCandidateEditor, {
      attachTo: document.body,
      props: {
        filePath: 'result.md',
        iteration: 1,
        status: 'awaiting_confirmation',
        candidate: candidate()
      },
      global: { stubs: { UiIcon: true } }
    })

    const editButton = wrapper.findAll('button').find((button) => button.text().includes('继续编辑'))!
    await editButton.trigger('click')
    expect(document.activeElement).toBe(wrapper.get('textarea').element)

    await wrapper.findAll('button').find((button) => button.text().includes('放弃编辑'))!.trigger('click')
    const restoredEditButton = wrapper.findAll('button').find((button) => button.text().includes('继续编辑'))!
    expect(document.activeElement).toBe(restoredEditButton.element)

    await wrapper.setProps({ status: 'processing' })
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('section').element)

    const nextCandidate = candidate()
    nextCandidate.candidateHash = hash('b')
    nextCandidate.content = '# Final candidate\n\nG2 only\n'
    await wrapper.setProps({ status: 'awaiting_confirmation', candidate: nextCandidate })
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('pre').element)

    wrapper.unmount()
  })
})
