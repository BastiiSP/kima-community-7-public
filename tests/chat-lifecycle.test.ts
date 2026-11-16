import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { appendNewChat, appendSentChat, ChatPage, initialChat, prependOlderChat } from "../src/lib/chat-state";

const source = readFileSync(new URL("../src/components/group-chat.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("group-chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = parsed.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === "GroupChat");
assert.ok(component?.body);
const executable = ts.transpileModule(`function render({memberId,request,onAccessLoss}) {
  ${component.body.statements.filter(item => !ts.isReturnStatement(item)).map(item => item.getText(parsed)).join("\n")}
  return {read,send,remove,setBody,scrollToLatest,messagesRef,state:{chat,error,body,loadingOlder,busy,unread}};
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

type Render = {
  read: (kind: "initial" | "older" | "newer") => Promise<void>;
  remove: (id: string) => Promise<void>;
  send: (event: { preventDefault(): void }) => Promise<void>;
  setBody: (value: string) => void;
  scrollToLatest: () => void;
  messagesRef: { current: { scrollTop: number; scrollHeight: number; clientHeight: number } | null };
  state: { chat: { messages: { id: string }[] } | null; error: string; loadingOlder: boolean; busy: boolean; body: string; unread: number };
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const page = (id: string, revision = "0"): ChatPage => ({ messages: [{ id, cursor: id, body: id, authorId: "alice", authorName: "Alice Test", createdAt: "2026-11-16T10:00:00Z" }], olderCursor: null, newerCursor: id, hasMore: false, revision });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function harness() {
  const slots: { value?: unknown; deps?: unknown[]; cleanup?: () => void }[] = [];
  const requests: { path: string; options?: RequestInit; pending: ReturnType<typeof deferred<unknown>> }[] = [];
  const timers = new Map<number, { callback: () => void; at: number }>();
  const listeners = new Map<string, () => void>();
  const accessLoss: Error[] = [];
  let index = 0, timerId = 0, now = 1_000_000;
  let effects: (() => void)[] = [];
  let onAccessLoss = (error: Error) => accessLoss.push(error);
  const changed = (before: unknown[] | undefined, after: unknown[]) => !before || after.some((item, i) => item !== before[i]);
  const hooks = {
    useState<T>(initial: T) {
      const slot = slots[index++] ?? (slots[index - 1] = { value: initial });
      return [slot.value, (next: T | ((value: T) => T)) => { slot.value = typeof next === "function" ? (next as (value: T) => T)(slot.value as T) : next; }];
    },
    useRef<T>(initial: T) { const slot = slots[index++] ?? (slots[index - 1] = { value: { current: initial } }); return slot.value; },
    useCallback<T>(callback: T, deps: unknown[]) {
      const slot = slots[index++] ?? (slots[index - 1] = {});
      if (changed(slot.deps, deps)) { slot.value = callback; slot.deps = deps; }
      return slot.value;
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const slot = slots[index++] ?? (slots[index - 1] = {});
      if (changed(slot.deps, deps)) { slot.deps = deps; effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; }); }
    },
    useLayoutEffect(effect: () => void, deps: unknown[]) { hooks.useEffect(effect, deps); },
  };
  const request = (path: string, options?: RequestInit) => { const pending = deferred<unknown>(); requests.push({ path, options, pending }); return pending.promise; };
  const windowMock = {
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    confirm() { return true; },
    addEventListener(name: string, callback: () => void) { listeners.set(name, callback); },
    removeEventListener(name: string) { listeners.delete(name); },
  };
  const documentMock = { visibilityState: "visible", addEventListener(name: string, callback: () => void) { listeners.set(name, callback); }, removeEventListener(name: string) { listeners.delete(name); } };
  const navigatorMock = { onLine: true };
  const create = new Function("hooks", "window", "document", "navigator", "Date", "initialChat", "prependOlderChat", "appendNewChat", "appendSentChat", "POLL_MS", "MIN_READ_MS", "REQUEST_TIMEOUT_MS", `const {useState,useRef,useCallback,useEffect,useLayoutEffect}=hooks; ${executable}; return render;`) as
    (...args: unknown[]) => (props: object) => Render;
  const run = create(hooks, windowMock, documentMock, navigatorMock, { now: () => now }, initialChat, prependOlderChat, appendNewChat, appendSentChat, 2_500, 1_100, 15_000);
  const render = () => { index = 0; const result = run({ memberId: "alice", request, onAccessLoss }); const pending = effects; effects = []; pending.forEach(effect => effect()); return result; };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  };
  const start = () => { render(); advance(0); };
  return { render, start, advance, freeze: (ms: number) => { now += ms; }, requests, listeners, documentMock, navigatorMock, accessLoss,
    refreshCallback: () => { onAccessLoss = (error: Error) => accessLoss.push(error); render(); },
    unmount: () => slots.forEach(slot => slot.cleanup?.()),
  };
}

async function loaded() {
  const app = harness(); app.start();
  app.requests[0].pending.resolve(page("1")); await settle(); app.render();
  return app;
}

test("visible chat continues near-live after five minutes without input; hidden/offline reads pause", async () => {
  const app = await loaded();
  app.advance(5 * 60_000);
  assert.equal(app.requests.length, 2);
  app.documentMock.visibilityState = "hidden";
  app.listeners.get("visibilitychange")!();
  assert.equal(app.requests[1].options?.signal?.aborted, true);
  app.advance(60_000); assert.equal(app.requests.length, 2);
  app.documentMock.visibilityState = "visible";
  app.navigatorMock.onLine = false;
  app.listeners.get("visibilitychange")!(); app.advance(0);
  assert.equal(app.requests.length, 2);
  app.navigatorMock.onLine = true;
  app.listeners.get("online")!(); app.advance(0);
  assert.equal(app.requests.length, 3);
  app.requests[1].pending.resolve(page("99")); await settle();
  assert.deepEqual(app.render().state.chat?.messages.map(message => message.id), ["1"]);
});

test("transient read failures back off, recover, and never overlap pending reads", async () => {
  const app = await loaded();
  app.advance(2500);
  await app.render().read("newer");
  assert.equal(app.requests.length, 2);
  app.requests[1].pending.reject(new Error("Zeitüberschreitung")); await settle();
  app.advance(4999); assert.equal(app.requests.length, 2);
  app.advance(1); assert.equal(app.requests.length, 3);
  app.requests[2].pending.resolve(page("2")); await settle();
  assert.deepEqual(app.render().state.chat?.messages.map(message => message.id), ["1", "2"]);
  assert.equal(app.render().state.error, "");
});

test("rate limits back off for one minute, including focus/manual retry", async () => {
  const app = await loaded(); app.advance(2500);
  app.requests[1].pending.reject(Object.assign(new Error("Zu viele Anfragen"), { status: 429 })); await settle();
  app.listeners.get("focus")!(); await app.render().read("initial");
  app.advance(59_999); assert.equal(app.requests.length, 2);
  app.advance(1); assert.equal(app.requests.length, 3);
});

test("hasMore catches up across pages with a minimum spacing; confirmed sends never skip interleaved messages", async () => {
  const app = await loaded();
  app.render().setBody("my message");
  const sending = app.render().send({ preventDefault() {} });
  app.requests[1].pending.resolve({ message: page("4").messages[0] }); await sending;
  assert.equal(app.render().state.busy, false);
  assert.deepEqual(app.render().state.chat?.messages.map(message => message.id), ["1", "4"]);
  app.advance(1099); assert.equal(app.requests.length, 2);
  app.advance(1); assert.equal(app.requests[2].path, "/api/chat?after=1");
  app.requests[2].pending.resolve({ ...page("2"), hasMore: true }); await settle();
  app.advance(1100); assert.equal(app.requests[3].path, "/api/chat?after=2");
  app.requests[3].pending.resolve({ ...page("4"), messages: [...page("3").messages, ...page("4").messages] }); await settle();
  assert.deepEqual(app.render().state.chat?.messages.map(message => message.id), ["1", "2", "3", "4"]);
});

test("session callback refresh does not abandon an in-flight send or leave busy stuck", async () => {
  const app = await loaded();
  app.render().setBody("draft");
  const sending = app.render().send({ preventDefault() {} });
  app.refreshCallback();
  assert.equal(app.requests[1].options?.signal?.aborted, false);
  app.requests[1].pending.resolve({ message: page("2").messages[0] }); await sending;
  assert.equal(app.render().state.busy, false);
  assert.equal(app.render().state.body, "");
  assert.deepEqual(app.render().state.chat?.messages.map(message => message.id), ["1", "2"]);
});

test("failed send retains draft, unlocks composer and never retries POST", async () => {
  const app = await loaded(); app.render().setBody("keep draft");
  const sending = app.render().send({ preventDefault() {} });
  app.requests[1].pending.reject(new Error("Zeitüberschreitung")); await sending;
  assert.equal(app.render().state.busy, false);
  assert.equal(app.render().state.body, "keep draft");
  app.advance(30_000);
  assert.equal(app.requests.filter(item => item.options?.method === "POST").length, 1);
});

test("revision change clears old messages before fetching a fresh snapshot", async () => {
  const app = await loaded(); app.advance(2500);
  app.requests[1].pending.resolve(page("2", "1")); await settle();
  assert.equal(app.render().state.chat, null);
  app.advance(1100); assert.equal(app.requests[2].path, "/api/chat");
  app.requests[2].pending.resolve(page("3", "1")); await settle();
  assert.deepEqual(app.render().state.chat?.messages.map(message => message.id), ["3"]);
});

test("own deletion cancels old reads and releases busy without waiting for the stale read", async () => {
  const app = await loaded(); app.advance(2500);
  const deletion = app.render().remove("1");
  app.requests[2].pending.resolve({ ok: true }); await deletion;
  assert.equal(app.requests[1].options?.signal?.aborted, true);
  assert.equal(app.render().state.chat, null);
  assert.equal(app.render().state.busy, false);
  app.advance(1100); assert.equal(app.requests[3].path, "/api/chat");
  app.requests[1].pending.resolve(page("1")); await settle();
  assert.equal(app.render().state.chat, null);
  app.requests[3].pending.resolve({ ...page("2", "1"), messages: [] }); await settle();
  assert.deepEqual(app.render().state.chat?.messages, []);
});

test("a late send response cannot reinsert text after a newer deletion revision", async () => {
  const app = await loaded(); app.render().setBody("draft");
  const sending = app.render().send({ preventDefault() {} }); app.advance(2500);
  app.requests[2].pending.resolve(page("2", "1")); await settle();
  app.advance(1100); app.requests[3].pending.resolve(page("3", "1")); await settle();
  app.requests[1].pending.resolve({ message: page("2").messages[0] }); await sending;
  assert.deepEqual(app.render().state.chat?.messages.map(message => message.id), ["3"]);
  assert.equal(app.render().state.busy, false);
});

test("hiding an in-flight older-page read releases its loading indicator", async () => {
  const app = harness(); app.start(); app.requests[0].pending.resolve({ ...page("2"), olderCursor: "2" }); await settle();
  app.advance(1100); const reading = app.render().read("older");
  assert.equal(app.render().state.loadingOlder, true);
  app.documentMock.visibilityState = "hidden"; app.listeners.get("visibilitychange")!();
  assert.equal(app.render().state.loadingOlder, false);
  app.requests[1].pending.resolve(page("1")); await reading;
  assert.deepEqual(app.render().state.chat?.messages.map(message => message.id), ["2"]);
});

test("unmount and access loss discard late private reads and sends", async () => {
  for (const stop of ["unmount", "access"] as const) {
    const app = await loaded(); app.render().setBody("draft");
    const sending = app.render().send({ preventDefault() {} }); app.advance(2500);
    if (stop === "unmount") app.unmount();
    else { app.requests[2].pending.reject(Object.assign(new Error("blocked"), { status: 403 })); await settle(); }
    app.requests[1].pending.resolve({ message: page("99").messages[0] }); await sending;
    app.requests[2].pending.resolve(page("99")); await settle();
    assert.ok(!app.render().state.chat?.messages.some(message => message.id === "99"));
    assert.equal(app.requests[1].options?.signal?.aborted, true);
    if (stop === "access") assert.equal(app.render().state.chat, null);
  }
});

test("incoming messages preserve an older reading position and expose unread navigation", async () => {
  const app = await loaded();
  const list = { scrollTop: 80, scrollHeight: 1000, clientHeight: 300 };
  app.render().messagesRef.current = list;
  app.advance(2500); app.requests[1].pending.resolve(page("2")); await settle();
  list.scrollHeight = 1200; app.render();
  assert.equal(list.scrollTop, 80);
  assert.equal(app.render().state.unread, 1);
  app.render().scrollToLatest();
  assert.equal(list.scrollTop, 1200);
  assert.equal(app.render().state.unread, 0);
});

test("older-page prepend preserves the visible message position; a reader near the end follows new messages", async () => {
  const app = harness(); app.start(); app.requests[0].pending.resolve({ ...page("2"), olderCursor: "2" }); await settle(); app.render();
  const list = { scrollTop: 40, scrollHeight: 1000, clientHeight: 300 };
  app.render().messagesRef.current = list;
  app.advance(1100); const older = app.render().read("older");
  app.requests[1].pending.resolve(page("1")); await older;
  list.scrollHeight = 1200; app.render(); assert.equal(list.scrollTop, 240);
  list.scrollTop = 880;
  app.advance(2500); app.requests[2].pending.resolve(page("3")); await settle();
  list.scrollHeight = 1400; app.render(); assert.equal(list.scrollTop, 1400);
});

test("page restoration replaces only an expired chat read and ignores its late private result", async () => {
  const app = await loaded(); app.render().setBody("draft after return"); app.advance(2500);
  const old = app.requests[1];
  app.freeze(15_001);
  app.listeners.get("pageshow")!(); app.advance(0);
  assert.equal(old.options?.signal?.aborted, true);
  assert.equal(app.requests.length, 3);
  assert.equal(app.render().state.body, "draft after return");
  old.pending.reject(Object.assign(new Error("expired old read"), { status: 401 })); await settle();
  assert.equal(app.accessLoss.length, 0);
  assert.equal(app.requests[2].options?.signal?.aborted, false);
  app.requests[2].pending.resolve(page("2")); await settle();
  assert.deepEqual(app.render().state.chat?.messages.map(message => message.id), ["1", "2"]);
});

test("a slow initial chat read does not serialize a confirmed send behind it", async () => {
  const app = harness(); app.start(); app.render().setBody("new message");
  const sending = app.render().send({ preventDefault() {} });
  assert.equal(app.requests[1].options?.method, "POST");
  app.requests[1].pending.resolve({ message: page("2").messages[0] }); await sending;
  assert.equal(app.render().state.busy, false);
  assert.equal(app.render().state.body, "");
  assert.equal(app.requests.filter(item => item.options?.method === "POST").length, 1);
  app.requests[0].pending.resolve(page("2")); await settle();
});
