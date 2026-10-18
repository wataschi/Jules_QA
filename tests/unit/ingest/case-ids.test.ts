import { describe, expect, it } from 'vitest';
import { extractCaseIds } from '../../../src/ingest/index.js';

describe('extractCaseIds', () => {
  it('знаходить ID у назві Vitest/Playwright-тесту', () => {
    expect(extractCaseIds('Акти > CYBER-ACT-014 акт без суми не зберігається')).toEqual(['CYBER-ACT-014']);
  });

  it('нормалізує pytest-стиль із підкресленнями до дефісів', () => {
    expect(extractCaseIds('test_CYBER_ACT_014_act_without_amount_is_rejected')).toEqual(['CYBER-ACT-014']);
  });

  it('повертає унікальні ID у порядку появи', () => {
    expect(extractCaseIds('CYBER-ACT-015 і CYBER-ACT-014, знову CYBER_ACT_015; C2-R2D2-1000')).toEqual([
      'CYBER-ACT-015',
      'CYBER-ACT-014',
      'C2-R2D2-1000',
    ]);
  });

  it('не бере частини довших слів і короткі номери', () => {
    expect(extractCaseIds('XCYBER-ACT-014a cyber-act-014 CYBER-ACT-01 aCYBER-ACT-014')).toEqual([]);
  });

  it('для порожнього рядка повертає порожній список', () => {
    expect(extractCaseIds('')).toEqual([]);
  });
});
