const fetchReceiver = async (event: any) => {
  return await fetch("http://localhost:3000/webhook/payment", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
};

Bun.serve({
  port: 4000,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/publish/payment") {
      const event = { event: "payment.succeeded", orderId: "abc" };

      for (let i = 0; i < 4; i++) {
        try {
          const response = await fetchReceiver(event);
          if (!response.ok)
            throw new Error(`receiver returned ${response.status}`);
          console.log("delivered:", response.status);
          break;
        } catch (e) {
          console.error(`attempt ${i + 1} failed:`, e);
        }

        if (i < 3) await Bun.sleep(1000 * 2 ** i);
      }
      // 4. answer the person who hit /publish/payment
      return new Response("published");
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log("Publisher is running on http://localhost:4000");
