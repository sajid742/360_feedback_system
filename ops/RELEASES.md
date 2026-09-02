# Releases and rollback

The four locally built images are one release. They are built together, verified together,
and rolled back together — never mixed.

```
release 2026-09-02-1500
    e360-api          the NestJS API
    e360-web          nginx + the built SPA
    e360-mock-sis     the standalone vendor SIS simulator
    e360-api-tools    db-init: applies the SQL and runs the seed chain
```

`postgres`, `redis` and `waha` are upstream images. They are recorded in each manifest for
diagnosis but never tagged or rolled back — they are not ours to version.

---

## The two commands

```powershell
.\ops\deploy-release.ps1          # back up, build, deploy, verify, roll back if it fails
.\ops\rollback.ps1 -List          # what can I go back to?
.\ops\rollback.ps1 -Previous      # go back one release
```

`start-docker.ps1` is unchanged and is still the right thing for development and a first
run. Use `deploy-release.ps1` when there is a working installation you cannot afford to
lose.

---

## Why tags, and why this matters

`compose.yaml` pins **untagged** image names (`image: e360-api`), which Docker reads as
`:latest`. So a rebuild does this:

```
before   e360-api:latest -> sha256:aaa
after    e360-api:latest -> sha256:bbb
         sha256:aaa      -> <none>:<none>     the previous release, now nameless
```

The old image is not deleted — it becomes **dangling**. And dangling images are removed by
`docker image prune`, `docker system prune`, and Docker Desktop's own **"Clean up"**
button.

> **A release tag is not decoration. It is the only thing stopping Docker from garbage
> collecting your rollback target.**

That is why `deploy-release.ps1` tags before it builds, and why retention only ever removes
a **tag**, never an image id.

---

## What a deployment does

```
1  PRE-FLIGHT       Docker running, .env present, compose config valid, disk space
                    -> nothing has changed yet; any failure here is free

2  IDENTIFY         which images are the containers actually running

3  BACK UP          pg_dump through the container -> backups\db-<id>-prev.dump
                    docker tag all four           -> e360-*:<id>-prev
                    write                          -> releases\<id>-prev\manifest.json
                    -> if this fails, the deployment STOPS. Nothing destructive has run

4  BUILD            docker compose build
                    -> `build` does not touch running containers. A failure leaves the
                       application serving, and the previous tags intact

5  START            docker compose up -d

6  HEALTH           wait for postgres, redis, api, web, mock-sis to report healthy
                    check db-init exited 0
                    (waha is excluded: 90s browser start-up, not on the critical path)

7  SMOKE            GET /health, /ready, web /, mock-sis /api/v1/health
                    SELECT count(*) FROM employees

8  SUCCESS          tag all four as e360-*:<id>, write the manifest, mark it current,
                    apply retention

9  FAILURE          restore the previous release automatically, as a complete set
```

---

## What a rollback does

```
1  VERIFY   every image in the manifest exists
            -> if any is missing: ABORT. The running application is not touched
2  DOWN     docker compose down            containers only; volumes untouched
3  RETAG    all four names, from ONE manifest file
4  UP       docker compose up -d --no-build
5  VERIFY   health + smoke
```

Two properties make a mixed set impossible:

- every image is checked **before** anything stops, and
- all four ids come from a **single** manifest, read once.

`--no-build` is essential. A rollback that rebuilt would compile the *current* source under
an old tag — the exact failure this exists to prevent.

---

## Images are not data

| | Restored by a rollback? |
|---|---|
| Application code (all four images) | **Yes** |
| PostgreSQL (`pgdata`) — everything | **No** |
| Redis queue (`redisdata`) | No |
| WhatsApp session (`waha_sessions`) | No |
| `.env` and its secrets | No |

**Schema changes are forward-only.** `database/001_reconcile.sql` is additive and
idempotent — 643 `IF NOT EXISTS`, and no `DROP`, `TRUNCATE`, `DELETE` or `SET NOT NULL` —
so rolling images back today leaves a database with columns the old code simply ignores.
That is safe, and it is a property of the current SQL, not a guarantee.

After a rollback, `/ready` reports **`degraded`** with a schema mismatch. That is expected:
readiness is gated on the database being *up*, not on the schema matching, which is
precisely what allows a rollback to work at all.

**The moment a release drops a column, renames one, or adds `NOT NULL` without a default,
image rollback alone stops being sufficient.** That is what the pre-deployment dump is for.
It is never restored automatically — restoring discards everything written since it was
taken, which must be a human decision:

```powershell
.\ops\restore.ps1        # see ops\BACKUP_RESTORE.md
```

---

## Retention

Five releases by default (`-Keep N`). Cost is only the layers that actually changed —
typically a few hundred MB per release, not a full copy, because Docker shares base and
dependency layers.

Two rules the scripts follow, and you should too:

1. **Only ever remove a tag**, never an image id. Removing a tag that is not the last
   reference frees nothing and cannot break another release.
2. **Never run `docker image prune -a`** here. Docker Desktop's "Clean up" button does
   exactly that, and will delete any untagged image.

`rollback.ps1 -List` shows `4/4` for a release that can still be restored. Anything less
**cannot** be rolled back to, and says so in red.

---

## Portable archives

Release tags cover fast local rollback and cost almost nothing. They do **not** survive
losing the Docker data root.

For a portable copy — a customer handover, or an offsite archive — use the release
packager, which already does `docker save` of the whole set:

```powershell
.\ops\make-release.ps1 -Version 2026-09-02-v1
```

That produces roughly 1.5–2.5 GB per release, which is why it is a deliberate command and
not part of every deployment. If the Docker data root is gone you have also lost `pgdata`,
and you are restoring from `ops\backup.ps1` regardless.

---

## Manual recovery

If the scripts are unavailable, the manifest holds everything needed. Read
`releases\<id>\manifest.json`, then:

```powershell
docker image inspect <api id> <web id> <mock-sis id> <api-tools id>   # verify FIRST

docker compose -f compose.yaml down
docker tag <api id>        e360-api
docker tag <web id>        e360-web
docker tag <mock-sis id>   e360-mock-sis
docker tag <api-tools id>  e360-api-tools
docker compose -f compose.yaml up -d --no-build
```

Verify all four exist before running `down`. That ordering is the whole safety property.

---

## Files

| Path | Purpose |
|---|---|
| `ops\deploy-release.ps1` | Deploy with backup, verification and automatic rollback |
| `ops\rollback.ps1` | List releases; restore one as a complete set |
| `ops\release-lib.ps1` | Shared logic, so deploy and rollback cannot disagree |
| `releases\<id>\manifest.json` | Image ids, tags, git commit, `.env` fingerprint, db dump path |
| `releases\<id>\compose.yaml` | The compose file that release was deployed with |
| `releases\current.txt` | Which release is live |
| `backups\db-<id>.dump` | Pre-deployment database dump (`pg_dump -Fc`) |

`releases\` and `backups\` are gitignored.
