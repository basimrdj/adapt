import { describe, expect, it, afterEach } from 'vitest';
import { parseFilterLists } from '../../src/page/filtering/compiler';
import { applyIsolatedScriptlet } from '../../src/page/filtering/scriptlets';

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
});

describe('Phase 3.1B scriptlet lifecycle', () => {
  it('marks DOM transformations for mutation reapplication', () => {
    const bundle = parseFilterLists([{ id: 1, text: "example.com#%#//scriptlet('remove-attr', 'data-ad', '.slot')" }]);
    expect(bundle.scriptlets[0]).toMatchObject({ lifecycle: 'REAPPLY_ON_MUTATION', supported: true });
  });

  it('reapplies remove-attr semantics to nodes created after the first pass', () => {
    const nodes: Array<{ removeAttribute: (name: string) => void; removed: string[] }> = [];
    const documentStub = {
      querySelectorAll: () => nodes,
    };
    (globalThis as Record<string, unknown>).document = documentStub;

    const first: { removed: string[]; removeAttribute: (name: string) => void } = { removed: [], removeAttribute(name: string) { this.removed.push(name); } };
    nodes.push(first);
    expect(applyIsolatedScriptlet('remove-attr', ['data-ad', '.slot'])).toBe('applied');
    expect(first.removed).toEqual(['data-ad']);

    const future: { removed: string[]; removeAttribute: (name: string) => void } = { removed: [], removeAttribute(name: string) { this.removed.push(name); } };
    nodes.push(future);
    expect(applyIsolatedScriptlet('remove-attr', ['data-ad', '.slot'])).toBe('applied');
    expect(future.removed).toEqual(['data-ad']);
  });
});
