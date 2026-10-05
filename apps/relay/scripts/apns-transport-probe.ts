// Transport-only probe: intentionally contains no provider credentials or device token.
export default {
  async fetch(): Promise<Response> {
    const response = await fetch("https://api.sandbox.push.apple.com/3/device/invalid", {
      method: "POST",
      headers: { "apns-push-type": "alert", "apns-topic": "invalid.example" },
      body: JSON.stringify({ aps: { alert: "probe" } }),
    });
    const body = await response.text();
    return Response.json({ status: response.status, apnsError: body.slice(0, 256) });
  },
};
