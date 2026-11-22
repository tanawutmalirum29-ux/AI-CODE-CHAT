import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isBlockedAddress, parseEngineUrl, guardedRequest, EngineError } from "../lib/engines/net-guard.js";
import { listEngineModels, completeWithEngine, streamFromEngine } from "../lib/engines/chat-adapter.js";
import { CircuitBreaker, checkChatHealth, checkComfyHealth } from "../lib/engines/health.js";
import { validateProfileInput, publicProfile, envProfile, isEngineProvider, engineIdFromProvider } from "../lib/engines/profiles.js";

const LOCAL = { allowHttp: false, allowedHosts: new Set(["127.0.0.1"]) };

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try { await fn(base); } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
}
const profileFor = (base, extra = {}) => ({ id: "t", name: "Test", chatUrl: base + "/v1", authScheme: "bearer", chatTimeoutMs: 5000, comfyUrl: base, comfyAuthScheme: "bearer", comfyTimeoutMs: 5000, ...extra });
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

test("private, loopback, link-local and reserved addresses are blocked", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test("public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isBlockedAddress(ip), false, ip);
});

test("engine URLs must be HTTPS and free of credentials, queries and private literals", () => {
  const policy = { allowHttp: false, allowedHosts: new Set() };
  assert.equal(parseEngineUrl("https://engine.example.com/v1/", policy).pathname, "/v1");
  for (const bad of ["http://engine.example.com", "ftp://x.com", "https://user:pw@x.com", "https://x.com/v1?key=1", "https://169.254.169.254/", "https://127.0.0.1/", "https://[::1]/", "not a url", ""]) {
    assert.throws(() => parseEngineUrl(bad, policy), EngineError, bad);
  }
});

test("allowlist and ENGINE_ALLOW_HTTP are the only ways to relax the policy", () => {
  assert.doesNotThrow(() => parseEngineUrl("http://127.0.0.1:8129/v1", LOCAL));
  assert.doesNotThrow(() => parseEngineUrl("http://engine.example.com", { allowHttp: true, allowedHosts: new Set() }));
});

test("hostnames resolving to private addresses are refused at connect time", async () => {
  await withServer((req, res) => json(res, 200, {}), async base => {
    const port = new URL(base).port;
    await assert.rejects(
      guardedRequest({ url: "http://localhost:" + port + "/v1/models", policy: { allowHttp: true, allowedHosts: new Set() }, timeoutMs: 3000 }),
      error => error instanceof EngineError && error.code === "address_blocked"
    );
  });
});

test("redirects are not followed", async () => {
  await withServer((req, res) => { res.writeHead(302, { Location: "http://169.254.169.254/" }); res.end(); }, async base => {
    await assert.rejects(guardedRequest({ url: base + "/x", policy: LOCAL, timeoutMs: 3000 }), error => error.code === "redirect_blocked");
  });
});

test("slow engines time out with a clear error", async () => {
  await withServer(() => {}, async base => {
    await assert.rejects(guardedRequest({ url: base + "/x", policy: LOCAL, timeoutMs: 150 }), error => error.code === "timeout");
  });
});

test("oversized responses are rejected", async () => {
  await withServer((req, res) => res.end("x".repeat(5000)), async base => {
    await assert.rejects(guardedRequest({ url: base + "/x", policy: LOCAL, timeoutMs: 3000, maxBytes: 1000 }), error => error.code === "response_too_large");
  });
});

test("model discovery sends the bearer token and normalises the list", async () => {
  let auth = null;
  await withServer((req, res) => { auth = req.headers.authorization; json(res, 200, { data: [{ id: "m1", name: "Model One" }, { id: "m2" }, { nope: 1 }] }); }, async base => {
    const result = await listEngineModels(profileFor(base), "secret-token", LOCAL);
    assert.equal(auth, "Bearer secret-token");
    assert.deepEqual(result.models.map(m => m.id), ["m1", "m2"]);
    assert.equal(result.defaultModel, "m1");
  });
});

test("auth scheme none sends no Authorization header", async () => {
  let auth = "unset";
  await withServer((req, res) => { auth = req.headers.authorization; json(res, 200, { data: [{ id: "m" }] }); }, async base => {
    await listEngineModels(profileFor(base, { authScheme: "none" }), "ignored", LOCAL);
    assert.equal(auth, undefined);
  });
});

test("engine HTTP errors map to understandable messages", async () => {
  for (const [status, code] of [[401, "unauthorized"], [404, "not_found"], [429, "rate_limited"], [503, "unavailable"], [500, "upstream_error"]]) {
    await withServer((req, res) => json(res, status, { error: { message: "boom" } }), async base => {
      await assert.rejects(listEngineModels(profileFor(base), "t", LOCAL), error => error instanceof EngineError && error.code === code, String(status));
    });
  }
});

test("chat completion returns text and forwards messages, model and limits", async () => {
  let received;
  await withServer((req, res) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => { received = JSON.parse(data); json(res, 200, { model: "m1", choices: [{ message: { content: "สวัสดี" } }], usage: { total_tokens: 5 } }); });
  }, async base => {
    const messages = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
    const result = await completeWithEngine({ profile: profileFor(base), token: "t", model: "m1", messages, temperature: 0.2, maxTokens: 300, policy: LOCAL });
    assert.equal(result.text, "สวัสดี");
    assert.equal(received.stream, false);
    assert.deepEqual(received.messages, messages);
    assert.equal(received.max_tokens, 300);
  });
});

test("empty chat response is an error, not a blank message", async () => {
  await withServer((req, res) => json(res, 200, { choices: [{ message: { content: "" } }] }), async base => {
    await assert.rejects(completeWithEngine({ profile: profileFor(base), token: "t", model: "m", messages: [{ role: "user", content: "x" }], policy: LOCAL }), error => error.code === "empty_response");
  });
});

test("streaming yields deltas across split SSE frames", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = text => "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n";
    const whole = frame("Hel") + frame("lo") + "data: [DONE]\n\n";
    res.write(whole.slice(0, 20));
    setTimeout(() => { res.write(whole.slice(20)); res.end(); }, 30);
  }, async base => {
    let out = "";
    for await (const part of streamFromEngine({ profile: profileFor(base), token: "t", model: "m", messages: [{ role: "user", content: "x" }], policy: LOCAL })) out += part.delta;
    assert.equal(out, "Hello");
  });
});

test("streaming surfaces HTTP errors and aborts cleanly", async () => {
  await withServer((req, res) => json(res, 401, { error: { message: "nope" } }), async base => {
    await assert.rejects(async () => { for await (const _ of streamFromEngine({ profile: profileFor(base), token: "t", model: "m", messages: [{ role: "user", content: "x" }], policy: LOCAL })); }, error => error.code === "unauthorized");
  });
  await withServer((req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "a" } }] }) + "\n\n"); }, async base => {
    const controller = new AbortController();
    const seen = [];
    await assert.rejects(async () => {
      for await (const part of streamFromEngine({ profile: profileFor(base), token: "t", model: "m", messages: [{ role: "user", content: "x" }], signal: controller.signal, policy: LOCAL })) { seen.push(part.delta); controller.abort(); }
    });
    assert.deepEqual(seen, ["a"]);
  });
});

test("health check reports ok, degraded and unauthorized states", async () => {
  await withServer((req, res) => json(res, 200, { data: [{ id: "m" }] }), async base => {
    const health = await checkChatHealth(profileFor(base), "t", LOCAL);
    assert.equal(health.status, "ok");
    assert.equal(health.modelCount, 1);
  });
  await withServer((req, res) => json(res, 200, { data: [] }), async base => {
    assert.equal((await checkChatHealth(profileFor(base), "t", LOCAL)).status, "degraded");
  });
  await withServer((req, res) => json(res, 401, {}), async base => {
    assert.equal((await checkChatHealth(profileFor(base), "t", LOCAL)).status, "unauthorized");
  });
  assert.equal((await checkChatHealth(profileFor("http://127.0.0.1:1", { chatUrl: "" }), "", LOCAL)).status, "unconfigured");
});

test("ComfyUI health probes /system_stats independently of chat", async () => {
  let path = null;
  await withServer((req, res) => { path = req.url; json(res, 200, { devices: [{ name: "gpu" }] }); }, async base => {
    const health = await checkComfyHealth(profileFor(base), "", LOCAL);
    assert.equal(path, "/system_stats");
    assert.equal(health.status, "ok");
    assert.equal(health.deviceCount, 1);
  });
  const chat = await checkChatHealth(profileFor("http://127.0.0.1:1", { chatUrl: "http://127.0.0.1:1/v1" }), "", LOCAL);
  assert.equal(chat.status, "unreachable");
});

test("circuit breaker opens after repeated failures and recovers", () => {
  let now = 0;
  const breaker = new CircuitBreaker({ threshold: 2, openMs: 1000, now: () => now });
  breaker.failure("k"); assert.equal(breaker.isOpen("k"), false);
  breaker.failure("k"); assert.equal(breaker.isOpen("k"), true);
  now = 1500; assert.equal(breaker.isOpen("k"), false);
  breaker.success("k"); breaker.failure("k"); assert.equal(breaker.isOpen("k"), false);
});

test("profile validation enforces URL policy and never echoes tokens", () => {
  const strict = { allowHttp: false, allowedHosts: new Set() };
  assert.throws(() => validateProfileInput({ name: "x", chatUrl: "http://a.example.com" }, strict));
  assert.throws(() => validateProfileInput({ name: "", chatUrl: "https://a.example.com" }, strict));
  assert.throws(() => validateProfileInput({ name: "x" }, strict));
  assert.throws(() => validateProfileInput({ name: "x", chatUrl: "https://a.example.com", chatToken: "a\nb1234" }, strict));
  const input = validateProfileInput({ name: " Rig ", chatUrl: "https://a.example.com/v1", chatToken: "token-1234", chatTimeoutMs: 1 }, strict);
  assert.equal(input.name, "Rig");
  assert.equal(input.chatTimeoutMs, 5000);
  const view = publicProfile({ id: "1", name: "Rig", chatUrl: "https://a.example.com/v1", chatToken: "token-1234", hasChatToken: true });
  assert.equal(JSON.stringify(view).includes("token-1234"), false);
  assert.equal(view.hasChatToken, true);
});

test("server-wide engine profile comes from environment only", () => {
  assert.equal(envProfile({}), null);
  const result = envProfile({ LU_CHAT_BASE_URL: "https://lu.example.com/v1", LU_CHAT_TOKEN: "abc12345" });
  assert.equal(result.profile.id, "env");
  assert.equal(result.chatToken, "abc12345");
  assert.equal(isEngineProvider("engine:env"), true);
  assert.equal(isEngineProvider("venice"), false);
  assert.equal(engineIdFromProvider("engine:abc"), "abc");
});
