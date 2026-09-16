import { describe, expect, it } from 'vitest'
import { createLocalRuntimeLaunchUrl } from './localRuntimeLauncher'

describe('local Runtime launcher', () => {
  it('encodes a server URL in the custom protocol launch URL', () => {
    expect(createLocalRuntimeLaunchUrl('https://agent.example.com'))
      .toBe('agent-runtime://connect?server=https%3A%2F%2Fagent.example.com')
  })
})
