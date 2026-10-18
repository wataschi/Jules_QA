# Плагін Jules QA для Claude Code

Конвенції тестів, задачі QA з хаба Jules (через MCP-сервер `jules`) і хуки, які проганяють
тести, поки агент працює. Стан плагін не зберігає: він живе в Jules і в git.

| Що | Навіщо |
|----|--------|
| `skills/qa-conventions` | Формат тестів: піраміда, ID кейса в назві, заборонені патерни, тексти з макета |
| `skills/qa-inbox` | Задачі QA: агент пропонує, розробник вирішує; оренда; результат лише PR |
| `skills/qa-bootstrap` | Первинне покриття модуля: інвентар → план на погодження → тести |
| `skills/qa-read` | Опис картинок і схем на погодження QA |
| `skills/qa-triage` | Класифікація падінь на main без зміни асертів |
| `skills/qa-weekly` | Висновки до тижневого звіту з цифр Jules |
| `skills/qa-visual` | Звірка інтерфейсу з макетом Figma |
| `hooks/hooks.json` | `PostToolUse` — прогін зміненого тест-файлу; `Stop` — пов'язані тести; `SessionStart` — задачі QA |
| `templates/` | `qa/jules.config.json`, `qa/conventions.md`, розділ `AGENTS.md` для репо продукту |

Хуки й скіли викликають CLI `qa/bin/jules-qa.mjs` у репо продукту. Без нього (або без
Tailscale) хуки тихо нічого не роблять.

## Встановлення в репо продукту (рекомендовано)

Один крок кладе все в репо, тож воно працює в кожного розробника після `git pull`, без
встановлення плагіна:

```bash
# з машини в tailnet
curl -fsS https://<mac>.<tailnet>.ts.net/cli/jules-qa.mjs -o /tmp/jules-qa.mjs
node /tmp/jules-qa.mjs init --hub https://<mac>.<tailnet>.ts.net --project <id-проєкту>
```

`init` створює або оновлює:

- `qa/jules.config.json` — адреса Jules, проєкт, де лежать звіти тестів, команди прогону;
- `qa/conventions.md` — конвенції проєкту (перекривають скіл `qa-conventions`);
- `qa/bin/jules-qa.mjs` — сам CLI;
- `.mcp.json` — MCP-сервер `jules` (`https://<mac>.<tailnet>.ts.net/mcp`);
- `AGENTS.md` — розділ між `<!-- jules-qa:start -->` і `<!-- jules-qa:end -->` для агентів без скілів;
- `.claude/skills/qa-*` і хуки в `.claude/settings.json` (злиття з наявним, без дублів);
- `.github/workflows/qa-ci.yml` — CI, якщо його ще немає;
- `.gitattributes` — `QA_STATUS.md` позначено як згенерований.

Повторний запуск безпечний: оновлює скіли, хуки й CLI до поточної версії, файли проєкту
(`conventions.md`, `qa-ci.yml`) не чіпає. `--force` перезаписує і їх.

Після `init`:

1. Перевірте `reports` і `commands` у `qa/jules.config.json` під свій раннер.
2. У GitHub додайте `vars.JULES_URL`, `secrets.JULES_TOKEN` (Jules → «Налаштування» → токен CI),
   `secrets.TS_OAUTH_CLIENT_ID`, `secrets.TS_OAUTH_SECRET`.
3. За бажанням — pre-commit `node qa/bin/jules-qa.mjs manifest --check`.
4. Закомітьте зміни через PR.

## Встановлення як плагін Claude Code

Для розробника, який хоче скіли в усіх своїх репо:

```bash
claude plugin marketplace add <шлях або git-URL репо Jules>   # якщо плагін опубліковано в маркетплейсі
claude plugin install jules-qa
```

або локально під час розробки плагіна: `claude --plugin-dir plugin/jules-qa`.

Хукам плагіна однаково потрібен `qa/bin/jules-qa.mjs` у репо продукту (`init`).

## Оновлення шаблонів

Файли плагіна — джерело для `init`: CLI вбудовує їх у себе під час збірки
(`node scripts/build-qa-cli.mjs` → `src/qa-cli/templates.ts` і `dist/qa-cli/jules-qa.mjs`).
Після правки скіла чи шаблону перезберіть CLI.
