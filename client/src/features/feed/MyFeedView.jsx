import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import { AtSign, MessageSquare, RefreshCcw, Repeat2, User } from "lucide-react";
import { fetchProfilesForEvents } from "@/nostr/profiles.js";
import { resolveRelays } from "@/nostr/config.js";
import { fetchNip65Relays } from "@/nostr/nip65.js";
import { fetchEventsOnce, getRelayHint, subscribeEvents } from "@/nostr/pool.js";
import { normalizeWsRelayUrl } from "@/utils/relayUrls.js";
import PostContent from "@/components/PostContent.jsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function shortKey(k) {
  if (!k) return "anon";
  return `${k.slice(0, 8)}…${k.slice(-6)}`;
}

function toNjumpProfileUrl(pubkey) {
  const pk = String(pubkey || "").trim();
  if (!pk) return "";
  try {
    const npub = nip19.npubEncode(pk);
    return `https://njump.me/${npub}`;
  } catch {
    return "";
  }
}

function formatWhen(tsSec) {
  const ts = Number(tsSec) || 0;
  if (!ts) return "";
  try {
    return new Date(ts * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

function sortNewestFirst(events) {
  return (Array.isArray(events) ? events : []).slice().sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));
}

function mergeEvents(prev, next) {
  const merged = new Map();
  for (const ev of Array.isArray(prev) ? prev : []) {
    if (ev?.id) merged.set(ev.id, ev);
  }
  for (const ev of Array.isArray(next) ? next : []) {
    if (ev?.id) merged.set(ev.id, ev);
  }
  return sortNewestFirst(Array.from(merged.values()));
}

function getETags(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  return tags
    .filter((t) => Array.isArray(t) && t[0] === "e" && t[1])
    .map((t) => ({
      id: String(t[1] || "").trim(),
      relay: normalizeWsRelayUrl(String(t[2] || "").trim()),
      marker: String(t[3] || "").trim().toLowerCase(),
    }))
    .filter((t) => t.id);
}

function getQTags(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  return tags
    .filter((t) => Array.isArray(t) && t[0] === "q" && t[1])
    .map((t) => ({
      id: String(t[1] || "").trim(),
      relay: normalizeWsRelayUrl(String(t[2] || "").trim()),
      pubkey: String(t[3] || "").trim(),
    }))
    .filter((t) => t.id);
}

function extractEmbeddedNoteHexIds(content = "") {
  const text = String(content || "");
  const matches = text.match(/\b(?:nostr:)?(note1\w+|nevent1\w+)\b/gi) || [];
  const out = new Set();
  for (const raw of matches) {
    const ref = raw.replace(/^nostr:/i, "");
    try {
      const decoded = nip19.decode(ref);
      if (decoded?.type === "note" && typeof decoded.data === "string") out.add(decoded.data);
      if (decoded?.type === "nevent" && decoded.data?.id) out.add(decoded.data.id);
    } catch {
      // ignore decode errors
    }
  }
  return out;
}

function getParentETag(ev) {
  if (!ev || Number(ev.kind) !== 1) return null;
  const eTags = getETags(ev);
  const explicit = eTags.find((t) => t.marker === "reply") || eTags.find((t) => t.marker === "root");
  if (explicit) return explicit;

  const embedded = extractEmbeddedNoteHexIds(ev.content || "");
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const t = tags[i];
    if (!Array.isArray(t) || t[0] !== "e") continue;
    const id = String(t[1] || "").trim();
    if (!id) continue;
    const marker = String(t[3] || "").trim().toLowerCase();
    if (marker === "mention") continue;
    if (embedded.has(id)) continue;
    return { id, relay: normalizeWsRelayUrl(String(t[2] || "").trim()), marker };
  }
  return null;
}

function isReplyNote(ev) {
  return Boolean(getParentETag(ev));
}

function noteCacheKey(noteId) {
  return `pidgeon.noteCache.${noteId}`;
}

function readNoteCache(noteId) {
  if (!noteId) return null;
  try {
    return JSON.parse(localStorage.getItem(noteCacheKey(noteId)) || "null");
  } catch {
    return null;
  }
}

function writeNoteCache(noteId, payload) {
  if (!noteId || !payload) return;
  try {
    localStorage.setItem(noteCacheKey(noteId), JSON.stringify(payload));
  } catch {}
}

function stripEventForCache(ev) {
  if (!ev || !ev.id) return null;
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    kind: ev.kind,
    created_at: ev.created_at,
    content: ev.content || "",
    tags: ev.tags || []
  };
}

const CACHE_VERSION = 1;
const CACHE_MAX_EVENTS = 250;
const CACHE_STALE_MS = 2 * 60 * 1000;

function readTabCache(pubkey, tabId) {
  if (!pubkey || !tabId) return null;
  const key = `pidgeon.myfeed.v${CACHE_VERSION}.${pubkey}.${tabId}`;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    if (!parsed || parsed.v !== CACHE_VERSION) return null;
    if (!Array.isArray(parsed.events)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeTabCache(pubkey, tabId, payload) {
  if (!pubkey || !tabId) return;
  const key = `pidgeon.myfeed.v${CACHE_VERSION}.${pubkey}.${tabId}`;
  try {
    localStorage.setItem(key, JSON.stringify({ v: CACHE_VERSION, savedAt: Date.now(), ...payload }));
  } catch {}
}

function EmbeddedNotePreview({ label, event, profile, placeholder = "Loading preview…" }) {
  if (!label) return null;
  const target = event || null;
  const authorKey = String(target?.pubkey || profile?.pubkey || "").trim();
  const authorName =
    profile?.display_name || profile?.name || profile?.username || (authorKey ? shortKey(authorKey) : "Unknown author");
  const when = target?.created_at ? formatWhen(target.created_at) : "";
  const content = String(target?.content || "").trim();

  return (
    <div className="space-y-3">
      <div className="text-sm text-white/70">{label}</div>
      <div className="rounded-2xl bg-slate-950/60 p-4 ring-1 ring-white/10">
        {target ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-white/70 truncate">{authorName}</div>
              </div>
              <div className="text-[11px] text-white/40">{when}</div>
            </div>
            <div className="mt-3">
              <PostContent content={content || placeholder} />
            </div>
          </>
        ) : (
          <div className="text-sm text-white/60">{placeholder}</div>
        )}
      </div>
    </div>
  );
}

function NoteCard({ event, profile, selfPubkey, context, repostPayload, onOpenRepost }) {
  const displayName = profile?.display_name || profile?.name || profile?.username || shortKey(event?.pubkey);
  const picture = profile?.picture || "";
  const kind = Number(event?.kind) || 0;
  const reply = kind === 1 ? isReplyNote(event) : false;
  const hasRepostAction = Boolean(onOpenRepost && repostPayload?.targetId);

  const authorPubkey = String(event?.pubkey || "").trim();
  const isOtherUser = Boolean(authorPubkey) && authorPubkey !== String(selfPubkey || "").trim();
  const profileUrl = isOtherUser ? toNjumpProfileUrl(authorPubkey) : "";

  return (
    <div className="group relative h-full overflow-hidden rounded-3xl bg-slate-900 p-5 ring-1 ring-white/10 transition-colors duration-150 hover:bg-slate-800/70 hover:ring-white/20">
      <div className="flex items-start gap-3">
        {profileUrl ? (
          <a
            href={profileUrl}
            target="_blank"
            rel="noreferrer"
            className="h-10 w-10 rounded-full overflow-hidden bg-slate-800 ring-1 ring-white/10 flex items-center justify-center shrink-0 transition hover:ring-indigo-400/60"
            aria-label="Open profile on njump"
          >
            {picture ? (
              <img src={picture} alt={displayName || "avatar"} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <User className="h-5 w-5 text-white/50" />
            )}
          </a>
        ) : (
          <div className="h-10 w-10 rounded-full overflow-hidden bg-slate-800 ring-1 ring-white/10 flex items-center justify-center shrink-0">
            {picture ? (
              <img src={picture} alt={displayName || "avatar"} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <User className="h-5 w-5 text-white/50" />
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="font-semibold truncate">{displayName}</div>
                {kind === 6 ? (
                  <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/70 ring-1 ring-white/10">
                    Repost
                  </span>
                ) : reply ? (
                  <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/70 ring-1 ring-white/10">
                    Reply
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-xs text-white/50">{formatWhen(event?.created_at)}</div>
              {hasRepostAction ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Repost or quote"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenRepost?.(repostPayload);
                  }}
                >
                  <Repeat2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </div>

          {kind === 6 ? null : (
            <div className="mt-3">
              <PostContent content={String(event?.content || "")} />
            </div>
          )}

          {context ? (
            <div className="mt-4">
              <EmbeddedNotePreview
                label={context.label}
                event={context.event}
                profile={context.profile}
                placeholder={context.placeholder || "Loading preview…"}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const FETCH_LIMIT = 200;

function initialTabState() {
  return {
    status: "idle", // idle | loading | ready | error
    error: "",
    events: [],
    cursorUntil: 0,
    hasMore: true,
    lastFetchedAt: 0,
    relaysKey: "",
  };
}

export function MyFeedView({ pubkey, relays, onOpenRepost }) {
  const [tab, setTab] = useState("posts"); // posts | replies | mentions
  const [tabs, setTabs] = useState(() => ({
    posts: initialTabState(),
    replies: initialTabState(),
    mentions: initialTabState(),
  }));
  const [profiles, setProfiles] = useState(() => ({}));
  const [noteTargets, setNoteTargets] = useState(() => ({})); // id -> event
  const [nip65State, setNip65State] = useState(() => ({ status: "idle", error: "", read: [], write: [] }));
  const relaysKey = useMemo(() => (Array.isArray(relays) ? relays.filter(Boolean).join("|") : ""), [relays]);

  const effectiveRelays = useMemo(() => {
    const base = Array.isArray(relays) ? relays : [];
    const nip65Relays = [...(nip65State.read || []), ...(nip65State.write || [])];
    return resolveRelays([...base, ...nip65Relays]);
  }, [relaysKey, nip65State.read, nip65State.write]);
  const effectiveRelaysKey = useMemo(() => effectiveRelays.join("|"), [effectiveRelays]);
  const subsRef = useRef({ author: null, mentions: null });
  const targetFetchRef = useRef({ timer: 0, inflight: false, queued: new Set(), hints: new Map() });
  const profileFetchRef = useRef({ timer: 0, queued: new Set() });
  const cacheWriteRef = useRef({ timer: 0 });

  useEffect(() => {
    return () => {
      if (profileFetchRef.current.timer) window.clearTimeout(profileFetchRef.current.timer);
      if (targetFetchRef.current.timer) window.clearTimeout(targetFetchRef.current.timer);
      if (cacheWriteRef.current.timer) window.clearTimeout(cacheWriteRef.current.timer);
    };
  }, []);

  const queueProfileFetch = useCallback(
    (events) => {
      const list = Array.isArray(events) ? events : [];
      if (!list.length) return;
      const queued = profileFetchRef.current.queued;
      for (const ev of list) {
        if (ev?.pubkey) queued.add(ev.pubkey);
      }
      if (profileFetchRef.current.timer) return;
      profileFetchRef.current.timer = window.setTimeout(async () => {
        profileFetchRef.current.timer = 0;
        const pubkeys = Array.from(profileFetchRef.current.queued.values()).filter(Boolean);
        profileFetchRef.current.queued = new Set();
        if (!pubkeys.length) return;
        try {
          const payload = pubkeys.map((pk) => ({ pubkey: pk }));
          const fetched = await fetchProfilesForEvents(payload, effectiveRelays);
          if (fetched && Object.keys(fetched).length) {
            setProfiles((prev) => ({ ...(prev || {}), ...(fetched || {}) }));
          }
        } catch {}
      }, 250);
    },
    [effectiveRelaysKey]
  );

  const fetchTabPage = useCallback(
    async ({ tabId, until, replace = false }) => {
      if (!pubkey) return;
      if (!effectiveRelays.length) return;

      const filter = (() => {
        if (tabId === "posts") {
          const f = { kinds: [1, 6], authors: [pubkey], limit: FETCH_LIMIT };
          if (until) f.until = until;
          return f;
        }
        if (tabId === "replies") {
          const f = { kinds: [1], authors: [pubkey], limit: FETCH_LIMIT };
          if (until) f.until = until;
          return f;
        }
        // mentions
        const f = { kinds: [1], "#p": [pubkey], limit: FETCH_LIMIT };
        if (until) f.until = until;
        return f;
      })();

      setTabs((prev) => ({
        ...prev,
        [tabId]: { ...(prev[tabId] || initialTabState()), status: "loading", error: "" }
      }));

      try {
        const raw = await fetchEventsOnce(effectiveRelays, filter);
        const rawSorted = sortNewestFirst(raw);
        const oldestRaw = rawSorted.length
          ? Math.min(...rawSorted.map((e) => Number(e?.created_at) || 0).filter(Boolean))
          : 0;

        const filtered = (() => {
          if (tabId === "posts") {
            return rawSorted.filter((ev) => {
              const kind = Number(ev?.kind) || 0;
              if (kind === 6) return true;
              if (kind === 1) return !isReplyNote(ev);
              return false;
            });
          }
          if (tabId === "replies") {
            return rawSorted.filter((ev) => Number(ev?.kind) === 1 && isReplyNote(ev));
          }
          return rawSorted.filter((ev) => Number(ev?.kind) === 1);
        })();

        setTabs((prev) => {
          const current = prev[tabId] || initialTabState();
          const nextEvents = replace ? filtered : mergeEvents(current.events, filtered);
          return {
            ...prev,
            [tabId]: {
              ...current,
              status: "ready",
              error: "",
              events: nextEvents,
              cursorUntil: oldestRaw ? Math.max(0, oldestRaw - 1) : current.cursorUntil,
              hasMore: rawSorted.length >= FETCH_LIMIT,
              lastFetchedAt: Date.now(),
              relaysKey: effectiveRelaysKey,
            }
          };
        });

        queueProfileFetch(filtered);
      } catch (err) {
        setTabs((prev) => ({
          ...prev,
          [tabId]: { ...(prev[tabId] || initialTabState()), status: "error", error: err?.message || String(err || "Fetch failed") }
        }));
      }
    },
    [pubkey, effectiveRelaysKey, queueProfileFetch]
  );

  const refreshTab = useCallback(
    async (tabId) => {
      await fetchTabPage({ tabId, replace: true });
    },
    [fetchTabPage]
  );

  const loadMore = useCallback(
    async (tabId) => {
      const current = tabs[tabId] || initialTabState();
      if (current.status === "loading") return;
      if (!current.hasMore) return;
      const until = current.cursorUntil ? Number(current.cursorUntil) : 0;
      await fetchTabPage({ tabId, until: until || undefined, replace: false });
    },
    [tabs, fetchTabPage]
  );

  useEffect(() => {
    // Load local caches on account switch (instant paint).
    if (!pubkey) return;
    setTabs(() => {
      const next = {
        posts: initialTabState(),
        replies: initialTabState(),
        mentions: initialTabState(),
      };
      for (const tabId of Object.keys(next)) {
        const cached = readTabCache(pubkey, tabId);
        if (!cached) continue;
        const cachedEvents = (cached.events || []).filter((e) => e && e.id).slice(0, CACHE_MAX_EVENTS);
        next[tabId] = {
          ...next[tabId],
          status: "ready",
          events: cachedEvents,
          cursorUntil: Number(cached.cursorUntil) || 0,
          hasMore: cached.hasMore !== false,
          lastFetchedAt: Number(cached.savedAt) || 0,
          relaysKey: String(cached.relaysKey || ""),
        };
      }
      return next;
    });
  }, [pubkey]);

  useEffect(() => {
    // Debounced cache writes.
    if (!pubkey) return;
    if (cacheWriteRef.current.timer) window.clearTimeout(cacheWriteRef.current.timer);
    cacheWriteRef.current.timer = window.setTimeout(() => {
      cacheWriteRef.current.timer = 0;
      for (const tabId of ["posts", "replies", "mentions"]) {
        const current = tabs[tabId] || initialTabState();
        const slim = (Array.isArray(current.events) ? current.events : [])
          .slice(0, CACHE_MAX_EVENTS)
          .map(stripEventForCache)
          .filter(Boolean);
        writeTabCache(pubkey, tabId, {
          events: slim,
          cursorUntil: current.cursorUntil || 0,
          hasMore: current.hasMore !== false,
          relaysKey: current.relaysKey || "",
        });
      }
    }, 800);
    return () => {
      if (cacheWriteRef.current.timer) window.clearTimeout(cacheWriteRef.current.timer);
    };
  }, [pubkey, tabs]);

  useEffect(() => {
    // Fetch NIP-65 relay hints for better coverage (read+write).
    let cancelled = false;
    if (!pubkey) {
      setNip65State({ status: "idle", error: "", read: [], write: [] });
      return () => {
        cancelled = true;
      };
    }
    setNip65State((s) => ({ ...s, status: "loading", error: "" }));
    fetchNip65Relays({ pubkey, relays: effectiveRelays })
      .then((res) => {
        if (cancelled) return;
        setNip65State({ status: "ready", error: "", read: res.read || [], write: res.write || [] });
      })
      .catch((err) => {
        if (cancelled) return;
        setNip65State({ status: "error", error: err?.message || String(err || "NIP-65 failed"), read: [], write: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [pubkey, relaysKey]);

  useEffect(() => {
    // First paint per tab: fetch when stale or empty.
    if (!pubkey || !effectiveRelaysKey) return;
    const current = tabs[tab] || initialTabState();
    const stale = !current.lastFetchedAt || Date.now() - current.lastFetchedAt > CACHE_STALE_MS;
    const relaysChanged = Boolean(current.relaysKey) && current.relaysKey !== effectiveRelaysKey;
    if (
      (current.status === "idle" && current.events.length === 0) ||
      (current.events.length === 0 && stale) ||
      (current.events.length === 0 && relaysChanged) ||
      (current.events.length > 0 && (stale || relaysChanged))
    ) {
      refreshTab(tab);
    }
  }, [tab, pubkey, effectiveRelaysKey]);

  useEffect(() => {
    // Live subscriptions: keep both author + mentions hot so tabs stay in sync.
    if (!pubkey || !effectiveRelaysKey) return;
    const since = Math.floor(Date.now() / 1000) - 3;

    subsRef.current.author?.close?.();
    subsRef.current.mentions?.close?.();

    subsRef.current.author = subscribeEvents(effectiveRelays, { kinds: [1, 6], authors: [pubkey], since }, {
      onEvent: (ev) => {
        const kind = Number(ev?.kind) || 0;
        if (kind === 6) {
          setTabs((prev) => ({ ...prev, posts: { ...(prev.posts || initialTabState()), events: mergeEvents(prev.posts?.events || [], [ev]) } }));
          return;
        }
        if (kind === 1) {
          const targetTab = isReplyNote(ev) ? "replies" : "posts";
          setTabs((prev) => ({ ...prev, [targetTab]: { ...(prev[targetTab] || initialTabState()), events: mergeEvents(prev[targetTab]?.events || [], [ev]) } }));
        }
      }
    });

    subsRef.current.mentions = subscribeEvents(effectiveRelays, { kinds: [1], "#p": [pubkey], since }, {
      onEvent: (ev) => {
        setTabs((prev) => ({ ...prev, mentions: { ...(prev.mentions || initialTabState()), events: mergeEvents(prev.mentions?.events || [], [ev]) } }));
        queueProfileFetch([ev]);
      }
    });

    return () => {
      subsRef.current.author?.close?.();
      subsRef.current.mentions?.close?.();
      subsRef.current = { author: null, mentions: null };
    };
  }, [pubkey, effectiveRelaysKey, queueProfileFetch]);

  useEffect(() => {
    // Target hydration (batch): repost targets, reply parents, and quote targets for embedded previews.
    const posts = Array.isArray(tabs.posts?.events) ? tabs.posts.events : [];
    const replies = Array.isArray(tabs.replies?.events) ? tabs.replies.events : [];
    const mentions = Array.isArray(tabs.mentions?.events) ? tabs.mentions.events : [];

    const queueTarget = (targetId, relayHint) => {
      const id = String(targetId || "").trim();
      if (!id) return false;
      if (noteTargets?.[id]) return false;
      const cached = readNoteCache(id);
      if (cached?.content && cached?.pubkey) return false;
      if (targetFetchRef.current.queued.has(id)) return false;
      targetFetchRef.current.queued.add(id);
      if (relayHint && !targetFetchRef.current.hints.has(id)) {
        targetFetchRef.current.hints.set(id, relayHint);
      }
      return true;
    };

    let queuedAny = false;

    for (const ev of posts) {
      if (Number(ev?.kind) !== 6) continue;
      const eTags = getETags(ev);
      const target = eTags[0]?.id || "";
      const relayHint = eTags[0]?.relay || "";
      if (queueTarget(target, relayHint)) queuedAny = true;
    }

    for (const ev of replies) {
      const parent = getParentETag(ev);
      if (!parent?.id) continue;
      if (queueTarget(parent.id, parent.relay)) queuedAny = true;
    }

    for (const ev of mentions) {
      const parent = getParentETag(ev);
      if (parent?.id) {
        if (queueTarget(parent.id, parent.relay)) queuedAny = true;
        continue;
      }
      const quoted = getQTags(ev)[0];
      if (quoted?.id) {
        if (queueTarget(quoted.id, quoted.relay)) queuedAny = true;
      }
    }

    if (!queuedAny) return;
    if (targetFetchRef.current.inflight) return;
    if (targetFetchRef.current.timer) return;

    targetFetchRef.current.timer = window.setTimeout(async () => {
      targetFetchRef.current.timer = 0;
      if (targetFetchRef.current.inflight) return;
      targetFetchRef.current.inflight = true;

      const ids = Array.from(targetFetchRef.current.queued.values()).slice(0, 50);
      targetFetchRef.current.queued = new Set(Array.from(targetFetchRef.current.queued.values()).slice(ids.length));
      const hintRelays = ids.map((id) => targetFetchRef.current.hints.get(id)).filter(Boolean);
      ids.forEach((id) => targetFetchRef.current.hints.delete(id));
      const relayList = resolveRelays([...(effectiveRelays || []), ...hintRelays]);

      try {
        const fetched = await fetchEventsOnce(relayList, { kinds: [1], ids, limit: ids.length });
        const byId = {};
        for (const ev of fetched || []) {
          if (ev?.id) byId[ev.id] = ev;
          if (ev?.id) {
            writeNoteCache(ev.id, {
              content: ev.content || "",
              tags: ev.tags || [],
              created_at: ev.created_at,
              pubkey: ev.pubkey
            });
          }
        }
        if (Object.keys(byId).length) {
          setNoteTargets((prev) => ({ ...(prev || {}), ...byId }));
          queueProfileFetch(Object.values(byId));
        }
      } catch {
        // ignore
      } finally {
        targetFetchRef.current.inflight = false;
      }
    }, 200);

    return () => {
      if (targetFetchRef.current.timer) window.clearTimeout(targetFetchRef.current.timer);
    };
  }, [tabs.posts?.events, tabs.replies?.events, tabs.mentions?.events, noteTargets, effectiveRelaysKey, queueProfileFetch]);

  const current = tabs[tab] || initialTabState();
  const headerIcon = tab === "mentions" ? AtSign : tab === "replies" ? MessageSquare : User;

  if (!pubkey) {
    return (
      <Card className="rounded-3xl bg-slate-900/80 ring-white/15">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">My Feed</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-white/70">Login to view your feed and mentions.</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {React.createElement(headerIcon, { className: "h-5 w-5 text-white/70" })}
          <div className="text-lg font-semibold">My Feed</div>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => refreshTab(tab)}
          loading={current.status === "loading"}
          busyText="Refreshing…"
        >
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="posts">
            Posts <span className="text-xs text-white/40">({tabs.posts?.events?.length || 0})</span>
          </TabsTrigger>
          <TabsTrigger value="replies">
            Replies <span className="text-xs text-white/40">({tabs.replies?.events?.length || 0})</span>
          </TabsTrigger>
          <TabsTrigger value="mentions">
            Mentions <span className="text-xs text-white/40">({tabs.mentions?.events?.length || 0})</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="posts" className="space-y-4">
          <FeedList
            tabId="posts"
            state={tabs.posts}
            profiles={profiles}
            noteTargets={noteTargets}
            fallbackRelay={effectiveRelays[0] || ""}
            selfPubkey={pubkey}
            onOpenRepost={onOpenRepost}
            onLoadMore={() => loadMore("posts")}
          />
        </TabsContent>
        <TabsContent value="replies" className="space-y-4">
          <FeedList
            tabId="replies"
            state={tabs.replies}
            profiles={profiles}
            noteTargets={noteTargets}
            fallbackRelay={effectiveRelays[0] || ""}
            selfPubkey={pubkey}
            onOpenRepost={onOpenRepost}
            onLoadMore={() => loadMore("replies")}
          />
        </TabsContent>
        <TabsContent value="mentions" className="space-y-4">
          <FeedList
            tabId="mentions"
            state={tabs.mentions}
            profiles={profiles}
            noteTargets={noteTargets}
            fallbackRelay={effectiveRelays[0] || ""}
            selfPubkey={pubkey}
            onOpenRepost={onOpenRepost}
            onLoadMore={() => loadMore("mentions")}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FeedList({ tabId, state, onLoadMore, profiles, noteTargets, fallbackRelay, selfPubkey, onOpenRepost }) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const noun = tabId === "mentions" ? "mentions" : tabId === "replies" ? "replies" : "posts";
  const errorMsg = state?.status === "error" ? String(state?.error || "Fetch failed") : "";

  if (!events.length && errorMsg) {
    return (
      <div className="rounded-3xl bg-slate-900 p-6 ring-1 ring-white/10">
        <div className="text-sm text-red-200">Failed to load: {errorMsg}</div>
      </div>
    );
  }

  if (!events.length && state?.status === "loading") {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="animate-pulse rounded-3xl bg-slate-900 p-5 ring-1 ring-white/10">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-white/10" />
              <div className="flex-1">
                <div className="h-3 w-40 rounded bg-white/10" />
                <div className="mt-2 h-3 w-24 rounded bg-white/10" />
              </div>
            </div>
            <div className="mt-4 h-3 w-full rounded bg-white/10" />
            <div className="mt-2 h-3 w-5/6 rounded bg-white/10" />
          </div>
        ))}
      </div>
    );
  }

  if (!events.length) {
    return (
      <div className="rounded-3xl bg-slate-900 p-10 ring-1 ring-white/10 text-center text-white/60">
        <div className="text-sm">
          {tabId === "mentions" ? "No mentions found yet." : tabId === "replies" ? "No replies found yet." : "No posts found yet."}
        </div>
        <div className="mt-2 text-xs text-white/40">Relays and history affect what you can see.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {errorMsg ? (
        <div className="rounded-2xl bg-red-500/10 px-4 py-2 text-sm text-red-200 ring-1 ring-red-400/30">
          Failed to refresh: {errorMsg}
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {events.map((ev) => {
          const authorProfile = profiles?.[ev.pubkey] || null;
          const kind = Number(ev?.kind) || 0;
          const safeFallbackRelay = String(fallbackRelay || "").trim();

          let context = null;
          let repostPayload = null;

          if (kind === 6) {
            const eTags = getETags(ev);
            const targetId = eTags[0]?.id || "";
            const tagRelayHint = eTags[0]?.relay || "";
            const cached = targetId ? readNoteCache(targetId) : null;
            const targetEv = noteTargets?.[targetId] || (cached?.content ? { id: targetId, kind: 1, ...cached } : null);
            const targetProfile = targetEv?.pubkey ? profiles?.[targetEv.pubkey] || { pubkey: targetEv.pubkey } : null;
            context = { label: "Boosted", event: targetEv, profile: targetProfile, placeholder: "Loading repost preview…" };
            const relayHint = tagRelayHint || getRelayHint(targetId) || safeFallbackRelay;
            repostPayload = {
              targetId: targetEv?.id || targetId,
              relayHint,
              resolvedEvent: targetEv && Number(targetEv.kind) === 1 ? targetEv : null
            };
          } else if (kind === 1) {
            const relayHint = getRelayHint(ev.id) || safeFallbackRelay;
            repostPayload = { targetId: ev.id, relayHint, resolvedEvent: ev };

            if (tabId === "replies" || tabId === "mentions") {
              let reference = null;
              let label = "";
              let placeholder = "Loading referenced post…";

              const parent = getParentETag(ev);
              if (tabId === "replies" && parent?.id) {
                reference = parent;
                label = "In reply to";
                placeholder = "Loading parent post…";
              } else if (tabId === "mentions") {
                if (parent?.id) {
                  reference = parent;
                  label = "In reply to";
                  placeholder = "Loading parent post…";
                } else {
                  const quoted = getQTags(ev)[0];
                  if (quoted?.id) {
                    reference = quoted;
                    label = "Quoted";
                    placeholder = "Loading quoted post…";
                  }
                }
              }

              if (reference?.id) {
                const refId = String(reference.id || "").trim();
                const cached = refId ? readNoteCache(refId) : null;
                const refEv = noteTargets?.[refId] || (cached?.content ? { id: refId, kind: 1, ...cached } : null);
                const refProfile = refEv?.pubkey ? profiles?.[refEv.pubkey] || { pubkey: refEv.pubkey } : null;
                context = { label, event: refEv, profile: refProfile, placeholder };
              }
            }
          }

          return (
            <NoteCard
              key={ev.id}
              event={ev}
              profile={authorProfile}
              selfPubkey={selfPubkey}
              context={context}
              repostPayload={repostPayload}
              onOpenRepost={onOpenRepost}
            />
          );
        })}
      </div>
      <div className="flex justify-center">
        <Button
          type="button"
          variant="outline"
          onClick={onLoadMore}
          loading={state?.status === "loading"}
          busyText="Loading…"
          disabled={state?.status === "loading" || state?.hasMore === false}
        >
          {state?.hasMore === false ? `No more ${noun}` : "Load older"}
        </Button>
      </div>
    </div>
  );
}
