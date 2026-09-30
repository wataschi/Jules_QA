/**
 * Наскрізна перевірка циклу реєстру по HTTP.
 *
 * Проходить увесь шлях, який робить інженер: документ → блоки → пропозиція →
 * апрув → кейс → масова правка → експорт у TestRail → ручний прогін зі статусами
 * → дашборд. Нічого не мокає: працює проти запущеного сервера.
 *
 *   npm run start                 # у окремому терміналі
 *   npm run registry:smoke        # або: npx tsx scripts/smoke-registry.ts
 *
 * Змінні: JULES_URL (дефолт http://127.0.0.1:3840), JULES_API_TOKEN (якщо API захищений).
 */
const BASE = (process.env.JULES_URL ?? 'http://127.0.0.1:3840').replace(/\/$/, '');
const API = `${BASE}/api/registry`;
const TOKEN = process.env.JULES_API_TOKEN;

let failures = 0;
let checks = 0;

function ok(label: string, detail = ''): void {
  checks += 1;
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function bad(label: string, detail: string): void {
  checks += 1;
  failures += 1;
  console.error(`  ✕ ${label} — ${detail}`);
}

function expect(condition: unknown, label: string, detail = ''): void {
  if (condition) ok(label, detail);
  else bad(label, detail || 'умова не виконалась');
}

async function call<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { 'X-Jules-User': 'smoke' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const response = await fetch(`${path.startsWith('http') ? '' : API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* лишаємо текстом — це або HTML сторінки, або CSV */
  }
  return { status: response.status, data: data as T };
}

const DOC = `
<h2>Доступність реєстру напрямків</h2>
<p>Реєстр напрямків доступний користувачу з валідним path. У таблиці відображаються активні напрямки.</p>
<h2>Пагінація реєстру</h2>
<p>На сторінці 20 записів. Перехід на наступну сторінку зберігає обраний фільтр.</p>
`.trim();

async function main(): Promise<void> {
  console.log(`Наскрізна перевірка реєстру: ${BASE}\n`);

  // ── 0. Сервер живий ──
  const health = await call('GET', `${BASE}/api/health`);
  expect(health.status === 200, 'сервер відповідає', `GET /api/health → ${health.status}`);
  if (health.status !== 200) {
    console.error('\nСервер недоступний. Запустіть `npm run start` і повторіть.');
    process.exit(1);
  }

  // ── 1. Проєкт ──
  const projects = await call<any[]>('GET', '/projects');
  expect(Array.isArray(projects.data), 'список проєктів доступний');
  let project = (projects.data ?? []).find((p) => p.id === 'smoke');
  if (!project) {
    const created = await call('POST', '/projects', {
      id: 'smoke',
      key: 'SMOKE',
      name: 'Наскрізна перевірка',
      baseUrl: 'https://example.com',
    });
    expect(created.status === 201, 'проєкт створено', `POST /projects → ${created.status}`);
    project = created.data;
  } else {
    ok('проєкт уже існує', project.id);
  }
  const projectId = project.id as string;

  // ── 2. Секція ──
  const sectionTree = await call<any[]>('GET', `/sections?projectId=${projectId}`);
  let section = (sectionTree.data ?? [])[0];
  if (!section) {
    const created = await call('POST', '/sections', { projectId, name: 'Реєстри напрямків' });
    expect(created.status === 201, 'секцію створено', `POST /sections → ${created.status}`);
    section = created.data;
  } else {
    ok('секція вже існує', section.name);
  }
  const sectionId = section.id as string;

  // ── 3. Документ вимог → блоки ──
  const imported = await call<any>('POST', '/sources/import', {
    projectId,
    kind: 'paste',
    title: `Вимоги (перевірка ${new Date().toISOString().slice(11, 19)})`,
    text: DOC,
    format: 'html',
  });
  expect(imported.status === 200 || imported.status === 201, 'документ імпортовано', `→ ${imported.status}`);
  const blocks: any[] = imported.data?.blocks ?? [];
  expect(blocks.length >= 2, 'документ розбито на блоки', `блоків: ${blocks.length}`);
  expect(
    blocks.every((b) => typeof b.hash === 'string' && b.hash.length >= 8),
    'кожен блок має хеш (основа для «що змінилось у вимогах»)',
  );

  const sources = await call<any[]>('GET', `/sources?projectId=${projectId}`);
  const thisSource = (sources.data ?? []).find((s) => s.id === imported.data?.source?.id);
  expect(Boolean(thisSource), 'джерело є у списку');
  expect(
    typeof thisSource?.blockCount === 'number' && typeof thisSource?.gapCount === 'number',
    'джерело віддає лічильники блоків і прогалин',
    `blockCount=${thisSource?.blockCount} gapCount=${thisSource?.gapCount}`,
  );

  // ── 4. Пропозиція кейса (шлях, яким ходять і скіли) → черга апрувів ──
  const proposal = await call<any>('POST', '/proposals', {
    projectId,
    kind: 'case_create',
    title: 'Реєстр напрямків доступний користувачу з валідним path',
    rationale: 'Пряма вимога з блоку документації',
    coverageKind: 'quote',
    origin: { blockId: blocks[0]?.id },
    payload: {
      sectionId,
      title: 'Реєстр напрямків доступний користувачу з валідним path',
      kind: 'positive',
      priority: 'P1',
      preconditions: 'Користувач авторизований',
      checks: ['Сторінка реєстру відкривається', 'У таблиці є щонайменше один запис'],
      tags: ['regression', 'smoke'],
    },
  });
  expect(proposal.status === 201 || proposal.status === 200, 'пропозиція у черзі', `→ ${proposal.status}`);

  const queue = await call<any>('GET', `/proposals?projectId=${projectId}&state=pending`);
  const queued = (queue.data?.items ?? []).find((p: any) => p.id === proposal.data?.id);
  expect(Boolean(queued), 'пропозиція видна у черзі апрувів');
  expect(
    typeof queued?.blockText === 'string' && queued.blockText.length > 0,
    'у черзі видно сам текст вимоги (цитата, а не лише ID блоку)',
    queued?.blockHeading ? `блок: ${queued.blockHeading}` : '',
  );

  const approved = await call<any>('POST', '/proposals/approve', {
    ids: [proposal.data?.id],
    reviewer: 'smoke',
  });
  expect(approved.status === 200, 'апрув виконано', `створено: ${approved.data?.created ?? 0}`);

  // ── 5. Кейс у реєстрі ──
  const cases = await call<any>('GET', `/cases?projectId=${projectId}&limit=100`);
  const created = (cases.data?.items ?? []).find((c: any) => c.title.includes('валідним path'));
  expect(Boolean(created), 'кейс з’явився в реєстрі', created?.id);
  expect(
    /^SMOKE-[A-Z0-9]+-\d{3,}$/.test(created?.id ?? ''),
    'ID кейса має стабільний людський формат',
    created?.id,
  );
  expect(
    (created?.coverage?.quote ?? 0) >= 1,
    'кейс звʼязаний із блоком вимоги як цитата',
    `quote=${created?.coverage?.quote} derived=${created?.coverage?.derived}`,
  );

  // ── 6. Пошук кирилицею (той самий біль, що в TestRail) ──
  const search = await call<any>('GET', `/cases?projectId=${projectId}&q=${encodeURIComponent('РЕЄСТР')}`);
  expect((search.data?.total ?? 0) >= 1, 'FTS-пошук знаходить кейс у верхньому регістрі', `знайдено: ${search.data?.total}`);

  // ── 7. Масова заміна: dry-run → застосування → відкат ──
  const dry = await call<any>('POST', '/cases/bulk', {
    projectId,
    caseIds: [created.id],
    operation: { op: 'replace-text', find: 'реєстру', replace: 'каталогу', fields: ['title', 'checks'] },
    dryRun: true,
  });
  expect((dry.data?.occurrences ?? 0) >= 1, 'dry-run рахує входження', `входжень: ${dry.data?.occurrences}`);
  expect(dry.data?.applied === false, 'dry-run нічого не змінює');

  const applied = await call<any>('POST', '/cases/bulk', {
    projectId,
    caseIds: [created.id],
    operation: { op: 'replace-text', find: 'реєстру', replace: 'каталогу', fields: ['title', 'checks'] },
    dryRun: false,
    reason: 'наскрізна перевірка',
  });
  expect(applied.data?.applied === true, 'масову правку застосовано', `batchId: ${applied.data?.batchId ?? '—'}`);

  const afterBulk = await call<any>('GET', `/cases/${created.id}`);
  expect(
    JSON.stringify(afterBulk.data?.checks ?? []).includes('каталогу') ||
      (afterBulk.data?.title ?? '').includes('каталогу'),
    'текст справді змінився',
  );

  if (applied.data?.batchId) {
    const undone = await call<any>('POST', '/cases/bulk/undo', { batchId: applied.data.batchId });
    expect(undone.status === 200, 'відкат пакета працює', `повернено: ${undone.data?.reverted ?? '?'}`);
    const afterUndo = await call<any>('GET', `/cases/${created.id}`);
    expect(
      (afterUndo.data?.title ?? '').includes('Реєстр') ||
        JSON.stringify(afterUndo.data?.checks ?? []).includes('реєстру'),
      'після відкату текст повернувся',
    );
  }

  // ── 8. Історія кейса ──
  const history = await call<any>('GET', `/cases/${created.id}/history`);
  expect((history.data?.revisions?.length ?? 0) >= 1, 'історія кейса пише ревізії', `ревізій: ${history.data?.revisions?.length}`);

  // ── 9. Експорт у TestRail (файлами, без API) ──
  const mappings = await call<any[]>('GET', `/testrail/mappings?projectId=${projectId}`);
  let mapping = (mappings.data ?? [])[0];
  if (!mapping) {
    const createdMapping = await call<any>('POST', '/testrail/mappings', {
      projectId,
      name: 'Стандартний',
      template: 'checklist',
      typeMap: { positive: 1, negative: 2, neutral: 6, security: 3, a11y: 6, performance: 5 },
      priorityMap: { P1: 4, P2: 3, P3: 2, P4: 1 },
      idField: 'custom_tc_id',
    });
    expect(createdMapping.status === 201 || createdMapping.status === 200, 'профіль мапінгу створено');
    mapping = createdMapping.data;
  } else {
    ok('профіль мапінгу вже є', mapping.name);
  }

  // BOM перевіряємо на байтах: fetch.text() зрізає його при декодуванні UTF-8.
  const csvResponse = await fetch(`${API}/export/testrail.csv?projectId=${projectId}&mappingId=${mapping.id}`, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  const csvBytes = new Uint8Array(await csvResponse.arrayBuffer());
  const csvText = new TextDecoder('utf-8').decode(csvBytes);
  expect(csvResponse.status === 200, 'CSV віддається', `${csvBytes.length} байтів`);
  expect(
    csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
    'CSV має BOM у байтах (Excel не ламає кирилицю)',
  );
  expect(csvText.includes(created.id), 'у CSV є наш ID кейса (round-trip)', created.id);

  const xml = await call<string>('GET', `/export/testrail.xml?projectId=${projectId}&mappingId=${mapping.id}`);
  expect(xml.status === 200 && String(xml.data).includes('<suite'), 'XML віддається');

  const drift = await call<any>('GET', `/testrail/drift?projectId=${projectId}`);
  expect(Array.isArray(drift.data), 'дрейф віддається масивом (те, що читає інтерфейс)');

  // ── 10. Ручний прогін зі статусами й дефектом ──
  const run = await call<any>('POST', '/runs', {
    projectId,
    kind: 'manual',
    title: `Наскрізна перевірка ${new Date().toISOString().slice(11, 16)}`,
    caseIds: [created.id],
    env: { baseUrl: 'https://example.com' },
  });
  expect(run.status === 201, 'ручний прогін створено', run.data?.id);

  const statusSet = await call<any>('PUT', `/runs/${run.data.id}/items/${created.id}`, {
    status: 'failed',
    comment: 'Перевірка дефекту з наскрізного прогону',
    defect: { title: 'Реєстр не відкривається за прямим path', severity: 'high' },
  });
  expect(statusSet.status === 200, 'статус кейса в прогоні виставлено');

  const runDetail = await call<any>('GET', `/runs/${run.data.id}`);
  expect(runDetail.data?.summary?.failed === 1, 'зведення прогону рахує падіння', JSON.stringify(runDetail.data?.summary));

  const defects = await call<any>('GET', `/defects?projectId=${projectId}`);
  expect((defects.data?.total ?? 0) >= 1, 'дефект створено з прогону', `дефектів: ${defects.data?.total}`);

  const rerun = await call<any>('POST', `/runs/${run.data.id}/rerun-failed`);
  expect(rerun.status === 201 || rerun.status === 200, 'перезапуск лише впалих створює новий прогін', rerun.data?.id);

  const completed = await call<any>('PATCH', `/runs/${run.data.id}`, { state: 'completed' });
  expect(completed.data?.state === 'completed', 'прогін закривається');

  // ── 11. Історія кейса бачить результат прогону ──
  const historyAfterRun = await call<any>('GET', `/cases/${created.id}/history`);
  expect(
    (historyAfterRun.data?.results?.length ?? 0) >= 1,
    'результат прогону дійшов до історії кейса (зворотний звʼязок циклу)',
    `результатів: ${historyAfterRun.data?.results?.length}`,
  );

  // ── 12. Дашборд ──
  const dashboard = await call<any>('GET', `/dashboard?projectId=${projectId}`);
  expect(dashboard.status === 200, 'дашборд відповідає');
  expect((dashboard.data?.cases?.total ?? 0) >= 1, 'дашборд бачить кейси', `кейсів: ${dashboard.data?.cases?.total}`);
  expect(
    typeof dashboard.data?.coverage?.blocks === 'number',
    'дашборд рахує покриття вимог',
    `блоків: ${dashboard.data?.coverage?.blocks}, прогалин: ${dashboard.data?.coverage?.gaps}`,
  );
  expect(
    (dashboard.data?.runs?.last7d ?? 0) >= 1,
    'дашборд бачить прогони за 7 днів',
    `прогонів: ${dashboard.data?.runs?.last7d}`,
  );

  // ── 13. Інтерфейс збудований і роздається ──
  const ui = await call<string>('GET', BASE);
  expect(ui.status === 200 && String(ui.data).includes('<div id="root"'), 'дашборд роздається сервером');

  console.log(`\nПеревірок: ${checks}, провалених: ${failures}`);
  if (failures > 0) process.exit(1);
  console.log('Цикл працює наскрізно.');
}

main().catch((error) => {
  console.error('\nПеревірка впала:', error instanceof Error ? error.message : error);
  process.exit(1);
});
