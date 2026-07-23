import { expect, it } from 'vitest'
import { workspaceBrokerReconnectDelay } from './workspaceBrokerReconnect'

it('workspace broker reconnects with capped exponential backoff while a workspace remains registered', () => {
  expect(workspaceBrokerReconnectDelay(1, false)).toBe(1_000)
  expect(workspaceBrokerReconnectDelay(1, false, 1)).toBe(2_000)
  expect(workspaceBrokerReconnectDelay(1, false, 4)).toBe(16_000)
  expect(workspaceBrokerReconnectDelay(1, false, 5)).toBe(30_000)
  expect(workspaceBrokerReconnectDelay(1, false, 20)).toBe(30_000)
})

it('workspace broker does not schedule duplicate or unused reconnects', () => {
  expect(workspaceBrokerReconnectDelay(0, false)).toBeUndefined()
  expect(workspaceBrokerReconnectDelay(1, true)).toBeUndefined()
})
