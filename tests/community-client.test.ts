import assert from "node:assert/strict";
import { test } from "node:test";
import { api, ApiError, REQUEST_TIMEOUT_MS } from "../src/lib/community-client";

function abortable(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

test("caller cancellation reaches fetch and remains an AbortError", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (_path, options) => abortable(options?.signal);
    const pending = api("/synthetic", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});

test("timeout bounds writes without retrying and preserves the supplied headers", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (_path, options) => {
      calls++;
      assert.equal(options?.method, "POST");
      assert.equal(new Headers(options?.headers).get("X-Synthetic"), "yes");
      return abortable(options?.signal);
    };
    const pending = api("/synthetic", { method: "POST", headers: new Headers({ "X-Synthetic": "yes" }) });
    context.mock.timers.tick(REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.code === "REQUEST_TIMEOUT" && error.message.includes("bereits angekommen"));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; context.mock.timers.reset(); }
});

test("timeout also covers response-body reads", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_path, options) => ({ ok: true, json: () => abortable(options?.signal) }) as unknown as Response;
    const pending = api("/synthetic");
    await Promise.resolve();
    context.mock.timers.tick(REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.code === "REQUEST_TIMEOUT");
  } finally { globalThis.fetch = original; context.mock.timers.reset(); }
});

test("operator responses retain access-loss codes", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: "COMMUNITY_PAUSED", error: "Pausiert" }), { status: 503 });
    await assert.rejects(api("/synthetic"), (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === "COMMUNITY_PAUSED");
  } finally { globalThis.fetch = original; }
});

test("auth requests with their own signal still time out, including a stalled response body", async context => {
  const { authFetch } = await import("../src/lib/community-client");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  const caller = new AbortController();
  let calls = 0;
  try {
    globalThis.fetch = async (_path, options) => {
      calls++;
      assert.notEqual(options?.signal, caller.signal);
      return { arrayBuffer: () => new Promise(() => {}) } as unknown as Response;
    };
    const pending = authFetch("https://synthetic.test/api/auth/sign-in/email-otp", { method: "POST", signal: caller.signal });
    await Promise.resolve();
    context.mock.timers.tick(REQUEST_TIMEOUT_MS);
    await assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.code === "REQUEST_TIMEOUT");
    assert.equal(caller.signal.aborted, false);
    assert.equal(calls, 1, "an ambiguous OTP write must never be retried");
  } finally { globalThis.fetch = original; context.mock.timers.reset(); }
});

test("auth preserves confirmed empty sessions and access-loss HTTP responses", async () => {
  const { authFetch } = await import("../src/lib/community-client");
  const original = globalThis.fetch;
  try {
    for (const status of [200, 401, 403, 503]) {
      const result = status === 200 ? null : { code: status === 503 ? "COMMUNITY_PAUSED" : "FORBIDDEN" };
      globalThis.fetch = async () => Response.json(result, { status });
      const response = await authFetch("https://synthetic.test/api/auth/get-session");
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), result);
    }
  } finally { globalThis.fetch = original; }
});

test("auth respects caller cancellation even when the transport never settles", async () => {
  const { authFetch } = await import("../src/lib/community-client");
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async () => new Promise(() => {});
    const pending = authFetch("https://synthetic.test/api/auth/get-session", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});

test("return from a frozen page expires pending reads and writes without waiting for suspended timers", async context => {
  const { authFetch } = await import("../src/lib/community-client");
  const original = globalThis.fetch;
  const browser = new EventTarget();
  const document = new EventTarget();
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Promise(() => {}); };
    const reading = api("/synthetic");
    const writing = authFetch("https://synthetic.test/api/auth/sign-out", { method: "POST", signal: new AbortController().signal });
    // Advance wall time only: queued timeout callbacks remain suspended.
    context.mock.timers.setTime(100_000 + REQUEST_TIMEOUT_MS + 1);
    browser.dispatchEvent(new Event("pageshow"));
    await assert.rejects(reading, (error: unknown) => error instanceof ApiError && error.code === "REQUEST_TIMEOUT");
    await assert.rejects(writing, (error: unknown) => error instanceof ApiError && error.code === "REQUEST_TIMEOUT");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original; context.mock.timers.reset();
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window");
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor); else Reflect.deleteProperty(globalThis, "document");
  }
});
