# Enterprise 360 — Backup & Restore Runbook (F21)

Product-grade, scripted, scheduled, and **tested** backup/restore for the
Enterprise 360 database and the secrets required to read it back. Replaces the
"run `pg_dump` yourself" note in the Deployment Manual.

## What gets backed up

Each run of `ops/backup.sh` (Linux/macOS) or `ops/backup.ps1` (Windows) produces
one timestamped archive (`e360-backup-YYYYMMDD-HHMMSS.tar.gz` / `.zip`) containing:

| File | Contents |
|------|----------|
| `db.dump` | `pg_dump` **custom-format** dump of the application database (`enterprise360`). |
| `env.backup` | A copy of `apps/api/.env` — **contains `MFA_ENCRYPTION_KEY`**. |
| `MANIFEST.txt` | Timestamp, database, host, `pg_dump` version, contents. |

> ### ⚠️ The encryption key is part of your backup
> `MFA_ENCRYPTION_KEY` (in `apps/api/.env`) encrypts **stored provider secrets**
> (HR/SIS connection credentials) and **MFA seeds** at rest. A database restored
> **without the matching key cannot decrypt** those secrets — HR/SIS syncs and MFA
> would break even though all rows restored. That is why the key is captured in
> every backup. **Keep the archive somewhere secure** (it holds a secret) and,
> if you rotate `MFA_ENCRYPTION_KEY`, take a fresh backup immediately.

## Prerequisites

- PostgreSQL client tools on `PATH`: `pg_dump`, `pg_restore`, `psql`, `createdb`
  (bundled with any PostgreSQL install; the same tools the app already relies on).
- The `DATABASE_URL` in `apps/api/.env`, or exported as an environment variable.

## Taking a backup

Linux/macOS:

```bash
# writes to ./backups by default; prunes archives older than 14 days
ops/backup.sh
# or choose an output directory / retention:
BACKUP_DIR=/var/backups/e360 RETENTION_DAYS=30 ops/backup.sh
```

Windows (PowerShell):

```powershell
.\ops\backup.ps1                       # writes to .\backups
.\ops\backup.ps1 -BackupDir D:\e360-backups -RetentionDays 30
```

## Scheduling automatic backups

**Linux — cron** (daily at 02:00, keep 30 days):

```cron
0 2 * * *  cd /opt/enterprise-360-app && RETENTION_DAYS=30 BACKUP_DIR=/var/backups/e360 ops/backup.sh >> /var/log/e360-backup.log 2>&1
```

**Windows — Task Scheduler** (daily at 02:00):

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -File C:\enterprise-360-app\ops\backup.ps1 -BackupDir D:\e360-backups -RetentionDays 30"
$trigger = New-ScheduledTaskTrigger -Daily -At 2:00AM
Register-ScheduledTask -TaskName "Enterprise360-Backup" -Action $action -Trigger $trigger -RunLevel Highest
```

Store the backup directory on separate storage (or sync it off-box) so a disk
failure doesn't take the backups with it.

## Restoring

> Restore is **destructive** to the target database — it brings that database back
> to the backed-up state. Restore into a **scratch database first** to rehearse.

Linux/macOS:

```bash
# interactive (asks you to type the DB name to confirm)
ops/restore.sh backups/e360-backup-20260813-145932.tar.gz
# non-interactive (automation)
ops/restore.sh backups/e360-backup-20260813-145932.tar.gz --yes
# rehearse into a scratch DB without touching production:
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/e360_restore_test" \
  ops/restore.sh backups/e360-backup-20260813-145932.tar.gz --yes
```

Windows (PowerShell):

```powershell
.\ops\restore.ps1 -Archive .\backups\e360-backup-20260813-145932.zip
.\ops\restore.ps1 -Archive .\backups\e360-backup-20260813-145932.zip -Yes
```

After a real restore:

1. If the script reports the backup's `MFA_ENCRYPTION_KEY` differs from the
   current `apps/api/.env`, restore the key from the archive's `env.backup`
   (otherwise encrypted provider secrets / MFA seeds won't decrypt).
2. Restart the API.
3. Run the sanity check below.

## Post-restore sanity check

```bash
# object + row sanity
psql "$DATABASE_URL" -c "SELECT count(*) AS employees FROM employees;"
psql "$DATABASE_URL" -c "SELECT count(*) AS cycles FROM appraisal_cycles;"
# app health: log in and confirm dashboards load; if you use HR/SIS providers,
# open HR Integration / Student Integration and click "Test connection" to prove
# the encrypted secrets decrypt with the restored key.
```

## Verification record (tested)

This procedure was executed end-to-end in the reference environment:

- **Backup:** `ops/backup.sh` on `enterprise360` → `e360-backup-20260813-145932.tar.gz`
  (90 KB), including `db.dump` + `env.backup` (with `MFA_ENCRYPTION_KEY`) + `MANIFEST.txt`.
- **Restore:** into a scratch DB `e360_restore_test` via
  `DATABASE_URL=... ops/restore.sh <archive> --yes`.
- **Result:** row counts matched the source exactly — `employees=58`, `cycles=2`,
  `users=60`; the key-match check reported the encryption key intact. Scratch DB
  dropped afterwards. Production database untouched.
