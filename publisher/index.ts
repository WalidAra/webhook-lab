const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "dev-shared-secret";
const RECEIVER_URL =
  process.env.RECEIVER_URL ?? "http://localhost:3000/webhook/payment";

function signPayload(payload: string, timestamp: number, secret: string) {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(`${timestamp}.${payload}`);
  return hasher.digest("hex");
}

async function deliver(event: unknown) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(payload, timestamp, WEBHOOK_SECRET);

  return fetch(RECEIVER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Timestamp": String(timestamp),
      "X-Webhook-Signature": `sha256=${signature}`,
    },
    body: payload,
  });
}

Bun.serve({
  port: 4000,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/publish/payment") {
      const body = (await req.json().catch(() => ({}))) as {
        amount?: number;
        currency?: string;
      };
      const event = {
        id: crypto.randomUUID(),
        type: "payment.completed",
        createdAt: new Date().toISOString(),
        data: {
          amount: body.amount ?? 4200,
          currency: body.currency ?? "usd",
        },
      };

      let receiverStatus: number | null = null;
      for (let i = 0; i < 4; i++) {
        try {
          const response = await deliver(event);
          receiverStatus = response.status;
          if (!response.ok)
            throw new Error(`receiver returned ${response.status}`);
          console.log("delivered:", response.status);
          break;
        } catch (e) {
          console.error(`attempt ${i + 1} failed:`, e);
        }

        if (i < 3) await Bun.sleep(1000 * 2 ** i);
      }

      return Response.json({ published: event.id, receiverStatus });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log("Publisher is running on http://localhost:4000");
