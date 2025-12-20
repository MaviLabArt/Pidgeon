import React, { useEffect, useMemo, useState } from "react";
import { Calendar, Clock, Trash2, Info, CheckCircle, Repeat2 } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import PostContent from "@/components/PostContent.jsx";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.jsx";
import { getJobDisplayContent, getQuoteTargetId, isQuoteJob, isRepostJob } from "@/utils/repostPreview.js";
import { fetchProfilesForEvents } from "@/nostr/profiles.js";
import { resolveRelays } from "@/nostr/config.js";

function formatDateTime(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatTimeAgo(isoString) {
  if (!isoString) return "";
  const now = Date.now();
  const target = new Date(isoString).getTime();
  const diff = target - now;

  if (diff <= 0) {
    const elapsed = Math.abs(diff);
    const mins = Math.floor(elapsed / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return `in ${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
const profileCache = new Map(); // pubkey -> { profile|null, ts }
const profileInflight = new Map(); // cacheKey -> Promise<profilesMap>

function nowMs() {
  return Date.now();
}

function getCachedProfile(pubkey) {
  const key = String(pubkey || "").trim();
  if (!key) return null;
  const cached = profileCache.get(key);
  if (!cached) return null;
  const age = nowMs() - Number(cached.ts || 0);
  if (age >= 0 && age < PROFILE_TTL_MS) return cached.profile ?? null;
  return null;
}

function hasFreshCache(pubkey) {
  const key = String(pubkey || "").trim();
  if (!key) return false;
  const cached = profileCache.get(key);
  if (!cached) return false;
  const age = nowMs() - Number(cached.ts || 0);
  return age >= 0 && age < PROFILE_TTL_MS;
}

function getProfileDisplayName(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const name =
    String(p.display_name || "").trim() ||
    String(p.displayName || "").trim() ||
    String(p.name || "").trim() ||
    String(p.nip05 || "").trim();
  return name || "Nostr user";
}

function getProfilePicture(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const url = String(p.picture || p.image || "").trim();
  if (!url) return "";
  return url;
}

function useProfiles(pubkeys = [], relays = []) {
  const keys = useMemo(
    () => Array.from(new Set((pubkeys || []).map((pk) => String(pk || "").trim()).filter(Boolean))),
    [Array.isArray(pubkeys) ? pubkeys.join(",") : ""]
  );
  const relaysKey = useMemo(() => resolveRelays(relays).join(","), [Array.isArray(relays) ? relays.join(",") : ""]);
  const [profiles, setProfiles] = useState(() => {
    const initial = {};
    for (const pk of keys) {
      if (hasFreshCache(pk)) initial[pk] = getCachedProfile(pk);
    }
    return initial;
  });

  useEffect(() => {
    let cancelled = false;
    const missing = keys.filter((pk) => !hasFreshCache(pk));
    if (!missing.length) return () => {};

    const cacheKey = `${relaysKey}::${missing.sort().join(",")}`;
    const run =
      profileInflight.get(cacheKey) ||
      (async () => {
        const fetched = await fetchProfilesForEvents(missing.map((pubkey) => ({ pubkey })), resolveRelays(relays));
        for (const pk of missing) {
          const profile = fetched?.[pk] ?? null;
          profileCache.set(pk, { profile, ts: nowMs() });
        }
        return fetched || {};
      })();
    profileInflight.set(cacheKey, run);

    run
      .then((fetched) => {
        if (cancelled) return;
        setProfiles((prev) => {
          const next = { ...(prev || {}) };
          for (const pk of missing) {
            if (hasFreshCache(pk)) next[pk] = getCachedProfile(pk);
            else if (fetched && Object.prototype.hasOwnProperty.call(fetched, pk)) next[pk] = fetched[pk] ?? null;
          }
          return next;
        });
      })
      .catch(() => {})
      .finally(() => {
        profileInflight.delete(cacheKey);
      });

    return () => {
      cancelled = true;
    };
  }, [keys.join(","), relaysKey]);

  return profiles || {};
}

function readCachedNoteContent(noteId = "") {
  const id = String(noteId || "").trim();
  if (!id) return "";
  try {
    const parsed = JSON.parse(localStorage.getItem(`pidgeon.noteCache.${id}`) || "null");
    return typeof parsed?.content === "string" ? String(parsed.content || "") : "";
  } catch {
    return "";
  }
}

function clipText(text = "", maxChars = 320) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…`;
}

export function JobCard({ job, onCancel, onReschedule, onRepost, onOpen, showActions = true, profileRelays = [] }) {
  const isPosted = job.status === "posted" || job.status === "sent";
  const isError = job.status === "error";
  const isDm = job.jobType === "dm17";
  const recipientPubkeys = useMemo(
    () => (Array.isArray(job?.recipients) ? job.recipients.map((r) => r?.pubkey).filter(Boolean) : []),
    [Array.isArray(job?.recipients) ? job.recipients.map((r) => r?.pubkey).join(",") : ""]
  );
  const recipientProfiles = useProfiles(
    recipientPubkeys,
    Array.isArray(profileRelays) && profileRelays.length ? profileRelays : job?.relays || []
  );
  const canRepost = isPosted && !isDm && job?.noteEvent?.kind === 1;
  const noteCreatedIso = job?.noteEvent?.created_at
    ? new Date(Number(job.noteEvent.created_at) * 1000).toISOString()
    : "";
  const isReposted = isRepostJob(job);
  const isQuoted = isQuoteJob(job);
  const displayContent = getJobDisplayContent(job);
  const quoteTargetId = isQuoted ? getQuoteTargetId(job) : "";
  const quoteTargetContent =
    String(job?.quoteTargetContent || "") || (quoteTargetId ? readCachedNoteContent(quoteTargetId) : "");

  return (
    <motion.div
      className="group relative cursor-pointer overflow-hidden rounded-3xl bg-slate-900 p-5 ring-1 ring-white/10 transition-colors duration-150 hover:bg-slate-800/70 hover:ring-white/20"
      whileHover={{ y: -2 }}
      initial={false} // disable mount re-animation to avoid flicker on tab switches
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      onClick={() => onOpen?.(job)}
    >
      {isQuoted || isReposted ? (
        <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white/80 ring-1 ring-white/10">
          {isQuoted ? "💬 Quote" : "🔁 Repost"}
        </div>
      ) : null}

      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-center gap-2 text-xs text-white/60">
          <Calendar className="h-3 w-3" />
          {formatDateTime(job.scheduledAt || job.updatedAt || job.createdAt || noteCreatedIso) || "Unknown time"}
        </div>

        {showActions ? (
          <div className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
            <Button
              variant="ghost"
              size="sm"
              className="h-10 w-10 rounded-lg p-0"
              title="Reschedule"
              onClick={(e) => {
                e.stopPropagation();
                onReschedule?.(job);
              }}
            >
              <Clock className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-10 w-10 rounded-lg p-0 text-red-200 hover:bg-red-500/10 hover:text-red-100"
              onClick={(e) => {
                e.stopPropagation();
                onCancel?.(job);
              }}
              title="Cancel"
            >
              <Trash2 className="h-5 w-5" />
            </Button>
          </div>
        ) : null}
      </div>

      {/* Content */}
      <PostContent content={displayContent} />

      {isQuoted ? (
        <div className="mt-3 rounded-2xl bg-black/20 p-3 ring-1 ring-white/10">
          <div className="mb-2 text-[11px] uppercase tracking-wide text-white/50">Quoted</div>
          {quoteTargetContent ? (
            <PostContent content={clipText(quoteTargetContent, 420)} />
          ) : quoteTargetId ? (
            <div className="text-sm text-white/50">Loading quoted note…</div>
          ) : (
            <div className="text-sm text-white/50">Quoted note unavailable.</div>
          )}
        </div>
      ) : null}

      {isDm && Array.isArray(job.recipients) ? (
        <div className="mt-3 space-y-1 text-xs text-white/60">
          {Array.isArray(job.recipients) && job.recipients.length ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>To</span>
              {job.recipients
                .map((r, idx) => {
                  const pk = String(r?.pubkey || "").trim();
                  if (!pk) return null;
                  const profile = recipientProfiles?.[pk] || null;
                  const name = getProfileDisplayName(profile);
                  const picture = getProfilePicture(profile);
                  return (
                    <span key={`${pk}:${idx}`} className="inline-flex items-center gap-1.5">
                      <Avatar className="h-4 w-4 bg-slate-800 ring-1 ring-white/10">
                        {picture ? (
                          <img alt="" src={picture} className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <AvatarFallback className="bg-slate-800 text-[10px] text-white/70">
                            {String(name || "N").slice(0, 1).toUpperCase()}
                          </AvatarFallback>
                        )}
                      </Avatar>
                      <span className="text-white/70">{name}</span>
                    </span>
                  );
                })
                .filter(Boolean)}
            </div>
          ) : null}
        </div>
      ) : null}

      {job.statusInfo && (isError || !showActions) && (
        <div
          className={`mt-3 rounded-xl px-3 py-2 text-sm ring-1 ${
            isError
              ? "bg-red-500/10 text-red-200 ring-red-400/30"
              : "bg-white/5 text-white/80 ring-white/10"
          }`}
        >
          {job.statusInfo}
        </div>
      )}

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-4">
        <div className="flex items-center gap-2">
          {isError ? (
            <div className="flex items-center gap-1.5 rounded-full bg-red-500/15 px-3 py-1 text-xs font-medium text-red-200 ring-1 ring-red-400/30">
              <Info className="h-3 w-3" />
              Failed{job.updatedAt ? ` ${formatTimeAgo(job.updatedAt)}` : ""}
            </div>
          ) : isPosted ? (
            <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-200 ring-1 ring-emerald-400/30">
              <CheckCircle className="h-3 w-3" />
              Posted {formatTimeAgo(job.updatedAt || job.scheduledAt || noteCreatedIso)}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 rounded-full bg-indigo-500/15 px-3 py-1 text-xs font-medium text-indigo-200 ring-1 ring-indigo-400/30">
              <Clock className="h-3 w-3" />
              {formatTimeAgo(job.scheduledAt)}
            </div>
          )}
        </div>

        {canRepost ? (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-xl"
            onClick={(e) => {
              e.stopPropagation();
              onRepost?.(job);
            }}
            title="Schedule repost or quote"
          >
            <Repeat2 className="mr-2 h-4 w-4" />
            Repost
          </Button>
        ) : null}
      </div>
    </motion.div>
  );
}

export const MemoJobCard = React.memo(JobCard);
