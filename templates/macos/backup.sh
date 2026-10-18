#!/usr/bin/env bash
# Нічний бекап Jules: консистентна копія registry.db через VACUUM INTO (безпечно під час
# роботи сервера, на відміну від cp), копія вкладень data/assets і ротація старших за KEEP_DAYS днів.
#
#   JULES_DIR   — каталог Jules (дефолт: два рівні вище від скрипта)
#   BACKUP_DIR  — куди складати (інший диск чи хмарна тека), обов'язково
#   KEEP_DAYS   — скільки днів тримати (дефолт 14)
#   REGISTRY_DB — шлях до бази, якщо не дефолтний data/registry.db
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JULES_DIR="${JULES_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:?Вкажіть BACKUP_DIR — каталог для бекапів}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB="${REGISTRY_DB:-$JULES_DIR/data/registry.db}"
ASSETS="$JULES_DIR/data/assets"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "$(date '+%F %T') sqlite3 не знайдено (brew install sqlite)" >&2
  exit 1
fi
if [ ! -f "$DB" ]; then
  echo "$(date '+%F %T') базу не знайдено: $DB" >&2
  exit 1
fi

STAMP="$(date '+%Y-%m-%d_%H%M')"
TARGET="$BACKUP_DIR/$STAMP"
mkdir -p "$TARGET"

# VACUUM INTO не перезаписує наявний файл — тека з датою завжди нова.
sqlite3 "$DB" "VACUUM INTO '$TARGET/registry.db'"
if [ "$(sqlite3 "$TARGET/registry.db" 'PRAGMA integrity_check;')" != "ok" ]; then
  echo "$(date '+%F %T') копія бази не пройшла integrity_check: $TARGET/registry.db" >&2
  exit 1
fi

if [ -d "$ASSETS" ]; then
  # Вкладення адресуються хешем і не змінюються, тож rsync копіює лише нові.
  rsync -a "$ASSETS/" "$TARGET/assets/"
fi

# Ротація: прибираємо теки бекапів, старші за KEEP_DAYS днів (лише наш формат назви).
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]_*' \
  -mtime +"$KEEP_DAYS" -exec rm -rf {} +

echo "$(date '+%F %T') бекап готовий: $TARGET ($(du -sh "$TARGET" | cut -f1))"
