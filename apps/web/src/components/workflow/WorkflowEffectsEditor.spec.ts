import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import WorkflowEffectsEditor from './WorkflowEffectsEditor.vue'
import WorkflowNodeInspector from './WorkflowNodeInspector.vue'
const empty = { contractVersion: 'intent-workflow-effects-v1' as const, effects: [] }

it('does not turn missing declaration into permission or explicit empty effects on mount', async () => {
  const wrapper = mount(WorkflowEffectsEditor, { props: { nodeId: 'one' } })
  expect(wrapper.text()).toContain('尚未声明'); expect(wrapper.emitted('update')).toBeUndefined()
  await wrapper.findAll('button').find(row => row.text() === '声明无需操作资源')!.trigger('click')
  expect(wrapper.emitted('update')?.[0]).toEqual([empty]); wrapper.unmount()
})

it('requires a concrete resource and emits only a declaration, never grant fields', async () => {
  const wrapper = mount(WorkflowEffectsEditor, { props: { nodeId: 'one' } })
  const add = () => wrapper.findAll('button').find(row => row.text() === '添加所需操作')!
  await add().trigger('click'); expect(wrapper.find('[role=alert]').exists()).toBe(true); expect(wrapper.emitted('update')).toBeUndefined()
  await wrapper.find('input').setValue('workspace-1'); await add().trigger('click')
  const value = wrapper.emitted('update')![0][0] as typeof empty
  expect(value).toEqual({ ...empty, effects: [{ kind: 'read_workspace', target: { kind: 'workspace', refId: 'workspace-1' } }] })
  await wrapper.setProps({ value }); await wrapper.find('input').setValue('workspace-1'); await add().trigger('click')
  expect(wrapper.emitted('update')).toHaveLength(1); expect(wrapper.find('[role=alert]').text()).toContain('不可重复'); wrapper.unmount()
})

it('human approval cannot author resource operations', () => {
  const wrapper = mount(WorkflowEffectsEditor, { props: { nodeId: 'human', human: true } })
  expect(wrapper.find('select').exists()).toBe(false); expect(wrapper.find('input').exists()).toBe(false)
  expect(wrapper.text()).toContain('只记录决定'); wrapper.unmount()
})

it('switching nodes clears unsaved targets and does not mutate the old published declaration', async () => {
  const value = { ...empty, effects: [{ kind: 'read_workspace' as const, target: { kind: 'workspace' as const, refId: 'old' } }] }
  const wrapper = mount(WorkflowEffectsEditor, { props: { nodeId: 'one', value } })
  await wrapper.find('input').setValue('unsaved'); await wrapper.setProps({ nodeId: 'two', value: undefined })
  expect((wrapper.find('input').element as HTMLInputElement).value).toBe(''); expect(value.effects[0].target.refId).toBe('old')
  expect(wrapper.emitted('update')).toBeUndefined(); wrapper.unmount()
})

it('inspector forwards an explicit declaration and preserves unrelated node fields', async () => {
  const node = { id: 'node', type: 'agent' as const, agentId: 'agent', order: 0, stageDescription: '保留说明' }
  const wrapper = mount(WorkflowNodeInspector, { props: { node, agents: [] } })
  await wrapper.findAll('[role=tab]').find(row => row.text() === '配置')!.trigger('click')
  await wrapper.findAll('button').find(row => row.text() === '声明无需操作资源')!.trigger('click')
  expect(wrapper.emitted('update')?.[0]).toEqual([{ ...node, intentEffects: empty }]); wrapper.unmount()
})
