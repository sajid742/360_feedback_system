# Communication Module — Provider Configuration Guide

The Communication module is a **configurable, provider-based** messaging service.
Business logic (feedback cycles, reminders, parent evaluations, campaigns) never
calls SMTP, Twilio, WAHA, or any SMS API directly — it calls a single
`NotificationService`, which resolves a provider through a `ProviderFactory` that
returns an adapter implementing the common `ChannelProvider` interface:

```
business logic → NotificationService.send() → ProviderFactory.forChannel()
                                                   ├─ Email:    EmailTransport (SMTP)
                                                   ├─ SMS:      TwilioSmsTransport | GenericSmsTransport
                                                   └─ WhatsApp: MetaWhatsAppTransport | TwilioWhatsAppTransport
                                                                | WahaTransport | MockWhatsAppTransport
```

Adding a new provider means adding one adapter class + a branch in the factory —
**no business-logic change**. All settings are stored per-organization in the
`configurations` table (module `communication`, keys `email`, `sms`, `whatsapp`,
`general`) and edited at runtime in the app under **Communication → Providers**
(permission `communication.manage`). Nothing here requires a code change or
redeploy.

Message **templates** (per event × channel, with placeholders) live in
**Communication → Templates**; **delivery status** is tracked on every message in
**Communication → Notifications** (`queued → sent | failed | skipped`); a disabled
channel records a `skipped` row and is never delivered.

---

## Environment variables

Provider credentials are stored in the database (per tenant), **not** in `.env`.
The only communication-related environment variables are:

| Variable | Used by | Purpose |
|---|---|---|
| `PUBLIC_APP_URL` | api | Fallback base URL for building secure links when the tenant has not set a `general.publicBaseUrl`. Default `http://localhost:5173`. |
| `REDIS_HOST` / `REDIS_PORT` | api | Optional — enables the BullMQ delivery queue (retryable). Without Redis, delivery runs inline. `REDIS_PORT` defaults to `6379`. |

> **`PUBLIC_APP_URL` decides whether the links you send actually open.** Every
> generated link — the `secureLink` in reminder and cycle messages, password-reset
> links, parent-evaluation links and their QR codes, and short links — is built on
> `general.publicBaseUrl`, which falls back to `PUBLIC_APP_URL` and finally to
> `http://localhost:5173`. Left at that default, recipients get a URL that only
> resolves on the machine running the app: fine for a single-machine demo,
> useless as soon as the app is served over a LAN address, a VPN or a real host
> name. Set `PUBLIC_APP_URL` in `apps/api/.env` to the address people actually
> type — e.g. `http://192.168.1.20:5173` for LAN testing, or
> `https://360.example.com` in production — and restart the API. A per-tenant
> value set at **Communication → Providers → General → Public base URL**
> (`general.publicBaseUrl`) takes precedence over the environment variable. See
> `DEPLOYMENT.md` §9 for the LAN case.

SIS integration variables (used by the legacy Mock-SIS vendor adapter, which
backs parent-evaluation delivery in test environments) live in `apps/api/.env`
and `apps/mock-sis/.env`:

| Variable | Where | Default |
|---|---|---|
| `SIS_BASE_URL` | `apps/api/.env` | `http://localhost:3100/api/v1` |
| `SIS_API_KEY` | `apps/api/.env` **and** `apps/mock-sis/.env` — the two must match | `mock-sis-dev-key-change-me` |
| `MOCK_SIS_DATABASE_URL` | `apps/mock-sis/.env` | — (required; note the name, the Mock SIS does **not** read `DATABASE_URL`) |

> **`SIS_PROVIDER` is not an environment variable.** `deploy.ps1` and
> `apps/api/.env.example` both write `SIS_PROVIDER=mock`, but **no code reads
> it**. `SIS_PROVIDER` is a dependency-injection `Symbol` declared in
> `apps/api/src/sis/sis-provider.interface.ts` and bound in `sis.module.ts` to
> `TenantSisProvider`, which resolves the current tenant's imported or synced
> dataset at request time and otherwise falls back to the Mock SIS. The student
> data source is chosen **per organisation, in the application**, on the Student
> Integration screen.

---

> **Branding** — the organisation name, logo, colours and sign-in page are configured in
> **Configuration → Brand Studio**, and per deployment through `BRAND_*` environment
> variables. See `WHITE_LABEL.md`. This page covers message delivery only.

## Public application URL — where links point

Every link the system sends is built from one value: parent-evaluation invitations,
consolidated parent forms, password resets, user invitations and short links.

**Order of precedence** (first usable value wins):

1. **Communication → Providers → Public application URL** — a per-organisation
   override. Leave it blank to inherit.
2. **`PUBLIC_APP_URL`** — the server-wide setting. This is the one to use.
3. `http://localhost:5173` — a development convenience only.

A value pointing at `localhost`, `127.0.0.1`, `0.0.0.0` or a Docker service name
(`api`, `web`, `waha`) is treated as unusable and **never** wins over a real
`PUBLIC_APP_URL`, because on a server that combination is always a mistake rather than a
choice: the recipient's phone resolves `localhost` to their own device.

| Deployment | Set |
|---|---|
| Local development (from source) | `PUBLIC_APP_URL=http://localhost:5173` — or leave unset |
| Local development (Docker) | `PUBLIC_APP_URL=http://localhost:8080` |
| LAN / office server | `PUBLIC_APP_URL=http://192.168.1.20:8080` — the machine's LAN address and the published port |
| Production domain | `PUBLIC_APP_URL=https://360.example.com` |

Where to put it: **Docker** — `.env` beside `compose.yaml`, then `docker compose up -d`.
**From source** — `apps/api/.env`, then restart the API (or
`.\deploy.ps1 -PublicAppUrl "http://192.168.1.20:5173"`).

### What happens when it is wrong

- The API logs the effective value at startup: `[PublicAppUrl] Outbound links will use …`.
- If it is unusable, that becomes a warning in development and an **error** in production.
- With `NODE_ENV=production` the application **refuses to generate an external link**
  rather than sending one that cannot be opened, and explains what to set. Nothing is
  written, so no half-built link is left behind.
- Existing links are unaffected — tokens are validated against the API, not the host in
  the URL, so changing this value does not invalidate anything already sent.

> Historical note: the admin screen used to pre-fill this field with the resolved value
> and post it back on save, which wrote `http://localhost:5173` into the database. From
> then on it shadowed `PUBLIC_APP_URL` permanently. The field now stores only what you
> type — blank means inherit — and a stored loopback value no longer beats the
> environment, so affected installations repair themselves on upgrade.

---

## Email (SMTP)

**Communication → Providers → Email.** All settings are runtime-configurable:

| Field | Config key | Notes |
|---|---|---|
| Enabled | `enabled` | Master on/off for the email channel (default off) |
| SMTP Host | `host` | e.g. `smtp.sendgrid.net` |
| SMTP Port | `port` | e.g. `587` (STARTTLS) or `465` (SSL). Default `587` |
| TLS/SSL | `secure` | On for port 465, off for 587 |
| Authentication | `auth` | When on, username/password are sent as SMTP AUTH; turn off for open relays |
| Username / Password | `user` / `pass` | Password is write-only; blank = keep existing |
| Sender Name | `senderName` | Display name on the `From` header |
| Sender Email | `from` | `From` address |
| Connection Timeout | `connectionTimeout` | Milliseconds before the SMTP connection aborts. Default `10000` |
| Accept untrusted certificate | `allowUntrustedCertificate` | Off by default. Send even when the server's TLS certificate cannot be verified — see *Certificate errors* below |

Under the hood this drives a `nodemailer` SMTP transport — swap host/port/creds to
move between SendGrid, SES, Mailgun, Office 365, etc. without code changes.
Messages are sent as plain text.

### Certificate errors — "self-signed certificate in certificate chain"

If a send fails with **`self-signed certificate in certificate chain`** (or
`unable to verify the first certificate`), the host, port, username and password are
almost certainly correct. The connection is being intercepted.

Antivirus products with an "SSL scanning"/"encrypted connection scanning" feature —
Kaspersky, ESET, Avast, Bitdefender — and corporate proxies such as Zscaler sit in the
middle of outbound TLS, decrypt it, and re-sign it with their **own** certificate
authority. Windows and your browser trust that authority because the installer added it
to the Windows certificate store. **Node.js does not read the Windows certificate
store**; it ships its own list of public authorities, so it correctly refuses a
certificate it has never heard of.

This is why the same server works in a browser and fails from the application.

**Preferred fix — trust the authority, keep verification on.**

1. Export the interceptor's root certificate as Base-64 `.cer`/`.pem`:
   `certmgr.msc` → *Trusted Root Certification Authorities* → *Certificates* → find your
   antivirus or proxy vendor → right-click → *All Tasks* → *Export* →
   **Base-64 encoded X.509**. Save it as e.g. `C:\certs\proxy-root.pem`.
2. Start the API with that file in `NODE_EXTRA_CA_CERTS`.

   PowerShell, from-source:
   ```powershell
   $env:NODE_EXTRA_CA_CERTS = "C:\certs\proxy-root.pem"
   .\start-dev.ps1
   ```
   To make it permanent for your account:
   ```powershell
   [Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS','C:\certs\proxy-root.pem','User')
   ```
   Docker — put the file beside `compose.yaml`, then add to the `api` service:
   ```yaml
   environment:
     NODE_EXTRA_CA_CERTS: /certs/proxy-root.pem
   volumes:
     - ./proxy-root.pem:/certs/proxy-root.pem:ro
   ```
   `NODE_EXTRA_CA_CERTS` takes **one** file. To trust several authorities, concatenate
   their PEM blocks into a single file.

**Quick unblock — tick "Accept untrusted certificate".**

In **Communication → Providers → Email**. The message is still encrypted in transit,
but the application no longer checks *who* it is talking to, so it cannot detect an
impersonated mail server. Reasonable for a test service such as Ethereal or an internal
mail server with its own certificate; prefer `NODE_EXTRA_CA_CERTS` for anything that
carries real recipient data.

> Credentials are never transmitted before the certificate check, so a failed send of
> this kind has not exposed your SMTP password.

---

## SMS

**Communication → Providers → SMS.** Choose a **Provider**: `twilio` (default) or
`generic`.

### Twilio
Account SID (`accountSid`), Auth Token (`authToken`), Sender ID (`senderId`, the
From number or alias). Delivered via Twilio's REST Messages API
(`POST https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json`); the
returned `sid` is stored as the provider message id.

### Generic HTTP gateway
Drives **any** REST SMS provider purely by configuration — no per-vendor code:

| Field | Config key | Notes |
|---|---|---|
| Provider URL / API endpoint | `endpoint` | The gateway's send URL (required) |
| HTTP method | `httpMethod` | `POST` (default) or `GET` — `GET` sends the fields as a query string |
| Body format | `bodyFormat` | `json` (default) or `form` (urlencoded), for `POST` |
| Authentication | `authType` | `none`, `apikey`, `basic`, `bearer` (default) or `oauth2` |
| Sender ID | `senderId` | Value sent in the "from" field |
| Recipient / Message / From field names | `toParam` / `messageParam` / `fromParam` | Default `to` / `message` / `from` |
| Retry attempts / backoff | `retryMaxAttempts` / `retryBackoffMs` | Defaults `3` attempts, `1000` ms between them |

**Auth details** — all resolved in `GenericSmsTransport.authHeaders()`:

- `apikey` — sends `apiKey` in the header named by `apiKeyHeader`. **If
  `apiKeyHeader` is blank the header defaults to `Authorization`**, so set it
  explicitly (e.g. `X-API-Key`) unless that is what you want.
- `basic` — `Authorization: Basic base64(username:password)`.
- `bearer` — `Authorization: Bearer <apiKey>` (the token is taken from the
  `apiKey` field, not `token`).
- `oauth2` — POSTs `grant_type=client_credentials` with `oauthClientId` /
  `oauthClientSecret` to `oauthTokenUrl`, then sends the returned `access_token`
  as a Bearer token. A response without `access_token` is an error.

This covers the vast majority of SMS gateways (Vonage, Clickatell, Infobip,
MessageBird, local aggregators). The provider message id is read from whichever
of `messageId`, `message-id`, `id` or `sid` the gateway returns.

> The retry policy applies to the **SMS** transports only. Email and WhatsApp
> sends are single-attempt at the transport level; use the Redis-backed delivery
> queue if you need retries across channels.

---

## WhatsApp

**Communication → Providers → WhatsApp.** Choose a **Provider** — switching
between them is configuration only. Default is `meta`.

### Meta Cloud API (`meta`)
Base URL (`baseUrl`, defaults to `https://graph.facebook.com/v18.0` when blank),
Phone Number ID (`phoneNumberId`), Access Token (`accessToken`), plus optional
Business Number and Webhook URL. Sends
`POST {baseUrl}/{phoneNumberId}/messages` with
`{ messaging_product: "whatsapp", to, type: "text", text: { body } }`.

### Twilio WhatsApp (`twilio`)
Account SID, Auth Token, Business Number (`businessNumber`). Messages go through
Twilio's Messages API; both the sender and the recipient are auto-prefixed with
`whatsapp:`.

### WAHA — WhatsApp HTTP API, self-hosted (`waha`)

| Field | Config key | Notes |
|---|---|---|
| Base URL | `baseUrl` | Your WAHA instance, e.g. `http://localhost:3001`. **Required** — do not point it at port 3000, which the API itself uses |
| Session | `session` | WAHA session name; defaults to `default` |
| API Key | `apiKey` | Sent as `X-Api-Key` if your WAHA requires it |

Messages are sent to `POST {baseUrl}/api/sendText` with
`{ session, chatId, text }`; the recipient number is normalised to a
`<digits>@c.us` chat id.

**Base URL must be the server root** — `http://waha:3000`, not
`http://waha:3000/api`. The application appends `/api/sendText` itself; including
`/api` yourself produces a 404.

If a WhatsApp send fails, the Outbox now names the cause instead of reporting
`fetch failed`:

| Message contains | Cause | Fix |
|---|---|---|
| *nothing is listening on that port* (`ECONNREFUSED`) | WAHA is not running, or the port is wrong | `docker compose ps`; check the port in the Base URL |
| *that host name does not resolve* (`ENOTFOUND`) | `localhost` used from inside a container — where it means the container itself | Use the service name: `http://waha:3000` |
| *the connection timed out* (`ETIMEDOUT`) | A firewall is dropping the traffic | Allow the port, or move WAHA onto the same Docker network |
| *its TLS certificate is not trusted* | An `https://` Base URL through TLS inspection | Use plain `http://` for a service on your own machine, or set `NODE_EXTRA_CA_CERTS` (see *Certificate errors* above) |
| *WAHA rejected the API key (401)* | The API key is wrong | It must equal `WAHA_API_KEY` in `.env` — **not** the WAHA dashboard password, which is a different credential |
| *WAHA returned 404* | The Base URL includes `/api` | Use the server root only |

### Mock (`mock`)
Records the message as delivered without calling any external API — for
integration testing (used by the parent-evaluation flow). A legacy
`mock: true` flag on an old config is still honoured and maps onto
`provider: "mock"`.

---

## Delivery webhooks (inbound status callbacks)

**Communication → Providers → Delivery webhooks.** Providers report what happened
to a message after sending; those callbacks arrive at:

```
POST /api/v1/communication/webhooks/:provider
X-Webhook-Signature: sha256=<hex HMAC-SHA256 of the RAW request body>
Content-Type: application/json

{ "providerMessageId": "SM1a2b3c…", "status": "delivered" }
```

`X-Hub-Signature-256` (Meta) and `X-Twilio-Signature` are accepted as aliases.
The secret comes from the WhatsApp channel config (`whatsapp.webhookSecret`) for
WhatsApp callbacks, otherwise from `general.webhookSecret`.

> **Fail-closed by design.** An organisation with **no** webhook secret
> configured cannot accept callbacks at all. Allowing unsigned updates "when no
> secret is set" would leave exactly the hole this closes — an attacker would
> simply target the tenants that never set one. Message *sending* is unaffected;
> only inbound delivery-status updates are gated.

> **Every rejection returns an identical `401`** — missing header, unknown
> `providerMessageId`, no secret configured and signature mismatch all produce
> *Invalid or missing webhook signature.* This prevents an unauthenticated caller
> probing for valid message ids or for tenants without a secret. The real reason
> is written to the server log as `Webhook rejected (<reason>) for
> providerMessageId=…` — that is where to look when diagnosing a provider.

The HMAC is computed over the **raw request bytes** (the API preserves them on
the request for exactly this reason), so your provider must sign the same bytes
it transmits.

---

## How to test each channel

Every provider can be validated from **Communication → Providers → "Send a test
message"**, which **bypasses the enable switch** so you can confirm credentials
before turning a channel on. The result shows `sent` or the provider's error.

1. **Email** — set the SMTP fields, enter a real inbox, Send test → check the inbox
   and the Notifications tab (`sent`).
2. **SMS** — configure Twilio or the generic gateway, enter a phone number in E.164
   format, Send test → the recipient receives the SMS; a `sent` row appears.
3. **WhatsApp (Twilio)** — configure Account SID/Auth Token/Business Number
   (join the Twilio sandbox first), enter your WhatsApp number, Send test.
4. **WhatsApp (WAHA)** — start WAHA, scan the QR to authenticate the session, set
   the Base URL/Session, Send test → the message arrives via your WAHA number.

**End-to-end (parent evaluation):** set WhatsApp to *Mock* (or a real provider),
enable it, then generate a parent evaluation link from **Parent Evaluations**
with "Generate & send" — the outbound message is recorded in Notifications and,
for real providers, delivered.

Programmatic check (replace `$TOKEN` with an access token for a user holding
`communication.manage`):

```bash
BASE=http://localhost:3000/api/v1
# configure + enable a channel, then:
curl -s -X POST $BASE/communication/settings/test \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"channel":"sms","recipient":"+15551234567"}'
# → { "id": "...", "status": "sent", "error": null }
```

`channel` must be one of `email`, `sms`, `whatsapp`.
