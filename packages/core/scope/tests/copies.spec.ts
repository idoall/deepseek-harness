import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { carrierKeyOf, createScope, scopeChainOf, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'

/**
 * A DSH profile installs plugins into its own `node_modules`, so one process can
 * hold an independently installed copy of this package beside the harness core.
 * Every workspace import resolves one copy, so only an explicit second module
 * instance exercises the identity that has to cross that install boundary.
 * @returns the same module loaded as a second instance.
 */
async function independentCopy(): Promise<typeof import('@deepseek-ai/dsh-scope')> {
  // Vite loads a query-suffixed specifier as a second module instance;
  // TypeScript has no declaration for that specifier.
  // @ts-expect-error -- the query suffix keeps this import out of the type graph.
  return await import('../src/index.ts?independent-copy') as typeof import('@deepseek-ai/dsh-scope')
}

describe('independently installed copies', () => {
  it('reads a context tag written by the other copy', async () => {
    const other = await independentCopy()
    expect(other.scopeOf).not.toBe(scopeOf)
    const key = {}
    const scope = createScope(new Context(), key)
    expect(scopeOf(scope.ctx)).toBe(key)
    expect(other.scopeOf(scope.ctx)).toBe(key)
    await scope.dispose()
  })

  it('walks a parent chain bound by the other copy', async () => {
    const other = await independentCopy()
    const parent = {}
    const child = {}
    const scope = createScope(new Context(), child, { parent })
    expect(scopeChainOf(child)).toEqual([child, parent])
    expect(other.scopeChainOf(child)).toEqual([child, parent])
    expect(other.scopeParentOf(child)).toBe(parent)
    expect(other.scopeOf(scope.ctx)).toBe(child)
    await scope.dispose()
  })

  it('reads a carrier mark written by the other copy', async () => {
    const other = await independentCopy()
    const key = {}
    const subject = { emits: (): void => {} }
    expect(other.carrierKeyOf(scopeTarget(subject, key))).toBe(key)
    expect(other.isScopeCarrier(scopeTarget(subject, undefined))).toBe(true)
    expect(carrierKeyOf(subject)).toBeUndefined()
    expect(other.carrierKeyOf(subject)).toBeUndefined()
  })
})
