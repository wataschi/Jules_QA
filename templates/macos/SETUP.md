# Розгортання Jules QA на Mac Studio

Покроково: від чистої macOS до Jules, доступного команді через Tailscale, з нічним бекапом.
Архітектура й причини рішень — у `docs/agent-driven-qa-plan.md`, розділ 4.5.

Позначення нижче:

- `jules` — обліковий запис macOS, від імені якого працює служба (не адміністратор);
- `/Users/jules/Jules_QA` — каталог клону (у шаблонах `__JULES_DIR__`);
- `/Volumes/Backup/jules-qa` — каталог бекапів на іншому диску (`__BACKUP_DIR__`);
- `<mac>.<tailnet>.ts.net` — ім'я Mac Studio в tailnet.

## 1. Безперервність

Mac має пережити вимкнення світла й не засинати.

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10
sudo pmset -a autorestart 1        # увімкнутися після збою живлення
sudo pmset -a womp 1               # пробудження з мережі
sudo pmset -a powernap 0
pmset -g                           # перевірка
```

- Увімкніть FileVault (у Jules лежить копія Confluence і кейси).
- «Системні параметри → Користувачі й групи → Автоматичний вхід» не потрібен: служби
  стартують без входу користувача. Якщо FileVault вимагає пароль після перезавантаження,
  налаштуйте `sudo fdesetup authrestart` для планових перезапусків.

## 2. Node 24 і код

```bash
xcode-select --install                       # git і компілятор для нативних модулів
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@24 sqlite rsync
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zprofile && source ~/.zprofile
node -v                                      # v24.x

sudo -u jules git clone <git-URL Jules> /Users/jules/Jules_QA
cd /Users/jules/Jules_QA
npm ci
npm run ui:build
```

## 3. Налаштування `.env`

```bash
cp .env.example .env && chmod 600 .env
```

Заповніть (сервісні облікові записи, не особисті токени):

```ini
# Доступ: людей пускає Tailscale, решта — лише з токеном
JULES_REQUIRE_AUTH=1
JULES_ADMINS=<логін QA-ліда в Tailscale>
JULES_QA_USERS=<логіни тестувальників через кому>
JULES_PUBLIC_URL=https://<mac>.<tailnet>.ts.net
# Адмін-токен для скриптів (npm run smoke:agentic) і як запасний вхід
JULES_API_TOKEN=<довгий випадковий рядок>

# Confluence Server/Data Center 8.5 — PAT сервісного облікового запису з правом лише на читання просторів
CONFLUENCE_BASE_URL=https://confluence.corp.example
CONFLUENCE_TOKEN=<PAT>

# Jira Server/Data Center 9.12 — PAT з правом створювати задачі в одному проєкті
JIRA_BASE_URL=https://jira.corp.example
JIRA_TOKEN=<PAT>

# Figma — токен користувача з Full або Dev seat (інакше ліміти API дуже низькі)
FIGMA_TOKEN=<token>

# Telegram — остання фаза
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Повний перелік із поясненнями — у `.env.example`.

**Внутрішній центр сертифікації.** Якщо Confluence чи Jira підписані корпоративним CA,
покладіть ланцюжок у `certs/corp-ca.pem` — служба запускається з
`NODE_EXTRA_CA_CERTS=/Users/jules/Jules_QA/certs/corp-ca.pem` (див. plist). Перевірка:

```bash
NODE_EXTRA_CA_CERTS=certs/corp-ca.pem node -e "fetch(process.argv[1]).then(r=>console.log(r.status))" https://confluence.corp.example/status
```

## 4. VPN до Confluence на старті системи

Confluence доступна лише через OpenVPN. Клієнт має підключатися **під час старту системи, без
входу користувача**, і перепідключатися сам:

- Tunnelblick: конфігурацію встановити «для всіх користувачів», у налаштуваннях з'єднання —
  «Connect: When computer starts», «Reconnect on wake».
- Або `openvpn` з Homebrew як LaunchDaemon (`brew install openvpn`,
  `sudo brew services start openvpn` з конфігом у `/opt/homebrew/etc/openvpn/`).

Перевірте після перезавантаження, ще до входу в систему (з іншої машини по SSH):
`curl -sI https://confluence.corp.example | head -1`.

## 5. Tailscale

```bash
brew install --cask tailscale          # або standalone-пакет з tailscale.com (працює без входу)
sudo tailscale up --advertise-tags=tag:jules
```

**DNS.** MagicDNS може перехопити резолвінг, і внутрішнє ім'я Confluence перестане
резолвитися через VPN. Оберіть одне:

- на Mac: `tailscale set --accept-dns=false`;
- або в адмін-консолі Tailscale: DNS → split DNS для корпоративного домену на DNS-сервер VPN.

Перевірка: `dscacheutil -q host -a name confluence.corp.example`.

**HTTPS для команди.** Увімкніть HTTPS-сертифікати в адмін-консолі (DNS → HTTPS Certificates), потім:

```bash
tailscale serve --bg 3840
tailscale serve status        # https://<mac>.<tailnet>.ts.net → http://127.0.0.1:3840
```

`tailscale serve` передає справжнього користувача в заголовку `Tailscale-User-Login`; Jules
довіряє йому лише для з'єднань із `127.0.0.1`, тому сервер слухає тільки локальну адресу.

## 6. ACL Tailscale

Вставте `templates/macos/tailscale-acl.hujson` в адмін-консоль (Access controls), замінивши
адреси людей у `group:qa` і `group:dev`. Що дає політика:

- QA й розробники — лише `443` Mac Studio;
- `tag:ci` (GitHub Actions) — теж лише `443`; що саме CI може робити, обмежує Jules машинним
  токеном проєкту (інжест, статус, PR-коментар);
- решта машин tailnet доступу не має.

Для CI створіть OAuth-клієнт (Settings → OAuth clients) зі scope `auth_keys` і тегом
`tag:ci`; його ID і секрет — у секрети організації GitHub `TS_OAUTH_CLIENT_ID` і
`TS_OAUTH_SECRET`.

## 7. Служба Jules (launchd)

```bash
cd /Users/jules/Jules_QA
sudo mkdir -p /Library/Logs/jules-qa && sudo chown jules /Library/Logs/jules-qa
sed -e 's#__JULES_DIR__#/Users/jules/Jules_QA#g' -e 's#__USER__#jules#g' \
  templates/macos/com.jules.qa.plist | sudo tee /Library/LaunchDaemons/com.jules.qa.plist >/dev/null
# Без внутрішнього CA приберіть ключ NODE_EXTRA_CA_CERTS з plist.
sudo chown root:wheel /Library/LaunchDaemons/com.jules.qa.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.jules.qa.plist
sudo launchctl print system/com.jules.qa | grep state
tail -f /Library/Logs/jules-qa/jules.err.log
```

Перезапуск після оновлення коду:

```bash
cd /Users/jules/Jules_QA && git pull && npm ci && npm run ui:build && npm run cli:build
sudo launchctl kickstart -k system/com.jules.qa
```

## 8. Нічний бекап

```bash
mkdir -p /Volumes/Backup/jules-qa
sed -e 's#__JULES_DIR__#/Users/jules/Jules_QA#g' -e 's#__USER__#jules#g' -e 's#__BACKUP_DIR__#/Volumes/Backup/jules-qa#g' \
  templates/macos/com.jules.qa.backup.plist | sudo tee /Library/LaunchDaemons/com.jules.qa.backup.plist >/dev/null
sudo chown root:wheel /Library/LaunchDaemons/com.jules.qa.backup.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.jules.qa.backup.plist
sudo launchctl kickstart -k system/com.jules.qa.backup     # перший прогін вручну
ls /Volumes/Backup/jules-qa && cat /Library/Logs/jules-qa/backup.out.log
```

Щоночі о 03:15: `VACUUM INTO` для `data/registry.db` у теку з датою, копія `data/assets`,
перевірка `integrity_check`, ротація старших за 14 днів. Каталог бекапів має бути на іншому
диску або в хмарній теці; додатково увімкніть Time Machine.

**Відновлення на іншій машині:** кроки 2–7, потім скопіювати `registry.db` і `assets/` з
останнього бекапу в `data/` до запуску служби.

## 9. Перевірка

```bash
curl -s http://127.0.0.1:3840/api/health                        # на самому Mac
curl -s https://<mac>.<tailnet>.ts.net/api/health               # з машини розробника в tailnet
curl -fsS https://<mac>.<tailnet>.ts.net/cli/jules-qa.mjs -o /tmp/jules-qa.mjs && node /tmp/jules-qa.mjs --help
```

У Jules відкрийте «Налаштування → Інтеграції»: стан Confluence, Jira і Figma має бути зеленим
(Confluence червона — найчастіше не піднявся VPN або не резолвиться внутрішнє ім'я, див. крок 4–5).

Наскрізна перевірка циклу на живому Jules (створить окремий проєкт `SMK…`):

```bash
cd /Users/jules/Jules_QA && JULES_URL=http://127.0.0.1:3840 JULES_API_TOKEN=<адмін-токен з .env> npm run smoke:agentic
```

## 10. Токен CI для репо продукту

1. Jules → «Новий проєкт» (крок «CI») або «Налаштування → Доступ» → видати токен з роллю CI для
   проєкту. Токен показується один раз і дає право лише на інжест і статус цього проєкту.
2. У репо продукту на GitHub: Settings → Secrets and variables → Actions:
   - secret `JULES_TOKEN` — токен;
   - variable `JULES_URL` — `https://<mac>.<tailnet>.ts.net`;
   - `TS_OAUTH_CLIENT_ID` і `TS_OAUTH_SECRET` — якщо не задані на рівні організації.
3. У репо продукту: `node /tmp/jules-qa.mjs init --hub https://<mac>.<tailnet>.ts.net --project <id>`
   і PR зі змінами. Перший прогін `qa-ci` на PR має показати коментар `Jules QA`.
