# How webhooks work in this lab

This repo has two small Bun servers that demonstrate a signed webhook flow:

- **`publisher`** (port 4000) — the sender. It owns events and pushes them to subscribers.
- **`receiver`** (port 3000) — the subscriber. It exposes an endpoint that the publisher calls.

A webhook is just an HTTP callback: instead of the receiver polling the publisher for
updates ("has anything happened yet?"), the publisher makes an outbound `POST` request to
the receiver the moment something happens. The receiver looks like a normal web server
from the outside — the only thing that makes it a "webhook receiver" is that the caller is
another server, not a browser.

## The request flow

```
 client                 publisher (:4000)              receiver (:3000)
   |                          |                                |
   |--- POST /publish/payment ->                                |
   |                          |-- build event JSON              |
   |                          |-- sign it (HMAC-SHA256)          |
   |                          |--- POST /webhook/payment ------->|
   |                          |     headers: signature, timestamp|
   |                          |     body: raw JSON               |
   |                          |                                  |-- recompute signature
   |                          |                                  |-- compare, check timestamp
   |                          |<---------- 200 OK / 401 ----------|
   |<---- 200 { receiverStatus } --                               |
```

1. Something you'd normally call an "event" happens (here, simulated by a client hitting
   `publisher`'s `/publish/payment`).
2. `publisher` builds a JSON payload describing the event (`type`, `id`, `createdAt`, ...).
3. `publisher` signs that payload and sends it as the body of a `POST` to a URL the
   receiver registered ahead of time (`RECEIVER_URL`, defaulting to
   `http://localhost:3000/webhook/payment`).
4. `receiver` verifies the signature, then processes the event (in this lab, it just logs
   it — in a real app this is where you'd update a database, trigger a job, etc).
5. `receiver` responds with a plain `200 OK`. That response only means "I received and
   accepted the request" — it's not part of the business logic.

## Why signatures matter

`/webhook/payment` is a public HTTP endpoint. Without protection, anyone who finds the URL
could `POST` a fake `payment.completed` event and the receiver would act on it. Since there's
no browser/user session involved, you can't use cookies or login — the two servers need a
way to prove requests really came from `publisher`. That's what the signature is for: proof
of authenticity and integrity (the body wasn't forged or tampered with in transit), not
secrecy.

### The shared secret

Both servers read the same `WEBHOOK_SECRET` from their `.env` file (defaults to
`dev-shared-secret` if unset). Only `publisher` and `receiver` know this value — it's never
sent over the wire.

### Signing (publisher side)

`publisher/index.ts` → `signPayload`:

```ts
const hasher = new Bun.CryptoHasher("sha256", secret);
hasher.update(`${timestamp}.${payload}`);
return hasher.digest("hex");
```

This computes an **HMAC-SHA256** over `"<timestamp>.<raw JSON body>"`, keyed with the
shared secret. HMAC (not a plain hash) matters here: a plain `sha256(payload)` could be
recomputed by anyone, since the payload itself is visible on the wire. HMAC mixes in the
secret key, so only someone who holds the secret can produce a signature that matches.

The signature and the timestamp it was computed over are sent as headers, not the body,
so the receiver can check them before trusting anything in the body:

```
X-Webhook-Timestamp: 1735689600
X-Webhook-Signature: sha256=<hex digest>
```

### Verifying (receiver side)

`receiver/index.ts` → `verifySignature` does three checks, all of which must pass:

1. **Both headers are present.** No signature, no timestamp → reject immediately.
2. **The timestamp is recent** (`MAX_TIMESTAMP_SKEW_SECONDS`, 5 minutes). This defends
   against **replay attacks**: without it, someone who captures a valid request off the
   wire (or a compromised proxy/log) could resend the exact same bytes forever and the
   receiver would accept it every time, since the signature alone would still match.
   Binding the signature to a timestamp means a captured request goes stale.
3. **The signature matches.** The receiver recomputes the same HMAC over the raw request
   body plus the received timestamp, using its copy of `WEBHOOK_SECRET`, and compares it
   to the `X-Webhook-Signature` header.

```ts
return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(providedHex, "hex"));
```

The comparison uses `timingSafeEqual` instead of `===`. A normal string/byte comparison
returns as soon as it finds the first mismatched byte, so the *time it takes to reject*
leaks how many leading bytes were correct — an attacker can exploit that timing difference
to guess a valid signature one byte at a time. `timingSafeEqual` always takes the same
amount of time regardless of where the mismatch is, so there's nothing to measure.

One implementation detail worth noting: the receiver reads the body with `req.text()`
(raw bytes) instead of `req.json()`. The signature was computed over the exact bytes
`publisher` sent, so verification must hash those same exact bytes — `req.json()` parses
into an object first, and re-serializing it (`JSON.stringify`) isn't guaranteed to produce
an identical byte string (key order, spacing, number formatting can all differ).

If any of the three checks fail, the receiver responds `401 Invalid signature` and never
touches the body as an event. Only after verification succeeds does it `JSON.parse` the
body and treat it as trusted input.

## Trying it yourself

```bash
# terminal 1
cd receiver && bun run index.ts

# terminal 2
cd publisher && bun run index.ts

# terminal 3 — trigger a real, correctly signed webhook
curl -X POST http://localhost:4000/publish/payment \
  -H "Content-Type: application/json" \
  -d '{"amount": 4200, "currency": "usd"}'

# forge a request straight at the receiver — gets rejected with 401
curl -i -X POST http://localhost:3000/webhook/payment \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Timestamp: $(date +%s)" \
  -H "X-Webhook-Signature: sha256=deadbeef" \
  -d '{"type":"payment.completed","amount":999999}'
```

## Mapping this onto real-world webhooks

This lab mirrors the same pattern used by Stripe, GitHub, Slack, and most other providers:

| This lab | Real-world equivalent |
|---|---|
| `WEBHOOK_SECRET` | Per-endpoint "signing secret" you get from the provider's dashboard |
| `X-Webhook-Signature` | `Stripe-Signature`, `X-Hub-Signature-256` (GitHub), etc. |
| `X-Webhook-Timestamp` | Also usually folded into the signature header itself (e.g. Stripe's `t=...,v1=...`) |
| HMAC-SHA256 over `timestamp.body` | Same construction Stripe uses |
| 5-minute skew window | Same defense, same rough magnitude, in most providers' SDKs |

The main things a production integration adds on top of this lab: retry/backoff handling
on the publisher side (webhooks are "at least once" delivery, so receivers must handle
duplicate deliveries idempotently), and persisting the received event before doing
slow work, so a slow handler doesn't cause the publisher to time out and retry.
