import { describe, expect, it } from 'vitest';
import { detectLevel } from '../../../src/ingest/index.js';

describe('detectLevel', () => {
  it('за дефолтами розпізнає e2e, integration, visual, решта — unit', () => {
    expect(detectLevel('e2e/acts.spec.ts')).toBe('e2e');
    expect(detectLevel('apps/web/e2e/acts.spec.ts')).toBe('e2e');
    expect(detectLevel('src/acts.e2e.ts')).toBe('e2e');
    expect(detectLevel('tests/integration/db.test.ts')).toBe('integration');
    expect(detectLevel('src/db.int.test.ts')).toBe('integration');
    expect(detectLevel('tests/visual/card.spec.ts')).toBe('visual');
    expect(detectLevel('src/card.visual.spec.ts')).toBe('visual');
    expect(detectLevel('src/acts/acts.test.ts')).toBe('unit');
  });

  it('visual усередині e2e-каталогу — visual', () => {
    expect(detectLevel('e2e/visual/card.spec.ts')).toBe('visual');
  });

  it('конфіг замінює дефолт лише для названих рівнів', () => {
    const config = { levels: { e2e: ['ui-tests/**'], unit: ['legacy/e2e/**'] } };
    expect(detectLevel('ui-tests/login.spec.ts', config)).toBe('e2e');
    expect(detectLevel('e2e/acts.spec.ts', config)).toBe('unit');
    expect(detectLevel('tests/integration/db.test.ts', config)).toBe('integration');
    expect(detectLevel('legacy/e2e/x.test.ts', config)).toBe('unit');
  });

  it('для порожнього шляху повертає unit', () => {
    expect(detectLevel('')).toBe('unit');
  });
});
