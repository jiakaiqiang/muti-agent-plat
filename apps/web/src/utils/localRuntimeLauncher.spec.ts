import { describe, expect, it } from 'vitest'
import { createLocalRuntimeLaunchUrl, resolveLocalRuntimeServerUrl } from './localRuntimeLauncher'

describe('local Runtime launcher', () => {
  it('uses the page origin for a same-origin API base', () => {
    expect(resolveLocalRuntimeServerUrl('/api', 'https://agent.example.com'))
      .toBe('https://agent.example.com')
  })

  it('uses the backend origin for an absolute API base', () => {
    expect(resolveLocalRuntimeServerUrl('https://api.example.com/api', 'https://agent.example.com'))
      .toBe('https://api.example.com')
  })

  it('encodes a server URL in the custom protocol launch URL', () => {
    expect(createLocalRuntimeLaunchUrl('https://agent.example.com'))
      .toBe('agent-runtime://connect?server=https%3A%2F%2Fagent.example.com')
  })
})
