"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { GroupChat } from "@/components/group-chat";
import { ContentActions } from "@/components/content-actions";

import { api, ApiError, REQUEST_TIMEOUT_MS } from "@/lib/community-client";
import { mergeComments, mergeFeedPage, type Comment, type CommentBoundary, type Community, type Post } from "@/lib/feed-state";

type View = "loading" | "login" | "join" | "setup" | "unavailable" | "feed";
type Panel = "none" | "invite";
type Section = "feed" | "chat";

function loginError(error: { code?: string; status?: number }, fallback: string) {
  if (error.code === "MEMBER_BLOCKED") return "Dieser Zugang ist gesperrt. Bitte kontaktiere den Betreiber.";
  if (error.code === "COMMUNITY_PAUSED") return "Die Community ist vorübergehend pausiert. Bitte versuche es später erneut.";
  if (error.code === "INVALID_OTP") return "Der Anmeldecode stimmt nicht. Bitte prüfe ihn und versuche es erneut.";
  if (error.code === "OTP_EXPIRED") return "Der Anmeldecode ist abgelaufen. Bitte fordere einen neuen Code an.";
  if (error.code === "TOO_MANY_ATTEMPTS" || error.status === 429) return "Zu viele Versuche. Bitte warte kurz und fordere dann einen neuen Code an.";
  return fallback;
}

const json = (value: object) => JSON.stringify(value);
const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(parsed);
};
const initials = (name: string) => name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase("de-DE")).join("");

export function CommunityApp() {
  const { data: session, isPending: sessionPending, error: sessionError } = authClient.useSession();
  const sessionUserId = session?.user.id;
  const sessionErrorCode = (sessionError as { code?: string } | null)?.code;
  const [view, setView] = useState<View>("loading");
  const [community, setCommunity] = useState<Community | null>(null);
  const [inviteToken, setInviteToken] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [section, setSection] = useState<Section>("feed");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const communityGeneration = useRef(0);
  const readSequence = useRef(0);
  const mutationVersion = useRef(0);
  const communityRef = useRef(community);
  const busyRef = useRef(false);
  const pageCursors = useRef<string[]>([]);
  const refreshSlot = useRef(0);
  const commentWindows = useRef<{ postId: string; cursor: string; after?: CommentBoundary }[]>([]);
  const sessionIdentity = useRef<string | null>(null);


  const chatAccessLoss = useCallback((failure: Error & { status?: number; code?: string }) => {
    communityGeneration.current++; pageCursors.current = []; commentWindows.current = [];
    setPanel("none");
    setCommunity(null);
    setError(failure.message);
    setView(failure.status === 401 ? "login" : "unavailable");
  }, []);

  const loadCommunity = useCallback(async () => {
    const generation = communityGeneration.current;
    const sequence = ++readSequence.current;
    setError("");
    try {
      const result = await api<Community>("/api/community");
      if (generation !== communityGeneration.current || sequence !== readSequence.current) return;
      setCommunity(current => mergeFeedPage(current, result));
      setView("feed");
    } catch (caught) {
      if (generation !== communityGeneration.current || sequence !== readSequence.current) return;
      const message = caught instanceof Error ? caught.message : "Die Pinnwand konnte nicht geladen werden.";
      if (caught instanceof ApiError && (caught.code === "COMMUNITY_PAUSED" || caught.code === "MEMBER_BLOCKED")) {
        communityGeneration.current++; pageCursors.current = []; commentWindows.current = []; setPanel("none"); setCommunity(null); setError(message); setView("unavailable");
      }
      else if (caught instanceof ApiError && caught.status === 503) {
        setError(`${message} Die Pinnwand konnte nicht aktualisiert werden.`);
        setView((current) => current === "feed" ? current : "setup");
      }
      else if (caught instanceof ApiError && caught.status === 403) { communityGeneration.current++; pageCursors.current = []; commentWindows.current = []; setPanel("none"); setCommunity(null); setView("join"); }
      else if (caught instanceof ApiError && caught.status === 401) { communityGeneration.current++; pageCursors.current = []; commentWindows.current = []; setPanel("none"); setCommunity(null); setView("login"); }
      else {
        setError(`${message} Die Pinnwand konnte nicht aktualisiert werden.`);
        setView((current) => current === "feed" ? current : "setup");
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      // Initial state is already loading. A background session refresh must not
      // unmount the login/join form and discard an OTP step or unsaved names.
      if (sessionPending) return;
      if (sessionErrorCode === "COMMUNITY_PAUSED" || sessionErrorCode === "MEMBER_BLOCKED") { communityGeneration.current++; pageCursors.current = []; commentWindows.current = []; setPanel("none"); setCommunity(null); setError(sessionErrorCode === "COMMUNITY_PAUSED" ? "Die Community ist vorübergehend pausiert. Bitte versuche es später erneut." : "Dieser Zugang ist gesperrt. Bitte kontaktiere den Betreiber."); setView("unavailable"); return; }
      if (sessionError && sessionError.status !== 401 && sessionError.status !== 403) {
        setError("Die Verbindung wird wiederhergestellt. Deine Eingaben bleiben erhalten.");
        setView(current => current === "loading" ? "setup" : current); return;
      }
      if (!sessionUserId || sessionError?.status === 401 || sessionError?.status === 403) { communityGeneration.current++; pageCursors.current = []; commentWindows.current = []; sessionIdentity.current = null; setPanel("none"); setCommunity(null); setView("login"); return; }
      if (sessionIdentity.current !== sessionUserId) {
        communityGeneration.current++; pageCursors.current = []; commentWindows.current = []; refreshSlot.current = 0;
        sessionIdentity.current = sessionUserId;
        setCommunity(null); setPanel("none");
      } else if (communityRef.current) {
        // Focus refreshes validate authentication; the active feed/chat owns
        // its data refresh. A renewed session must not add another feed read.
        return;
      }
      void loadCommunity();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessionPending, sessionUserId, sessionError, sessionErrorCode, loadCommunity]);

  useEffect(() => {
    function captureInvitation() {
      const url = new URL(window.location.href);
      const fragment = new URLSearchParams(url.hash.slice(1));
      if (!url.searchParams.has("invite") && !fragment.has("invite")) return;
      const token = fragment.get("invite") || url.searchParams.get("invite");
      // Keep the invitation only in component memory across login and session
      // refreshes. A clean URL or an empty fragment must not discard it.
      if (token) setInviteToken(token);
      url.searchParams.delete("invite");
      if (fragment.has("invite")) {
        fragment.delete("invite");
        url.hash = fragment.toString();
      }
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    // Read after hydration, and also when a link changes only this document's
    // fragment. Cancel the initial task on effect replay before URL cleanup.
    const timer = window.setTimeout(captureInvitation, 0);
    window.addEventListener("hashchange", captureInvitation);
    window.addEventListener("popstate", captureInvitation);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", captureInvitation);
      window.removeEventListener("popstate", captureInvitation);
    };
  }, []);

  useEffect(() => {
    if (view !== "feed" || section !== "feed" || !community?.member.id) return;
    let stopped = false;
    let timer: number | undefined;
    let lastStarted = 0;
    let pendingRead: AbortController | null = null;
    async function refresh() {
      if (stopped || pendingRead || busyRef.current || document.visibilityState === "hidden" || navigator.onLine === false) return;
      // Focus/online events may arrive together. Keep the same bounded budget.
      if (Date.now() - lastStarted < 5_000) return;
      lastStarted = Date.now();
      const controller = new AbortController();
      pendingRead = controller;
      const generation = communityGeneration.current;
      const sequence = ++readSequence.current;
      const current = () => !stopped && !controller.signal.aborted && pendingRead === controller && generation === communityGeneration.current && sequence === readSequence.current;
      try {
        const latest = await api<Community>("/api/community", { signal: controller.signal });
        if (!current()) return;
        setCommunity(previous => mergeFeedPage(previous, latest));
        const snapshot = communityRef.current;
        const jobs = [
          ...pageCursors.current.map(cursor => ({ kind: "posts" as const, cursor })),
          ...commentWindows.current.map(window => ({ kind: "comments" as const, ...window })),
          ...(snapshot?.posts.filter(post => post.comments.filter(comment => !comment.deleted).length > 5).map(post => ({ kind: "comments" as const, postId: post.id, cursor: "", after: undefined as CommentBoundary | undefined })) || []),
        ];
        const job = jobs.length ? jobs[refreshSlot.current++ % jobs.length] : null;
        // At most one additional history read per cycle, regardless of depth.
        if (job?.kind === "posts") {
          const page = await api<Community>(`/api/community?cursor=${encodeURIComponent(job.cursor)}`, { signal: controller.signal });
          if (current()) setCommunity(previous => mergeFeedPage(previous, page));
        } else if (job?.kind === "comments") {
          const page = await api<{ comments: Comment[]; nextCursor: string | null }>(`/api/posts/${encodeURIComponent(job.postId)}/comments${job.cursor ? `?cursor=${encodeURIComponent(job.cursor)}` : ""}`, { signal: controller.signal });
          if (current()) setCommunity(previous => previous && { ...previous, posts: previous.posts.map(post => post.id === job.postId ? {
            ...post, comments: mergeComments(post.comments, page.comments, !page.nextCursor, job.after),
          } : post) });
        }
        if (current()) setError("");
      } catch (caught) {
        if (!current() || controller.signal.aborted) return;
        if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403 || caught.code === "COMMUNITY_PAUSED" || caught.code === "MEMBER_BLOCKED")) {
          communityGeneration.current++; pageCursors.current = []; commentWindows.current = []; setCommunity(null); setPanel("none");
          setView(caught.status === 401 ? "login" : caught.status === 403 && !caught.code ? "join" : "unavailable");
          setError(caught.message);
        } else setError("Die Pinnwand wird gerade nicht aktualisiert. Deine Eingaben bleiben erhalten; die Verbindung wird automatisch erneut geprüft.");
      } finally { if (pendingRead === controller) pendingRead = null; }
    }
    function schedule() {
      timer = window.setTimeout(() => { void refresh().finally(() => { if (!stopped) schedule(); }); }, 10_000);
    }
    function recover() {
      if (document.visibilityState === "hidden" || navigator.onLine === false || pendingRead && Date.now() - lastStarted >= REQUEST_TIMEOUT_MS) {
        pendingRead?.abort(); pendingRead = null;
      }
      void refresh();
    }
    schedule(); recover();
    window.addEventListener("focus", recover);
    window.addEventListener("online", recover);
    window.addEventListener("offline", recover);
    window.addEventListener("pageshow", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      stopped = true; pendingRead?.abort(); pendingRead = null; window.clearTimeout(timer);
      window.removeEventListener("focus", recover); window.removeEventListener("online", recover);
      window.removeEventListener("offline", recover); window.removeEventListener("pageshow", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [view, section, community?.member.id]);

  useEffect(() => { communityRef.current = community; }, [community]);

  function appendComments(id: string, comments: Comment[], cursor: string | null, loadedCursor?: string, after?: Comment) {
    if (loadedCursor && !commentWindows.current.some(window => window.postId === id && window.cursor === loadedCursor)) commentWindows.current.push({ postId: id, cursor: loadedCursor, after: after && { id: after.id, createdAt: after.createdAt, orderAt: after.orderAt } });
    setCommunity(current => current && { ...current, posts: current.posts.map(post => post.id === id ? {
      ...post, comments: [...post.comments, ...comments.filter(comment => !post.comments.some(item => item.id === comment.id))],
      commentsNextCursor: cursor, commentsTruncated: cursor !== null,
    } : post) });
  }

  async function action(work: (isCurrent: () => boolean) => Promise<void>, success?: string, onFailure?: (message: string) => void, lockWriting = true) {
    const generation = communityGeneration.current;
    if (lockWriting) { busyRef.current = true; readSequence.current++; mutationVersion.current++; setBusy(true); }
    const version = mutationVersion.current;
    const isCurrent = () => generation === communityGeneration.current && (lockWriting || version === mutationVersion.current);
    setError(""); setNotice("");
    try { await work(isCurrent); if (!isCurrent()) return false; if (success) setNotice(success); return true; }
    catch (caught) {
      if (!isCurrent()) return false;
      const message = caught instanceof Error ? caught.message : "Das hat leider nicht geklappt.";
      if (caught instanceof ApiError && (caught.code === "COMMUNITY_PAUSED" || caught.code === "MEMBER_BLOCKED" || caught.status === 401 || caught.status === 403)) {
        communityGeneration.current++; pageCursors.current = []; commentWindows.current = []; setPanel("none"); setCommunity(null);
        setView(caught.status === 401 ? "login" : "unavailable"); setError(message);
      } else if (onFailure) onFailure(message); else setError(message);
      return false;
    }
    // Also invalidate pages begun while the mutation was still in flight.
    finally { if (lockWriting) { mutationVersion.current++; busyRef.current = false; setBusy(false); } }
  }

  async function signOut() {
    // Invalidate reads both before and after logout: pending mutations may have
    // started another refresh while the sign-out request was in flight.
    communityGeneration.current++; pageCursors.current = []; commentWindows.current = []; sessionIdentity.current = null;
    await action(async () => {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || "Abmelden fehlgeschlagen.");
      communityGeneration.current++; pageCursors.current = []; commentWindows.current = [];
      setPanel("none"); setCommunity(null); setView("login");
    });
  }

  function confirmPostEdit(id: string, body: string) {
    setCommunity((current) => current && { ...current, posts: current.posts.map((post) => post.id === id ? { ...post, body } : post) });
  }

  function confirmPostDelete(id: string) {
    setCommunity((current) => current && { ...current, posts: current.posts.map((post) => post.id === id ? { ...post, deleted: true } : post) });
  }

  function confirmCommentEdit(id: string, body: string) {
    setCommunity((current) => current && { ...current, posts: current.posts.map((post) => ({
      ...post,
      comments: post.comments.map((comment) => comment.id === id ? { ...comment, body } : comment),
    })) });
  }

  function confirmCommentDelete(id: string) {
    setCommunity((current) => current && { ...current, posts: current.posts.map((post) => ({
      ...post,
      comments: post.comments.filter((comment) => comment.id !== id),
      commentCount: post.comments.some(comment => comment.id === id) ? Math.max(0, post.commentCount - 1) : post.commentCount,
    })) });
  }

  async function loadMore() {
    if (!community?.nextCursor || loadingMore) return;
    const generation = communityGeneration.current;
    setLoadingMore(true);
    try {
      await action(async isCurrent => {
        const more = await api<Community>(`/api/community?cursor=${encodeURIComponent(community.nextCursor!)}`);
        if (!isCurrent()) return;
        if (!pageCursors.current.includes(community.nextCursor!)) pageCursors.current.push(community.nextCursor!);
        setCommunity(current => mergeFeedPage(current, more, true));
      }, undefined, (message) => {
        if (generation === communityGeneration.current) setError(message);
      }, false);
    } finally { setLoadingMore(false); }
  }

  return <div className="site-shell">
    <header className="site-header">
      <div className="header-inner">
        <div className="brand" aria-label="LG7 Community">
          <span className="brand-mark" aria-hidden="true">LG7</span>
          <span className="brand-copy"><strong>Unsere Community</strong><small>KI-Manager · Lerngruppe 7</small></span>
        </div>
        {view === "feed" && community ? <div className="header-account"><span className="header-avatar" aria-hidden="true">{initials(`${community.member.firstName} ${community.member.lastName}`)}</span><span className="account-name">{community.member.firstName} {community.member.lastName}</span><button type="button" className="header-signout" onClick={() => void signOut()} disabled={busy}>Abmelden</button></div> : <div className="entry-header-actions"><span className="header-private">Privat · Nur für Mitglieder</span>{session && <button type="button" className="header-signout" onClick={() => void signOut()} disabled={busy}>Abmelden</button>}</div>}
      </div>
    </header>

    {view === "feed" && community ? <main className="main-layout">
      <nav className="side-navigation" aria-label="Community-Navigation">
        <p className="nav-caption">COMMUNITY</p>
        <button type="button" className={`nav-item${section === "feed" ? " active" : ""}`} aria-current={section === "feed" ? "page" : undefined} onClick={() => setSection("feed")}><span className="nav-icon" aria-hidden="true">▤</span>Pinnwand</button>
        <button type="button" className={`nav-item${section === "chat" ? " active" : ""}`} aria-current={section === "chat" ? "page" : undefined} onClick={() => setSection("chat")}><span className="nav-icon" aria-hidden="true">◌</span>Gruppenchat</button>
        <button type="button" className="nav-item" onClick={() => setPanel("invite")}><span className="nav-icon" aria-hidden="true">＋</span>Einladen</button>
        <div className="nav-foot"><strong>Lerngruppe 7</strong><span>Ein privater Ort für unseren Austausch.</span></div>
      </nav>
      {section === "feed" ? <section className="feed-column" id="pinnwand" aria-labelledby="feed-title">
        <div className="feed-heading"><div><p className="eyebrow">UNSER AUSTAUSCH</p><h1 id="feed-title">Pinnwand</h1><p>Gedanken, Fragen und Erfahrungen aus der Lerngruppe.</p></div><span className="feed-count">{community.posts.length} {community.posts.length === 1 ? "Beitrag" : "Beiträge"}</span></div>
        <div className="inline-feedback" aria-live="polite">{notice && <p className="notice success">{notice}</p>}{error && <p className="notice error">{error}</p>}</div>
        <Composer busy={busy} name={community.member.firstName} onSubmit={(body) => action(async () => { await api("/api/posts", { method: "POST", body: json({ body }) }); void loadCommunity(); }, "Dein Beitrag ist veröffentlicht.")} />
        <div className="section-heading"><h2>Neueste Beiträge</h2></div>
        {community.posts.length === 0 ? <div className="empty-state"><span aria-hidden="true">✳</span><h3>Hier beginnt unser Gespräch.</h3><p>Noch ist die Pinnwand leer. Teile den ersten Gedanken mit der Gruppe.</p></div> : <div className="posts">{community.posts.map((post) => <PostCard key={post.id} post={post} memberId={community.member.id} busy={busy} run={action} reload={loadCommunity} onPostEdit={confirmPostEdit} onPostDelete={confirmPostDelete} onCommentEdit={confirmCommentEdit} onCommentDelete={confirmCommentDelete} onMoreComments={appendComments} />)}</div>}
        {community.nextCursor && <button className="more-button" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Wird geladen …" : "Weitere Beiträge laden"}</button>}
      </section> : <GroupChat key={community.member.id} memberId={community.member.id} request={api} onAccessLoss={chatAccessLoss} />}
      <aside className="side-column" aria-label="Über die Community"><div className="side-card"><span className="side-symbol" aria-hidden="true">✳</span><h2>Gemeinsam im Gespräch</h2><p>Ein privater Raum für aktuelle und ehemalige Mitglieder der Lerngruppe 7.</p><div className="side-divider" /><p>Jemand fehlt noch? Alle Mitglieder können Einladungen teilen.</p><button type="button" className="side-action" onClick={() => setPanel("invite")}>Einladung erstellen <span aria-hidden="true">↗</span></button></div></aside>
    </main> : <main className="entry-layout"><div className="entry-content"><div className="entry-intro"><span className="entry-symbol" aria-hidden="true">✳</span><p className="eyebrow">LERNGRUPPE 7</p><h1>Willkommen in unserer Community.</h1><p>Der private Treffpunkt für Ideen, Fragen und Erfahrungen – während der Ausbildung und darüber hinaus.</p></div>{error && <p className="notice error" role="alert">{error}</p>}{notice && <p className="notice success" role="status">{notice}</p>}{view === "loading" && <div className="entry-card"><p>Dein Zugang wird geprüft …</p></div>}{view === "login" && <Login onSuccess={() => void loadCommunity()} onError={setError} onNotice={setNotice} />}{view === "join" && <Join inviteToken={inviteToken} busy={busy} run={action} reload={loadCommunity} />}{view === "unavailable" && <div className="entry-card"><h2>Zugang vorübergehend nicht verfügbar</h2><p>Bei Fragen wende dich bitte an den Betreiber der Community.</p><button className="primary-button" type="button" onClick={() => { setView("loading"); void loadCommunity(); }}>Erneut versuchen</button></div>}{view === "setup" && <div className="entry-card"><h2>Wir richten den Treffpunkt ein.</h2><p>Die Community ist gerade noch nicht verfügbar. Bitte komm später wieder.</p><button className="primary-button" type="button" onClick={() => { setView("loading"); void loadCommunity(); }}>Erneut versuchen</button></div>}<p className="entry-footnote">Nur für eingeladene Mitglieder der Lerngruppe 7.</p></div></main>}

    {view === "feed" && community && panel !== "none" && <Modal onClose={() => setPanel("none")}>{error && <p className="notice error" role="alert">{error}</p>}{notice && <p className="notice success" role="status">{notice}</p>}<Invitations run={action} busy={busy} /></Modal>}
    <footer className="site-footer"><span>LG7 · Unsere Community</span><details className="community-info"><summary>Hinweise zur privaten Community</summary><div><p>Diese Community dient dem privaten Austausch. Eine verbindliche Betreuung, Vertretung oder Reaktionsfrist ist nicht zugesagt.</p><p>Deine E-Mail-Adresse dient der Anmeldung. Dein Name, deine Beiträge, Kommentare und Chatnachrichten sind für alle Mitglieder sichtbar. Die Website läuft auf Vercel, die Datenbank bei Neon; Brevo verschickt die Anmeldecodes. Verschlüsselte Sicherungen bei GitHub werden sieben Tage aufbewahrt.</p><p>Inhalte bleiben bis zur eigenen Löschung oder Kontolöschung gespeichert. Eigene Beiträge und Kommentare kannst du bearbeiten oder löschen, eigene Chatnachrichten löschen. Beim Löschen eines Beitrags bleibt eine leere Gesprächshülle mit Antworten anderer Mitglieder erhalten. Bei einer Kontolöschung werden dein Profil und deine eigenen Texte entfernt; fremde Antworten und Erwähnungen sowie bereits angefertigte Kopien werden dadurch nicht gelöscht. Sicherungskopien verschwinden nicht sofort mit der Löschung.</p><p>Kontakt: Wende dich an die Person, die deine Community betreibt. Bitte teile keine vertraulichen Daten Dritter.</p></div></details></footer>
  </div>;
}

function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    closeRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); previousFocus?.focus(); };
  }, []);
  return <dialog ref={dialogRef} className="modal" aria-labelledby="panel-title" onClose={(event) => { if (!event.currentTarget.open) onClose(); }}><button ref={closeRef} type="button" className="modal-close" aria-label="Schließen" onClick={() => dialogRef.current?.close()}>×</button>{children}</dialog>;
}

function Login({ onSuccess, onError, onNotice }: { onSuccess: () => void; onError: (value: string) => void; onNotice: (value: string) => void }) {
  const [email, setEmail] = useState(""); const [otp, setOtp] = useState(""); const [step, setStep] = useState<"email" | "code">("email"); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); onError(""); onNotice("");
    try {
      if (step === "email") {
        const result = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
        if (result.error) throw new Error(loginError(result.error, "Der Code konnte nicht gesendet werden. Bitte versuche es erneut."));
        setStep("code"); onNotice("Ein Anmeldecode wurde an deine E-Mail-Adresse gesendet.");
      } else {
        const result = await authClient.signIn.emailOtp({ email: email.trim(), otp: otp.trim() });
        if (result.error) throw new Error(loginError(result.error, "Der Code konnte nicht bestätigt werden. Bitte versuche es erneut."));
        onNotice(""); onSuccess();
      }
    } catch (caught) { onError(caught instanceof Error ? caught.message : "Anmeldung fehlgeschlagen."); }
    finally { setBusy(false); }
  }
  return <form className="entry-card form-stack" onSubmit={(event) => void submit(event)}><h2>{step === "email" ? "Schön, dich zu sehen." : "Fast geschafft."}</h2><p>{step === "email" ? "Melde dich mit deiner E-Mail-Adresse an. Du erhältst einen einmaligen Code." : `Gib den Code ein, den wir an ${email} gesendet haben.`}</p><label htmlFor="login-email">E-Mail-Adresse</label><input id="login-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy || step === "code"} placeholder="name@beispiel.de" />{step === "code" && <><label htmlFor="login-code">Anmeldecode</label><input id="login-code" type="text" inputMode="numeric" autoComplete="one-time-code" required value={otp} onChange={(event) => setOtp(event.target.value)} disabled={busy} placeholder="Dein Code" /><button className="link-button" type="button" onClick={() => { setOtp(""); setStep("email"); onError(""); onNotice(""); }}>E-Mail ändern oder neuen Code anfordern</button></>}<button className="primary-button" type="submit" disabled={busy}>{busy ? "Einen Moment …" : step === "email" ? "Code anfordern" : "Anmelden"}<span aria-hidden="true">↗</span></button></form>;
}

function Join({ inviteToken, busy, run, reload }: { inviteToken: string; busy: boolean; run: (work: (isCurrent: () => boolean) => Promise<void>, success?: string, onFailure?: (message: string) => void, lockWriting?: boolean) => Promise<boolean>; reload: () => Promise<void> }) {
  const [firstName, setFirstName] = useState(""); const [lastName, setLastName] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await run(async () => { await api("/api/join", { method: "POST", body: json({ token: inviteToken, firstName: firstName.trim(), lastName: lastName.trim() }) }); await reload(); }, "Willkommen in der Community!"); }
  return <form className="entry-card form-stack" onSubmit={(event) => void submit(event)}><h2>{inviteToken ? "Willkommen in der Runde." : "Du brauchst eine Einladung."}</h2><p>{inviteToken ? "Noch dein Name, dann kannst du an der Pinnwand mitmachen." : "Dein Konto ist angemeldet. Bitte öffne den persönlichen Einladungslink eines Mitglieds, um beizutreten."}</p>{inviteToken && <><label htmlFor="first-name">Vorname</label><input id="first-name" type="text" autoComplete="given-name" maxLength={80} required value={firstName} onChange={(event) => setFirstName(event.target.value)} disabled={busy} /><label htmlFor="last-name">Nachname</label><input id="last-name" type="text" autoComplete="family-name" maxLength={80} required value={lastName} onChange={(event) => setLastName(event.target.value)} disabled={busy} /><button className="primary-button" type="submit" disabled={busy}>{busy ? "Einen Moment …" : "Der Community beitreten"}<span aria-hidden="true">↗</span></button></>}</form>;
}

function Composer({ name, busy, onSubmit }: { name: string; busy: boolean; onSubmit: (body: string) => Promise<boolean> }) {
  const [body, setBody] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!body.trim()) return; const saved = await onSubmit(body.trim()); if (saved) setBody(""); }
  return <form className="composer card" onSubmit={(event) => void submit(event)}><div className="composer-top"><span className="avatar">{initials(name)}</span><div><h2>Neuen Beitrag schreiben</h2><p>Teile deine Gedanken mit der Runde.</p></div></div><label className="field-label" htmlFor="new-post">Dein Beitrag</label><textarea id="new-post" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Was beschäftigt dich gerade?" maxLength={5000} rows={3} required disabled={busy} aria-describedby="new-post-hint" /><div className="composer-bottom"><span id="new-post-hint">Bis zu 5.000 Zeichen · {body.length}/5.000</span><button className="primary-button small" type="submit" disabled={busy || !body.trim()}>{busy ? "Wird geteilt …" : "Beitrag teilen"}<span aria-hidden="true">↗</span></button></div></form>;
}

function PostCard({ post, memberId, busy, run, reload, onPostEdit, onPostDelete, onCommentEdit, onCommentDelete, onMoreComments }: { post: Post; memberId: string; busy: boolean; run: (work: (isCurrent: () => boolean) => Promise<void>, success?: string, onFailure?: (message: string) => void, lockWriting?: boolean) => Promise<boolean>; reload: () => Promise<void>; onPostEdit: (id: string, body: string) => void; onPostDelete: (id: string) => void; onCommentEdit: (id: string, body: string) => void; onCommentDelete: (id: string) => void; onMoreComments: (id: string, comments: Comment[], cursor: string | null, loadedCursor?: string, after?: Comment) => void }) {
  const [edit, setEdit] = useState(false); const [body, setBody] = useState(post.body); const [comment, setComment] = useState(""); const [localError, setLocalError] = useState(""); const [showComments, setShowComments] = useState(post.comments.length > 0); const [loadingComments, setLoadingComments] = useState(false);
  async function moreComments() {
    if (!post.commentsNextCursor || loadingComments) return;
    setLoadingComments(true);
    try { await run(async isCurrent => {
      const result = await api<{ comments: Comment[]; nextCursor: string | null }>(`/api/posts/${post.id}/comments?cursor=${encodeURIComponent(post.commentsNextCursor!)}`);
      if (!isCurrent()) return;
      onMoreComments(post.id, result.comments, result.nextCursor, post.commentsNextCursor!, post.comments.filter(comment => !comment.deleted).at(-1));
    }, undefined, setLocalError, false); } finally { setLoadingComments(false); }
  }
  const deleted = post.deleted;
  const own = post.authorId === memberId && !deleted;
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setLocalError(""); const nextBody = body.trim(); await run(async () => { await api(`/api/posts/${encodeURIComponent(post.id)}`, { method: "PATCH", body: json({ body: nextBody }) }); onPostEdit(post.id, nextBody); setEdit(false); void reload(); }, "Beitrag aktualisiert.", setLocalError); }
  async function remove() { if (!window.confirm("Diesen Beitrag wirklich löschen?")) return; await run(async () => { await api(`/api/posts/${encodeURIComponent(post.id)}`, { method: "DELETE" }); onPostDelete(post.id); setEdit(false); void reload(); }, "Beitrag gelöscht."); }
  async function addComment(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!comment.trim()) return; setLocalError(""); await run(async () => { await api(`/api/posts/${encodeURIComponent(post.id)}/comments`, { method: "POST", body: json({ body: comment.trim() }) }); setComment(""); setShowComments(true); void reload(); }, "Kommentar veröffentlicht.", setLocalError); }
  return <article className="post card"><div className="post-head"><span className="avatar">{initials(post.authorName)}</span><div className="post-author"><div><strong>{post.authorName}</strong>{post.agentName && <span className="agent-badge">✳ KI-Agent {post.agentName} im Auftrag von {post.authorName}</span>}</div><time dateTime={post.createdAt}>{date(post.createdAt)}</time></div>{own && <ContentActions label="Beitragsaktionen" disabled={busy} onEdit={() => { setBody(post.body); setLocalError(""); setEdit(true); }} onDelete={() => void remove()} />}</div>{edit && deleted && <p className="notice error">Der Beitrag wurde gelöscht. Dein offener Entwurf bleibt erhalten.</p>}{edit ? <form className="edit-form" onSubmit={(event) => void save(event)}><label className="field-label" htmlFor={`edit-post-${post.id}`}>Beitrag bearbeiten</label><textarea id={`edit-post-${post.id}`} value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={5000} required disabled={busy} />{localError && <p className="notice error" role="alert">{localError}</p>}<button type="submit" className="primary-button small" disabled={busy || deleted || !body.trim()}>Änderung speichern</button><button type="button" className="link-button" onClick={() => { setBody(post.body); setLocalError(""); setEdit(false); }}>Abbrechen</button></form> : <p className={`post-body${deleted ? " deleted-post" : ""}`}>{deleted ? "Beitrag gelöscht" : post.body}</p>}<div className="post-actions"><button type="button" className="comment-toggle" aria-expanded={showComments} onClick={() => setShowComments(!showComments)}><span aria-hidden="true">◌</span> {post.commentCount} {post.commentCount === 1 ? "Kommentar" : "Kommentare"}</button></div>{showComments && <div className="comments">{post.comments.map((item) => <CommentItem key={item.id} item={item} own={item.authorId === memberId} busy={busy} run={run} reload={reload} onEdit={onCommentEdit} onDelete={onCommentDelete} />)}{post.commentsNextCursor && <button type="button" className="link-button" disabled={loadingComments} onClick={() => void moreComments()}>{loadingComments ? "Wird geladen …" : "Weitere Kommentare laden"}</button>}{(!deleted || comment.length > 0) && <form className="comment-form" onSubmit={(event) => void addComment(event)}><label className="field-label" htmlFor={`comment-${post.id}`}>Kommentar schreiben</label>{deleted && <p className="notice error">Der Beitrag wurde gelöscht. Dein ungesendeter Text bleibt hier erhalten.</p>}<div className="comment-entry"><textarea id={`comment-${post.id}`} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Deine Antwort an die Runde …" maxLength={5000} rows={2} required disabled={busy || deleted} aria-describedby={`comment-hint-${post.id}`} /><button type="submit" className="send-button" disabled={busy || deleted || !comment.trim()}>Senden</button></div><small id={`comment-hint-${post.id}`} className="field-hint">Bis zu 5.000 Zeichen</small>{localError && <p className="notice error" role="alert">{localError}</p>}</form>}</div>}{!showComments && !deleted && <button type="button" className="add-comment" onClick={() => setShowComments(true)}>Kommentar schreiben <span aria-hidden="true">↗</span></button>}</article>;
}

function CommentItem({ item, own, busy, run, reload, onEdit, onDelete }: { item: Comment; own: boolean; busy: boolean; run: (work: (isCurrent: () => boolean) => Promise<void>, success?: string, onFailure?: (message: string) => void, lockWriting?: boolean) => Promise<boolean>; reload: () => Promise<void>; onEdit: (id: string, body: string) => void; onDelete: (id: string) => void }) {
  const [edit, setEdit] = useState(false); const [body, setBody] = useState(item.body); const [localError, setLocalError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setLocalError(""); const nextBody = body.trim(); await run(async () => { await api(`/api/comments/${encodeURIComponent(item.id)}`, { method: "PATCH", body: json({ body: nextBody }) }); onEdit(item.id, nextBody); setEdit(false); void reload(); }, "Kommentar aktualisiert.", setLocalError); }
  async function remove() { if (!window.confirm("Diesen Kommentar wirklich löschen?")) return; await run(async () => { await api(`/api/comments/${encodeURIComponent(item.id)}`, { method: "DELETE" }); onDelete(item.id); void reload(); }, "Kommentar gelöscht."); }
  return <div className="comment"><span className="avatar small-avatar">{initials(item.authorName)}</span><div className="comment-content"><div className="comment-meta"><strong>{item.authorName}</strong>{item.agentName && <span className="agent-badge">✳ KI-Agent {item.agentName} im Auftrag von {item.authorName}</span>}<time dateTime={item.createdAt}>{date(item.createdAt)}</time></div>{item.deleted && <p className="field-hint">Dieser Kommentar wurde gelöscht. Ein offener Entwurf bleibt erhalten.</p>}{edit ? <form className="edit-form" onSubmit={(event) => void save(event)}><label className="field-label" htmlFor={`edit-comment-${item.id}`}>Kommentar bearbeiten</label><textarea id={`edit-comment-${item.id}`} value={body} onChange={(event) => setBody(event.target.value)} rows={2} maxLength={5000} required disabled={busy} /><div className="comment-edit-actions"><button className="primary-button small" type="submit" disabled={busy || item.deleted || !body.trim()}>Speichern</button><button className="link-button" type="button" onClick={() => { setBody(item.body); setLocalError(""); setEdit(false); }}>Abbrechen</button></div></form> : <p>{item.body}</p>}{localError && <p className="notice error" role="alert">{localError}</p>}{own && !edit && !item.deleted && <ContentActions label="Kommentaraktionen" disabled={busy} onEdit={() => { setBody(item.body); setLocalError(""); setEdit(true); }} onDelete={() => void remove()} />}</div></div>;
}

function Invitations({ run, busy }: { run: (work: (isCurrent: () => boolean) => Promise<void>, success?: string, onFailure?: (message: string) => void, lockWriting?: boolean) => Promise<boolean>; busy: boolean }) {
  const [link, setLink] = useState(""); const [expiresAt, setExpiresAt] = useState(""); const [copied, setCopied] = useState(false);
  async function create() { await run(async () => { const result = await api<{ url: string; expiresAt: string }>("/api/invitations", { method: "POST" }); setLink(result.url); setExpiresAt(result.expiresAt); setCopied(false); }); }
  async function copy() { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); } }
  return <><p className="eyebrow">DIE RUNDE WÄCHST</p><h2 id="panel-title">Jemanden einladen</h2><p className="modal-intro">Teile einen persönlichen Einladungslink mit einem Menschen aus unserer Lerngruppe.</p>{link ? <div className="result-box"><label htmlFor="invitation-link">Dein Einladungslink</label><input id="invitation-link" readOnly value={link} onFocus={(event) => event.currentTarget.select()} /><button className="primary-button" type="button" onClick={() => void copy()}>{copied ? "Kopiert!" : "Link kopieren"}<span aria-hidden="true">↗</span></button><small>Gültig bis {date(expiresAt)}. Bewahre den Link sorgfältig auf.</small></div> : <button className="primary-button" type="button" onClick={() => void create()} disabled={busy}>{busy ? "Wird erstellt …" : "Einladung erstellen"}<span aria-hidden="true">↗</span></button>}</>;
}

