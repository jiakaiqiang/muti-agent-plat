import { describe, expect, it } from 'vitest'
import { createLocalRuntimeLaunchUrl, createLocalRuntimeUpgradeUrl } from './localRuntimeLauncher'

describe('local Runtime launcher', () => {
  it('encodes a server URL in the custom protocol launch URL', () => {
    expect(createLocalRuntimeLaunchUrl('https://agent.example.com'))
      .toBe('agent-runtime://connect?server=https%3A%2F%2Fagent.example.com')
  })

  it('includes a one-time-shaped nonce when launching a trusted upgrade', () => {
    expect(createLocalRuntimeUpgradeUrl('https://agent.example.com', '0123456789abcdef', 'nonce-0123456789'))
      .toBe('agent-runtime://upgrade?server=https%3A%2F%2Fagent.example.com&upgradeId=0123456789abcdef&nonce=nonce-0123456789')
  })
})
