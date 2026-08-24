import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'

interface MigrationFile {
  filename: string
  version: string
  sql: string
  checksum: string
}

interface AppliedMigrationRow {
  version: string
  checksum: string
}

export interface RunMigrationsOptions {
  migrationsDir?: string
}

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/

const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`

function defaultMigrationsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')
}

function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migration directory not found: ${migrationsDir}`)
  }

  const filenames = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  if (filenames.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`)
  }

  const versions = new Set<string>()

  return filenames.map((filename) => {
    if (!MIGRATION_FILE_PATTERN.test(filename)) {
      throw new Error(`Invalid migration filename: ${filename}. Expected format: 0001_description.sql`)
    }

    const version = filename.slice(0, -'.sql'.length)
    if (versions.has(version)) {
      throw new Error(`Duplicate migration version detected: ${version}`)
    }
    versions.add(version)

    const filePath = path.join(migrationsDir, filename)
    const sql = fs.readFileSync(filePath, 'utf8')
    if (sql.trim().length === 0) {
      throw new Error(`Migration file is empty: ${filename}`)
    }

    const checksum = createHash('sha256').update(sql).digest('hex')
    return {
      filename,
      version,
      sql,
      checksum,
    }
  })
}

export function runMigrations(db: Database.Database, options: RunMigrationsOptions = {}): void {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir()

  db.exec(SCHEMA_MIGRATIONS_TABLE_SQL)

  const appliedRows = db
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version ASC')
    .all() as AppliedMigrationRow[]
  const appliedChecksums = new Map<string, string>(appliedRows.map((row) => [row.version, row.checksum]))

  const insertAppliedMigration = db.prepare(
    'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)'
  )

  const applyMigration = db.transaction((migration: MigrationFile) => {
    db.exec(migration.sql)
    insertAppliedMigration.run(migration.version, migration.checksum, Date.now())
  })

  const migrations = loadMigrationFiles(migrationsDir)
  for (const migration of migrations) {
    const appliedChecksum = appliedChecksums.get(migration.version)
    if (appliedChecksum) {
      if (appliedChecksum !== migration.checksum) {
        throw new Error(
          `Migration checksum mismatch: ${migration.filename}. Create a new migration file instead of editing applied migrations.`
        )
      }
      continue
    }
    applyMigration(migration)
  }
}
