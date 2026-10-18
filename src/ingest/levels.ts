/**
 * Рівень тесту (unit / integration / e2e / visual) за шляхом файлу.
 *
 * Конфіг проєкту (`levels` у `qa/jules.config.json`) замінює дефолт лише
 * для тих рівнів, які в ньому названо. Visual перевіряємо раніше за e2e:
 * візуальні тести зазвичай лежать усередині e2e-каталогу.
 */
import { matchAnyGlob } from './glob.js';
import type { LevelConfig, TestLevel } from './types.js';

export const DEFAULT_LEVEL_GLOBS: Readonly<Record<Exclude<TestLevel, 'unit'>, readonly string[]>> = {
  e2e: ['e2e/**', '**/e2e/**', '**/*.e2e.*'],
  integration: ['**/integration/**', '**/*.int.*'],
  visual: ['**/visual/**', '**/*.visual.*'],
};

const ORDER: TestLevel[] = ['visual', 'e2e', 'integration', 'unit'];

export function detectLevel(file: string, config?: LevelConfig): TestLevel {
  for (const level of ORDER) {
    const globs =
      config?.levels?.[level] ?? (level === 'unit' ? undefined : DEFAULT_LEVEL_GLOBS[level]);
    if (globs && matchAnyGlob(globs, file)) return level;
  }
  return 'unit';
}
