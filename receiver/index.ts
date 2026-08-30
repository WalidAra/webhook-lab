Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "POST" && pathname === "/webhook/payment") {
      console.log("Received a payment webhook request");
      console.log("Processing payment webhook");
      const requestBody = await req.json();
      console.log("Request Body:", requestBody);
      return new Response("OK");
    } else {
      console.log("Received a request to an unknown endpoint");

      return new Response("Not Found", { status: 404 });
    }
  },
});

console.log("Receiver is running on http://localhost:3000");
