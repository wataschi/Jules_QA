import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENTS_END, AGENTS_START, mergeHookSettings, runInit, skillNames, upsertMarkedSection } from '../../../src/qa-cli/commands/init.js';
import { runCli } from '../../../src/qa-cli/main.js';
import { makeCtx, makeTempRepo, readFile, writeFile } from './_helpers.js';

const HUB = 'https://mac.tail.ts.net';

describe('qa-cli / init', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function repo() {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    fs.mkdirSync(path.join(r.root, '.git'));
    return r.root;
  }

  it('створює конфіг, конвенції, .mcp.json, AGENTS.md, скіли, хуки й workflow', () => {
    const root = repo();
    const self = path.join(root, 'bundle.mjs');
    fs.writeFileSync(self, '#!/usr/bin/env node\nconsole.log(1)\n');
    const actions = runInit({ root, hub: HUB, projectId: 'cyber', selfPath: self });
    expect(actions.every((a) => a.action === 'created')).toBe(true);

    const config = JSON.parse(readFile(root, 'qa/jules.config.json'));
    expect(config.hub).toBe(HUB);
    expect(config.projectId).toBe('cyber');
    expect(config.commands.testFile).toContain('{files}');
    expect(readFile(root, 'qa/conventions.md')).toContain('Конвенції тестів');
    expect(JSON.parse(readFile(root, '.mcp.json'))).toEqual({ mcpServers: { jules: { type: 'http', url: `${HUB}/mcp` } } });
    const agents = readFile(root, 'AGENTS.md');
    expect(agents).toContain(AGENTS_START);
    expect(agents).toContain(AGENTS_END);
    expect(agents).toContain(HUB);
    expect(skillNames()).toEqual(['qa-bootstrap', 'qa-conventions', 'qa-inbox', 'qa-read', 'qa-triage', 'qa-visual', 'qa-weekly']);
    for (const name of skillNames()) expect(readFile(root, `.claude/skills/${name}/SKILL.md`)).toContain(`name: ${name}`);
    const settings = JSON.parse(readFile(root, '.claude/settings.json'));
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'SessionStart', 'Stop']);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit');
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('qa/bin/jules-qa.mjs" hook post-edit');
    expect(readFile(root, 'qa/bin/jules-qa.mjs')).toContain('console.log(1)');
    expect(readFile(root, '.github/workflows/qa-ci.yml')).toContain('tailscale/github-action@v3');
    expect(readFile(root, '.gitattributes')).toContain('QA_STATUS.md linguist-generated=true');
  });

  it('повторний запуск ідемпотентний: нічого не змінює й не дублює', () => {
    const root = repo();
    runInit({ root, hub: HUB, projectId: 'cyber' });
    const snapshot = (rel: string) => readFile(root, rel);
    const before = ['AGENTS.md', '.claude/settings.json', '.mcp.json', 'qa/jules.config.json', '.gitattributes'].map(snapshot);
    const second = runInit({ root, hub: HUB, projectId: 'cyber' });
    expect(second.filter((a) => a.path !== 'qa/bin/jules-qa.mjs').every((a) => a.action === 'unchanged')).toBe(true);
    const after = ['AGENTS.md', '.claude/settings.json', '.mcp.json', 'qa/jules.config.json', '.gitattributes'].map(snapshot);
    expect(after).toEqual(before);
    expect(readFile(root, 'AGENTS.md').split(AGENTS_START).length).toBe(2);
  });

  it('зберігає чужий вміст: AGENTS.md, інші MCP-сервери, наявні хуки й налаштування конфігу', () => {
    const root = repo();
    writeFile(root, 'AGENTS.md', '# Правила репо\n\nПишемо на TypeScript.\n');
    writeFile(root, '.mcp.json', JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://gh' } } }));
    writeFile(root, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npm run lint' }] }] } }));
    writeFile(root, 'qa/jules.config.json', JSON.stringify({ hub: 'https://old', projectId: 'old', reports: { tests: ['custom.xml'] } }));
    writeFile(root, 'qa/conventions.md', '# Наші правила\n');

    runInit({ root, hub: HUB, projectId: 'cyber' });

    const agents = readFile(root, 'AGENTS.md');
    expect(agents.startsWith('# Правила репо\n\nПишемо на TypeScript.\n\n<!-- jules-qa:start -->')).toBe(true);
    expect(JSON.parse(readFile(root, '.mcp.json')).mcpServers.github.url).toBe('https://gh');
    const settings = JSON.parse(readFile(root, '.claude/settings.json'));
    expect(settings.permissions.allow).toEqual(['Bash(npm test)']);
    expect(settings.hooks.Stop[0].hooks.map((h: { command: string }) => h.command)).toEqual([
      'npm run lint',
      expect.stringContaining('hook stop'),
    ]);
    const config = JSON.parse(readFile(root, 'qa/jules.config.json'));
    expect(config).toEqual({ hub: HUB, projectId: 'cyber', reports: { tests: ['custom.xml'] } });
    expect(readFile(root, 'qa/conventions.md')).toBe('# Наші правила\n');
  });

  it('--force перезаписує файли проєкту шаблоном', () => {
    const root = repo();
    writeFile(root, 'qa/conventions.md', '# Наші правила\n');
    writeFile(root, '.github/workflows/qa-ci.yml', 'name: old\n');
    const actions = runInit({ root, hub: HUB, projectId: 'cyber', force: true });
    expect(actions.find((a) => a.path === 'qa/conventions.md')?.action).toBe('updated');
    expect(readFile(root, 'qa/conventions.md')).toContain('Конвенції тестів');
    expect(readFile(root, '.github/workflows/qa-ci.yml')).toContain('name: qa-ci');
  });

  it('без бандла пропускає копію qa/bin з поясненням', () => {
    const root = repo();
    const actions = runInit({ root, hub: HUB, projectId: 'cyber', selfPath: '/x/src/qa-cli/main.ts' });
    const bin = actions.find((a) => a.path === 'qa/bin/jules-qa.mjs');
    expect(bin?.action).toBe('skipped');
    expect(bin?.note).toContain('cli:build');
  });

  it('через runCli: без --hub — помилка використання, з ним — звіт про дії', async () => {
    const root = repo();
    const bad = makeCtx({ cwd: root });
    expect(await runCli(['init', '--project', 'cyber'], bad.ctx)).toBe(1);
    expect(bad.err()).toContain('--hub');
    const ok = makeCtx({ cwd: root });
    expect(await runCli(['init', '--hub', `${HUB}/`, '--project', 'cyber'], ok.ctx)).toBe(0);
    expect(ok.out()).toContain('створено');
    expect(JSON.parse(readFile(root, '.mcp.json')).mcpServers.jules.url).toBe(`${HUB}/mcp`);
  });

  it('битий .claude/settings.json не перезаписується', () => {
    const root = repo();
    writeFile(root, '.claude/settings.json', '{ broken');
    expect(() => runInit({ root, hub: HUB, projectId: 'cyber' })).toThrow(/settings\.json/);
    expect(readFile(root, '.claude/settings.json')).toBe('{ broken');
  });
});

describe('qa-cli / маркери AGENTS.md', () => {
  it('додає розділ у порожній файл', () => {
    expect(upsertMarkedSection('', 'Текст')).toBe(`${AGENTS_START}\nТекст\n${AGENTS_END}\n`);
  });

  it('замінює лише вміст між маркерами', () => {
    const text = `до\n\n${AGENTS_START}\nстаре\n${AGENTS_END}\n\nпісля\n`;
    expect(upsertMarkedSection(text, 'нове')).toBe(`до\n\n${AGENTS_START}\nнове\n${AGENTS_END}\n\nпісля\n`);
  });

  it('без кінцевого маркера дописує новий розділ у кінець', () => {
    const text = `${AGENTS_START}\nобрізано`;
    expect(upsertMarkedSection(text, 'нове').endsWith(`${AGENTS_START}\nнове\n${AGENTS_END}\n`)).toBe(true);
  });
});

describe('qa-cli / злиття settings.json', () => {
  const spec = {
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/qa/bin/jules-qa.mjs" hook post-edit' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/qa/bin/jules-qa.mjs" hook session-start' }] }],
  };

  it('порожні налаштування — додає всі хуки', () => {
    const { settings, changed } = mergeHookSettings(null, spec);
    expect(changed).toBe(true);
    expect((settings.hooks as Record<string, unknown[]>).PostToolUse).toHaveLength(1);
  });

  it('не дублює хук, записаний іншим способом виклику (npx jules-qa …)', () => {
    const existing = {
      hooks: {
        PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'npx jules-qa hook post-edit' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'npx jules-qa inbox --brief' }] }],
      },
    };
    const { settings, changed } = mergeHookSettings(existing, spec);
    expect(changed).toBe(false);
    expect(settings).toEqual(existing);
  });

  it('додає хук у наявну групу з тим самим matcher, не чіпаючи чужих', () => {
    const existing = { hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'prettier --write' }] }] } };
    const { settings } = mergeHookSettings(existing, spec);
    const groups = (settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).PostToolUse;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hooks.map((h) => h.command)).toEqual(['prettier --write', expect.stringContaining('hook post-edit')]);
    expect(existing.hooks.PostToolUse[0]!.hooks).toHaveLength(1);
  });
});
