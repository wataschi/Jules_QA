/**
 * `jules-qa import <confluence-url>` — запасний шлях імпорту, коли Mac Studio не бачить
 * Confluence: сторінку тягне машина QA з увімкненим VPN (потрібні змінні CONFLUENCE_*),
 * а в Jules іде вже готовий storage-HTML через `POST /sources/import`.
 *
 * Клієнт Confluence підвантажується динамічно, щоб решта команд не залежала від нього.
 */
import { loadConfig, requireProject } from '../config.js';
import { eprintln, println, type CliContext } from '../context.js';
import { hubFor, UsageError, type CommandHandler } from './common.js';

interface ImportedSource {
  id?: string | number;
  sourceId?: string | number;
  blocks?: number;
}

export const importCommand: CommandHandler = async (ctx: CliContext, args) => {
  const url = args.positionals[0];
  if (!url) throw new UsageError('Вкажіть посилання на сторінку: jules-qa import <confluence-url>');
  eprintln(ctx, 'Основний шлях — імпорт у самому Jules. Ця команда запасна: потребує CONFLUENCE_* в оточенні');
  eprintln(ctx, 'і тягне сторінку локально, з цієї машини (через ваш VPN).');

  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const projectId = requireProject(config);
  const hub = hubFor(ctx, config, { timeoutMs: 60_000 });

  const { fetchConfluencePage } = await import('../../integrations/confluence.js');
  const page = await fetchConfluencePage({ url });
  const response = await hub.postJson<ImportedSource>('/sources/import', {
    projectId,
    kind: 'confluence',
    html: page.html,
    title: page.title,
    url: page.url,
    externalId: page.externalId,
    externalVersion: page.version,
  });
  const id = response.sourceId ?? response.id;
  println(ctx, `Jules: імпортовано «${page.title}» (версія ${page.version})${id !== undefined ? `, джерело ${id}` : ''}${response.blocks !== undefined ? `, блоків ${response.blocks}` : ''}.`);
  return 0;
};
