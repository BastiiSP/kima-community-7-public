import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { mergeComments, mergeFeedPage } from "../src/lib/feed-state";

type Feed = { member: { id: string }; posts: { id: string; createdAt: string; body?: string; deleted?: boolean; comments: never[]; commentCount: number; commentsNextCursor: null; commentsTruncated: false }[]; nextCursor: string | null };
type Session = { data: { user: { id: string } } | null; isPending: boolean; error: { status?: number; code?: string } | null };
type Effect = () => void | (() => void);
type Render = {
  loadCommunity: () => Promise<void>;
  loadMore: () => Promise<void>;
  signOut: () => Promise<void>;
  action: (work: (isCurrent: () => boolean) => Promise<void>, success?: string, onFailure?: (message: string) => void, lockWriting?: boolean) => Promise<boolean>;
  confirmPostEdit: (id: string, body: string) => void;
  confirmPostDelete: (id: string) => void;
  setPanel: (value: string) => void;
  setSection: (value: string) => void;
  state: { view: string; community: Feed | null; panel: string; error: string; inviteToken: string; busy: boolean; loadingMore: boolean };
};

class TestApiError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(`synthetic ${status}`); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Execute the actual component callbacks, not a second implementation of their
// guards. Small hook stubs model rerenders and pending I/O, without a DOM/server.
// This supplements browser tests; it does not claim React/Better Auth coverage.
const source = readFileSync(new URL("../src/components/community-app.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("community-app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "CommunityApp");
assert.ok(component?.body);
const statements = component.body.statements.filter(node => !ts.isReturnStatement(node));
const executable = ts.transpileModule(`function render() {
  ${statements.map(node => node.getText(parsed)).join("\n")}
  return {loadCommunity, loadMore, signOut, setPanel, setSection, action, confirmPostDelete, confirmPostEdit,
    state: {view, community, panel, error, inviteToken, busy, loadingMore}};
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function harness(initialUrl = "https://community.example/#invite=synthetic") {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const timers = new Map<number, () => void>();
  const reads: ReturnType<typeof deferred<Feed>>[] = [];
  const logouts: ReturnType<typeof deferred<{ error?: { message: string } }>>[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let stateIndex = 0, refIndex = 0, timerId = 0, now = 10_000;
  let effects: Effect[] = [];
  let session: Session = { data: null, isPending: true, error: null };
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const index = stateIndex++;
      if (index === states.length) states.push(typeof initial === "function" ? (initial as () => T)() : initial);
      const set = (next: T | ((previous: T) => T)) => {
        states[index] = typeof next === "function" ? (next as (previous: T) => T)(states[index] as T) : next;
      };
      return [states[index] as T, set];
    },
    useRef<T>(initial: T) {
      const index = refIndex++;
      if (index === refs.length) refs.push({ current: initial });
      return refs[index] as { current: T };
    },
    useCallback<T>(callback: T) { return callback; },
    useEffect(effect: Effect) { effects.push(effect); },
  };
  const client = {
    useSession: () => session,
    signOut: () => { const request = deferred<{ error?: { message: string } }>(); logouts.push(request); return request.promise; },
  };
  const api = () => { const request = deferred<Feed>(); reads.push(request); return request.promise; };
  const browser = {
    location: new URL(initialUrl),
    history: {
      state: { __NA: true, syntheticRouterState: "preserve" } as unknown,
      replaceState(value: unknown, _title: string, url: string) {
        browser.history.state = value;
        browser.location = new URL(url, browser.location);
      },
    },
    addEventListener(name: string, listener: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); },
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const create = new Function("hooks", "authClient", "api", "ApiError", "window", "document", "navigator", "mergeComments", "mergeFeedPage", "Date", "REQUEST_TIMEOUT_MS",
    `const {useState,useRef,useCallback,useEffect}=hooks; ${executable}; return render;`) as
    (hooks: object, client: object, api: () => Promise<Feed>, error: typeof TestApiError, browser: object, document: object, navigator: object, comments: typeof mergeComments, merge: typeof mergeFeedPage, clock: object, timeout: number) => () => Render;
  const document = { visibilityState: "visible", addEventListener: browser.addEventListener, removeEventListener: browser.removeEventListener };
  const navigator = { onLine: true };
  const run = create(hooks, client, api, TestApiError, browser, document, navigator, mergeComments, mergeFeedPage, { now: () => now }, 15_000);
  const render = () => { stateIndex = 0; refIndex = 0; effects = []; const result = run(); effects[3]?.(); return result; };
  const flushTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); };
  const mountInvitation = () => { render(); return effects[1](); };
  const navigate = (url: string, event = "hashchange") => {
    browser.location = new URL(url, browser.location);
    listeners.get(event)?.forEach(listener => listener());
  };
  const updateSession = (value: Session) => {
    session = value;
    render();
    assert.ok(effects[0], "the session effect must remain available");
    effects[0]();
    flushTimers();
  };
  const mountPolling = () => { render(); return effects[2](); };
  return { render, updateSession, reads, logouts, browser, mountInvitation, mountPolling, navigate, flushTimers, listeners, document, navigator, advance: (ms: number) => { now += ms; } };
}

const feed = (id: string): Feed => ({ member: { id }, posts: [{ id: `${id}-post`, createdAt: "2026-11-16T12:00:00Z", comments: [], commentCount: 0, commentsNextCursor: null, commentsTruncated: false }], nextCursor: `${id}-cursor` });
async function showFeed(state: ReturnType<typeof harness>, id = "alice") {
  const pending = state.render().loadCommunity();
  state.reads.at(-1)!.resolve(feed(id));
  await pending;
}

test("pending background session checks preserve login and its invitation", () => {
  const state = harness();
  assert.equal(state.render().state.view, "loading");
  state.mountInvitation(); state.flushTimers();
  state.updateSession({ data: null, isPending: false, error: null });
  assert.equal(state.render().state.view, "login");
  state.updateSession({ data: null, isPending: true, error: null });
  assert.equal(state.render().state.view, "login");
  assert.equal(state.render().state.inviteToken, "synthetic");
  assert.equal(state.reads.length, 0);
});

test("invitation capture starts after mount, cleans both URL forms and preserves router state", () => {
  for (const [url, token, cleaned] of [
    ["https://community.example/?keep=1#invite=fragment&tab=chat", "fragment", "https://community.example/?keep=1#tab=chat"],
    ["https://community.example/?invite=legacy&keep=1#pinnwand", "legacy", "https://community.example/?keep=1#pinnwand"],
    ["https://community.example/?invite=legacy#invite=fragment", "fragment", "https://community.example/"],
  ]) {
    const state = harness(url);
    assert.equal(state.render().state.inviteToken, "", "first render must not depend on browser location");
    const routerState = state.browser.history.state;
    state.mountInvitation(); state.flushTimers();
    assert.equal(state.render().state.inviteToken, token);
    assert.equal(state.browser.location.href, cleaned);
    assert.equal(state.browser.history.state, routerState);
  }
});

test("an already authenticated nonmember receives in-place invitation navigation", async () => {
  const state = harness("https://community.example/");
  state.mountInvitation(); state.flushTimers();
  state.updateSession({ data: { user: { id: "newcomer" } }, isPending: false, error: null });
  state.reads.at(-1)!.reject(new TestApiError(403)); await Promise.resolve();
  assert.equal(state.render().state.view, "join");
  assert.equal(state.render().state.inviteToken, "");
  state.navigate("#invite=in-place");
  assert.equal(state.render().state.inviteToken, "in-place");
  assert.equal(state.browser.location.href, "https://community.example/");
  state.updateSession({ data: null, isPending: true, error: null });
  assert.equal(state.render().state.view, "join");
  assert.equal(state.render().state.inviteToken, "in-place");
  state.navigate("#pinnwand");
  state.navigate("#invite=");
  assert.equal(state.render().state.inviteToken, "in-place", "unrelated/empty fragments must not erase the in-memory invitation");
  state.navigate("?invite=next&keep=1", "popstate");
  assert.equal(state.render().state.inviteToken, "next");
  assert.equal(state.browser.location.href, "https://community.example/?keep=1");
});

test("invitation effect replay retains capture and removes listeners on cleanup", () => {
  const state = harness();
  const firstCleanup = state.mountInvitation();
  firstCleanup?.();
  state.flushTimers();
  const secondCleanup = state.mountInvitation();
  state.flushTimers();
  assert.equal(state.render().state.inviteToken, "synthetic");
  secondCleanup?.();
  const finalCleanup = state.mountInvitation(); state.flushTimers();
  assert.equal(state.render().state.inviteToken, "synthetic", "effect replay after URL cleanup retains the token");
  assert.equal(state.listeners.get("hashchange")?.size, 1);
  assert.equal(state.listeners.get("popstate")?.size, 1);
  finalCleanup?.();
  assert.equal(state.listeners.get("hashchange")?.size, 0);
  assert.equal(state.listeners.get("popstate")?.size, 0);
  state.navigate("#invite=after-unmount");
  state.flushTimers();
  assert.equal(state.render().state.inviteToken, "synthetic");
});

test("logout rejects late feed success and failure, including reads begun during logout", async () => {
  for (const failure of [false, true]) {
    const state = harness();
    await showFeed(state);
    state.render().setPanel("invite");
    const beforeLogout = state.render().loadCommunity();
    const oldRead = state.reads.at(-1)!;
    const logout = state.render().signOut();
    const duringLogout = state.render().loadCommunity();
    const newerRead = state.reads.at(-1)!;
    state.logouts.at(-1)!.resolve({});
    await logout;
    if (failure) { oldRead.reject(new TestApiError(503)); newerRead.reject(new TestApiError(403)); }
    else { oldRead.resolve(feed("old")); newerRead.resolve(feed("during-logout")); }
    await Promise.all([beforeLogout, duringLogout]);
    assert.equal(state.render().state.view, "login");
    assert.equal(state.render().state.community, null);
    assert.equal(state.render().state.panel, "none");
    assert.equal(state.render().state.error, "");
  }
});

test("confirmed session loss invalidates pending private reads", async () => {
  for (const status of [null]) {
    const state = harness();
    await showFeed(state);
    state.render().setPanel("invite");
    const pending = state.render().loadCommunity();
    const request = state.reads.at(-1)!;
    state.updateSession({ data: null, isPending: false, error: status ? { status } : null });
    request.resolve(feed("late")); await pending;
    assert.equal(state.render().state.view, status ? "setup" : "login");
    assert.equal(state.render().state.community, null);
    assert.equal(state.render().state.panel, "none");
  }
});

test("a new session cannot be replaced by the previous session's delayed feed or error", async () => {
  for (const failure of [false, true]) {
    const state = harness();
    await showFeed(state);
    const pending = state.render().loadCommunity();
    const oldRead = state.reads.at(-1)!;
    state.updateSession({ data: { user: { id: "bob" } }, isPending: false, error: null });
    state.reads.at(-1)!.resolve(feed("bob"));
    await Promise.resolve();
    if (failure) oldRead.reject(new TestApiError(401)); else oldRead.resolve(feed("alice"));
    await pending;
    assert.equal(state.render().state.view, "feed");
    assert.deepEqual(state.render().state.community, feed("bob"));
    assert.equal(state.render().state.error, "");
  }
});

test("pagination ignores old pages and errors after logout or a change of account", async () => {
  for (const destination of ["logout", "bob"]) for (const failure of [false, true]) {
    const state = harness();
    await showFeed(state);
    const pending = state.render().loadMore();
    const oldPage = state.reads.at(-1)!;
    if (destination === "logout") {
      const logout = state.render().signOut();
      state.logouts.at(-1)!.resolve({}); await logout;
    } else {
      state.updateSession({ data: { user: { id: "bob" } }, isPending: false, error: null });
      state.reads.at(-1)!.resolve(feed("bob")); await Promise.resolve();
    }
    if (failure) oldPage.reject(new TestApiError(503)); else oldPage.resolve(feed("alice-private-page"));
    await pending;
    assert.equal(state.render().state.view, destination === "logout" ? "login" : "feed");
    assert.deepEqual(state.render().state.community, destination === "logout" ? null : feed("bob"));
    assert.equal(state.render().state.error, "");
  }
});


test("operator pause or block clears private state and invalidates delayed responses", async () => {
  for (const code of ["COMMUNITY_PAUSED", "MEMBER_BLOCKED"]) {
    const state = harness();
    await showFeed(state);
    state.render().setPanel("invite");
    const pending = state.render().loadMore();
    const oldPage = state.reads.at(-1)!;
    state.updateSession({ data: null, isPending: false, error: { status: code === "COMMUNITY_PAUSED" ? 503 : 403, code } });
    oldPage.resolve(feed("late-private"));
    await pending;
    assert.equal(state.render().state.view, "unavailable");
    assert.equal(state.render().state.community, null);
    assert.equal(state.render().state.panel, "none");
  }
});

test("operator errors during feed or pagination hide private data instead of showing join", async () => {
  for (const code of ["COMMUNITY_PAUSED", "MEMBER_BLOCKED"]) for (const method of ["loadCommunity", "loadMore"] as const) {
    const state = harness();
    await showFeed(state);
    state.render().setPanel("invite");
    const pending = state.render()[method]();
    state.reads.at(-1)!.reject(new TestApiError(code === "COMMUNITY_PAUSED" ? 503 : 403, code));
    await pending;
    assert.equal(state.render().state.view, "unavailable");
    assert.equal(state.render().state.community, null);
    assert.equal(state.render().state.panel, "none");
  }
});

test("transient session refresh and feed errors preserve private history and recover", async () => {
  const state = harness();
  await showFeed(state);
  state.render().setPanel("invite");
  state.updateSession({ data: null, isPending: false, error: { status: 503 } });
  assert.equal(state.render().state.view, "feed");
  assert.deepEqual(state.render().state.community, feed("alice"));
  assert.equal(state.render().state.panel, "invite");
  const cleanup = state.mountPolling();
  state.reads.at(-1)!.reject(new TestApiError(503));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.render().state.view, "feed");
  state.advance(10_000); state.flushTimers();
  state.reads.at(-1)!.resolve(feed("alice"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.render().state.error, "");
  cleanup?.();
});

test("feed polling prevents overlap, pauses while hidden/offline and cleans up listeners", async () => {
  const state = harness(); await showFeed(state);
  const cleanup = state.mountPolling();
  const initialReads = state.reads.length;
  state.listeners.get("focus")?.forEach(listener => listener());
  state.advance(10_000); state.flushTimers();
  assert.equal(state.reads.length, initialReads, "pending request must not overlap");
  state.reads.at(-1)!.resolve(feed("alice"));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  state.document.visibilityState = "hidden";
  state.advance(10_000); state.flushTimers();
  assert.equal(state.reads.length, initialReads);
  state.document.visibilityState = "visible"; state.navigator.onLine = false;
  state.listeners.get("visibilitychange")?.forEach(listener => listener());
  assert.equal(state.reads.length, initialReads);
  state.navigator.onLine = true;
  state.listeners.get("online")?.forEach(listener => listener());
  assert.equal(state.reads.length, initialReads + 1);
  cleanup?.();
  state.reads.at(-1)!.resolve(feed("late"));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(state.render().state.community, feed("alice"));
  assert.equal(state.listeners.get("focus")?.size, 0);
  assert.equal(state.listeners.get("online")?.size, 0);
});

test("feed polling is inactive in the chat and access loss clears private panels", async () => {
  const state = harness(); await showFeed(state);
  state.render().setSection("chat");
  assert.equal(state.mountPolling(), undefined);
  const previous = state.reads.length;
  state.flushTimers(); assert.equal(state.reads.length, previous);
  state.render().setSection("feed"); state.render().setPanel("invite");
  const cleanup = state.mountPolling();
  state.reads.at(-1)!.reject(new TestApiError(401));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.render().state.community, null);
  assert.equal(state.render().state.view, "login");
  assert.equal(state.render().state.panel, "none");
  cleanup?.();
});

test("an older read cannot overwrite a confirmed post deletion", async () => {
  const state = harness(); await showFeed(state);
  const pending = state.render().loadCommunity();
  const stale = state.reads.at(-1)!;
  await state.render().action(async () => state.render().confirmPostDelete("alice-post"));
  stale.resolve(feed("alice")); await pending;
  assert.equal((state.render().state.community?.posts[0] as { deleted?: boolean }).deleted, true);
});

test("a poll refreshes the top page and at most one loaded history page", async () => {
  const state = harness(); await showFeed(state);
  const more = state.render().loadMore();
  state.reads.at(-1)!.resolve({ ...feed("alice"), posts: feed("older").posts, nextCursor: "older-cursor" });
  await more;
  const before = state.reads.length;
  const cleanup = state.mountPolling();
  state.reads.at(-1)!.resolve(feed("alice"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.reads.length, before + 2);
  state.reads.at(-1)!.resolve({ ...feed("alice"), posts: feed("older").posts, nextCursor: "older-cursor" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.reads.length, before + 2);
  assert.equal(state.render().state.community?.posts.length, 2);
  assert.equal(state.render().state.community?.nextCursor, "older-cursor");
  cleanup?.();
});

test("transient session failures preserve OTP and join views, including errors without HTTP status", async () => {
  for (const error of [{}, { status: 0 }, { status: 503 }]) {
    const login = harness();
    login.updateSession({ data: null, isPending: false, error: null });
    login.updateSession({ data: null, isPending: false, error });
    assert.equal(login.render().state.view, "login", "the OTP form must not be unmounted");
    const join = harness();
    join.mountInvitation(); join.flushTimers();
    join.updateSession({ data: { user: { id: "newcomer" } }, isPending: false, error: null });
    join.reads.at(-1)!.reject(new TestApiError(403)); await Promise.resolve();
    join.updateSession({ data: { user: { id: "newcomer" } }, isPending: false, error });
    assert.equal(join.render().state.view, "join", "names and invitation remain in the same form");
    assert.equal(join.render().state.inviteToken, "synthetic");
  }
});

test("successful same-account session refetches do not fetch the feed again in the chat", async () => {
  const state = harness();
  state.updateSession({ data: { user: { id: "alice" } }, isPending: false, error: null });
  state.reads.at(-1)!.resolve(feed("alice")); await Promise.resolve();
  state.render().setSection("chat");
  const before = state.reads.length;
  state.updateSession({ data: { user: { id: "alice" } }, isPending: false, error: null });
  state.updateSession({ data: { user: { id: "alice" } }, isPending: false, error: { status: 0 } });
  state.updateSession({ data: { user: { id: "alice" } }, isPending: false, error: null });
  assert.equal(state.reads.length, before);
  assert.equal(state.render().state.view, "feed");
});

test("pending feed pagination does not lock the composer or unrelated actions", async () => {
  const state = harness(); await showFeed(state);
  const reading = state.render().loadMore();
  const pending = state.reads.at(-1)!;
  assert.equal(state.render().state.loadingMore, true);
  assert.equal(state.render().state.busy, false);
  assert.equal(await state.render().action(async () => {}), true);
  pending.resolve({ ...feed("alice"), nextCursor: null }); await reading;
  assert.equal(state.render().state.loadingMore, false);
});

test("a frozen feed read is replaced on return and its late result cannot clear the active view", async () => {
  const state = harness(); await showFeed(state);
  const cleanup = state.mountPolling();
  const old = state.reads.at(-1)!;
  const before = state.reads.length;
  state.advance(15_001); // no timer flush and no hidden event, as during a freeze
  state.listeners.get("pageshow")?.forEach(listener => listener());
  assert.equal(state.reads.length, before + 1);
  old.reject(new TestApiError(401)); await Promise.resolve();
  assert.equal(state.render().state.view, "feed");
  state.reads.at(-1)!.resolve(feed("alice")); await Promise.resolve();
  assert.equal(state.render().state.error, "");
  cleanup?.();
});

test("delayed feed pagination cannot undo a confirmed edit or deletion", async () => {
  for (const mutation of ["edit", "delete"]) for (const pageStartedDuringWrite of [false, true]) {
    const state = harness(); await showFeed(state);
    const confirmation = deferred<void>();
    const mutate = () => state.render().action(async () => {
      await confirmation.promise;
      if (mutation === "edit") state.render().confirmPostEdit("alice-post", "confirmed new text");
      else state.render().confirmPostDelete("alice-post");
    });
    const writing = pageStartedDuringWrite ? mutate() : null;
    const reading = state.render().loadMore();
    const stalePage = state.reads.at(-1)!;
    const laterWrite = writing ?? mutate();
    confirmation.resolve(); await laterWrite;
    stalePage.resolve(feed("alice")); await reading;
    const post = state.render().state.community!.posts[0];
    if (mutation === "edit") assert.equal(post.body, "confirmed new text");
    else assert.equal(post.deleted, true);
    assert.equal(state.render().state.loadingMore, false);
  }
});

test("a background feed refresh does not invalidate pending pagination", async () => {
  const state = harness(); await showFeed(state);
  const reading = state.render().loadMore();
  const older = state.reads.at(-1)!;
  const refreshing = state.render().loadCommunity();
  state.reads.at(-1)!.resolve(feed("alice")); await refreshing;
  older.resolve({ ...feed("alice"), posts: feed("older").posts, nextCursor: null }); await reading;
  assert.ok(state.render().state.community!.posts.some(post => post.id === "older-post"));
});

// Exercise PostCard's actual completion callback together with CommunityApp's
// actual action guard, including the point before onMoreComments mutates state.
const postCard = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "PostCard");
const moreComments = postCard?.body?.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "moreComments");
assert.ok(moreComments);
const commentExecutable = ts.transpileModule(`let loadingComments = false; ${moreComments.getText(parsed)}; return moreComments;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const createCommentLoader = new Function("post", "run", "api", "onMoreComments", "setLoadingComments", "setLocalError", commentExecutable) as
  (post: object, run: Render["action"], api: () => Promise<unknown>, append: () => void, loading: (value: boolean) => void, error: (value: string) => void) => () => Promise<void>;

test("delayed comment pages cannot append after logout, account change or a newer mutation", async () => {
  for (const change of ["logout", "account", "mutation", "mutation-in-flight"]) {
    const state = harness(); await showFeed(state);
    const response = deferred<unknown>();
    const confirmation = deferred<void>();
    const writing = change === "mutation-in-flight" ? state.render().action(async () => { await confirmation.promise; }) : null;
    let appended = 0, loading = false;
    const load = createCommentLoader({ id: "alice-post", comments: [], commentsNextCursor: "next" }, state.render().action, () => response.promise, () => { appended++; }, value => { loading = value; }, () => {});
    const reading = load();
    assert.equal(loading, true);
    if (change === "logout") {
      const logout = state.render().signOut(); state.logouts.at(-1)!.resolve({}); await logout;
    } else if (change === "account") {
      state.updateSession({ data: { user: { id: "bob" } }, isPending: false, error: null });
      state.reads.at(-1)!.resolve(feed("bob")); await Promise.resolve();
    } else if (writing) { confirmation.resolve(); await writing; }
    else await state.render().action(async () => {});
    response.resolve({ comments: [], nextCursor: null }); await reading;
    assert.equal(appended, 0, change);
    assert.equal(loading, false, change);
  }
});

test("comment pagination remains useful across ordinary feed refreshes", async () => {
  const state = harness(); await showFeed(state);
  const response = deferred<unknown>();
  let appended = 0;
  const load = createCommentLoader({ id: "alice-post", comments: [], commentsNextCursor: "next" }, state.render().action, () => response.promise, () => { appended++; }, () => {}, () => {});
  const reading = load();
  const refresh = state.render().loadCommunity(); state.reads.at(-1)!.resolve(feed("alice")); await refresh;
  response.resolve({ comments: [], nextCursor: null }); await reading;
  assert.equal(appended, 1);
});
