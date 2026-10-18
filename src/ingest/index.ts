/**
 * Інжест звітів CI для Jules QA: публічний API модуля `src/ingest/`.
 *
 * Чисті функції без бази й мережі — їх використовують і CLI `jules-qa`
 * (у CI продукту), і сервер хаба (`POST /ingest/run`).
 */
export * from './types.js';
export * from './glob.js';
export * from './case-ids.js';
export * from './levels.js';
export * from './junit.js';
export * from './playwright.js';
export * from './jest-like.js';
export * from './coverage.js';
export * from './stryker.js';
export * from './manifest.js';
export * from './assertions.js';
export * from './codeowners.js';
export * from './detect.js';
