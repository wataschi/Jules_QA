/**
 * Тимчасова база реєстру для тестів.
 * Перекриває `REGISTRY_DB`, тому кожен тест працює на власному файлі.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../../../src/registry/db.js';
import { createProject } from '../../../src/registry/projects-store.js';
import { createSection } from '../../../src/registry/sections-store.js';
import { createCase } from '../../../src/registry/cases-store.js';
import type { Case, CaseInput, Project, Section } from '../../../src/registry/types.js';

export interface TempRegistry {
  dir: string;
  file: string;
  cleanup: () => void;
}

export function createTempRegistry(): TempRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-registry-'));
  const file = path.join(dir, 'registry.db');
  closeDb();
  process.env.REGISTRY_DB = file;
  return {
    dir,
    file,
    cleanup: () => {
      closeDb();
      delete process.env.REGISTRY_DB;
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* Windows тримає -wal/-shm — не критично для тесту */
      }
    },
  };
}

export interface Fixture {
  project: Project;
  section: Section;
  child: Section;
}

/** Проєкт CYBER із секцією «Карта договору» і підсекцією «Акти». */
export function seedProject(): Fixture {
  const project = createProject({ key: 'CYBER', name: 'Кібер', description: 'Тестовий проєкт' });
  const section = createSection({ projectId: project.id, name: 'Карта договору' });
  const child = createSection({ projectId: project.id, name: 'Акти', parentId: section.id });
  return { project, section, child };
}

export function seedCase(
  projectId: string,
  sectionId: string,
  input: Partial<CaseInput> & { title: string },
): Case {
  return createCase(projectId, { sectionId, ...input } as CaseInput, { author: 'test' });
}
