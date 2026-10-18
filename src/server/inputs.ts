/**
 * Прийом вхідних даних проєкту: дерево сторінок Confluence зі схемами й
 * картинками та кадри Figma. Тут мережеві інтеграції (чисті функції)
 * зшиваються зі сховищами; модель не потрібна.
 *
 * Схема (docs/agent-driven-qa-plan.md, 2.1–2.5):
 *  1. `loadConfluenceTree` — дерево сторінок без тіл, людина ставить галочки;
 *  2. `syncConfluenceSource` — тіло сторінки → блоки, вкладення, схеми (текст
 *     без моделі), посилання на Figma і Jira; картинка без тексту → `read_asset`;
 *  3. `importFigma` / `syncFigmaSource` — кадр = блок вимоги + знімок;
 *  4. `assignModulesFromTree` — модулі з дерева сторінок + задачі плану.
 * Зміна блоку, з яким уже зв'язані кейси, дає пропозицію `case_update`.
 */
import {
  downloadAttachment,
  downloadUrl,
  fetchConfluencePage,
  fetchPageTree,
  isConfluenceConfigured,
  readConfluenceConfig,
  splitIntoBlocksWithAssets,
  type AssetRef,
  type ConfluenceRequestOptions,
} from '../integrations/confluence.js';
import { drawioToText, parseDrawio } from '../integrations/drawio.js';
import { gliffyToText, parseGliffy } from '../integrations/gliffy.js';
import {
  createFigmaClientFromEnv,
  extractFrames,
  extractFramesFromFile,
  frameToBlockText,
  isFigmaConfigured,
  parseFigmaUrl,
  type FigmaFrame,
} from '../integrations/figma.js';
import { pruneBlockAssets, storeAssetFile, upsertAsset } from '../registry/assets-store.js';
import { createProposal, type CreateProposalInput } from '../registry/proposals-store.js';
import { requireProject, updateProject } from '../registry/projects-store.js';
import { createSection, getSectionByName } from '../registry/sections-store.js';
import {
  casesForBlocks,
  descendantSourceIds,
  liveBlocks,
  listSources,
  markSourceChecked,
  pruneBlockLinks,
  refreshSource,
  requireSource,
  resolveFigmaLinks,
  setBlockExtras,
  setSourceFlags,
  setSourceTreePosition,
  setSourceVersion,
  upsertBlockLink,
  upsertSourceStub,
  type RawBlockInput,
  type RefreshResult,
} from '../registry/sources-store.js';
import type { Proposal, Source } from '../registry/types.js';
import { requestModulePlan, requestReading } from './workflow.js';

export interface InputOptions {
  /** Для тестів: підміна мережі. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  author?: string;
}

function requestOptions(options: InputOptions): ConfluenceRequestOptions {
  return { fetch: options.fetch, sleep: options.sleep };
}

/* ───────────────────────────── пропозиції ──────────────────────────────── */

/** Змінені й видалені блоки, з якими вже зв'язані кейси, → пропозиції перевірити кейс. */
function proposeCaseUpdates(source: Source, result: RefreshResult, what: string): Proposal[] {
  const touched = casesForBlocks([...result.changed, ...result.removed]);
  return touched.map((link) =>
    createProposal({
      projectId: source.projectId,
      kind: 'case_update',
      title: `${what} змінилась — перевірте кейс ${link.caseId}`,
      rationale: `Блок «${source.title}» змінився після оновлення джерела`,
      payload: { caseId: link.caseId, changes: {} },
      origin: { sourceId: source.id, blockId: link.blockId, caseId: link.caseId },
    } satisfies CreateProposalInput),
  );
}

/* ─────────────────────────────── Confluence ────────────────────────────── */

export function confluenceNotConfigured(): string {
  return 'Confluence не налаштовано: потрібні CONFLUENCE_BASE_URL і CONFLUENCE_TOKEN (PAT) у .env';
}

/** Дерево сторінок без тіл: створює й оновлює вузли, не чіпаючи галочок людини. */
export async function loadConfluenceTree(
  projectId: string,
  ref: string,
  options: InputOptions & { maxPages?: number } = {},
): Promise<{ sources: Source[]; truncated: boolean }> {
  const project = requireProject(projectId);
  if (!isConfluenceConfigured()) throw new Error(confluenceNotConfigured());
  const tree = await fetchPageTree(ref, { maxPages: options.maxPages, ...requestOptions(options) });

  const byPageId = new Map<string, Source>();
  for (const page of tree.pages) {
    byPageId.set(
      page.id,
      upsertSourceStub({
        projectId,
        kind: 'confluence',
        title: page.title,
        url: page.url,
        externalId: page.id,
        depth: page.depth,
      }),
    );
  }
  const rootSource = tree.root ? byPageId.get(tree.root.id) : undefined;
  for (const page of tree.pages) {
    const source = byPageId.get(page.id);
    if (!source) continue;
    const parent = page.parentId ? byPageId.get(page.parentId) : undefined;
    setSourceTreePosition(source.id, parent?.id ?? null, rootSource && source.id !== rootSource.id ? rootSource.id : null);
  }

  if (!project.settings.confluenceRoots.includes(ref)) {
    updateProject(projectId, { settings: { ...project.settings, confluenceRoots: [...project.settings.confluenceRoots, ref] } });
  }
  return { sources: [...byPageId.values()].map((source) => requireSource(source.id)), truncated: tree.truncated };
}

/** Хости, з яких дозволено тягнути зовнішні картинки сторінок, крім самої Confluence. */
function allowedAssetHost(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    host = parsed.host.toLowerCase();
  } catch {
    return false;
  }
  try {
    if (new URL(readConfluenceConfig().baseUrl).host.toLowerCase() === host) return true;
  } catch {
    /* Confluence не налаштовано */
  }
  return (process.env.JULES_ASSET_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(host);
}

interface AssetOutcome {
  kind: 'image' | 'diagram';
  name: string;
  readTask: string | null;
  error?: string;
}

async function ingestAssetRef(
  source: Source,
  pageId: string,
  blockId: string,
  ref: AssetRef,
  options: InputOptions,
  author: string,
): Promise<AssetOutcome> {
  const base = { projectId: source.projectId, sourceId: source.id, blockId };
  const opts = requestOptions(options);
  try {
    if (ref.kind === 'image') {
      let file: { data: Buffer; mediaType: string } | null = null;
      let error: string | undefined;
      if (ref.source === 'attachment' && !ref.page) {
        file = await downloadAttachment(pageId, ref.name, opts);
      } else if (ref.source === 'url' && ref.url) {
        if (allowedAssetHost(ref.url)) file = await downloadUrl(ref.url, opts);
        else error = 'Зовнішнє зображення не завантажено: хоста немає в JULES_ASSET_HOSTS';
      } else {
        error = 'Вкладення з іншої сторінки — відкрийте ту сторінку в дереві';
      }
      const stored = file ? storeAssetFile(file.data) : undefined;
      const { asset, needsReading } = upsertAsset({
        ...base,
        kind: 'image',
        name: ref.name,
        mediaType: file?.mediaType,
        sha256: stored?.sha256,
        size: stored?.size,
        originUrl: ref.url,
        extractedText: ref.alt && ref.alt !== ref.name ? `Підпис: ${ref.alt}` : '',
        error,
      });
      return { kind: 'image', name: ref.name, readTask: needsReading ? requestReading(asset, author) : null, error };
    }

    // Схеми: текст дістаємо без моделі, знімок — для людини і для агента.
    const owner = ref.pageId ?? pageId;
    let text = '';
    let preview: { data: Buffer; mediaType: string } | null = null;
    let error: string | undefined;
    if (ref.diagramType === 'plantuml' || ref.diagramType === 'mermaid') {
      text = ref.source?.trim() ? `${ref.diagramType === 'plantuml' ? 'PlantUML' : 'Mermaid'}:\n${ref.source.trim()}` : '';
    } else if (ref.diagramType === 'drawio' || ref.diagramType === 'gliffy') {
      const raw = await downloadAttachment(owner, ref.name, opts);
      const content = raw.data.toString('utf8');
      text = ref.diagramType === 'drawio' ? drawioToText(parseDrawio(content)) : gliffyToText(parseGliffy(content));
      preview = await downloadAttachment(owner, `${ref.name}.png`, opts).catch(() => null);
      if (!text.trim()) error = 'Схему не вдалося розібрати — потрібне прочитання';
    } else {
      error = `Схема «${ref.macro}» не віддає даних через API — додайте скрін або опис на сторінку`;
    }
    const stored = preview ? storeAssetFile(preview.data) : undefined;
    const { asset, needsReading } = upsertAsset({
      ...base,
      kind: 'diagram',
      name: ref.name,
      diagramType: ref.diagramType,
      mediaType: preview?.mediaType,
      sha256: stored?.sha256,
      size: stored?.size,
      extractedText: text,
      error,
    });
    return { kind: 'diagram', name: ref.name, readTask: needsReading ? requestReading(asset, author) : null, error };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    upsertAsset({ ...base, kind: ref.kind, name: ref.name, diagramType: ref.kind === 'diagram' ? ref.diagramType : undefined, error: message });
    return { kind: ref.kind, name: ref.name, readTask: null, error: message };
  }
}

export interface SyncResult {
  sourceId: string;
  title: string;
  unchanged: boolean;
  changed: number;
  added: number;
  removed: number;
  proposals: number;
  assets: number;
  readTasks: string[];
  assetErrors: Array<{ name: string; error: string }>;
}

/** Тіло однієї сторінки → блоки, вкладення, зв'язки. Без змін версії — нічого не робить. */
export async function syncConfluenceSource(sourceId: string, options: InputOptions & { force?: boolean } = {}): Promise<SyncResult> {
  const source = requireSource(sourceId);
  if (source.kind !== 'confluence' || !source.externalId) throw new Error('Це джерело не є сторінкою Confluence');
  const author = options.author ?? 'jules';
  const empty: SyncResult = {
    sourceId,
    title: source.title,
    unchanged: true,
    changed: 0,
    added: 0,
    removed: 0,
    proposals: 0,
    assets: 0,
    readTasks: [],
    assetErrors: [],
  };
  try {
    const page = await fetchConfluencePage({ pageId: source.externalId }, requestOptions(options));
    const hasBlocks = liveBlocks(sourceId).length > 0;
    if (!options.force && hasBlocks && page.version === source.externalVersion) {
      markSourceChecked(sourceId);
      return empty;
    }

    const parsed = splitIntoBlocksWithAssets(page.html);
    const result = refreshSource(sourceId, parsed.map(({ heading, anchor, text, position }) => ({ heading, anchor, text, position })));
    setSourceVersion(sourceId, page.version);
    const proposals = hasBlocks ? proposeCaseUpdates(source, result, 'Вимога') : [];

    const byPosition = new Map(liveBlocks(sourceId).map((block) => [block.position, block]));
    const outcome: SyncResult = {
      ...empty,
      unchanged: false,
      changed: result.changed.length,
      added: result.added.length,
      removed: result.removed.length,
      proposals: proposals.length,
    };
    for (const raw of parsed) {
      const block = byPosition.get(raw.position);
      if (!block) continue;
      setBlockExtras(block.id, { meta: { figmaLinks: raw.figmaLinks, jiraKeys: raw.jiraKeys } });
      for (const link of raw.figmaLinks) {
        upsertBlockLink({ projectId: source.projectId, fromBlockId: block.id, url: link.url, fileKey: link.fileKey, nodeId: link.nodeId });
      }
      pruneBlockLinks(block.id, raw.figmaLinks.map((link) => link.url));
      for (const ref of raw.assets) {
        const assetOutcome = await ingestAssetRef(source, source.externalId, block.id, ref, options, author);
        outcome.assets += 1;
        if (assetOutcome.readTask) outcome.readTasks.push(assetOutcome.readTask);
        if (assetOutcome.error) outcome.assetErrors.push({ name: assetOutcome.name, error: assetOutcome.error });
      }
      pruneBlockAssets(block.id, raw.assets.map((ref) => ({ kind: ref.kind, name: ref.name })));
    }
    resolveFigmaLinks(source.projectId);
    markSourceChecked(sourceId);
    return outcome;
  } catch (error) {
    markSourceChecked(sourceId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Усі вибрані сторінки проєкту; помилка однієї не зупиняє інших. */
export async function syncProjectInputs(
  projectId: string,
  options: InputOptions & { force?: boolean } = {},
): Promise<{ results: SyncResult[]; errors: Array<{ sourceId: string; title: string; error: string }> }> {
  const results: SyncResult[] = [];
  const errors: Array<{ sourceId: string; title: string; error: string }> = [];
  for (const source of listSources(projectId)) {
    if (!source.included || !source.externalId) continue;
    try {
      if (source.kind === 'confluence') results.push(await syncConfluenceSource(source.id, options));
      else if (source.kind === 'figma') results.push(await syncFigmaSource(source.id, options));
    } catch (error) {
      errors.push({ sourceId: source.id, title: source.title, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, errors };
}

/**
 * Модулі з дерева: сторінки першого рівня під коренем стають секціями (якщо
 * такої назви ще нема), уся гілка сторінок отримує цей модуль, а на кожен
 * новий модуль створюється задача плану покриття.
 */
export function assignModulesFromTree(
  projectId: string,
  rootSourceId: string,
  author: string,
): { sections: Array<{ id: string; name: string; created: boolean; planTask: string | null }> } {
  const root = requireSource(rootSourceId);
  if (root.projectId !== projectId) throw new Error('Корінь дерева належить іншому проєкту');
  const children = listSources(projectId).filter((source) => source.parentId === root.id && source.included);
  const sections: Array<{ id: string; name: string; created: boolean; planTask: string | null }> = [];
  for (const child of children) {
    const existing = getSectionByName(projectId, child.title, null);
    const section = existing ?? createSection({ projectId, name: child.title });
    for (const id of [child.id, ...descendantSourceIds(child.id)]) setSourceFlags(id, { sectionId: section.id });
    const planTask = requestModulePlan(projectId, section.id, section.name, author);
    sections.push({ id: section.id, name: section.name, created: !existing, planTask });
  }
  return { sections };
}

/* ──────────────────────────────── Figma ────────────────────────────────── */

const MAX_FRAMES = 200;

export function figmaNotConfigured(): string {
  return 'Figma не налаштовано: потрібен FIGMA_TOKEN (персональний токен користувача з місцем Full або Dev)';
}

/** Файл або кадр Figma як джерело вимог. Повторний імпорт того самого посилання оновлює джерело. */
export async function importFigma(projectId: string, url: string, options: InputOptions = {}): Promise<SyncResult> {
  const project = requireProject(projectId);
  if (!isFigmaConfigured()) throw new Error(figmaNotConfigured());
  const ref = parseFigmaUrl(url);
  if (!ref) throw new Error('Не схоже на посилання Figma: очікується figma.com/design/<ключ>/…');
  const externalId = ref.nodeId ? `${ref.fileKey}:${ref.nodeId}` : ref.fileKey;
  const source = upsertSourceStub({ projectId, kind: 'figma', title: `Figma ${ref.fileKey}`, url, externalId });
  if (!project.settings.figmaFiles.includes(url)) {
    updateProject(projectId, { settings: { ...project.settings, figmaFiles: [...project.settings.figmaFiles, url] } });
  }
  return syncFigmaSource(source.id, { ...options, force: true });
}

export async function syncFigmaSource(sourceId: string, options: InputOptions & { force?: boolean } = {}): Promise<SyncResult> {
  const source = requireSource(sourceId);
  if (source.kind !== 'figma' || !source.externalId) throw new Error('Це джерело не є файлом Figma');
  const [fileKey, ...rest] = source.externalId.split(':');
  const nodeId = rest.length ? rest.join(':') : undefined;
  const client = createFigmaClientFromEnv({ fetch: options.fetch, sleep: options.sleep });
  const empty: SyncResult = {
    sourceId,
    title: source.title,
    unchanged: true,
    changed: 0,
    added: 0,
    removed: 0,
    proposals: 0,
    assets: 0,
    readTasks: [],
    assetErrors: [],
  };
  try {
    const meta = await client.getVersion(fileKey);
    const hasBlocks = liveBlocks(sourceId).length > 0;
    if (!options.force && hasBlocks && meta.version === source.externalVersion) {
      markSourceChecked(sourceId);
      return empty;
    }

    let frames: FigmaFrame[];
    if (nodeId) {
      const nodes = await client.getNodes(fileKey, [nodeId]);
      const document = nodes[nodeId]?.document;
      if (!document) throw new Error(`Вузол ${nodeId} не знайдено у файлі Figma`);
      frames = extractFrames(document);
    } else {
      frames = extractFramesFromFile(await client.getFile(fileKey));
    }
    frames = frames.slice(0, MAX_FRAMES);

    const blocks: RawBlockInput[] = frames.map((frame, position) => ({
      heading: frame.pageName ? `${frame.pageName} / ${frame.name}` : frame.name,
      anchor: frame.nodeId,
      text: frameToBlockText(frame),
      position,
    }));
    const result = refreshSource(sourceId, blocks);
    setSourceVersion(sourceId, meta.version);
    setSourceFlags(sourceId, {});
    updateSourceTitle(sourceId, nodeId ? `${meta.name} · ${frames[0]?.name ?? nodeId}` : meta.name);
    const proposals = hasBlocks ? proposeCaseUpdates(source, result, 'Макет') : [];

    const byPosition = new Map(liveBlocks(sourceId).map((block) => [block.position, block]));
    const images = await client.getImageUrls(fileKey, frames.map((frame) => frame.nodeId), { format: 'png', scale: 1 }).catch(() => ({}) as Record<string, string | null>);
    const outcome: SyncResult = {
      ...empty,
      title: meta.name,
      unchanged: false,
      changed: result.changed.length,
      added: result.added.length,
      removed: result.removed.length,
      proposals: proposals.length,
    };
    for (const [position, frame] of frames.entries()) {
      const block = byPosition.get(position);
      if (!block) continue;
      setBlockExtras(block.id, { nodeId: frame.nodeId, meta: { components: frame.components, pageName: frame.pageName } });
      let stored: { sha256: string; size: number } | undefined;
      let error: string | undefined;
      const imageUrl = images[frame.nodeId];
      if (imageUrl) {
        try {
          stored = storeAssetFile((await client.download(imageUrl)).data);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      }
      upsertAsset({
        projectId: source.projectId,
        sourceId,
        blockId: block.id,
        kind: 'frame',
        name: frame.name,
        mediaType: stored ? 'image/png' : undefined,
        sha256: stored?.sha256,
        size: stored?.size,
        originUrl: `https://www.figma.com/design/${fileKey}?node-id=${frame.nodeId.replace(':', '-')}`,
        extractedText: frame.texts.join('\n'),
        error,
      });
      outcome.assets += 1;
      if (error) outcome.assetErrors.push({ name: frame.name, error });
    }
    resolveFigmaLinks(source.projectId);
    markSourceChecked(sourceId);
    return outcome;
  } catch (error) {
    markSourceChecked(sourceId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function updateSourceTitle(id: string, title: string): void {
  const source = requireSource(id);
  upsertSourceStub({ projectId: source.projectId, kind: source.kind, title, externalId: source.externalId as string, depth: source.depth, parentId: source.parentId ?? null, rootId: source.rootId ?? null });
}
