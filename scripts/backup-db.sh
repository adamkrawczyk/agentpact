#!/bin/bash
set -e

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/agentpact_backup_$TIMESTAMP.sql"

echo "📦 Creating database backup..."
mkdir -p "$BACKUP_DIR"

docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-agentpact}" > "$BACKUP_FILE"

gzip "$BACKUP_FILE"

echo "✅ Backup created: ${BACKUP_FILE}.gz"

find "$BACKUP_DIR" -name "agentpact_backup_*.sql.gz" -mtime +7 -delete

echo "🧹 Cleaned up old backups"
