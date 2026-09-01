# Deploying for a new client

The same image, the same database schema and the same code serve every client. What
changes per client is a `.env` file and whatever the administrator then edits in
**Brand Studio**. There is no per-client branch, no per-client build.

---

## 1. The model

Branding resolves per field, in this order — the first usable value wins:

1. **What an administrator saved** in Brand Studio (per organisation, stored in the
   existing `configurations` table under `module='communication', key='branding'`)
2. **`BRAND_*` environment variables** (per deployment)
3. **A neutral built-in default** that carries no client's name

This is the same precedence the public application URL already uses, so there is one
rule to remember rather than two. It also means a client can set their colours in the
environment and their tagline in the UI without either erasing the other.

## 2. One client per deployment

The usual case. Put this in `.env` (beside `compose.yaml`) or `apps/api/.env`:

```env
# Which tenant this deployment belongs to. Read at RUNTIME — this is what used to
# require rebuilding the web image.
DEFAULT_ORG_SLUG=abc

# Where the app is reachable. Every outgoing link is built from it.
PUBLIC_APP_URL=https://360.abc.edu

# First-run tenant creation (used once)
ORG_NAME=ABC University
ORG_SLUG=abc
ADMIN_EMAIL=admin@abc.edu

# Identity
BRAND_APP_NAME=360 Feedback System
BRAND_ORG_NAME=ABC University
BRAND_SHORT_NAME=ABC
BRAND_TAGLINE=Comprehensive performance feedback and development
BRAND_PRIMARY_COLOR=#0b5cab
BRAND_ACCENT_COLOR=#37a3a0
BRAND_SUPPORT_EMAIL=support@abc.edu
BRAND_WEBSITE=https://abc.edu
BRAND_LOGO_URL=https://abc.edu/assets/logo.svg
```

Then `docker compose up -d`. **No rebuild.**

Everything above is a default. The administrator can change any of it in Brand Studio
without touching the server.

## 3. Several clients in one deployment

Already supported — the application has always been multi-tenant, and every table is
scoped by `organization_id`. Provision each tenant with
`npm run db:new-client -- --force --org "…" --slug …`, or `POST /provisioning/organizations`
with `PLATFORM_PROVISIONING_KEY`.

Each tenant sets its own branding in Brand Studio; the environment supplies the shared
default. The sign-in page brands itself from `DEFAULT_ORG_SLUG`, or from
`?org=<slug>` on the branding request.

> Mapping a hostname to a tenant (`abc.360.example.com` → `abc`) is not built. It would
> reuse the same endpoint and is a small addition when you need it.

## 4. Brand Studio

**Configuration → Brand Studio**, permission `communication.manage` — the same permission
the Communication branding form used, so no role gains or loses access.

Four sections, named by who sees the result:

| Section | Sets |
|---|---|
| **Identity** | Organisation name, application name, short name, legal name, tagline, website, logo |
| **Theme** | Primary and accent colour, corner style. Six curated presets shown as miniature feedback-report radars |
| **Sign-in** | Welcome title, subtitle, footer note, support email |
| **Messages** | Display name, support phone, email signature |

Edits apply to the running page immediately so the choice is judged in context, and
**Publish** persists them. **Discard** restores what was loaded. Nothing is written until
you publish.

**Preview as a visitor** switches between the sign-in page, a WhatsApp invitation and an
email invitation. The sign-in preview renders the *real* `AuthShell` component — the same
one the live sign-in page uses — so it cannot drift from what visitors actually get.

### The logo

Upload an image (PNG, JPEG, SVG, WebP or GIF, under 150 KB) and it is stored inline in
the branding record as a `data:` URI — no object storage, upload endpoint or volume. Or
paste a URL if you already host it. With neither, the client's initials are drawn on a
brand-coloured tile.

### What the theme controls

An administrator picks **one** colour. The light and dark shades, the sidebar gradient,
the sign-in background and the chart accent are derived from it. That is deliberate: a
self-service theme with twenty independent controls produces something unprofessional.

## 5. What is public

`GET /api/v1/public/branding[?org=<slug>]` is unauthenticated — the sign-in page has to
be branded before anyone signs in.

It returns presentation fields only: names, tagline, logo, colours, support contact. No
provider settings, no secrets, no counts.

**An unknown slug returns the deployment defaults with HTTP 200**, identical in shape to a
real one. It never 404s, because a 404 would let anyone enumerate which clients are hosted
here. Responses are cached for five minutes.

## 6. Full variable reference

| Variable | Purpose |
|---|---|
| `DEFAULT_ORG_SLUG` | Which tenant the sign-in page belongs to |
| `BRAND_APP_NAME` | Product name — sidebar, sign-in, browser tab |
| `BRAND_ORG_NAME` | Client display name (defaults to the organisation's own name) |
| `BRAND_SHORT_NAME` | Logo tile text when there is no image (defaults to initials) |
| `BRAND_LEGAL_NAME` | Registered name, if different |
| `BRAND_TAGLINE` | Line under the name on sign-in |
| `BRAND_PRIMARY_COLOR` | Buttons, links, sidebar, first chart series |
| `BRAND_ACCENT_COLOR` | Second chart series and highlights |
| `BRAND_CORNER_STYLE` | `sharp` · `default` · `soft` |
| `BRAND_SUPPORT_EMAIL` | Shown on sign-in and in messages |
| `BRAND_SUPPORT_PHONE` | Shown in messages |
| `BRAND_WEBSITE` | Client website |
| `BRAND_LOGO_URL` | Logo URL (a `data:` URI also works) |
| `BRAND_FAVICON_URL` | Favicon. Without one, a tile of the initials is generated |

## 7. Notes

- **Nothing was migrated.** The branding record is the JSONB row that already existed;
  the new fields are optional and older rows keep working.
- **`VITE_DEFAULT_ORG_SLUG` still works** as a build-time fallback, so existing
  deployments are unaffected — but it is no longer needed, and no longer the thing that
  decides which client a build serves.
- **Vertical wording is not branding.** The public parent form still says "Teacher
  evaluation", and Reports says "the institution". Fine for schools and universities,
  wrong for a corporate client. That is a copy/i18n change, deliberately out of scope here.

---

## Licensing

Branding decides how a deployment *looks*; the licence decides what it may *do* —
expiry, employee limit and which modules are included. See `LICENSING.md`.
