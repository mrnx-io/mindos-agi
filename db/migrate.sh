#!/bin/bash

# MindOS Database Migration Script

set -e

DB_URL="${DATABASE_URL:-postgresql://mindos:mindos@localhost:5432/mindos}"

echo "🗄️  Running MindOS database migrations..."

# Run migrations in order
for migration in migrations/*.sql; do
  if [ -f "$migration" ]; then
    echo "📄 Applying: $(basename "$migration")"
    psql "$DB_URL" -f "$migration"
  fi
done

echo "✅ All migrations applied successfully!"
