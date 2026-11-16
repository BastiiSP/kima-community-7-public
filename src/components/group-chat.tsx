"use client";

import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ContentActions } from "@/components/content-actions";
import { REQUEST_TIMEOUT_MS } from "@/lib/community-client";
import { appendNewChat, appendSentChat, ChatMessage, ChatPage, ChatState, initialChat, prependOlderChat } from "@/lib/chat-state";

type ApiFailure = Error & { status?: number; code?: string };
type ReadKind = "initial" | "older" | "newer";
type Props = {
  memberId: string;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  onAccessLoss: (error: ApiFailure) => void;
};

const POLL_MS = 2_500;
// Includes manual refreshes, catch-up pages and focus events: at most 55 GETs/minute per mounted chat.
const MIN_READ_MS = 1_100;
const formatDate = (value: string) => new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function GroupChat({ memberId, request, onAccessLoss }: Props) {
  const [chat, setChat] = useState<ChatState | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unread, setUnread] = useState(0);
  const active = useRef(false);
  const chatRef = useRef<ChatState | null>(null);
  const pendingRead = useRef<AbortController | null>(null);
  const readStartedAt = useRef(0);
  const pendingMutation = useRef<AbortController | null>(null);
  const queuedRead = useRef<ReadKind | null>(null);
  const nextReadAt = useRef(0);
  const failures = useRef(0);
  const timer = useRef<number | null>(null);
  const readRef = useRef<(kind: ReadKind) => Promise<void>>(async () => {});
  const messagesRef = useRef<HTMLOListElement | null>(null);
  const scrollPlan = useRef<{ bottom: boolean; top: number; height: number; prepend: boolean } | null>(null);

  const schedule = useCallback((delay: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void readRef.current(queuedRead.current ?? (chatRef.current ? "newer" : "initial"));
    }, delay);
  }, []);

  const updateChat = useCallback((next: ChatState, kind: ReadKind | "sent") => {
    const list = messagesRef.current;
    const nearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const bottom = kind === "sent" || kind === "initial" || (kind === "newer" && nearBottom);
    scrollPlan.current = { bottom, top: list?.scrollTop ?? 0, height: list?.scrollHeight ?? 0, prepend: kind === "older" };
    if (bottom) setUnread(0);
    else if (kind === "newer") {
      const known = new Set(chatRef.current?.messages.map(message => message.id));
      const count = next.messages.filter(message => !known.has(message.id)).length;
      if (count) setUnread(value => value + count);
    }
    chatRef.current = next;
    setChat(next);
  }, []);

  useLayoutEffect(() => {
    const list = messagesRef.current;
    const plan = scrollPlan.current;
    if (list && plan) list.scrollTop = plan.bottom ? list.scrollHeight : plan.top + (plan.prepend ? list.scrollHeight - plan.height : 0);
    scrollPlan.current = null;
  }, [chat]);

  const handleError = useCallback((caught: unknown, mutation = false) => {
    const failure = caught as ApiFailure;
    if (failure.code === "COMMUNITY_PAUSED" || failure.code === "MEMBER_BLOCKED" || failure.status === 401 || failure.status === 403) {
      active.current = false;
      pendingRead.current?.abort();
      pendingMutation.current?.abort();
      queuedRead.current = null;
      chatRef.current = null;
      setChat(null);
      setBody("");
      onAccessLoss(failure);
    } else if (mutation) setMutationError(failure.message || "Die Änderung konnte nicht bestätigt werden. Bitte prüfe den Verlauf vor einem erneuten Versuch.");
    else setError(failure.message || "Der Chat konnte nicht geladen werden.");
  }, [onAccessLoss]);

  const read = useCallback(async (kind: ReadKind) => {
    if (!active.current || document.visibilityState !== "visible" || !navigator.onLine) return;
    // Preserve explicit refresh/older-page requests while a poll is in flight.
    if (kind === "initial" || queuedRead.current === null || (kind === "older" && queuedRead.current !== "initial")) queuedRead.current = kind;
    if (pendingRead.current) return;
    if (Date.now() < nextReadAt.current) { schedule(nextReadAt.current - Date.now()); return; }
    kind = queuedRead.current ?? kind;
    queuedRead.current = null;
    const current = chatRef.current;
    if (!current) kind = "initial";
    if (kind === "older" && !current?.olderCursor) { schedule(POLL_MS); return; }
    const controller = new AbortController();
    pendingRead.current = controller;
    readStartedAt.current = Date.now();
    nextReadAt.current = Date.now() + MIN_READ_MS;
    if (kind === "older") setLoadingOlder(true);
    let delay = POLL_MS;
    try {
      const path = kind === "initial" ? "/api/chat" : kind === "older"
        ? `/api/chat?before=${encodeURIComponent(current!.olderCursor!)}`
        : `/api/chat?after=${encodeURIComponent(current!.newerCursor)}`;
      const page = await request<ChatPage>(path, { signal: controller.signal });
      if (!active.current || pendingRead.current !== controller || controller.signal.aborted) return;
      failures.current = 0;
      if (kind !== "initial" && chatRef.current?.revision !== page.revision) {
        // Never continue showing messages after a deletion revision changed.
        chatRef.current = null;
        setChat(null);
        setUnread(0);
        queuedRead.current = "initial";
      } else {
        const next = kind === "initial" ? initialChat(page) : kind === "older"
          ? prependOlderChat(chatRef.current!, page) : appendNewChat(chatRef.current!, page);
        updateChat(next, kind);
        if (kind === "newer" && page.hasMore) { queuedRead.current ??= "newer"; }
      }
      setError("");
    } catch (caught) {
      if (active.current && pendingRead.current === controller && !controller.signal.aborted) {
        failures.current++;
        delay = (caught as ApiFailure).status === 429 ? 60_000 : Math.min(30_000, POLL_MS * 2 ** Math.min(failures.current, 4));
        nextReadAt.current = Date.now() + delay;
        handleError(caught);
      }
    } finally {
      // An aborted old read must never unlock or reschedule a newer read.
      if (pendingRead.current === controller) {
        pendingRead.current = null;
        if (active.current) {
          if (kind === "older") setLoadingOlder(false);
          schedule(queuedRead.current ? Math.max(0, nextReadAt.current - Date.now()) : delay);
        }
      }
    }
  }, [handleError, request, schedule, updateChat]);

  // Callback changes (e.g. a session refresh) do not invalidate mutations or restart the chat.
  useEffect(() => { readRef.current = read; }, [read]);
  useEffect(() => {
    active.current = true;
    schedule(0);
    const resume = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        // A restored/frozen page can miss hidden and timeout callbacks. Release
        // only expired reads; old completion cannot unlock the replacement.
        if (pendingRead.current && Date.now() - readStartedAt.current >= REQUEST_TIMEOUT_MS) {
          pendingRead.current.abort(); pendingRead.current = null; setLoadingOlder(false);
        }
        schedule(Math.max(0, nextReadAt.current - Date.now()));
      }
      else {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        pendingRead.current?.abort();
        pendingRead.current = null;
        setLoadingOlder(false);
      }
    };
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active.current = false;
      pendingRead.current?.abort();
      pendingRead.current = null;
      pendingMutation.current?.abort();
      pendingMutation.current = null;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [memberId, schedule]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = body.trim();
    if (!message || pendingMutation.current || !active.current) return;
    const controller = new AbortController();
    const revision = chatRef.current?.revision;
    pendingMutation.current = controller;
    setBusy(true); setMutationError("");
    try {
      const result = await request<{ message: ChatMessage }>("/api/chat", { method: "POST", body: JSON.stringify({ body: message }), signal: controller.signal });
      if (!active.current || pendingMutation.current !== controller || controller.signal.aborted) return;
      setBody("");
      // Show the confirmed send immediately, but GET still starts at its last confirmed cursor.
      if (chatRef.current && chatRef.current.revision === revision) updateChat(appendSentChat(chatRef.current, result.message), "sent");
      void readRef.current(chatRef.current ? "newer" : "initial");
    } catch (caught) {
      if (active.current && pendingMutation.current === controller && !controller.signal.aborted) handleError(caught, true);
    } finally {
      if (pendingMutation.current === controller) {
        pendingMutation.current = null;
        if (active.current) setBusy(false);
      }
    }
  }

  async function remove(id: string) {
    if (pendingMutation.current || !active.current || !window.confirm("Diese Nachricht wirklich löschen?")) return;
    const controller = new AbortController();
    pendingMutation.current = controller;
    setBusy(true); setMutationError("");
    try {
      await request(`/api/chat/${encodeURIComponent(id)}`, { method: "DELETE", signal: controller.signal });
      if (!active.current || pendingMutation.current !== controller || controller.signal.aborted) return;
      // Cancel the pre-delete snapshot and invalidate its ownership before reloading.
      pendingRead.current?.abort();
      pendingRead.current = null;
      setLoadingOlder(false);
      chatRef.current = null;
      setChat(null);
      setUnread(0);
      queuedRead.current = "initial";
      schedule(0);
    } catch (caught) {
      if (active.current && pendingMutation.current === controller && !controller.signal.aborted) handleError(caught, true);
    } finally {
      if (pendingMutation.current === controller) {
        pendingMutation.current = null;
        if (active.current) setBusy(false);
      }
    }
  }

  function scrollToLatest() {
    const list = messagesRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    setUnread(0);
  }

  return <section className="chat-column" aria-labelledby="chat-title">
    <div className="feed-heading"><div><p className="eyebrow">GEMEINSAM IM GESPRÄCH</p><h1 id="chat-title">Gruppenchat</h1><p>Nachrichten für die ganze Lerngruppe.</p></div><button type="button" className="secondary-button" onClick={() => void read("initial")}>Aktualisieren</button></div>
    {(mutationError || error) && <p className="notice error" role="alert">{mutationError || error}</p>}
    <div className="chat-card card">
      {chat?.olderCursor && <button type="button" className="more-button" disabled={loadingOlder} onClick={() => void read("older")}>{loadingOlder ? "Wird geladen …" : "Ältere Nachrichten laden"}</button>}
      {!chat ? <p className="chat-empty" role="status">Nachrichten werden geladen …</p> : chat.messages.length === 0 ? <p className="chat-empty">Noch keine Nachrichten. Schreib der Gruppe zuerst.</p> : <ol ref={messagesRef} className="chat-messages" aria-label="Gruppennachrichten" tabIndex={0} onScroll={event => { const list = event.currentTarget; if (list.scrollHeight - list.scrollTop - list.clientHeight < 80) setUnread(0); }}>{chat.messages.map(message => <li className="chat-message" key={message.id}><div className="chat-message-head"><strong>{message.authorName}</strong><time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time>{message.authorId === memberId && <ContentActions label={`Aktionen für Nachricht vom ${formatDate(message.createdAt)}`} disabled={busy} onDelete={() => void remove(message.id)} />}</div><p>{message.body}</p></li>)}</ol>}
      {unread > 0 && <button type="button" className="more-button" onClick={scrollToLatest}>{unread === 1 ? "1 neue Nachricht" : `${unread} neue Nachrichten`} · Zum Ende</button>}
      <form className="chat-composer" onSubmit={(event) => void send(event)}><label className="field-label" htmlFor="chat-message">Nachricht an die Gruppe</label><textarea id="chat-message" value={body} onChange={event => setBody(event.target.value)} maxLength={5000} rows={3} required disabled={busy} placeholder="Was möchtest du der Gruppe sagen?" /><div className="chat-composer-actions"><small>Bis zu 5.000 Zeichen</small><button className="primary-button small" type="submit" disabled={busy || !body.trim()}>{busy ? "Wird gesendet …" : "Senden"}</button></div></form>
    </div>
  </section>;
}
