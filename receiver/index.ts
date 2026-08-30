import { timingSafeEqual } from "node:crypto";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "dev-shared-secret";
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

function signPayload(payload: string, timestamp: string, secret: string) {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(`${timestamp}.${payload}`);
  return hasher.digest("hex");
}

function verifySignature(
  body: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
) {
  if (!timestampHeader || !signatureHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;

  const skewSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (skewSeconds > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const expectedHex = signPayload(body, timestampHeader, WEBHOOK_SECRET);
  const providedHex = signatureHeader.replace(/^sha256=/, "");

  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
}

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/webhook/payment") {
      const body = await req.text();
      const timestamp = req.headers.get("X-Webhook-Timestamp");
      const signature = req.headers.get("X-Webhook-Signature");

      if (!verifySignature(body, timestamp, signature)) {
        console.warn("rejected webhook: invalid signature");
        return new Response("Invalid signature", { status: 401 });
      }

      const event = JSON.parse(body);
      console.log("received verified webhook:", event.type, event.id);
      console.log("payload:", event.data);
      return new Response("OK");
    }

    console.log("Received a request to an unknown endpoint");
    return new Response("Not Found", { status: 404 });
  },
});

console.log("Receiver is running on http://localhost:3000");
