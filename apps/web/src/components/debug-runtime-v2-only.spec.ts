import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const debugView = readFileSync(resolve('src/components/DebugRuntimeView.vue'), 'utf8')
const debugStore = readFileSync(resolve('src/stores/debug.ts'), 'utf8')
const debugBoundary = `${debugView}\n${debugStore}`

describe('Debug runtime v2-only boundary', () => {
  it('does not depend on legacy ContextAssembly structures', () => {
    expect(debugBoundary).not.toMatch(/DebugContextAssembly|ContextAssemblyItem|contextAssembly|Context Assembly/)
  })

  it('does not expose legacy Runtime selection fields', () => {
    expect(debugBoundary).not.toMatch(/EngineeringRuntimeSelection|runtimeSelection|configuredRuntime|effectiveRuntime/)
  })

  it('uses invocationId as the only invocation correlation key', () => {
    expect(debugBoundary).toMatch(/invocationId/)
    expect(debugBoundary).not.toMatch(/runId/)
  })

  it('renders the compiled Agent identity and Skill snapshots', () => {
    expect(debugStore).toMatch(/RuntimeInvocationProfileSnapshot/)
    expect(debugView).toMatch(/Skill snapshots/)
    expect(debugView).toMatch(/profileHash/)
  })

  it('renders Tool Authority decisions and catalog hash', () => {
    expect(debugStore).toMatch(/ResolvedToolCatalog/)
    expect(debugView).toMatch(/Tool Authority/)
    expect(debugView).toMatch(/catalogHash/)
    expect(debugView).toMatch(/decisions/)
  })

  it('renders the resolved Execution Target with source and reason', () => {
    expect(debugStore).toMatch(/ResolvedExecutionTarget/)
    expect(debugView).toMatch(/Execution Target/)
    expect(debugView).toMatch(/executionTarget\.source/)
    expect(debugView).toMatch(/executionTarget\.reason/)
  })

  it('renders the authoritative ContextEnvelope L0 through L6', () => {
    expect(debugStore).toMatch(/ContextEnvelopeV2/)
    for (const layer of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
      expect(debugView).toContain(layer)
    }
  })

  it('loads the canonical v2 invocation audit endpoint', () => {
    expect(debugStore).toMatch(/debug\/runtime-invocations/)
    expect(debugBoundary).not.toMatch(/debug\/context-envelopes/)
  })

  it('renders strict output contract identity and data isolation evidence', () => {
    expect(debugStore).toMatch(/outputContract/)
    expect(debugView).toMatch(/outputContract\.contractId/)
    expect(debugView).toMatch(/outputContract\.contractVersion/)
    expect(debugView).toMatch(/outputContract\.schemaHash/)
    expect(debugBoundary).toMatch(/dataEpoch/)
    expect(debugBoundary).toMatch(/systemEvidence/)
  })

  it('keeps provider protocol diagnostics in the debug-only view', () => {
    expect(debugBoundary).toMatch(/runtimeDiagnostics/)
    expect(debugView).toMatch(/providerNotifications/)
    expect(debugView).toMatch(/unknownNotificationCount/)
    expect(debugView).toMatch(/stderrTail/)
  })
})
