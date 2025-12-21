import React, { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Calendar as CalendarIcon,
  CalendarClock,
  BarChart2,
  Clock,
  FileText,
  Zap,
  MessageSquare,
  Heart,
  Settings,
  PenSquare,
  Trash2,
  MoreHorizontal,
  X,
  Check,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Plus,
  PauseCircle,
  PlayCircle,
  Image,
  Repeat2,
  Menu,
  LogOut,
  User,
  Github,
  Copy,
} from "lucide-react";
import QRCode from "react-qr-code";
import { useNostr } from "@/providers/NostrProvider.jsx";
import { fetchProfilesForEvents } from "@/nostr/profiles.js";
import { resolveRelays } from "@/nostr/config.js";
import { fetchEventOnceWithRelay, fetchEventsOnce, subscribeEvents } from "@/nostr/pool.js";
import { loadNip19 } from "@/utils/loadNip19.js";
import { extractImageUrls, isImageUrl, tokenizeTextWithUrls } from "@/utils/contentUrls.js";
import { normalizeWsRelayUrl, parseRelayListText } from "@/utils/relayUrls.js";
import { buildDraftEvent } from "@/lib/draft.js";
import { nip44DecryptWithKey } from "@/nostr/crypto.js";
import { Button } from "@/components/ui/button";
import {
  buildScheduleRequest,
  buildDm17ScheduleRequest,
  buildDm17RetryRequest,
  buildMailboxRepairRequest,
  buildSupportActionRequest,
  cancelScheduleRequest,
  ensurePreviewKey,
  ensureMailboxSecrets,
  getDvmConfig,
  getDvmPublishRelays,
  publishScheduleRequest,
  clearMasterKeyCache
} from "@/nostr/dvm.js";
import { fetchNip65WriteRelays } from "@/nostr/nip65.js";
import { fetchDrafts as fetchDraftsApi, saveDraft as saveDraftApi, removeDraft as removeDraftApi } from "@/services/drafts.js";
import { isDemoMailboxEnabled } from "@/services/demoMailbox.js";
import { fetchUserSettings as fetchUserSettingsApi, saveUserSettings as saveUserSettingsApi } from "@/services/userSettings.js";
import { subscribeMailbox, fetchNoteBlob } from "@/services/mailboxNostr.js";
import { computePerformance, quickEstimateFromRelay } from "@/services/performanceEngine.js";
import { MemoJobCard } from "@/components/JobCard.jsx";
import PostContent from "@/components/PostContent.jsx";
import EventPreview from "@/features/calendar/EventPreview";
import { getDefaultDurationMinutes, jobsToCalendarEvents, jobToCalendarEvent } from "@/features/calendar/jobAdapter";
import { SupportZapFooter } from "@/features/settings/SupportZapFooter.jsx";
import { getJobDisplayContent, getQuoteTargetInfo, isQuoteJob, isRepostJob } from "@/utils/repostPreview.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip.jsx";
import { Uploader } from "@/components/Uploader.jsx";
import EmojiPickerButton from "@/components/EmojiPickerButton.jsx";
import { useWindowVirtualizer } from "@tanstack/react-virtual";

const loadCalendarPage = () => import("@/features/calendar");
const CalendarPage = lazy(loadCalendarPage);
const loadDmView = () => import("@/features/dm/DmView.jsx").then((m) => ({ default: m.DmView }));
const DmView = lazy(loadDmView);
const loadHowItWorksView = () => import("@/features/info/HowItWorksView.jsx").then((m) => ({ default: m.HowItWorksView }));
const HowItWorksView = lazy(loadHowItWorksView);
const loadAnalyticsView = () => import("@/features/analytics/AnalyticsView.jsx").then((m) => ({ default: m.AnalyticsView }));
const AnalyticsView = lazy(loadAnalyticsView);
const loadSettingsView = () => import("@/features/settings/SettingsView.jsx").then((m) => ({ default: m.SettingsView }));
const SettingsView = lazy(loadSettingsView);
const loadMyFeedView = () => import("@/features/feed/MyFeedView.jsx").then((m) => ({ default: m.MyFeedView }));
const MyFeedView = lazy(loadMyFeedView);

// ---- Utilities --------------------------------------------------------------
const LS_KEYS = {
  drafts: "pidgeon.drafts",
};

function readLocalJson(key, fallback = null) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function readLocalString(key, fallback = "") {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return String(raw);
  } catch {
    return fallback;
  }
}

const toIso = (ts) => new Date((Number(ts) || 0) * 1000).toISOString();
function hydrateServerDraft(row) {
  return {
    ...row,
    createdAt: row.createdAt ? toIso(row.createdAt) : new Date().toISOString(),
    updatedAt: row.updatedAt ? toIso(row.updatedAt) : new Date().toISOString(),
    eventId: row.eventId || row.id || ""
  };
}

function hydrateServerJob(row) {
  const mapStatus = (s) => {
    if (s === "sent") return "posted";
    if (s === "error") return "error";
    return s || "scheduled";
  };
  return {
    id: row.id,
    requestId: row.id,
    noteId: row.noteId || "",
    content: row.content || "",
    tags: row.tags || [],
    scheduledAt: row.scheduledAt ? toIso(row.scheduledAt) : "",
    createdAt: row.createdAt ? toIso(row.createdAt) : "",
    updatedAt: row.updatedAt ? toIso(row.updatedAt) : "",
    status: mapStatus(row.status),
    relays: row.relays || [],
    lastError: row.lastError || "",
    statusInfo: row.lastError || ""
  };
}

function ViewFallback({ title = "Loading…" }) {
  return (
    <div className="rounded-3xl bg-slate-900 p-5 ring-1 ring-white/10 animate-pulse">
      <div className="h-4 w-40 rounded bg-white/10" />
      <div className="mt-4 h-3 w-full rounded bg-white/10" />
      <div className="mt-2 h-3 w-5/6 rounded bg-white/10" />
      <div className="mt-2 h-3 w-2/3 rounded bg-white/10" />
      <div className="mt-6 text-xs text-white/50">{title}</div>
    </div>
  );
}

const isCancelledStatus = (status) => status === "canceled" || status === "cancelled";

const sortJobsByUpdated = (iterable = []) =>
  Array.from(iterable)
    .filter((j) => j && !isCancelledStatus(j.status))
    .sort(
      (a, b) =>
        new Date(b.updatedAt || b.scheduledAt || 0).getTime() -
        new Date(a.updatedAt || a.scheduledAt || 0).getTime()
    );

function readNoteCache(noteId) {
  if (!noteId) return null;
  try {
    return readLocalJson(`pidgeon.noteCache.${noteId}`, null);
  } catch {
    return null;
  }
}

function writeNoteCache(noteId, payload) {
  if (!noteId || !payload) return;
  try {
    localStorage.setItem(`pidgeon.noteCache.${noteId}`, JSON.stringify(payload));
  } catch {}
}

function jobKey(job) {
  if (!job) return "";
  return String(job.requestId || job.id || job.noteId || "").trim();
}

function fingerprintMailboxJobs(list = []) {
  const items = Array.isArray(list) ? list : [];
  let hash = 5381;
  for (const j of items) {
    const k = jobKey(j);
    const s = String(j?.status || "");
    const u = String(j?.updatedAt || "");
    const n = String(j?.noteId || "");
    const str = `${k}|${s}|${u}|${n}`;
    for (let i = 0; i < str.length; i += 1) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
  }
  // Keep it short but stable.
  return `${items.length}:${(hash >>> 0).toString(16)}`;
}

function areJobsListEquivalent(a = [], b = []) {
  if (a === b) return true;
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;

  for (let i = 0; i < aa.length; i += 1) {
    const aj = aa[i];
    const bj = bb[i];
    if (jobKey(aj) !== jobKey(bj)) return false;
    if (String(aj?.status || "") !== String(bj?.status || "")) return false;
    if (String(aj?.scheduledAt || "") !== String(bj?.scheduledAt || "")) return false;
    if (String(aj?.updatedAt || "") !== String(bj?.updatedAt || "")) return false;
    if (String(aj?.noteId || "") !== String(bj?.noteId || "")) return false;
    if (String(aj?.statusInfo || "") !== String(bj?.statusInfo || "")) return false;
  }

  return true;
}

function stringArrayEqual(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i += 1) {
    if (String(aa[i] ?? "") !== String(bb[i] ?? "")) return false;
  }
  return true;
}

function tagsDeepEqual(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i += 1) {
    const at = Array.isArray(aa[i]) ? aa[i] : [];
    const bt = Array.isArray(bb[i]) ? bb[i] : [];
    if (at.length !== bt.length) return false;
    for (let j = 0; j < at.length; j += 1) {
      if (String(at[j] ?? "") !== String(bt[j] ?? "")) return false;
    }
  }
  return true;
}

function mailboxJobRenderEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    jobKey(a) === jobKey(b) &&
    String(a.jobType || "") === String(b.jobType || "") &&
    String(a.status || "") === String(b.status || "") &&
    String(a.statusInfo || "") === String(b.statusInfo || "") &&
    String(a.scheduledAt || "") === String(b.scheduledAt || "") &&
    String(a.updatedAt || "") === String(b.updatedAt || "") &&
    String(a.noteId || "") === String(b.noteId || "") &&
    String(a.content || "") === String(b.content || "") &&
    tagsDeepEqual(a.tags, b.tags) &&
    stringArrayEqual(a.relays, b.relays) &&
    JSON.stringify(a.noteBlob || null) === JSON.stringify(b.noteBlob || null) &&
    String(a.repostTargetId || "") === String(b.repostTargetId || "") &&
    Boolean(a.isRepost) === Boolean(b.isRepost)
  );
}

function mergeMailboxJobs(prevJobs = [], mailboxJobs = []) {
  const prevByKey = new Map();
  for (const j of Array.isArray(prevJobs) ? prevJobs : []) {
    const key = jobKey(j);
    if (key) prevByKey.set(key, j);
  }

  const next = [];
  const seen = new Set();

  for (const mj of Array.isArray(mailboxJobs) ? mailboxJobs : []) {
    const key = jobKey(mj);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const pj = prevByKey.get(key);

    // Mailbox is truth for ids/status/times; UI-hydrated fields should persist across mailbox refreshes.
    const merged = {
      ...(pj || {}),
      ...(mj || {}),
      // Preserve kind-1 hydration for posted jobs (mailbox stores only noteId pointers).
      noteEvent: pj?.noteEvent || mj?.noteEvent,
      content: mj?.content || pj?.content || "",
      tags: (Array.isArray(mj?.tags) && mj.tags.length ? mj.tags : pj?.tags) || [],
      // Preserve relay hints when mailbox doesn't include them for posted pointers.
      relays:
        Array.isArray(mj?.relays) && mj.relays.length
          ? mj.relays
          : Array.isArray(pj?.relays)
          ? pj.relays
          : []
    };
    // Preserve timestamps when mailbox doesn't include them (e.g. posted history pointers).
    merged.scheduledAt = mj?.scheduledAt || pj?.scheduledAt || merged.scheduledAt || "";
    merged.createdAt = mj?.createdAt || pj?.createdAt || merged.createdAt || "";
    merged.updatedAt = mj?.updatedAt || pj?.updatedAt || merged.updatedAt || "";

    // Fast path: hydrate posted pointers from local cache (so posted content appears immediately after refresh).
    if (
      (merged.status === "posted" || merged.status === "sent" || merged.status === "published") &&
      merged.noteId &&
      !merged.noteEvent
    ) {
      const cached = readNoteCache(merged.noteId);
      if (cached?.content && !merged.content) merged.content = cached.content;
      if (Array.isArray(cached?.tags) && cached.tags.length && (!merged.tags || !merged.tags.length)) {
        merged.tags = cached.tags;
      }
      const createdAtIso = cached?.created_at ? toIso(cached.created_at) : "";
      if (createdAtIso) {
        merged.updatedAt = merged.updatedAt || createdAtIso;
        merged.scheduledAt = merged.scheduledAt || createdAtIso;
        merged.createdAt = merged.createdAt || createdAtIso;
      }
    }

    // Avoid showing raw embedded JSON for repost previews (scheduled/queued and in compact cards).
    if (isRepostJob(merged) && String(merged.content || "").trim().startsWith("{")) {
      merged.content = getJobDisplayContent(merged) || merged.content;
    }

    next.push(pj && mailboxJobRenderEqual(pj, merged) ? pj : merged);
  }

  // Keep optimistic/queued jobs not yet reflected in mailbox.
  for (const pj of Array.isArray(prevJobs) ? prevJobs : []) {
    const key = jobKey(pj);
    if (!key || seen.has(key)) continue;
    if (pj?.status === "queued") {
      seen.add(key);
      next.push(pj);
    }
  }

  return next;
}

function clsx(...args) {
  return args.filter(Boolean).join(" ");
}

function shortKey(k) {
  if (!k) return "anon";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function formatDateTime(dt) {
  try {
    return new Date(dt).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function startOfMonth(date) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfMonth(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatLocalDateTimeInput(date = new Date()) {
  const pad = (val) => String(val).padStart(2, "0");
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

function daysInMonthGrid(date) {
  const start = startOfMonth(date);
  const end = endOfMonth(date);
  const startDay = start.getDay();
  const days = [];
  // Fill previous month blanks
  for (let i = 0; i < startDay; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() - (startDay - i));
    days.push({ date: d, outside: true });
  }
  // Current month
  for (let d = 1; d <= end.getDate(); d++) {
    const current = new Date(start);
    current.setDate(d);
    days.push({ date: current, outside: false });
  }
  // Next month blanks to complete 42 cells
  while (days.length % 7 !== 0 || days.length < 42) {
    const last = days[days.length - 1].date;
    const next = new Date(last);
    next.setDate(next.getDate() + 1);
    days.push({ date: next, outside: true });
  }
  return days;
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

function randomColorFromString(seed) {
  // Subtle deterministic hue based on content
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 45% / 0.15)`;
}

// ---- Demo Data --------------------------------------------------------------
const demoRelays = [
  { url: "wss://relay.damus.io", enabled: true },
  { url: "wss://nos.lol", enabled: true },
  { url: "wss://relay.primal.net", enabled: false },
];

const emptyEditor = {
  content: "",
  tags: "",
  media: [],
};
const emptyUploads = [];
const DEFAULT_BLOSSOM_SERVERS = [
  "https://blossom.yakihonne.com",
  "https://cdn.nostrcheck.me",
  "https://cdn.satellite.earth",
  "https://nostr.download",
].join("\n");

// ---- Root ------------------------------------------------------------------
export default function PidgeonUI() {
  const { pubkey, startLogin, logout } = useNostr();
  const [view, setView] = useState("compose");
  const [jobsTab, setJobsTab] = useState("queue");
  const [editor, setEditor] = useState(emptyEditor);
  const [composerDraftId, setComposerDraftId] = useState("");
  const [draftCleanupPrompt, setDraftCleanupPrompt] = useState(() => ({
    open: false,
    id: "",
    preview: "",
  }));
  const ONBOARDING_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
  const onboardingKeys = useMemo(() => {
    const who = pubkey || "anon";
    return {
      hiddenUser: `pidgeon.onboarding.hidden.${who}`,
      snoozeUser: `pidgeon.onboarding.snoozeUntil.${who}`,
      hiddenGlobal: "pidgeon.onboarding.hidden.global",
      snoozeGlobal: "pidgeon.onboarding.snoozeUntil.global",
    };
  }, [pubkey]);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingHidden, setOnboardingHidden] = useState(() => {
    try {
      const who = pubkey || "anon";
      return (
        localStorage.getItem(`pidgeon.onboarding.hidden.${who}`) === "true" ||
        localStorage.getItem("pidgeon.onboarding.hidden.global") === "true"
      );
    } catch {
      return false;
    }
  });
  const [onboardingSnoozeUntil, setOnboardingSnoozeUntil] = useState(() => {
    try {
      const who = pubkey || "anon";
      const userUntil = Math.floor(Number(localStorage.getItem(`pidgeon.onboarding.snoozeUntil.${who}`) || 0));
      const globalUntil = Math.floor(Number(localStorage.getItem("pidgeon.onboarding.snoozeUntil.global") || 0));
      return Math.max(0, userUntil, globalUntil);
    } catch {
      return 0;
    }
  });
  const [charLimit] = useState(1000);
  const [now, setNow] = useState(new Date());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try {
      const stored = String(readLocalString("pidgeon.theme", "") || "").trim();
      return stored === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const setThemePreference = useCallback((next) => {
    const normalized = next === "light" ? "light" : "dark";
    setTheme(normalized);
  }, []);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(() => {
    try {
      return readLocalString("pidgeon.analytics.enabled", "false") === "true";
    } catch {
      return false;
    }
  });
  const [analyticsState, setAnalyticsState] = useState(() => ({
    status: "idle", // idle | loading | ready | error
    error: "",
    global: null,
    series: [],
    latest: [],
    quickEstimate: null,
    updatedAt: 0
  }));
  const [settingsSync, setSettingsSync] = useState(() => ({
    status: "idle", // idle | loading | saving | error
    error: "",
    eventId: "",
    createdAt: 0,
    loadedAt: 0,
    savedAt: 0,
    remote: null,
  }));
  const settingsLoadedRef = useRef("");
  const [scheduleAt, setScheduleAt] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 30);
    d.setSeconds(0, 0);
    return formatLocalDateTimeInput(d); // yyyy-mm-ddThh:mm in local time
  });
  const [repostOpen, setRepostOpen] = useState(false);
  const [repostTarget, setRepostTarget] = useState("");
  const [repostRelayHint, setRepostRelayHint] = useState("");
  const [repostMode, setRepostMode] = useState("repost"); // repost | quote
  const [repostQuoteText, setRepostQuoteText] = useState("");
  const [repostScheduleAt, setRepostScheduleAt] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 30);
    d.setSeconds(0, 0);
    return formatLocalDateTimeInput(d);
  });
  const [repostResolveState, setRepostResolveState] = useState({
    status: "idle", // idle | resolving | found | notfound | wrongkind | invalid
    event: null,
    relay: "",
    kind: 0,
    error: ""
  });
  const [repostSchedulingStep, setRepostSchedulingStep] = useState("");
  const [repostShowAnyway, setRepostShowAnyway] = useState(false);
  const [dmTo, setDmTo] = useState("");
  const [dmMessage, setDmMessage] = useState("");
  const [dmScheduleAt, setDmScheduleAt] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 30);
    d.setSeconds(0, 0);
    return formatLocalDateTimeInput(d);
  });
  const [dmSchedulingStep, setDmSchedulingStep] = useState("");
  const [dmPreviewKeyVersion, setDmPreviewKeyVersion] = useState(0);
  const [addClientTag, setAddClientTag] = useState(true);
  const [nsfw, setNsfw] = useState(false);
  const [composeOptionsOpen, setComposeOptionsOpen] = useState(false);
  const storageKey = (base) => `${base}.${pubkey || "anon"}`;
  const readStored = (key, fallback) => readLocalJson(key, fallback);
  const [nip96Service, setNip96Service] = useState(() => {
    try {
      return readLocalString("pidgeon.nip96", "https://nostr.build") || "https://nostr.build";
    } catch {
      return "https://nostr.build";
    }
  });
  const [uploadBackend, setUploadBackend] = useState(() => {
    try {
      const stored = String(readLocalString("pidgeon.upload.backend", "") || "").trim();
      if (stored === "nip96" || stored === "blossom") return stored;
      // Default matches docs.md (nip96).
      return "nip96";
    } catch {
      return "nip96";
    }
  });
  const [blossomServers, setBlossomServers] = useState(() => {
    try {
      const stored = localStorage.getItem("pidgeon.blossom.servers");
      return stored === null ? DEFAULT_BLOSSOM_SERVERS : String(stored);
    } catch {
      return DEFAULT_BLOSSOM_SERVERS;
    }
  });
  const [publishRelaysMode, setPublishRelaysMode] = useState(() => {
    try {
      const stored = readLocalString("pidgeon.publishRelays.mode", "");
      return stored === "nip65" || stored === "custom" || stored === "recommended" ? stored : "nip65";
    } catch {
      return "nip65";
    }
  });
  const [publishRelaysCustom, setPublishRelaysCustom] = useState(() => {
    try {
      return readLocalString("pidgeon.publishRelays.custom", "") || "";
    } catch {
      return "";
    }
  });
  const [supportInvoiceSats, setSupportInvoiceSats] = useState(() => {
    try {
      const raw = readLocalString("pidgeon.support.invoiceSats", "");
      const n = Math.floor(Number(raw) || 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  });
  const [dvmPubkeyOverride, setDvmPubkeyOverride] = useState(() => {
    try {
      return String(readLocalString("pidgeon.dvm.pubkey", "") || "").trim();
    } catch {
      return "";
    }
  });
  const [dvmRelaysOverride, setDvmRelaysOverride] = useState(() => {
    try {
      return String(readLocalString("pidgeon.dvm.relays", "") || "").trim();
    } catch {
      return "";
    }
  });
  const [nip65PublishRelaysState, setNip65PublishRelaysState] = useState(() => ({
    status: "idle", // idle | loading | error
    relays: [],
    error: "",
    loadedAt: 0
  }));
  const [drafts, setDrafts] = useState([]);
  const draftsOwnerRef = useRef(pubkey || "");
  const [jobs, setJobs] = useState(() => []);
  const dvmRelays = useMemo(() => getDvmConfig().relays || [], []);
  const recommendedPublishRelays = useMemo(() => resolveRelays(getDvmPublishRelays().relays || []), []);
  const forcedRelays = useMemo(() => {
    const list = resolveRelays(dvmRelays);
    return list.length ? list.map((url) => ({ url, enabled: true })) : demoRelays;
  }, [dvmRelays]);
  const [relays, setRelaysState] = useState(forcedRelays);
  useEffect(() => {
    setRelaysState(forcedRelays);
  }, [forcedRelays]);
  const [uploads, setUploads] = useState(emptyUploads);
  const [toast, setToast] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [toastPop, setToastPop] = useState(false);
  const toastTimersRef = useRef({ pop: null, hide: null, clear: null });
  const scheduleSuccessAudioRef = useRef(null);
  const [rescheduleJob, setRescheduleJob] = useState(null);
  const [rescheduleWhen, setRescheduleWhen] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [jobPreview, setJobPreview] = useState(null);
  const [npubState, setNpubState] = useState({ npubFull: "", npubShort: "" });
  const [nostrProfile, setNostrProfile] = useState(null);
  const [schedulingStep, setSchedulingStep] = useState("");
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [mailboxSync, setMailboxSync] = useState({ status: "idle", rev: 0, missing: 0 });
  const [mailboxCounts, setMailboxCounts] = useState(null);
  const [mailboxSupport, setMailboxSupport] = useState(null);
  const [mailboxReady, setMailboxReady] = useState(false);
  const [queueMore, setQueueMore] = useState({ loading: false, hasMore: false });
  const [postedMore, setPostedMore] = useState({ loading: false, hasMore: false });
  const [supportDialog, setSupportDialog] = useState({ open: false, prompt: null, source: "" }); // source: mailbox | gate
  const [supportPayment, setSupportPayment] = useState({ active: false, startedAt: 0 });
  const supportDialogResolveRef = useRef(null);
  const supportDismissedRef = useRef(new Set());
  const mailboxRetryRef = useRef(null);
  const mailboxSubRef = useRef(null);
  const mailboxJobsBatchRef = useRef({ handle: 0, latest: null, latestFp: "", appliedFp: "" });
  const noteHydrateBatchRef = useRef({ handle: 0, events: new Map() });
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const defaultBlockMinutes = useMemo(() => getDefaultDurationMinutes(), []);
  const activeRelays = useMemo(
    () => resolveRelays(relays.filter((r) => r.enabled).map((r) => r.url)),
    [relays]
  );
  const localSettings = useMemo(
    () => ({
      ...(theme === "light" ? { theme: "light" } : {}),
      uploadBackend: uploadBackend === "nip96" ? "nip96" : "blossom",
      nip96Service: String(nip96Service || "").trim(),
      blossomServers: String(blossomServers || "").trim(),
      analyticsEnabled: Boolean(analyticsEnabled),
      publishRelays: {
        mode: publishRelaysMode,
        custom: String(publishRelaysCustom || "")
      },
      supportInvoiceSats: Number(supportInvoiceSats) || 0,
      ...(() => {
        const pk = String(dvmPubkeyOverride || "").trim();
        const relays = String(dvmRelaysOverride || "").trim();
        if (!pk && !relays) return {};
        return { dvm: { pubkey: pk, relays } };
      })(),
    }),
    [theme, uploadBackend, nip96Service, blossomServers, analyticsEnabled, publishRelaysMode, publishRelaysCustom, supportInvoiceSats, dvmPubkeyOverride, dvmRelaysOverride]
  );
  const settingsDirty = useMemo(() => {
    const remote = settingsSync.remote;
    if (!remote) return true;
    try {
      return JSON.stringify(remote) !== JSON.stringify(localSettings);
    } catch {
      return true;
    }
  }, [settingsSync.remote, localSettings]);
  const noteJobs = useMemo(() => jobs.filter((j) => j?.jobType !== "dm17"), [jobs]);
  const dmJobs = useMemo(() => jobs.filter((j) => j?.jobType === "dm17"), [jobs]);
  const dmPreviewsLocked = useMemo(() => {
    if (!pubkey) return true;
    try {
      const dvm = getDvmConfig();
      const d = dvm.pubkey || "default";
      return !localStorage.getItem(`pidgeon.pkv.${d}:${pubkey}`);
    } catch {
      return true;
    }
  }, [pubkey, dmPreviewKeyVersion]);
  const dmPreviewUnlockAttemptRef = useRef({ key: "", at: 0, inFlight: false });

  // Refs to avoid circular dependencies in analytics effect
  const jobsRef = useRef(jobs);
  const activeRelaysRef = useRef(activeRelays);
  const repostHydrateRef = useRef(new Set());

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(() => {
    if (rescheduleJob?.scheduledAt) {
      setRescheduleWhen(formatLocalDateTimeInput(new Date(rescheduleJob.scheduledAt)));
    } else {
      setRescheduleWhen("");
    }
  }, [rescheduleJob]);

  useEffect(() => {
    activeRelaysRef.current = activeRelays;
  }, [activeRelays]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  // Prefetch likely-next views when idle (keeps initial JS small but navigation snappy).
  useEffect(() => {
    try {
      if (!import.meta?.env?.PROD) return;
      const conn = navigator?.connection || navigator?.mozConnection || navigator?.webkitConnection;
      if (conn?.saveData) return;
      const type = String(conn?.effectiveType || "");
      if (type.includes("2g")) return;

      const prefetch = () => {
        loadCalendarPage().catch(() => {});
        loadSettingsView().catch(() => {});
        loadMyFeedView().catch(() => {});
        loadDmView().catch(() => {});
      };

      if (typeof requestIdleCallback === "function") {
        const id = requestIdleCallback(prefetch, { timeout: 2500 });
        return () => {
          if (typeof cancelIdleCallback === "function") cancelIdleCallback(id);
        };
      }

      const id = setTimeout(prefetch, 1200);
      return () => clearTimeout(id);
    } catch {
      return undefined;
    }
  }, []);

  const clearToastTimers = useCallback(() => {
    const timers = toastTimersRef.current;
    Object.values(timers).forEach((timerId) => {
      if (timerId) clearTimeout(timerId);
    });
    toastTimersRef.current = { pop: null, hide: null, clear: null };
  }, []);

  useEffect(() => () => clearToastTimers(), [clearToastTimers]);

  useEffect(() => {
    if (view !== "dm") return;
    if (!pubkey) return;
    if (!dmPreviewsLocked) return;
    if (!window.nostr?.signEvent || !window.nostr?.nip44?.encrypt) return;

    const hint = dmJobs.find((j) => j?.dm?.pkv_id)?.dm?.pkv_id || "";
    const dvm = getDvmConfig();
    const attemptKey = `${pubkey}:${dvm.pubkey || "default"}:${hint || "nohint"}`;
    const nowMs = Date.now();
    const last = dmPreviewUnlockAttemptRef.current;
    if (last.inFlight) return;
    if (last.key === attemptKey && nowMs - last.at < 60_000) return;

    dmPreviewUnlockAttemptRef.current = { key: attemptKey, at: nowMs, inFlight: true };
    ensurePreviewKey(pubkey, { pkvIdHint: hint })
      .then(() => {
        setDmPreviewKeyVersion((v) => v + 1);
        mailboxRetryRef.current?.();
      })
      .catch(() => {})
      .finally(() => {
        dmPreviewUnlockAttemptRef.current = { ...dmPreviewUnlockAttemptRef.current, inFlight: false };
      });
  }, [view, pubkey, dmPreviewsLocked, dmJobs]);

  useEffect(() => {
    try {
      if (!pubkey) return;
      if (draftsOwnerRef.current !== pubkey) return;
      localStorage.setItem(storageKey(LS_KEYS.drafts), JSON.stringify(drafts));
    } catch {}
  }, [drafts, pubkey]);

  useEffect(() => {
    try {
      localStorage.setItem("pidgeon.analytics.enabled", analyticsEnabled ? "true" : "false");
    } catch {}
  }, [analyticsEnabled]);

  const snoozeOnboarding = useCallback(() => {
    const until = Date.now() + ONBOARDING_SNOOZE_MS;
    setOnboardingSnoozeUntil(until);
    setOnboardingOpen(false);
    try {
      localStorage.setItem(onboardingKeys.snoozeUser, String(until));
      localStorage.setItem(onboardingKeys.snoozeGlobal, String(until));
    } catch {}
  }, [ONBOARDING_SNOOZE_MS, onboardingKeys]);

  const hideOnboardingForever = useCallback(() => {
    setOnboardingHidden(true);
    setOnboardingOpen(false);
    try {
      localStorage.setItem(onboardingKeys.hiddenUser, "true");
      localStorage.setItem(onboardingKeys.hiddenGlobal, "true");
    } catch {}
  }, [onboardingKeys]);

  useEffect(() => {
    try {
      const hidden =
        localStorage.getItem(onboardingKeys.hiddenUser) === "true" ||
        localStorage.getItem(onboardingKeys.hiddenGlobal) === "true";
      const userUntil = Math.floor(Number(localStorage.getItem(onboardingKeys.snoozeUser) || 0));
      const globalUntil = Math.floor(Number(localStorage.getItem(onboardingKeys.snoozeGlobal) || 0));
      setOnboardingHidden(Boolean(hidden));
      setOnboardingSnoozeUntil(Math.max(0, userUntil, globalUntil));
    } catch {
      setOnboardingHidden(false);
      setOnboardingSnoozeUntil(0);
    }
    setOnboardingOpen(false);
  }, [onboardingKeys]);

  useEffect(() => {
    const normalized = theme === "light" ? "light" : "dark";
    try {
      document.documentElement.setAttribute("data-theme", normalized);
    } catch {}
    try {
      localStorage.setItem("pidgeon.theme", normalized);
    } catch {}
    try {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", normalized === "light" ? "#F5EFE6" : "#020617");
    } catch {}
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem("pidgeon.nip96", nip96Service);
    } catch {}
  }, [nip96Service]);
  useEffect(() => {
    try {
      localStorage.setItem("pidgeon.upload.backend", uploadBackend);
    } catch {}
  }, [uploadBackend]);
  useEffect(() => {
    try {
      localStorage.setItem("pidgeon.blossom.servers", blossomServers);
    } catch {}
  }, [blossomServers]);
  useEffect(() => {
    try {
      localStorage.setItem("pidgeon.publishRelays.mode", publishRelaysMode);
    } catch {}
  }, [publishRelaysMode]);
  useEffect(() => {
    try {
      localStorage.setItem("pidgeon.publishRelays.custom", publishRelaysCustom);
    } catch {}
  }, [publishRelaysCustom]);
  useEffect(() => {
    try {
      const n = Math.floor(Number(supportInvoiceSats) || 0);
      if (n > 0) {
        localStorage.setItem("pidgeon.support.invoiceSats", String(n));
      } else {
        localStorage.removeItem("pidgeon.support.invoiceSats");
      }
    } catch {}
  }, [supportInvoiceSats]);
  useEffect(() => {
    let cancelled = false;
    // reload per-account persisted state (drafts/relays). Jobs are mailbox‑truth.
    setComposerDraftId("");
    setDraftCleanupPrompt({ open: false, id: "", preview: "" });
    setJobs([]);
    setMailboxCounts(null);
    setMailboxSync({ status: "idle", rev: 0, missing: 0 });
    setMailboxReady(false);
    setRelaysState(forcedRelays);
    if (!pubkey) {
      setDrafts([]);
      setDraftsLoading(false);
      draftsOwnerRef.current = "";
      setNpubState({ npubFull: "", npubShort: "" });
      setNostrProfile(null);
      return () => {
        cancelled = true;
      };
    }
    // Mark drafts as belonging to this pubkey immediately, so local saves persist even if
    // remote draft decrypt hangs/fails (ex: Amber 4.0.4 NIP-46 decrypt regression).
    draftsOwnerRef.current = pubkey;
    try {
      setDrafts(readStored(storageKey(LS_KEYS.drafts), []));
    } catch {
      setDrafts([]);
    }
    (async () => {
      setDraftsLoading(true);
      try {
        const relaySnapshot = activeRelaysRef.current || activeRelays;
        const remoteDrafts = await fetchDraftsApi(pubkey, relaySnapshot);
        if (!cancelled) {
          const hydrated = Array.isArray(remoteDrafts) ? remoteDrafts.map(hydrateServerDraft) : [];
          const stored = readStored(storageKey(LS_KEYS.drafts), []);
          const byId = new Map();
          for (const d of Array.isArray(stored) ? stored : []) {
            if (d?.id) byId.set(d.id, d);
          }
          for (const d of hydrated) {
            if (d?.id) byId.set(d.id, d);
          }
          const merged = Array.from(byId.values()).sort(
            (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
          );
          setDrafts(merged);
        }
      } catch (err) {
        console.warn("draft fetch failed", err?.message || err);
        if (!cancelled) {
          setDrafts(readStored(storageKey(LS_KEYS.drafts), []));
        }
      } finally {
        if (!cancelled) setDraftsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setDraftsLoading(false);
    };
  }, [pubkey, forcedRelays]);

  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    (async () => {
      try {
        const { npubEncode } = await loadNip19();
        const full = pubkey.startsWith("npub1") ? pubkey : npubEncode(pubkey);
        const short = full.length <= 16 ? full : `${full.slice(0, 8)}…${full.slice(-6)}`;
        if (!cancelled) setNpubState({ npubFull: full, npubShort: short });
      } catch {
        const hex = String(pubkey);
        const short = `npub…${hex.slice(-6)}`;
        if (!cancelled) setNpubState({ npubFull: hex, npubShort: short });
      }
      try {
        const profiles = await fetchProfilesForEvents([{ pubkey }], activeRelays);
        const profile = profiles?.[pubkey];
        if (!cancelled) {
          setNostrProfile(
            profile
              ? {
                  name: profile.display_name || profile.name || "",
                  picture: profile.picture || "",
                }
              : null
          );
        }
      } catch {
        if (!cancelled) setNostrProfile(null);
      }

      // Relay list is forced by DVM config; ignore user relay lists.
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey, activeRelays]);

  const remaining = charLimit - editor.content.length;

  const FOOTER_NPUB = "npub1lvzt92km8nua8wt675kn74zwz9v7uxjts4yrx32f6yahetz0sa5s7szg03";
  const FOOTER_REPO_URL = "https://github.com/MaviLabArt/Pidgeon";
  const FOOTER_REPO_LABEL = "MaviLabArt/Pidgeon";

  const showToast = useCallback((msg) => {
    const message = String(msg || "").trim();
    if (!message) return;
    clearToastTimers();
    setToast(message);
    setToastVisible(true);
    setToastPop(true);
    toastTimersRef.current.pop = setTimeout(() => setToastPop(false), 360);
    toastTimersRef.current.hide = setTimeout(() => setToastVisible(false), 3200);
    toastTimersRef.current.clear = setTimeout(() => setToast(""), 3600);
  }, [clearToastTimers]);

  function playScheduleSuccessSound() {
    try {
      if (!scheduleSuccessAudioRef.current) {
        const audio = new Audio("/sfx/env_bird_hototogisu_00.mp3");
        audio.volume = 0.45;
        scheduleSuccessAudioRef.current = audio;
      } else {
        scheduleSuccessAudioRef.current.currentTime = 0;
      }
      const promise = scheduleSuccessAudioRef.current.play?.();
      if (promise && typeof promise.catch === "function") promise.catch(() => {});
    } catch {}
  }

  const openSupportDialog = useCallback((prompt, { source = "mailbox" } = {}) => {
    const p = prompt && typeof prompt === "object" ? prompt : null;
    if (!p) return Promise.resolve({ action: "close" });
    if (supportDialogResolveRef.current) return Promise.resolve({ action: "close" });
    setSupportDialog({ open: true, prompt: p, source: source || "mailbox" });
    setSupportPayment({ active: false, startedAt: 0 });
    return new Promise((resolve) => {
      supportDialogResolveRef.current = resolve;
    });
  }, []);

  const resolveSupportDialog = useCallback((result = { action: "close" }) => {
    const resolve = supportDialogResolveRef.current;
    supportDialogResolveRef.current = null;
    setSupportDialog({ open: false, prompt: null, source: "" });
    setSupportPayment({ active: false, startedAt: 0 });
    if (typeof resolve === "function") resolve(result);
  }, []);

  const publishSupportAction = useCallback(async (action, { promptId = "", source = "", invoiceId = "", sats = 0 } = {}) => {
    const a = String(action || "").trim().toLowerCase();
    if (!["use_free", "maybe_later", "support", "check_invoice"].includes(a)) return;

    const isDemo = (() => {
      try {
        return Boolean(isDemoMailboxEnabled?.());
      } catch {
        return false;
      }
    })();
    if (isDemo) return;

    if (!pubkey || !window.nostr?.signEvent || !window.nostr?.nip44?.encrypt) return;
    const dvm = getDvmConfig();
    if (!dvm.pubkey || !dvm.relays.length) return;

    try {
      await ensureMailboxSecrets(pubkey);
      const requestEvent = await buildSupportActionRequest({
        fromPubkey: pubkey,
        action: a,
        promptId,
        source,
        invoiceId,
        sats: Math.max(0, Math.floor(Number(sats) || 0)),
        dvmPubkey: dvm.pubkey
      });
      await publishScheduleRequest({ requestEvent, dvmRelays: dvm.relays });
      mailboxRetryRef.current?.();
    } catch (err) {
      console.debug("[support] action publish failed", err?.message || err);
    }
  }, [pubkey]);

  useEffect(() => {
    if (onboardingOpen) return;
    if (onboardingHidden) return;
    if (view !== "compose") return;
    if (
      mobileMenuOpen ||
      composeOptionsOpen ||
      repostOpen ||
      supportDialog.open ||
      draftCleanupPrompt.open
    )
      return;
    if (Date.now() < onboardingSnoozeUntil) return;
    if ((Array.isArray(jobs) ? jobs.length : 0) > 0) return;
    if ((Array.isArray(drafts) ? drafts.length : 0) > 0) return;
    if (String(editor?.content || "").trim()) return;

    const id = setTimeout(() => setOnboardingOpen(true), 650);
    return () => clearTimeout(id);
  }, [
    onboardingOpen,
    onboardingHidden,
    onboardingSnoozeUntil,
    view,
    mobileMenuOpen,
    composeOptionsOpen,
    repostOpen,
    supportDialog.open,
    draftCleanupPrompt.open,
    jobs,
    drafts,
    editor?.content,
  ]);

  const copyText = useCallback(async (text) => {
    const t = String(text || "").trim();
    if (!t) return false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch {}
    return false;
  }, []);

  const supportPayMode = useMemo(
    () => String(mailboxSupport?.policy?.payment?.mode || "").trim().toLowerCase(),
    [mailboxSupport?.policy?.payment?.mode]
  );
  const supportPaymentPolicy = mailboxSupport?.policy?.payment && typeof mailboxSupport.policy.payment === "object" ? mailboxSupport.policy.payment : {};
  const supportDefaultInvoiceSats = Math.max(0, Math.floor(Number(supportPaymentPolicy?.invoiceSats) || 0));
  const supportMinInvoiceSats = Math.max(0, Math.floor(Number(supportPaymentPolicy?.minSats) || supportDefaultInvoiceSats || 0));
  const supportDesiredInvoiceSats = useMemo(() => {
    const chosen = Math.max(0, Math.floor(Number(supportInvoiceSats) || 0));
    const base = chosen > 0 ? chosen : supportDefaultInvoiceSats;
    const clamped = supportMinInvoiceSats > 0 ? Math.max(base, supportMinInvoiceSats) : base;
    return Math.max(0, Math.floor(Number(clamped) || 0));
  }, [supportInvoiceSats, supportDefaultInvoiceSats, supportMinInvoiceSats]);
  const supportInvoice = mailboxSupport?.invoice && typeof mailboxSupport.invoice === "object" ? mailboxSupport.invoice : null;
  const supportHasInvoice = Boolean(supportInvoice?.pr);
  const supportShowInvoice = supportPayMode === "lnurl_verify" && (supportPayment.active || supportHasInvoice);

  const openSupportLink = useCallback(async () => {
    const lud16 = String(mailboxSupport?.policy?.cta?.lud16 || "").trim();
    if (!lud16) {
      showToast("Support is not configured on this DVM");
      return;
    }
    const copied = await copyText(lud16);
    if (copied) showToast("Copied lightning address");
    try {
      window.open(`lightning:${lud16}`, "_blank", "noopener,noreferrer");
    } catch {}
  }, [mailboxSupport, copyText, showToast]);

  const openInvoiceLink = useCallback(
    async (invoice) => {
      const pr = String(invoice || "").trim();
      if (!pr) return;
      const copied = await copyText(pr);
      if (copied) showToast("Copied invoice");
      try {
        window.open(`lightning:${pr}`, "_blank", "noopener,noreferrer");
      } catch {}
    },
    [copyText, showToast]
  );

  const handleSupportDialogAction = useCallback(
    (action, { invoiceId = "" } = {}) => {
      const a = String(action || "").trim().toLowerCase() || "close";
      const promptId = String(supportDialog?.prompt?.id || "").trim();
      const promptType = String(supportDialog?.prompt?.type || "").trim();
      const source = promptType || (supportDialog.source === "gate" ? "gate" : "mailbox");

      if (promptId && supportDialog.source === "mailbox") {
        supportDismissedRef.current.add(promptId);
      }

      if (a === "support") {
        const payMode = String(mailboxSupport?.policy?.payment?.mode || "").trim().toLowerCase();
        if (payMode === "lnurl_verify") {
          const pr = String(mailboxSupport?.invoice?.pr || "").trim();
          if (pr) {
            openInvoiceLink(pr);
            return;
          }
          setSupportPayment({ active: true, startedAt: Date.now() });
          publishSupportAction("support", { promptId, source, sats: supportDesiredInvoiceSats });
          return;
        }

        openSupportLink().finally(() => {
          publishSupportAction("support", { promptId, source });
          resolveSupportDialog({ action: "support" });
        });
        return;
      }

      if (a === "check_invoice") {
        const id = String(invoiceId || "").trim();
        publishSupportAction("check_invoice", { promptId, source, invoiceId: id });
        return;
      }

      if (a === "use_free" || a === "maybe_later") {
        publishSupportAction(a, { promptId, source });
        resolveSupportDialog({ action: a });
        return;
      }

      resolveSupportDialog({ action: a });
    },
    [supportDialog, mailboxSupport, supportDesiredInvoiceSats, publishSupportAction, openSupportLink, openInvoiceLink, resolveSupportDialog]
  );

  useEffect(() => {
    if (!supportDialog.open) return;
    if (!supportPayment.active) return;
    if (!mailboxSupport?.state?.isSupporter) return;

    try {
      showToast("Thanks for supporting!");
    } catch {}

    const promptId = String(supportDialog?.prompt?.id || "").trim();
    if (promptId && supportDialog.source === "mailbox") {
      supportDismissedRef.current.add(promptId);
    }
    resolveSupportDialog({ action: "support" });
  }, [supportDialog.open, supportDialog?.prompt?.id, supportDialog.source, supportPayment.active, mailboxSupport?.state?.isSupporter, showToast, resolveSupportDialog]);

  async function getSupportGateCap({ scheduledAtSec, feature, intent = "" } = {}) {
    const policy = mailboxSupport?.policy;
    const state = mailboxSupport?.state;
    if (!policy || !state) return { ok: true, cap: null };
    if (state.isSupporter || state.isUnlocked) return { ok: true, cap: null };

    const nowSec = Math.floor(Date.now() / 1000);
    const horizonDays = Number(policy.horizonDays) || 0;
    const horizonSec = horizonDays > 0 ? horizonDays * 86400 : 0;
    const tooFar = horizonSec > 0 && Number(scheduledAtSec) > nowSec + horizonSec;

    const want = String(feature || "").trim().toLowerCase();
    const gated = (Array.isArray(policy.gatedFeatures) ? policy.gatedFeatures : [])
      .map((f) => String(f || "").trim().toLowerCase())
      .includes(want);

    if (!tooFar && !gated) return { ok: true, cap: null };

    const prompt = {
      v: 1,
      id: `local-gate:${tooFar ? "horizon" : "feature"}:${want}:${Number(scheduledAtSec) || 0}`,
      type: "gate",
      reason: tooFar ? "horizon" : "feature",
      feature: want,
      scheduledAt: Number(scheduledAtSec) || 0,
      horizonDays,
      windowSchedules: Number(policy.windowSchedules) || 0,
      intent: String(intent || "")
    };
    const res = await openSupportDialog(prompt, { source: "gate" });
    const act = String(res?.action || "").trim().toLowerCase();
    if (act === "use_free") {
      return { ok: true, cap: { allowFree: true } };
    }
    if (act === "support") {
      return { ok: true, cap: null };
    }
    return { ok: false, cap: null };
  }

  const applyRemoteSettings = (next) => {
    if (!next || typeof next !== "object") return;
    if (typeof next.theme === "string") {
      const t = String(next.theme || "").trim().toLowerCase();
      if (t === "light" || t === "dark") setThemePreference(t);
    }
    if (next.uploadBackend === "nip96" || next.uploadBackend === "blossom") {
      setUploadBackend(next.uploadBackend);
    }
    if (typeof next.nip96Service === "string") setNip96Service(next.nip96Service);
    if (typeof next.blossomServers === "string") setBlossomServers(next.blossomServers);
    if (typeof next.analyticsEnabled === "boolean") setAnalyticsEnabled(next.analyticsEnabled);
    const pr = next.publishRelays && typeof next.publishRelays === "object" ? next.publishRelays : null;
    if (pr) {
      const mode = String(pr.mode || "").trim();
      setPublishRelaysMode(mode === "nip65" || mode === "custom" || mode === "recommended" ? mode : "nip65");
      if (typeof pr.custom === "string") setPublishRelaysCustom(pr.custom);
    }
    if (Object.prototype.hasOwnProperty.call(next, "supportInvoiceSats")) {
      const n = Math.floor(Number(next.supportInvoiceSats) || 0);
      setSupportInvoiceSats(Number.isFinite(n) && n > 0 ? n : 0);
    }

    const dvm = next.dvm && typeof next.dvm === "object" ? next.dvm : null;
    if (dvm) {
      const pk = typeof dvm.pubkey === "string" ? dvm.pubkey : "";
      const relays = typeof dvm.relays === "string" ? dvm.relays : "";
      setDvmPubkeyOverride(pk);
      setDvmRelaysOverride(relays);
      try {
        const trimmedPk = String(pk || "").trim();
        const trimmedRelays = String(relays || "").trim();
        if (trimmedPk) localStorage.setItem("pidgeon.dvm.pubkey", trimmedPk);
        else localStorage.removeItem("pidgeon.dvm.pubkey");
        if (trimmedRelays) localStorage.setItem("pidgeon.dvm.relays", trimmedRelays);
        else localStorage.removeItem("pidgeon.dvm.relays");
      } catch {}
    }
  };

  const refreshNip65PublishRelays = useCallback(async () => {
    if (!pubkey) return;
    setNip65PublishRelaysState((prev) => ({ ...prev, status: "loading", error: "" }));
    try {
      const seedRelays = Array.from(new Set([...(recommendedPublishRelays || []), ...(activeRelays || [])])).filter(Boolean);
      const relays = await fetchNip65WriteRelays({ pubkey, relays: seedRelays });
      setNip65PublishRelaysState({ status: "idle", relays, error: "", loadedAt: Date.now() });
    } catch (err) {
      const msg = String(err?.message || err || "Failed to load relay list").trim();
      setNip65PublishRelaysState({ status: "error", relays: [], error: msg, loadedAt: Date.now() });
    }
  }, [pubkey, activeRelays, recommendedPublishRelays]);

  useEffect(() => {
    if (!pubkey) return;
    if (publishRelaysMode !== "nip65") return;
    refreshNip65PublishRelays();
  }, [pubkey, publishRelaysMode, refreshNip65PublishRelays]);

  const loadUserSettingsFromNostr = async ({ silent = false } = {}) => {
    if (!pubkey) {
      if (!silent) showToast("Login to sync settings");
      return;
    }
    setSettingsSync((prev) => ({ ...prev, status: "loading", error: "" }));
    try {
      const res = await fetchUserSettingsApi(pubkey, activeRelays);
      if (res?.settings) {
        applyRemoteSettings(res.settings);
        setSettingsSync((prev) => ({
          ...prev,
          status: "idle",
          error: "",
          eventId: res.eventId || "",
          createdAt: Number(res.createdAt) || 0,
          loadedAt: Date.now(),
          remote: res.settings,
        }));
        if (!silent) showToast("Loaded settings from Nostr");
      } else {
        setSettingsSync((prev) => ({
          ...prev,
          status: "idle",
          error: "",
          eventId: "",
          createdAt: 0,
          loadedAt: Date.now(),
          remote: null,
        }));
        if (!silent) showToast("No Nostr settings found yet");
      }
    } catch (err) {
      const msg = err?.message || "Failed to load settings";
      setSettingsSync((prev) => ({ ...prev, status: "error", error: msg }));
      if (!silent) showToast(msg);
    }
  };

  const saveUserSettingsToNostr = async () => {
    if (!pubkey) return showToast("Login to save settings");
    setSettingsSync((prev) => ({ ...prev, status: "saving", error: "" }));
    try {
      const res = await saveUserSettingsApi({ pubkey, settings: localSettings, relays: activeRelays });
      setSettingsSync((prev) => ({
        ...prev,
        status: "idle",
        error: "",
        eventId: res?.eventId || "",
        createdAt: Number(res?.createdAt) || 0,
        savedAt: Date.now(),
        remote: localSettings,
      }));
      showToast("Settings saved to Nostr");
    } catch (err) {
      const msg = err?.message || "Failed to save settings";
      setSettingsSync((prev) => ({ ...prev, status: "error", error: msg }));
      showToast(msg);
    }
  };

  useEffect(() => {
    if (!pubkey) {
      settingsLoadedRef.current = "";
      setSettingsSync((prev) => ({ ...prev, status: "idle", error: "", eventId: "", createdAt: 0, loadedAt: 0, savedAt: 0, remote: null }));
      return;
    }
    if (settingsLoadedRef.current === pubkey) return;
    settingsLoadedRef.current = pubkey;
    loadUserSettingsFromNostr({ silent: true });
  }, [pubkey]);

  function collectUploadTags(content) {
    const list = [];
    uploadTagStore.forEach((tags, url) => {
      if (content.includes(url)) {
        list.push(...tags);
      }
    });
    return list;
  }

  const handleConnectNIP07 = useCallback(() => startLogin(), [startLogin]);
  const handleLogout = useCallback(async () => {
    const currentPubkey = pubkey;
    try {
      await logout();
      if (currentPubkey) {
        clearMasterKeyCache(currentPubkey);
      }
      setJobs([]);
      showToast("Signed out");
    } catch {
      showToast("Logout failed");
    }
  }, [logout, pubkey, showToast]);
  const handleMenuToggle = useCallback(() => setMobileMenuOpen((prev) => !prev), []);
  const uploadTagStore = useMemo(() => new Map(), []);

  const noteWatch = useMemo(() => {
    const targets = noteJobs.filter(
      (j) => j.status === "posted" && j.noteId && !j.noteEvent
    );
    const quoteTargets = noteJobs
      .filter((j) => isQuoteJob(j))
      .map((j) => getQuoteTargetInfo(j))
      .filter((it) => it?.id);
    const quoteRelays = quoteTargets
      .map((it) => normalizeWsRelayUrl(String(it?.relay || "")))
      .filter(Boolean);
    const dvm = getDvmConfig();
    const relays = resolveRelays([
      ...activeRelays,
      ...(Array.isArray(dvm?.relays) ? dvm.relays : []),
      ...targets.flatMap((j) => j.relays || []),
      ...quoteRelays
    ]).sort();
    const noteIds = Array.from(
      new Set([
        ...targets.map((j) => j.noteId).filter(Boolean),
        ...quoteTargets.map((it) => it.id).filter(Boolean)
      ])
    ).sort();
    return { relays, noteIds, key: `${noteIds.join(",")}|${relays.join(",")}` };
  }, [noteJobs, activeRelays]);
  const handleUploadStart = (file, cancel) => {
    setUploads((u) => [...u, { file, name: file.name, progress: 0, cancel }]);
  };
  const handleUploadProgress = (file, progress) => {
    setUploads((u) => u.map((item) => (item.file === file ? { ...item, progress } : item)));
  };
  const handleUploadEnd = (file) => {
    setUploads((u) => u.filter((item) => item.file !== file));
  };
  const handleUploadSuccess = ({ url, tags }) => {
    if (tags && tags.length) {
      uploadTagStore.set(url, tags);
    }
    setEditor((prev) => ({
      ...prev,
      content: `${prev.content}${prev.content.endsWith("\n") ? "" : "\n"}${url}\n`,
    }));
  };

  async function saveDraft() {
    if (!editor.content.trim()) return;
    if (!pubkey) return;
    if (draftSaving) return;
    setDraftSaving(true);
    // Ensure local persistence is scoped to this pubkey even if drafts bootstrap is still running.
    draftsOwnerRef.current = pubkey;
    const draftId = composerDraftId || ((typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Math.random().toString(36).slice(2) + Date.now().toString(36)));
    const d = {
      id: draftId,
      content: editor.content,
      tags: editor.tags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      eventId: ""
    };
    setComposerDraftId(draftId);
    setDrafts((prev) => [d, ...(Array.isArray(prev) ? prev.filter((x) => x.id !== draftId) : [])].slice(0, 200));
    try {
      const saved = await saveDraftApi({
        id: draftId,
        pubkey,
        content: editor.content,
        tags: editor.tags,
        relays: activeRelays
      });
      if (saved) {
        const hydrated = hydrateServerDraft(saved);
        setDrafts((prev) => [hydrated, ...prev.filter((x) => x.id !== hydrated.id)].slice(0, 200));
      }
      showToast("Draft saved");
    } catch (err) {
      console.error("draft save failed", err);
      showToast("Failed to save draft");
    } finally {
      setDraftSaving(false);
    }
  }

  function useDraft(d) {
    setEditor({ content: d.content, tags: d.tags, media: [] });
    setComposerDraftId(String(d?.id || ""));
    showToast("Draft loaded");
    setView("compose");
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {}
  }

  function deleteDraft(id) {
    setDrafts((prev) => (Array.isArray(prev) ? prev.filter((d) => d.id !== id) : prev));
    setComposerDraftId((prev) => (prev === id ? "" : prev));
    if (!pubkey) return;
    removeDraftApi(pubkey, id, activeRelays).catch((err) => {
      console.warn("draft delete failed", err?.message || err);
    });
    showToast("Draft deleted");
  }

  async function resolvePublishRelaysForRequest() {
    const recommended = Array.isArray(recommendedPublishRelays) ? recommendedPublishRelays : [];
    if (publishRelaysMode === "custom") {
      const parsed = parseRelayListText(publishRelaysCustom || "", { max: 20 });
      const relays = parsed.relays || [];
      return {
        mode: "custom",
        relayHints: relays.length ? relays : null,
        uiRelays: relays.length ? relays : recommended,
        warning: relays.length ? "" : "No valid custom relays; using recommended"
      };
    }
    if (publishRelaysMode === "nip65") {
      const relays = Array.isArray(nip65PublishRelaysState.relays) ? nip65PublishRelaysState.relays : [];
      return {
        mode: "nip65",
        relayHints: relays.length ? relays : null,
        uiRelays: relays.length ? relays : recommended,
        warning: relays.length ? "" : "No NIP-65 relay list found; using recommended"
      };
    }
    return { mode: "recommended", relayHints: null, uiRelays: recommended, warning: "" };
  }

  async function schedulePost() {
    if (!editor.content.trim()) return showToast("Write something first");
    if (!pubkey || !window.nostr?.signEvent || !window.nostr?.nip44?.encrypt) {
      return showToast("Connect a Nostr signer first");
    }
    const draftIdForCleanup = String(composerDraftId || "").trim();
    const isDemo = (() => {
      try {
        return Boolean(isDemoMailboxEnabled?.());
      } catch {
        return false;
      }
    })();
    const dvm = getDvmConfig();
    if (!isDemo && (!dvm.pubkey || dvm.relays.length === 0)) {
      return showToast("Configure DVM pubkey/relays (VITE_DVM_PUBKEY/VITE_DVM_RELAYS)");
    }

    const when = new Date(scheduleAt);
    if (Number.isNaN(when.getTime())) return showToast("Pick a valid time");
    const scheduledAtSec = Math.floor(when.getTime() / 1000);

    const gate = isDemo ? { ok: true, cap: null } : await getSupportGateCap({ scheduledAtSec, feature: "note", intent: "schedule_note" });
    if (!gate.ok) return;
    const cap = gate.cap;

    const draftEvent = buildDraftEvent({
      content: editor.content,
      manualTags: editor.tags,
      uploadTags: collectUploadTags(editor.content),
      addClientTag,
      nsfw,
    });
    draftEvent.created_at = scheduledAtSec;
    draftEvent.pubkey = pubkey;

    try {
      setSchedulingStep("Signing note…");
      const signedNote = await window.nostr.signEvent(draftEvent);
      if (isDemo) {
        const requestId = `demo-${signedNote.id}`;
        const j = {
          id: requestId,
          requestId,
          noteId: signedNote.id,
          content: editor.content,
          tags: editor.tags,
          scheduledAt: when.toISOString(),
          createdAt: new Date().toISOString(),
          status: "scheduled",
          relays: [],
          dvmRelays: [],
          noteEvent: signedNote,
          requestEvent: null,
          statusInfo: "",
          lastError: ""
        };
        setJobs((prev) => sortJobsByUpdated([j, ...(Array.isArray(prev) ? prev : [])]));
        setSchedulingStep(`Scheduled for ${formatDateTime(when)}`);
        playScheduleSuccessSound();
        showToast("Scheduled ✨");
        setEditor({ content: "", tags: "", media: [] });
        setComposerDraftId("");
        if (draftIdForCleanup) {
          const draftPreview = String(editor.content || "").trim().replace(/\s+/g, " ").slice(0, 160);
          setDraftCleanupPrompt({ open: true, id: draftIdForCleanup, preview: draftPreview });
        }
        setTimeout(() => setSchedulingStep(""), 1200);
        return;
      }
      setSchedulingStep("Unwrapping mailbox key…");
      await ensureMailboxSecrets(pubkey);
      setSchedulingStep("Encrypting request…");
      const publishSelection = await resolvePublishRelaysForRequest();
      if (publishSelection.warning && publishSelection.mode !== "recommended") {
        showToast(publishSelection.warning);
      }
      const scheduleRequest = await buildScheduleRequest({
        signedNote,
        relayHints: publishSelection.relayHints,
        dvmPubkey: dvm.pubkey,
        cap
      });
      const requestId = scheduleRequest.requestId || scheduleRequest.id;
      try {
        console.debug("[schedule] built request", {
          noteId: signedNote.id,
          requestId,
          dvm: dvm.pubkey,
          relays: dvm.relays.length
        });
      } catch {}
      setSchedulingStep("Publishing request…");
      await publishScheduleRequest({ requestEvent: scheduleRequest, dvmRelays: dvm.relays });
      try {
        console.debug("[schedule] published request", { requestId });
      } catch {}
      const j = {
        id: requestId,
        requestId,
        noteId: signedNote.id,
        content: editor.content,
        tags: editor.tags,
        scheduledAt: when.toISOString(),
        createdAt: new Date().toISOString(),
        status: "scheduled", // scheduled | posted | paused
        relays: publishSelection.uiRelays,
        dvmRelays: dvm.relays,
        noteEvent: signedNote,
        requestEvent: scheduleRequest,
        statusInfo: "",
        lastError: ""
      };
      setJobs((prev) => sortJobsByUpdated([j, ...prev]));
      setSchedulingStep(`Scheduled for ${formatDateTime(when)}`);
      playScheduleSuccessSound();
      showToast("Scheduled via DVM ✨");
      setEditor({ content: "", tags: "", media: [] });
      setComposerDraftId("");
      if (draftIdForCleanup) {
        const draftPreview = String(editor.content || "").trim().replace(/\s+/g, " ").slice(0, 160);
        setDraftCleanupPrompt({ open: true, id: draftIdForCleanup, preview: draftPreview });
      }
      setTimeout(() => setSchedulingStep(""), 2000);
    } catch (err) {
      console.error("[schedulePost] Schedule error", err);
      showToast(err?.message || "Failed to schedule");
      try {
        console.debug("[schedulePost] context", {
          pubkey,
          dvmRelays: dvm.relays,
          dvmPubkey: dvm.pubkey,
          hasSigner: Boolean(window.nostr?.signEvent),
          hasNip44: Boolean(window.nostr?.nip44?.encrypt)
        });
      } catch {}
      setSchedulingStep("");
    }
  }

  async function requestMailboxRepair({ scope = "queue" } = {}) {
    if (!pubkey || !window.nostr?.signEvent || !window.nostr?.nip44?.encrypt) {
      showToast("Connect a Nostr signer first");
      return;
    }
    const dvm = getDvmConfig();
    if (!dvm.pubkey || !dvm.relays.length) {
      showToast("Configure DVM pubkey/relays (VITE_DVM_PUBKEY/VITE_DVM_RELAYS)");
      return;
    }
    try {
      await ensureMailboxSecrets(pubkey);
      const requestEvent = await buildMailboxRepairRequest({ fromPubkey: pubkey, scope, dvmPubkey: dvm.pubkey });
      await publishScheduleRequest({ requestEvent, dvmRelays: dvm.relays });
      showToast("Job ledger repair requested");
      mailboxRetryRef.current?.();
    } catch (err) {
      console.warn("[mailbox] repair request failed", err?.message || err);
      showToast(err?.message || "Failed to request job ledger repair");
    }
  }

  function shortHexId(id = "") {
    const hex = String(id || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(hex)) return "";
    return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
  }

  async function normalizeNoteIdInput(input) {
    const raw = String(input || "").trim().replace(/^nostr:/i, "");
    if (!raw) return "";
    if (/^[a-f0-9]{64}$/i.test(raw)) return raw.toLowerCase();
    if (!/^(note1|nevent1)/i.test(raw)) return "";
    try {
      const { decode } = await loadNip19();
      const decoded = decode(raw);
      if (decoded?.type === "note" && typeof decoded.data === "string") return decoded.data.toLowerCase();
      if (decoded?.type === "nevent") {
        const id = typeof decoded.data === "string" ? decoded.data : decoded.data?.id;
        if (typeof id === "string" && /^[a-f0-9]{64}$/i.test(id)) return id.toLowerCase();
      }
    } catch {}
    return "";
  }

  function openRepostDialog({ targetId = "", relayHint = "", resolvedEvent = null } = {}) {
    const nextWhen = new Date();
    nextWhen.setMinutes(nextWhen.getMinutes() + 30);
    nextWhen.setSeconds(0, 0);
    const dvm = getDvmConfig();
    const fallbackRelay = String(relayHint || dvm?.relays?.[0] || activeRelays?.[0] || "");
    setRepostScheduleAt(formatLocalDateTimeInput(nextWhen));
    setRepostTarget(String(targetId || ""));
    setRepostRelayHint(fallbackRelay);
    setRepostMode("repost");
    setRepostQuoteText("");
    setRepostSchedulingStep("");
    setRepostShowAnyway(false);
    setRepostResolveState({
      status: resolvedEvent ? "found" : "idle",
      event: resolvedEvent || null,
      relay: fallbackRelay,
      kind: resolvedEvent?.kind || 0,
      error: ""
    });
    setRepostOpen(true);
  }

  async function resolveRepostTargetById(targetId) {
    const dvm = getDvmConfig();
    const relaysToTry = resolveRelays([...(activeRelays || []), ...(dvm.relays || [])]);
    if (!relaysToTry.length) {
      return { status: "notfound", event: null, relay: "", kind: 0, error: "No relays available" };
    }
    try {
      const { event, relay } = await fetchEventOnceWithRelay(
        relaysToTry,
        { ids: [targetId], limit: 1 },
        { timeoutMs: 1500 }
      );
      if (!event) {
        return { status: "notfound", event: null, relay: "", kind: 0, error: "" };
      }
      const kind = Number(event.kind) || 0;
      if (kind !== 1) {
        return { status: "wrongkind", event, relay: relay || "", kind, error: "" };
      }
      return { status: "found", event, relay: relay || "", kind, error: "" };
    } catch (err) {
      return {
        status: "notfound",
        event: null,
        relay: "",
        kind: 0,
        error: err?.message || "Resolution failed"
      };
    }
  }

  async function resolveRepostTarget() {
    setRepostSchedulingStep("");
    const targetId = await normalizeNoteIdInput(repostTarget);
    if (!targetId) {
      setRepostResolveState({ status: "invalid", event: null, relay: "", kind: 0, error: "Invalid note id" });
      return;
    }

    setRepostResolveState({ status: "resolving", event: null, relay: "", kind: 0, error: "" });
    const next = await resolveRepostTargetById(targetId);
    setRepostResolveState(next);
    if (next.status === "found" && next.relay) setRepostRelayHint(next.relay);
    if (next.status === "found") setRepostShowAnyway(false);
  }

  async function scheduleRepost({ allowUnresolved = false } = {}) {
    if (!pubkey || !window.nostr?.signEvent || !window.nostr?.nip44?.encrypt) {
      showToast("Connect a Nostr signer first");
      return { ok: false, reason: "no_signer" };
    }
    const isDemo = (() => {
      try {
        return Boolean(isDemoMailboxEnabled?.());
      } catch {
        return false;
      }
    })();
    const dvm = getDvmConfig();
    if (!isDemo && (!dvm.pubkey || dvm.relays.length === 0)) {
      showToast("Configure DVM pubkey/relays (VITE_DVM_PUBKEY/VITE_DVM_RELAYS)");
      return { ok: false, reason: "no_dvm" };
    }

    const when = new Date(repostScheduleAt);
    if (Number.isNaN(when.getTime())) {
      showToast("Pick a valid time");
      return { ok: false, reason: "bad_time" };
    }
    const scheduledAtSec = Math.floor(when.getTime() / 1000);

    const gate = isDemo ? { ok: true, cap: null } : await getSupportGateCap({ scheduledAtSec, feature: repostMode === "quote" ? "quote" : "repost", intent: `schedule_${repostMode}` });
    if (!gate.ok) return { ok: false, reason: "support_gate" };
    const cap = gate.cap;

    const targetId = await normalizeNoteIdInput(repostTarget);
    if (!targetId) {
      showToast("Invalid target note id");
      return { ok: false, reason: "bad_target" };
    }

    const relayHint = normalizeWsRelayUrl(repostRelayHint);
    const pickedRelayHint =
      relayHint ||
      (isDemo
        ? "wss://demo.relay"
        : normalizeWsRelayUrl(String(dvm?.relays?.[0] || activeRelays?.[0] || "")));
    if (!pickedRelayHint) {
      showToast("No relay hint available (configure relays first)");
      return { ok: false, reason: "no_relay" };
    }

    let resolved = repostResolveState?.event;
    let strictOk = resolved && Number(repostResolveState?.kind) === 1;

    if (!isDemo && !strictOk && !allowUnresolved) {
      setRepostSchedulingStep("Checking note…");
      setRepostResolveState({ status: "resolving", event: null, relay: "", kind: 0, error: "" });
      const next = await resolveRepostTargetById(targetId);
      setRepostResolveState(next);
      if (next.status === "found" && next.relay) setRepostRelayHint(next.relay);

      if (next.status === "wrongkind") {
        showToast("That note can't be reposted/quoted (only text notes are supported)");
        setRepostSchedulingStep("");
        return { ok: false, reason: "wrong_kind" };
      }
      if (next.status === "found" && next.event && Number(next.kind) === 1) {
        resolved = next.event;
        strictOk = true;
      } else {
        setRepostSchedulingStep("");
        return { ok: false, reason: "unresolved" };
      }
    }

    if (isDemo && (!resolved || !strictOk)) {
      resolved = {
        id: targetId,
        kind: 1,
        pubkey: "0".repeat(64),
        created_at: Math.max(0, scheduledAtSec - 3600),
        tags: [],
        content: "Demo quoted note: placeholder content for local-only demo mode."
      };
      strictOk = true;
    }

    const targetPubkey = strictOk ? String(resolved?.pubkey || "").trim() : "";
    const actionLabel = repostMode === "quote" ? "quote" : "repost";

    let draft;
    if (repostMode === "quote") {
      let quoteRef = "";
      try {
        const { noteEncode } = await loadNip19();
        quoteRef = `nostr:${noteEncode(targetId)}`;
      } catch {}

      const baseText = String(repostQuoteText || "").trim();
      const content = quoteRef ? (baseText ? `${baseText}\n\n${quoteRef}` : quoteRef) : baseText;

      const base = buildDraftEvent({
        content: baseText,
        manualTags: "",
        uploadTags: [],
        addClientTag,
        nsfw
      });

      const tags = Array.isArray(base.tags) ? base.tags.slice() : [];
      const addTag = (t) => {
        const key = JSON.stringify(t);
        if (!tags.some((x) => JSON.stringify(x) === key)) tags.push(t);
      };
      if (targetPubkey) addTag(["p", targetPubkey]);
      addTag(targetPubkey ? ["q", targetId, pickedRelayHint, targetPubkey] : ["q", targetId, pickedRelayHint]);

      draft = {
        ...base,
        kind: 1,
        created_at: scheduledAtSec,
        pubkey,
        tags,
        content
      };
    } else {
      const tags = [["e", targetId, pickedRelayHint]];
      if (targetPubkey) tags.push(["p", targetPubkey]);

      let content = "";
      if (strictOk) {
        try {
          const json = JSON.stringify(resolved);
          // Embed target event JSON if reasonably small; otherwise keep repost content empty.
          if (json && json.length <= 8000) content = json;
        } catch {}
      }

      draft = {
        kind: 6,
        created_at: scheduledAtSec,
        pubkey,
        tags,
        content
      };
    }

    try {
      setRepostSchedulingStep(`Signing ${actionLabel}…`);
      const signed = await window.nostr.signEvent(draft);
      if (repostMode === "quote" && strictOk && resolved?.id) {
        try {
          writeNoteCache(String(resolved.id || ""), { content: resolved.content || "", tags: resolved.tags || [], created_at: resolved.created_at, pubkey: resolved.pubkey });
        } catch {}
      }
      if (isDemo) {
        const requestId = `demo-${signed.id}`;
        const snippet = strictOk ? String(resolved?.content || "").trim().replace(/\s+/g, " ").slice(0, 180) : "";
        const preview =
          repostMode === "quote"
            ? (String(repostQuoteText || "").trim() || `Quote ${shortHexId(targetId) || ""}`.trim())
            : (snippet
                ? `${snippet}${snippet.length === 180 ? "…" : ""}`
                : `Repost ${shortHexId(targetId) || ""} (demo)`.trim());

        const j = {
          id: requestId,
          requestId,
          noteId: signed.id,
          content: preview,
          tags: [["pidgeon", repostMode === "quote" ? "quote" : "repost", targetId]],
          quoteTargetId: repostMode === "quote" ? targetId : "",
          quoteTargetContent: repostMode === "quote" && strictOk ? String(resolved?.content || "") : "",
          scheduledAt: when.toISOString(),
          createdAt: new Date().toISOString(),
          status: "scheduled",
          relays: [],
          dvmRelays: [],
          noteEvent: signed,
          requestEvent: null,
          statusInfo: "",
          lastError: ""
        };
        setJobs((prev) => sortJobsByUpdated([j, ...(Array.isArray(prev) ? prev : [])]));
        playScheduleSuccessSound();
        showToast(repostMode === "quote" ? "Quote scheduled ✨" : "Repost scheduled ✨");
        setRepostSchedulingStep("");
        setRepostOpen(false);
        return { ok: true };
      }

      setRepostSchedulingStep("Unwrapping mailbox key…");
      await ensureMailboxSecrets(pubkey);
      setRepostSchedulingStep("Encrypting request…");
      const publishSelection = await resolvePublishRelaysForRequest();
      if (publishSelection.warning && publishSelection.mode !== "recommended") {
        showToast(publishSelection.warning);
      }
      const scheduleRequest = await buildScheduleRequest({
        signedNote: signed,
        relayHints: publishSelection.relayHints,
        dvmPubkey: dvm.pubkey,
        cap
      });
      const requestId = scheduleRequest.requestId || scheduleRequest.id;
      setRepostSchedulingStep("Publishing request…");
      await publishScheduleRequest({ requestEvent: scheduleRequest, dvmRelays: dvm.relays });

      const snippet = strictOk ? String(resolved?.content || "").trim().replace(/\s+/g, " ").slice(0, 180) : "";
      const preview =
        repostMode === "quote"
          ? (String(repostQuoteText || "").trim() || `Quote ${shortHexId(targetId) || ""}`.trim())
          : (snippet
              ? `${snippet}${snippet.length === 180 ? "…" : ""}`
              : `Repost ${shortHexId(targetId) || ""}${strictOk ? "" : " (unresolved)"}`.trim());

      const j = {
        id: requestId,
        requestId,
        noteId: signed.id,
        content: preview,
        tags: [["pidgeon", repostMode === "quote" ? "quote" : "repost", targetId]],
        quoteTargetId: repostMode === "quote" ? targetId : "",
        quoteTargetContent: repostMode === "quote" && strictOk ? String(resolved?.content || "") : "",
        scheduledAt: when.toISOString(),
        createdAt: new Date().toISOString(),
        status: "scheduled",
        relays: publishSelection.uiRelays,
        dvmRelays: dvm.relays,
        noteEvent: signed,
        requestEvent: scheduleRequest,
        statusInfo: "",
        lastError: ""
      };
      setJobs((prev) => sortJobsByUpdated([j, ...prev]));
      playScheduleSuccessSound();
      showToast(repostMode === "quote" ? "Quote scheduled via DVM ✨" : "Repost scheduled via DVM ✨");
      setRepostSchedulingStep("");
      setRepostOpen(false);
      return { ok: true };
    } catch (err) {
      console.error("[scheduleRepost] Schedule error", err);
      showToast(err?.message || (repostMode === "quote" ? "Failed to schedule quote" : "Failed to schedule repost"));
      setRepostSchedulingStep("");
      return { ok: false, reason: "error" };
    }
  }

  async function scheduleDm() {
    if (!dmTo.trim()) return showToast("Add a recipient npub");
    if (!dmMessage.trim()) return showToast("Write a message first");
    if (!pubkey || !window.nostr?.signEvent || !window.nostr?.nip44?.encrypt) {
      return showToast("Connect a Nostr signer first");
    }
    const isDemo = (() => {
      try {
        return Boolean(isDemoMailboxEnabled?.());
      } catch {
        return false;
      }
    })();
    const dvm = getDvmConfig();
    if (!isDemo && (!dvm.pubkey || dvm.relays.length === 0)) {
      return showToast("Configure DVM pubkey/relays (VITE_DVM_PUBKEY/VITE_DVM_RELAYS)");
    }

    const when = new Date(dmScheduleAt);
    if (Number.isNaN(when.getTime())) return showToast("Pick a valid time");
    const scheduledAtSec = Math.floor(when.getTime() / 1000);
    const gate = isDemo ? { ok: true, cap: null } : await getSupportGateCap({ scheduledAtSec, feature: "dm17", intent: "schedule_dm" });
    if (!gate.ok) return;
    const cap = gate.cap;

    try {
      if (isDemo) {
        const requestId = `demo-dm-${scheduledAtSec}-${Math.random().toString(16).slice(2)}`;
        const j = {
          jobType: "dm17",
          id: requestId,
          requestId,
          noteId: "",
          content: dmMessage,
          tags: [],
          scheduledAt: when.toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "scheduled",
          relays: [],
          dvmRelays: [],
          statusInfo: "",
          lastError: "",
          recipients: [{ pubkey: dmTo.trim() }]
        };
        setJobs((prev) => sortJobsByUpdated([j, ...(Array.isArray(prev) ? prev : [])]));
        setDmSchedulingStep(`Scheduled for ${formatDateTime(when)}`);
        playScheduleSuccessSound();
        showToast("DM scheduled ✨");
        setTimeout(() => setDmSchedulingStep(""), 1200);
        return;
      }
      setDmSchedulingStep("Unwrapping mailbox key…");
      await ensureMailboxSecrets(pubkey);
      setDmSchedulingStep("Building DM request…");
      const requestEvent = await buildDm17ScheduleRequest({
        fromPubkey: pubkey,
        toPubkeys: dmTo.trim(),
        content: dmMessage,
        scheduledAt: scheduledAtSec,
        dvmPubkey: dvm.pubkey,
        cap
      });
      setDmPreviewKeyVersion((v) => v + 1);
      const requestId = requestEvent.requestId || requestEvent.id;
      setDmSchedulingStep("Publishing request…");
      await publishScheduleRequest({ requestEvent, dvmRelays: dvm.relays });

      const j = {
        jobType: "dm17",
        id: requestId,
        requestId,
        noteId: "",
        content: dmMessage,
        tags: [],
        scheduledAt: when.toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "scheduled",
        relays: [],
        dvmRelays: dvm.relays,
        statusInfo: "",
        lastError: "",
        recipients: [{ pubkey: dmTo.trim() }]
      };
      setJobs((prev) => sortJobsByUpdated([j, ...prev]));
      setDmSchedulingStep(`Scheduled for ${formatDateTime(when)}`);
      playScheduleSuccessSound();
      showToast("DM scheduled via DVM ✨");
      setTimeout(() => setDmSchedulingStep(""), 2000);
    } catch (err) {
      console.error("[scheduleDm] error", err);
      showToast(err?.message || "Failed to schedule DM");
      setDmSchedulingStep("");
    }
  }

  async function retryDmJob(job) {
    const isDemo = (() => {
      try {
        return Boolean(isDemoMailboxEnabled?.());
      } catch {
        return false;
      }
    })();
    if (isDemo) {
      showToast("Retry queued");
      return;
    }
    if (!pubkey || !window.nostr?.signEvent || !window.nostr?.nip44?.encrypt) {
      return showToast("Connect a Nostr signer first");
    }
    const dvm = getDvmConfig();
    if (!dvm.pubkey || dvm.relays.length === 0) {
      return showToast("Configure DVM pubkey/relays (VITE_DVM_PUBKEY/VITE_DVM_RELAYS)");
    }
    const jobId = job?.requestId || job?.id || "";
    if (!jobId) return showToast("Missing job id");
    try {
      const requestEvent = await buildDm17RetryRequest({ fromPubkey: pubkey, jobId, dvmPubkey: dvm.pubkey });
      await publishScheduleRequest({ requestEvent, dvmRelays: dvm.relays });
      showToast("Retry requested");
      mailboxRetryRef.current?.();
    } catch (err) {
      console.error("[retryDmJob] error", err);
      showToast(err?.message || "Retry failed");
    }
  }

  function cancelJob(job) {
    const removeJob = () =>
      setJobs((prev) =>
        sortJobsByUpdated(prev.filter((j) => j.id !== job.id && j.requestId !== job.requestId))
      );
    const isDemo = (() => {
      try {
        return Boolean(isDemoMailboxEnabled?.());
      } catch {
        return false;
      }
    })();
    if (isDemo || String(job?.requestId || "").startsWith("demo-") || String(job?.id || "").startsWith("demo-")) {
      removeJob();
      return showToast("Canceled");
    }
    if (!job?.requestId) {
      removeJob();
      return showToast("Canceled locally (no request id)");
    }
    const dvm = getDvmConfig();
    if (!dvm.pubkey || !dvm.relays.length) return showToast("Configure DVM env vars first");
    if (!window.nostr?.signEvent) return showToast("Connect a signer to cancel");
    cancelScheduleRequest({ requestId: job.requestId, dvmRelays: dvm.relays, dvmPubkey: dvm.pubkey })
      .then(() => {
        removeJob();
        showToast("Canceled via DVM");
      })
      .catch((err) => {
        console.error("Cancel error", err);
        showToast(err?.message || "Cancel failed");
      });
  }

  function pauseResumeJob(job) {
    setJobs((prev) =>
      sortJobsByUpdated(
        prev.map((j) =>
          j.id === job.id ? { ...j, status: j.status === "paused" ? "scheduled" : "paused" } : j
        )
      )
    );
  }

  async function doRescheduleDm(job, newIso) {
    const when = new Date(newIso);
    if (Number.isNaN(when.getTime())) return showToast("Invalid time");
    const scheduledAtSec = Math.floor(when.getTime() / 1000);
    const isDemo = (() => {
      try {
        return Boolean(isDemoMailboxEnabled?.());
      } catch {
        return false;
      }
    })();
    if (isDemo) {
      setJobs((prev) =>
        sortJobsByUpdated(
          prev.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  scheduledAt: when.toISOString(),
                  updatedAt: new Date().toISOString(),
                  status: "scheduled",
                  statusInfo: "",
                  lastError: ""
                }
              : j
          )
        )
      );
      playScheduleSuccessSound();
      showToast("DM rescheduled");
      return;
    }
    if (!window.nostr?.signEvent || !window.nostr?.nip44?.encrypt) return showToast("Connect a signer to reschedule");
    const dvm = getDvmConfig();
    if (!dvm.pubkey || !dvm.relays.length) return showToast("Configure DVM env vars first");

    const toPubkeys = Array.isArray(job?.recipients)
      ? job.recipients.map((r) => r?.pubkey).filter(Boolean)
      : job?.to
      ? [job.to]
      : [];
    if (!toPubkeys.length) return showToast("Missing DM recipient");

    const gate = await getSupportGateCap({ scheduledAtSec, feature: "dm17", intent: "reschedule_dm" });
    if (!gate.ok) return;
    const cap = gate.cap;

    let message = String(job?.content || "");
    try {
      const dmEnc = job?.dm?.dmEnc;
      if (dmEnc) {
        const pkvIdHint = job?.dm?.pkv_id || "";
        const { pkvBytes } = await ensurePreviewKey(pubkey, { pkvIdHint });
        setDmPreviewKeyVersion((v) => v + 1);
        const plain = nip44DecryptWithKey(pkvBytes, String(dmEnc || ""));
        const decoded = JSON.parse(plain || "{}");
        if (decoded?.content) message = String(decoded.content || "");
      }
    } catch {
      // keep fallback
    }
    if (!message.trim()) return showToast("Could not decrypt this DM on this device");

    try {
      if (job?.requestId) {
        await cancelScheduleRequest({ requestId: job.requestId, dvmRelays: dvm.relays, dvmPubkey: dvm.pubkey });
      }
      const requestEvent = await buildDm17ScheduleRequest({
        fromPubkey: pubkey,
        toPubkeys,
        content: message,
        scheduledAt: scheduledAtSec,
        dvmPubkey: dvm.pubkey,
        cap
      });
      await publishScheduleRequest({ requestEvent, dvmRelays: dvm.relays });
      const requestId = requestEvent.requestId || requestEvent.id;

      setJobs((prev) =>
        sortJobsByUpdated(
          prev.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  id: requestId,
                  requestId,
                  scheduledAt: when.toISOString(),
                  updatedAt: new Date().toISOString(),
                  status: "scheduled",
                  statusInfo: "",
                  lastError: ""
                }
              : j
          )
        )
      );
      playScheduleSuccessSound();
      showToast("DM rescheduled via DVM");
    } catch (err) {
      console.error("DM reschedule error", err);
      showToast(err?.message || "DM reschedule failed");
    }
  }

  async function doReschedule(job, newIso) {
    if (job?.jobType === "dm17") {
      return doRescheduleDm(job, newIso);
    }
    const when = new Date(newIso);
    if (Number.isNaN(when.getTime())) return showToast("Invalid time");
    const scheduledAtSec = Math.floor(when.getTime() / 1000);
    const isDemo = (() => {
      try {
        return Boolean(isDemoMailboxEnabled?.());
      } catch {
        return false;
      }
    })();
    if (isDemo) {
      setJobs((prev) =>
        sortJobsByUpdated(
          prev.map((j) =>
            j.id === job.id
              ? {
                  ...j,
                  scheduledAt: when.toISOString(),
                  updatedAt: new Date().toISOString(),
                  status: "scheduled",
                  statusInfo: "",
                  lastError: ""
                }
              : j
          )
        )
      );
      playScheduleSuccessSound();
      showToast("Rescheduled");
      return;
    }
    if (!window.nostr?.signEvent) return showToast("Connect a signer to reschedule");
    const dvm = getDvmConfig();
    if (!dvm.pubkey || !dvm.relays.length) return showToast("Configure DVM env vars first");

    const feature = isRepostJob(job) ? "repost" : isQuoteJob(job) ? "quote" : "note";
    const gate = await getSupportGateCap({ scheduledAtSec, feature, intent: "reschedule" });
    if (!gate.ok) return;
    const cap = gate.cap;

    try {
      if (job?.requestId) {
        await cancelScheduleRequest({ requestId: job.requestId, dvmRelays: dvm.relays, dvmPubkey: dvm.pubkey });
      }
      const baseEvent = job.noteEvent
        ? { ...job.noteEvent, id: undefined, sig: undefined }
        : buildDraftEvent({
            content: job.content,
            manualTags: job.tags,
            uploadTags: [],
            addClientTag: true,
            nsfw: false,
          });
      baseEvent.created_at = scheduledAtSec;
      baseEvent.pubkey = pubkey;
      const signedNote = await window.nostr.signEvent(baseEvent);
      const publishSelection = await resolvePublishRelaysForRequest();
      const relayHints =
        Array.isArray(job?.relays) && job.relays.length ? job.relays : publishSelection.relayHints;
      const scheduleRequest = await buildScheduleRequest({
        signedNote,
        relayHints,
        dvmPubkey: dvm.pubkey,
        cap
      });
      await publishScheduleRequest({ requestEvent: scheduleRequest, dvmRelays: dvm.relays });
      const requestId = scheduleRequest.requestId || scheduleRequest.id;

      setJobs((prev) =>
        sortJobsByUpdated(
          prev.map((j) =>
                j.id === job.id
                  ? {
                      ...j,
                      id: requestId,
                      requestId,
                      noteId: signedNote.id,
                      scheduledAt: when.toISOString(),
                      status: "scheduled",
                      relays: Array.isArray(job?.relays) && job.relays.length ? job.relays : publishSelection.uiRelays,
                      noteEvent: signedNote,
                      requestEvent: scheduleRequest,
                      statusInfo: "",
                      lastError: ""
                    }
                  : j
          )
        )
      );
      playScheduleSuccessSound();
      showToast("Rescheduled via DVM");
    } catch (err) {
      console.error("Reschedule error", err);
      showToast(err?.message || "Reschedule failed");
    }
  }

  async function scheduleCalendarEvent(payload = {}) {
    const when = new Date(payload.start || payload.end || "");
    if (Number.isNaN(when.getTime())) return showToast("Pick a valid time");
    const scheduledAtSec = Math.floor(when.getTime() / 1000);
    if (!pubkey || !window.nostr?.signEvent || !window.nostr?.nip44?.encrypt) {
      return showToast("Connect a Nostr signer first");
    }
    const isDemo = (() => {
      try {
        return Boolean(isDemoMailboxEnabled?.());
      } catch {
        return false;
      }
    })();
    const dvm = getDvmConfig();
    if (!isDemo && (!dvm.pubkey || dvm.relays.length === 0)) {
      return showToast("Configure DVM pubkey/relays (VITE_DVM_PUBKEY/VITE_DVM_RELAYS)");
    }

    const gate = isDemo ? { ok: true, cap: null } : await getSupportGateCap({ scheduledAtSec, feature: "note", intent: "schedule_calendar" });
    if (!gate.ok) return;
    const cap = gate.cap;

    // Avoid duplication: if title is just a shortened version of caption, only use caption
    let content;
    if (payload.title && payload.caption) {
      const trimmedTitle = payload.title.trim();
      const trimmedCaption = payload.caption.trim();

      // More robust duplication detection
      if (trimmedTitle === trimmedCaption) {
        content = trimmedTitle;
      } else if (trimmedCaption.startsWith(trimmedTitle) && trimmedTitle.length < trimmedCaption.length) {
        content = trimmedCaption;
      } else if (trimmedTitle.startsWith(trimmedCaption) && trimmedCaption.length < trimmedTitle.length) {
        content = trimmedTitle;
      } else {
        // Use both if they're different
        content = [trimmedTitle, trimmedCaption].filter(Boolean).join("\n\n");
      }
    } else {
      // Fallback to original logic
      const contentParts = [payload.title, payload.caption].filter(Boolean);
      content = contentParts.join("\n\n");
    }
    const manualTags = Array.isArray(payload.tags) ? payload.tags.join(",") : "";
    const calAddClientTag = typeof payload.addClientTag === "boolean" ? payload.addClientTag : addClientTag;
    const calNsfw = typeof payload.nsfw === "boolean" ? payload.nsfw : nsfw;

    try {
      setSchedulingStep("Signing note…");
      const draftEvent = buildDraftEvent({
        content,
        manualTags,
        uploadTags: [],
        addClientTag: calAddClientTag,
        nsfw: calNsfw,
      });
      draftEvent.created_at = scheduledAtSec;
      draftEvent.pubkey = pubkey;

      const signedNote = await window.nostr.signEvent(draftEvent);
      if (isDemo) {
        const requestId = `demo-${signedNote.id}`;
        const j = {
          id: requestId,
          requestId,
          noteId: signedNote.id,
          content,
          tags: manualTags,
          scheduledAt: when.toISOString(),
          createdAt: new Date().toISOString(),
          status: "scheduled",
          relays: [],
          dvmRelays: [],
          noteEvent: signedNote,
          requestEvent: null,
          statusInfo: "",
          lastError: ""
        };
        setJobs((prev) => sortJobsByUpdated([j, ...(Array.isArray(prev) ? prev : [])]));
        setSchedulingStep(`Scheduled for ${formatDateTime(when)}`);
        playScheduleSuccessSound();
        showToast("Scheduled ✨");
        setTimeout(() => setSchedulingStep(""), 1200);
        return;
      }
      setSchedulingStep("Unwrapping mailbox key…");
      await ensureMailboxSecrets(pubkey);
      setSchedulingStep("Encrypting request…");
      const publishSelection = await resolvePublishRelaysForRequest();
      if (publishSelection.warning && publishSelection.mode !== "recommended") {
        showToast(publishSelection.warning);
      }
      const scheduleRequest = await buildScheduleRequest({
        signedNote,
        relayHints: publishSelection.relayHints,
        dvmPubkey: dvm.pubkey,
        cap
      });
      const requestId = scheduleRequest.requestId || scheduleRequest.id;
      try {
        console.debug("[schedule] built request", {
          noteId: signedNote.id,
          requestId,
          dvm: dvm.pubkey,
          relays: dvm.relays.length
        });
      } catch {}
      setSchedulingStep("Publishing request…");
      await publishScheduleRequest({ requestEvent: scheduleRequest, dvmRelays: dvm.relays });
      try {
        console.debug("[schedule] published request", { requestId });
      } catch {}

      const j = {
        id: requestId,
        requestId,
        noteId: signedNote.id,
        content,
        tags: manualTags,
        scheduledAt: when.toISOString(),
        createdAt: new Date().toISOString(),
        status: "scheduled",
        relays: publishSelection.uiRelays,
        dvmRelays: dvm.relays,
        noteEvent: signedNote,
        requestEvent: scheduleRequest,
        statusInfo: "",
        lastError: ""
      };
      setJobs((prev) => sortJobsByUpdated([j, ...prev]));
      setSchedulingStep(`Scheduled for ${formatDateTime(when)}`);
      playScheduleSuccessSound();
      showToast("Scheduled via DVM ✨");
      setTimeout(() => setSchedulingStep(""), 2000);
    } catch (err) {
      console.error("[scheduleCalendarEvent] Schedule error", err);
      showToast(err?.message || "Failed to schedule");
      try {
        console.debug("[scheduleCalendarEvent] context", {
          pubkey,
          dvmRelays: dvm.relays,
          dvmPubkey: dvm.pubkey,
          hasSigner: Boolean(window.nostr?.signEvent),
          hasNip44: Boolean(window.nostr?.nip44?.encrypt)
        });
      } catch {}
      setSchedulingStep("");
    }
  }

  const calendarEvents = useMemo(
    () => jobsToCalendarEvents(noteJobs, defaultBlockMinutes),
    [noteJobs, defaultBlockMinutes]
  );

  async function handleCalendarUpdate(id, patch) {
    const job = noteJobs.find((j) => j.id === id);
    if (!job) return;
    if (patch?.start) {
      await doReschedule(job, patch.start);
    }
  }

  function handleCalendarDelete(evt) {
    const job = noteJobs.find((j) => j.id === evt.id);
    if (!job) return;
    cancelJob(job);
  }

  async function openJobPreview(job) {
    if (!job) return;
    const evt = jobToCalendarEvent(job, defaultBlockMinutes);
    if (isQuoteJob(job)) {
      const info = getQuoteTargetInfo(job);
      const cached = info?.id ? readNoteCache(info.id) : null;
      const content = String(job?.quoteTargetContent || cached?.content || "");
      if (info?.id && content) {
        evt.quoteTargetId = info.id;
        evt.quoteTargetContent = content;
      }
    }
    setJobPreview(evt);
    if (job.noteBlob) {
      try {
        const full = await fetchNoteBlob(pubkey, job.noteBlob);
        if (full?.content) {
          setJobPreview((prev) =>
            prev && prev.id === evt.id
              ? {
                  ...prev,
                  caption: full.content,
                  title: full.content.slice(0, 80)
                }
              : prev
          );
        }
      } catch (err) {
        console.debug("[mailbox] blob fetch failed", err?.message || err);
      }
    }
  }

  function cancelMailboxJobsBatch() {
    const h = mailboxJobsBatchRef.current?.handle;
    if (!h) return;
    try {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
      else clearTimeout(h);
    } catch {}
    mailboxJobsBatchRef.current.handle = 0;
    mailboxJobsBatchRef.current.latest = null;
    mailboxJobsBatchRef.current.latestFp = "";
  }

  function flushMailboxJobsBatch() {
    const latest = mailboxJobsBatchRef.current.latest;
    const latestFp = mailboxJobsBatchRef.current.latestFp;
    mailboxJobsBatchRef.current.handle = 0;
    mailboxJobsBatchRef.current.latest = null;
    mailboxJobsBatchRef.current.latestFp = "";
    if (!latest) return;
    if (latestFp && latestFp === mailboxJobsBatchRef.current.appliedFp) return;
    startTransition(() => {
      setJobs((prev) => {
        const next = sortJobsByUpdated(mergeMailboxJobs(prev, latest));
        return areJobsListEquivalent(prev, next) ? prev : next;
      });
    });
    mailboxJobsBatchRef.current.appliedFp = latestFp || mailboxJobsBatchRef.current.appliedFp;
  }

  function scheduleMailboxJobsBatch(list) {
    mailboxJobsBatchRef.current.latest = list;
    const fp = fingerprintMailboxJobs(list);
    mailboxJobsBatchRef.current.latestFp = fp;
    if (fp && fp === mailboxJobsBatchRef.current.appliedFp) return;
    if (mailboxJobsBatchRef.current.handle) return;
    try {
      mailboxJobsBatchRef.current.handle = setTimeout(flushMailboxJobsBatch, 80);
    } catch {
      flushMailboxJobsBatch();
    }
  }

  function cancelNoteHydrateBatch() {
    const h = noteHydrateBatchRef.current?.handle;
    if (!h) return;
    try {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
      else clearTimeout(h);
    } catch {}
    noteHydrateBatchRef.current.handle = 0;
    noteHydrateBatchRef.current.events = new Map();
  }

  function flushNoteHydrateBatch() {
    const batch = noteHydrateBatchRef.current.events;
    noteHydrateBatchRef.current.handle = 0;
    noteHydrateBatchRef.current.events = new Map();
    if (!batch || batch.size === 0) return;

    startTransition(() => {
      setJobs((prev) => {
        let changed = false;
        const next = prev.map((job) => {
          const mainEv = batch.get(job?.noteId);
          let out = job;
          let outChanged = false;

          if (mainEv) {
            changed = true;
            outChanged = true;
            const kind = Number(mainEv.kind) || 0;
            let nextContent = mainEv.content || job.content;
            if (kind === 6) {
              const tags = Array.isArray(mainEv.tags) ? mainEv.tags : [];
              const eTag = tags.find((t) => Array.isArray(t) && t[0] === "e");
              const targetId = String(eTag?.[1] || "").trim();
              let snippet = "";
              try {
                const embedded = JSON.parse(String(mainEv.content || ""));
                if (embedded && typeof embedded === "object") {
                  snippet = String(embedded.content || "").trim();
                }
              } catch {}
              if (!snippet && targetId) {
                const cached = readNoteCache(targetId);
                if (cached?.content) snippet = String(cached.content || "").trim();
              }
              if (snippet) {
                const compact = snippet.replace(/\s+/g, " ");
                nextContent = compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
              } else {
                nextContent = `Repost ${shortHexId(targetId) || ""}`.trim();
              }
            }

            const createdIso = toIso(mainEv.created_at);
            out = {
              ...job,
              status: "posted",
              updatedAt: createdIso,
              scheduledAt: job.scheduledAt || createdIso,
              createdAt: job.createdAt || createdIso,
              content: nextContent,
              tags: mainEv.tags || job.tags,
              noteEvent: mainEv
            };
          }

          // Quote hydration: attach quoted note content when we receive the target kind:1 event.
          const quoteInfo = getQuoteTargetInfo(out);
          const quoteEv = quoteInfo?.id ? batch.get(quoteInfo.id) : null;
          if (quoteEv && Number(quoteEv.kind) === 1) {
            changed = true;
            outChanged = true;
            out = {
              ...out,
              quoteTargetId: quoteInfo.id,
              quoteTargetContent: String(quoteEv.content || "")
            };
          }

          return outChanged ? out : job;
        });
        return changed ? sortJobsByUpdated(next) : prev;
      });
    });
  }

  function scheduleNoteHydrateBatch(ev) {
    if (!ev?.id) return;
    noteHydrateBatchRef.current.events.set(ev.id, ev);
    if (noteHydrateBatchRef.current.handle) return;
    try {
      if (typeof requestAnimationFrame === "function") {
        noteHydrateBatchRef.current.handle = requestAnimationFrame(flushNoteHydrateBatch);
      } else {
        noteHydrateBatchRef.current.handle = setTimeout(flushNoteHydrateBatch, 16);
      }
    } catch {
      flushNoteHydrateBatch();
    }
  }

  // Mailbox-based job truth (kind 30078)
  useEffect(() => {
    if (!pubkey) return;
    let sub;
    (async () => {
      try {
        sub = await subscribeMailbox(pubkey, {
          onJobs: (list = []) => {
            scheduleMailboxJobsBatch(list);
            setMailboxReady(true);
            const queueHasMore = Boolean(sub?.hasMorePending?.());
            const postedHasMore = Boolean(sub?.hasMoreHistory?.());
            setQueueMore((s) => (s.hasMore === queueHasMore ? s : { ...s, hasMore: queueHasMore }));
            setPostedMore((s) => (s.hasMore === postedHasMore ? s : { ...s, hasMore: postedHasMore }));
          },
          onSync: ({ status, rev, missing } = {}) => {
            const next = {
              status: status || "idle",
              rev: Number(rev) || 0,
              missing: Number(missing) || 0
            };
            setMailboxSync(next);
            mailboxRetryRef.current = typeof sub?.retryNow === "function" ? sub.retryNow : null;
            if (next.status === "up_to_date") {
              // Hide shortly after reaching a stable rev to keep the UI clean.
              setTimeout(() => setMailboxSync((prev) => (prev.rev === next.rev ? { status: "idle", rev: next.rev, missing: 0 } : prev)), 1500);
            }
          },
          onCounts: (counts) => {
            setMailboxCounts(counts || null);
            setMailboxReady(true);
          },
          onSupport: (support) => {
            setMailboxSupport(support || null);
            setMailboxReady(true);
          }
        });
        mailboxSubRef.current = sub;
        mailboxRetryRef.current = typeof sub?.retryNow === "function" ? sub.retryNow : null;
        const queueHasMore = Boolean(sub?.hasMorePending?.());
        const postedHasMore = Boolean(sub?.hasMoreHistory?.());
        setQueueMore((s) => (s.hasMore === queueHasMore ? s : { ...s, hasMore: queueHasMore }));
        setPostedMore((s) => (s.hasMore === postedHasMore ? s : { ...s, hasMore: postedHasMore }));
      } catch (err) {
        console.warn("[mailbox] subscribe failed", err?.message || err);
        setMailboxReady(true);
      }
    })();
    return () => {
      mailboxRetryRef.current = null;
      mailboxSubRef.current = null;
      cancelMailboxJobsBatch();
      setMailboxReady(false);
      setQueueMore({ loading: false, hasMore: false });
      setPostedMore({ loading: false, hasMore: false });
      sub?.close?.();
    };
  }, [pubkey]);

  useEffect(() => {
    if (!pubkey) return;
    const prompt = mailboxSupport?.prompt;
    const promptId = String(prompt?.id || "").trim();
    if (!promptId) return;
    if (supportDismissedRef.current.has(promptId)) return;
    if (supportDialogResolveRef.current || supportDialog.open) return;
    openSupportDialog(prompt, { source: "mailbox" }).catch(() => {});
  }, [pubkey, mailboxSupport?.prompt?.id, supportDialog.open, openSupportDialog]);

  async function loadOlderPosted() {
    const sub = mailboxSubRef.current;
    if (!sub?.loadMoreHistory || postedMore.loading) return;
    setPostedMore((s) => ({ ...s, loading: true }));
    try {
      await sub.loadMoreHistory({ pages: 1 });
    } catch (err) {
      console.debug("[mailbox] loadMoreHistory failed", err?.message || err);
    } finally {
      setPostedMore((s) => ({ ...s, loading: false, hasMore: Boolean(sub?.hasMoreHistory?.()) }));
    }
  }

  async function loadFurtherQueue() {
    const sub = mailboxSubRef.current;
    if (!sub?.loadMorePending || queueMore.loading) return;
    setQueueMore((s) => ({ ...s, loading: true }));
    try {
      await sub.loadMorePending({ pages: 1 });
    } catch (err) {
      console.debug("[mailbox] loadMorePending failed", err?.message || err);
    } finally {
      setQueueMore((s) => ({ ...s, loading: false, hasMore: Boolean(sub?.hasMorePending?.()) }));
    }
  }

  async function ensureQueueCoversRange(range) {
    const sub = mailboxSubRef.current;
    if (!sub?.hasMorePending || !sub?.loadMorePending) return;
    if (queueMore.loading) return;
    if (!range?.end) return;
    const endMs = new Date(range.end).getTime();
    if (!Number.isFinite(endMs)) return;

    // Keep loading pending pages until the newest loaded scheduled job reaches the visible range end (or we run out).
    let maxScheduledMs = 0;
    const calcMaxScheduled = () => {
      const scheduled = jobsRef.current
        .filter((j) => j.status === "scheduled" || j.status === "queued" || j.status === "paused")
        .map((j) => new Date(j.scheduledAt).getTime())
        .filter((t) => Number.isFinite(t));
      return scheduled.length ? Math.max(...scheduled) : 0;
    };
    maxScheduledMs = calcMaxScheduled();
    let loops = 0;
    while (
      sub.hasMorePending() &&
      ((maxScheduledMs && maxScheduledMs < endMs) || (!maxScheduledMs && loops === 0)) &&
      loops < 6
    ) {
      loops += 1;
      // eslint-disable-next-line no-await-in-loop
      await loadFurtherQueue();
      maxScheduledMs = calcMaxScheduled();
      if (!maxScheduledMs) break;
    }
  }

  // Nostr-based posted notes (kind 1) + reposts (kind 6) for hydrateable jobs
  useEffect(() => {
    if (!noteWatch.noteIds.length || !noteWatch.relays.length) return;

    const sub = subscribeEvents(noteWatch.relays, [{ kinds: [1, 6], ids: noteWatch.noteIds }], {
      onEvent: (ev) => {
        writeNoteCache(ev.id, { content: ev.content || "", tags: ev.tags || [], created_at: ev.created_at, pubkey: ev.pubkey });
        scheduleNoteHydrateBatch(ev);

        // If it's a repost and we couldn't derive a preview, try to hydrate the target kind:1 note once.
        if ((Number(ev.kind) || 0) === 6) {
          const tags = Array.isArray(ev.tags) ? ev.tags : [];
          const eTag = tags.find((t) => Array.isArray(t) && t[0] === "e");
          const targetId = String(eTag?.[1] || "").trim();
          const hintRelay = normalizeWsRelayUrl(String(eTag?.[2] || "").trim());
          if (!targetId) return;
          if (readNoteCache(targetId)?.content) return;
          const inflight = repostHydrateRef.current;
          if (!inflight || inflight.has(targetId)) return;
          inflight.add(targetId);

          (async () => {
            const relaysToTry = resolveRelays([hintRelay, ...noteWatch.relays, ...(activeRelaysRef.current || [])]);
            const { event: target } = await fetchEventOnceWithRelay(
              relaysToTry,
              { ids: [targetId], kinds: [1], limit: 1 },
              { timeoutMs: 1500 }
            );
            if (target?.id) {
              writeNoteCache(target.id, { content: target.content || "", tags: target.tags || [], created_at: target.created_at, pubkey: target.pubkey });
	              const snippet = String(target.content || "").trim().replace(/\s+/g, " ");
	              const clipped = snippet.length > 180 ? `${snippet.slice(0, 180)}…` : snippet;
	              if (clipped) {
	                startTransition(() => {
	                  setJobs((prev) =>
	                    sortJobsByUpdated(
	                      prev.map((j) => (j?.noteId === ev.id ? { ...j, content: clipped } : j))
	                    )
	                  );
	                });
	              }
	            }
          })()
            .catch(() => {})
            .finally(() => {
              inflight.delete(targetId);
            });
        }
      }
    });
    return () => {
      cancelNoteHydrateBatch();
      sub?.close?.();
    };
  }, [noteWatch.key]);

  const ANALYTICS_RANGE_DAYS = 7;
  const ANALYTICS_LATEST_POSTS = 20;
  const ANALYTICS_GLOBAL_POSTS = 200;

  const getPostedJobsSorted = () => {
    const list = Array.isArray(jobsRef.current) ? jobsRef.current : [];
    const posted = list.filter((j) => j && j.status === "posted" && j.noteId);
    posted.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt || b.scheduledAt || 0).getTime() -
        new Date(a.updatedAt || a.createdAt || a.scheduledAt || 0).getTime()
    );
    return posted;
  };

  const ensurePostedHistoryMin = async (minCount) => {
    const sub = mailboxSubRef.current;
    if (!sub?.hasMoreHistory?.() || !sub?.loadMoreHistory) return;
    let loops = 0;
    while (sub.hasMoreHistory() && getPostedJobsSorted().length < minCount && loops < 6) {
      loops += 1;
      // eslint-disable-next-line no-await-in-loop
      await sub.loadMoreHistory({ pages: 1 });
      // Let mailbox state land before re-checking.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  const computeAnalyticsRelays = (postedJobs) => {
    const dvm = getDvmConfig();
    const jobRelays = postedJobs.flatMap((j) => (Array.isArray(j.relays) ? j.relays : []));
    return resolveRelays([...(activeRelaysRef.current || []), ...(Array.isArray(dvm?.relays) ? dvm.relays : []), ...jobRelays]);
  };

  const computeAnalytics = useCallback(async () => {
    if (!analyticsEnabled || view !== "analytics" || !pubkey) return;
    setAnalyticsState((s) => ({ ...s, status: "loading", error: "" }));
    try {
      await ensurePostedHistoryMin(ANALYTICS_GLOBAL_POSTS);
      const postedJobs = getPostedJobsSorted();
      const globalNoteIds = [];
      const seen = new Set();
      for (const j of postedJobs) {
        const id = String(j.noteId || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        globalNoteIds.push(id);
        if (globalNoteIds.length >= ANALYTICS_GLOBAL_POSTS) break;
      }
      const latestNoteIds = globalNoteIds.slice(0, ANALYTICS_LATEST_POSTS);
      const relays = computeAnalyticsRelays(postedJobs);
      const nowSec = Math.floor(Date.now() / 1000);
      const sinceSec = nowSec - ANALYTICS_RANGE_DAYS * 24 * 3600;

      const { global, perNote, series } = await computePerformance({
        relays,
        noteIds: globalNoteIds,
        sinceSec,
        untilSec: nowSec,
        rangeDays: ANALYTICS_RANGE_DAYS
      });

      const jobByNoteId = new Map();
      for (const j of postedJobs) {
        if (j?.noteId && !jobByNoteId.has(j.noteId)) jobByNoteId.set(j.noteId, j);
      }
      const latest = latestNoteIds.map((noteId) => {
        const job = jobByNoteId.get(noteId) || {};
        const row = perNote.get(noteId) || {};
        return {
          noteId,
          content: job.content || "",
          createdAt: job.createdAt || "",
          updatedAt: job.updatedAt || "",
          likes: row.likes || 0,
          replies: row.replies || 0,
          quotes: row.quotes || 0,
          reposts: row.reposts || 0,
          zaps: row.zaps || 0,
          zapMsat: row.zapMsat || 0,
          bookmarks: row.bookmarks || 0,
          score: row.score || 0
        };
      });

      setAnalyticsState({
        status: "ready",
        error: "",
        global,
        series,
        latest,
        quickEstimate: null,
        updatedAt: Date.now()
      });
    } catch (err) {
      setAnalyticsState((s) => ({ ...s, status: "error", error: err?.message || String(err || "Analytics failed") }));
    }
  }, [analyticsEnabled, view, pubkey]);

  const runQuickEstimate = useCallback(async () => {
    if (!analyticsEnabled || view !== "analytics" || !pubkey) return;
    try {
      const postedJobs = getPostedJobsSorted();
      const relays = computeAnalyticsRelays(postedJobs);
      const relay = relays[0];
      if (!relay) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const sinceSec = nowSec - ANALYTICS_RANGE_DAYS * 24 * 3600;
      const globalNoteIds = (() => {
        const list = [];
        const seen = new Set();
        for (const j of postedJobs) {
          const id = String(j.noteId || "").trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          list.push(id);
          if (list.length >= ANALYTICS_GLOBAL_POSTS) break;
        }
        return list;
      })();
      const res = await quickEstimateFromRelay({ relay, noteIds: globalNoteIds, sinceSec, untilSec: nowSec, rangeDays: ANALYTICS_RANGE_DAYS });
      setAnalyticsState((s) => ({ ...s, quickEstimate: res }));
    } catch (err) {
      console.warn("[analytics] quick estimate failed", err?.message || err);
    }
  }, [analyticsEnabled, view, pubkey]);

  useEffect(() => {
    if (!analyticsEnabled) return;
    if (view !== "analytics") return;
    computeAnalytics();
    const id = setInterval(computeAnalytics, 60000);
    return () => clearInterval(id);
  }, [analyticsEnabled, view, computeAnalytics]);

  useEffect(() => {
    if (!analyticsEnabled && view === "analytics") {
      setView("settings");
    }
  }, [analyticsEnabled, view]);

  return (
    <div className="min-h-screen w-full bg-slate-950 text-white flex flex-col">
      {/* Toast */}
		      {toast ? (
		        <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center px-4">
			          <div
			            className={clsx(
		              "ps-toast flex w-full max-w-md items-center justify-center gap-4 rounded-3xl bg-gradient-to-br from-indigo-950/70 via-slate-800/95 to-slate-900/95 px-6 py-4 ring-1 ring-white/20 shadow-[0_1px_0_rgba(255,255,255,0.08),0_24px_80px_rgba(0,0,0,0.65)] backdrop-blur-sm transition-all duration-500 ease-out transform text-center",
		              toastVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8",
		              toastPop ? "scale-105 shadow-[0_12px_40px_rgba(99,102,241,0.35)] ring-2 ring-indigo-400/60" : "scale-100"
		            )}
		            role="status"
		            aria-live="polite"
		          >
	            <div className="ps-toast-dot h-2.5 w-2.5 rounded-full bg-indigo-300 shadow-[0_0_0_4px_rgba(99,102,241,0.18)]" />
	            <span className="text-base text-white/90">{toast}</span>
	          </div>
	        </div>
	      ) : null}

      <TopBar
        pubkey={pubkey}
        npubShort={npubState.npubShort}
        profile={nostrProfile}
        onLogin={handleConnectNIP07}
        onLogout={handleLogout}
        onMenuToggle={handleMenuToggle}
        userMenuOpen={userMenuOpen}
        setUserMenuOpen={setUserMenuOpen}
        view={view}
        setView={setView}
        analyticsEnabled={analyticsEnabled}
      />

      {/* Mobile Menu Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileMenuOpen(false)} />
          <div className="fixed left-0 top-0 bottom-0 w-[280px] bg-slate-900 shadow-2xl border-r border-white/10">
	            <div className="flex items-center justify-between border-b border-white/10 p-4">
	              <div className="flex items-center gap-2">
	                <img src="/pidgeon-icon.svg" alt="" className="h-8 w-8" draggable="false" />
	                <div className="font-display text-lg font-semibold">Menu</div>
	              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-xl p-2 text-white/70 transition hover:bg-white/5 hover:text-white"
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="grid gap-1 p-4">
              <NavItem icon={<PenSquare size={18} />} active={view === "compose"} label="Compose" onClick={() => { setView("compose"); setMobileMenuOpen(false); }} />
              <NavItem icon={<Clock size={18} />} active={view === "jobs"} label="Jobs" onClick={() => { setView("jobs"); setMobileMenuOpen(false); }} />
              <NavItem icon={<CalendarIcon size={18} />} active={view === "calendar"} label="Calendar" onClick={() => { setView("calendar"); setMobileMenuOpen(false); }} />
              <NavItem icon={<FileText size={18} />} active={view === "drafts"} label="Drafts" onClick={() => { setView("drafts"); setMobileMenuOpen(false); }} />
              <NavItem icon={<User size={18} />} active={view === "feed"} label="My Feed" onClick={() => { setView("feed"); setMobileMenuOpen(false); }} />
              <NavItem icon={<MessageSquare size={18} />} active={view === "dm"} label="DMs" onClick={() => { setView("dm"); setMobileMenuOpen(false); }} />
              {analyticsEnabled && (
                <NavItem icon={<BarChart2 size={18} />} active={view === "analytics"} label="Analytics" onClick={() => { setView("analytics"); setMobileMenuOpen(false); }} />
              )}
              <NavItem icon={<Settings size={18} />} active={view === "settings"} label="Settings" onClick={() => { setView("settings"); setMobileMenuOpen(false); }} />
            </nav>
          </div>
        </div>
      )}

	      <main className="flex-1 min-w-0">
	        <div className="mx-auto w-full max-w-[1600px] px-4 py-6 md:px-6 lg:px-8 lg:py-8">
          {(mailboxSync.status === "syncing" || mailboxSync.status === "retrying") && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl bg-indigo-500/10 px-4 py-2 ring-1 ring-indigo-400/30">
              <div className="text-sm text-indigo-200">
                <span className="font-semibold">
                  {mailboxSync.status === "retrying" ? "Fetching bottles at sea…" : "Fetching bottles at sea…"}
                </span>
                {mailboxSync.missing ? (
                  <span className="ml-2 text-indigo-200/80">
                    Missing {mailboxSync.missing} bottle{mailboxSync.missing === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
              <Button
                type="button"
                onClick={() => mailboxRetryRef.current?.()}
                variant="outline"
                size="sm"
                loading={mailboxSync.status === "retrying"}
                busyText="Retrying…"
              >
                Retry now
              </Button>
            </div>
          )}
	          {view === "compose" && (
	            <ComposeView
	              editor={editor}
	              setEditor={setEditor}
	              charLimit={charLimit}
	              remaining={remaining}
	              scheduleAt={scheduleAt}
	              setScheduleAt={setScheduleAt}
	              onSaveDraft={saveDraft}
	              onSchedule={schedulePost}
	              onOpenRepost={() => openRepostDialog()}
	              pubkey={pubkey}
	              uploads={uploads}
	              onUploadStart={handleUploadStart}
	          onUploadProgress={handleUploadProgress}
	          onUploadEnd={handleUploadEnd}
	          onUploadSuccess={handleUploadSuccess}
	          onUploadError={showToast}
	          uploadTags={collectUploadTags(editor.content)}
	          addClientTag={addClientTag}
	          setAddClientTag={setAddClientTag}
          draftSaving={draftSaving}
          draftsLoading={draftsLoading}
          mailboxReady={mailboxReady}
          mailboxSync={mailboxSync}
          mailboxCounts={mailboxCounts}
          queueMore={queueMore}
          postedMore={postedMore}
	              jobs={noteJobs}
	              drafts={drafts}
	              onViewJobs={(tab) => { setJobsTab(tab); setView("jobs"); }}
	              onViewDrafts={() => setView("drafts")}
	              onRescheduleJob={(j) => setRescheduleJob(j)}
	              onOpenPreview={openJobPreview}
	              onCancelJob={cancelJob}
	              useDraft={useDraft}
	              nip96Service={nip96Service}
	              uploadBackend={uploadBackend}
	              blossomServers={blossomServers}
	              nsfw={nsfw}
	              setNsfw={setNsfw}
		              optionsOpen={composeOptionsOpen}
		              setOptionsOpen={setComposeOptionsOpen}
		              schedulingStep={schedulingStep}
                  supportInvoiceSats={supportInvoiceSats}
		            />
		          )}

          {view === "dm" && (
            <Suspense fallback={<ViewFallback title="Loading DMs…" />}>
	              <DmView
	                to={dmTo}
	                setTo={setDmTo}
	                message={dmMessage}
	                setMessage={setDmMessage}
	                scheduleAt={dmScheduleAt}
	                setScheduleAt={setDmScheduleAt}
	                onSchedule={scheduleDm}
	                schedulingStep={dmSchedulingStep}
	                jobs={dmJobs}
	                profileRelays={activeRelays}
	                onCancelJob={cancelJob}
	                onRescheduleJob={(j) => setRescheduleJob(j)}
	                onRetryJob={retryDmJob}
	              />
            </Suspense>
          )}

          {view === "calendar" && (
            <Suspense fallback={<ViewFallback title="Loading Calendar…" />}>
              <CalendarPage
                events={calendarEvents}
                loading={queueMore.loading}
                onRangeChange={ensureQueueCoversRange}
                onCreateEvent={scheduleCalendarEvent}
                onUpdateEvent={handleCalendarUpdate}
                onDeleteEvent={handleCalendarDelete}
                pubkey={pubkey}
                nip96Service={nip96Service}
                uploadBackend={uploadBackend}
                blossomServers={blossomServers}
                uploads={uploads}
                onUploadStart={handleUploadStart}
                onUploadProgress={handleUploadProgress}
                onUploadEnd={handleUploadEnd}
                onUploadSuccess={handleUploadSuccess}
                onUploadError={showToast}
              />
            </Suspense>
          )}

          {view === "drafts" && (
            <DraftsView drafts={drafts} onUse={useDraft} onDelete={deleteDraft} loading={draftsLoading} />
          )}

          {view === "feed" && (
            <Suspense fallback={<ViewFallback title="Loading feed…" />}>
              <MyFeedView pubkey={pubkey} relays={activeRelays} onOpenRepost={openRepostDialog} />
            </Suspense>
          )}

          {view === "jobs" && (
            <JobsView
              jobs={noteJobs}
              now={now}
              profileRelays={activeRelays}
              onReschedule={(j) => setRescheduleJob(j)}
              onCancel={(j) => setConfirmCancel(j)}
              onRepost={(job) => {
                const note = job?.noteEvent;
                const resolvedEvent = note && Number(note.kind) === 1 ? note : null;
                const hint = (Array.isArray(job?.relays) && job.relays.length ? job.relays[0] : activeRelays[0]) || "";
                openRepostDialog({ targetId: job?.noteId || "", relayHint: hint, resolvedEvent });
              }}
              onPauseResume={pauseResumeJob}
              initialTab={jobsTab}
              onOpenPreview={openJobPreview}
              mailboxCounts={mailboxCounts}
              queueHasMore={queueMore.hasMore}
              queueLoading={queueMore.loading}
              onLoadMoreQueue={loadFurtherQueue}
              postedHasMore={postedMore.hasMore}
              postedLoading={postedMore.loading}
              onLoadMorePosted={loadOlderPosted}
            />
          )}

          {view === "analytics" && (
            <Suspense fallback={<ViewFallback title="Loading Analytics…" />}>
              <AnalyticsView
                loading={analyticsState.status === "loading"}
                global={analyticsState.global}
                series={analyticsState.series}
                latest={analyticsState.latest}
                quickEstimate={analyticsState.quickEstimate}
                onQuickEstimate={runQuickEstimate}
              />
            </Suspense>
          )}

          {view === "how" && (
            <Suspense fallback={<ViewFallback title="Loading How it works…" />}>
              <HowItWorksView />
            </Suspense>
          )}

          {view === "settings" && (
            <Suspense fallback={<ViewFallback title="Loading Settings…" />}>
              <SettingsView
                theme={theme}
                setTheme={setThemePreference}
                nip96Service={nip96Service}
                setNip96Service={setNip96Service}
                uploadBackend={uploadBackend}
                setUploadBackend={setUploadBackend}
                blossomServers={blossomServers}
                setBlossomServers={setBlossomServers}
                publishRelaysMode={publishRelaysMode}
                setPublishRelaysMode={setPublishRelaysMode}
                publishRelaysCustom={publishRelaysCustom}
                setPublishRelaysCustom={setPublishRelaysCustom}
                dvmPubkeyOverride={dvmPubkeyOverride}
                setDvmPubkeyOverride={setDvmPubkeyOverride}
                dvmRelaysOverride={dvmRelaysOverride}
                setDvmRelaysOverride={setDvmRelaysOverride}
                recommendedPublishRelays={recommendedPublishRelays}
                nip65PublishRelays={nip65PublishRelaysState.relays}
                nip65PublishRelaysStatus={nip65PublishRelaysState.status}
                nip65PublishRelaysError={nip65PublishRelaysState.error}
                onRefreshNip65PublishRelays={refreshNip65PublishRelays}
                analyticsEnabled={analyticsEnabled}
                setAnalyticsEnabled={setAnalyticsEnabled}
                supportIsSupporter={Boolean(mailboxSupport?.state?.isSupporter)}
                supporterUntil={Number(mailboxSupport?.state?.supporterUntil) || 0}
                pubkey={pubkey}
                settingsSync={settingsSync}
                settingsDirty={settingsDirty}
                onLoadNostrSettings={() => loadUserSettingsFromNostr({ silent: false })}
                onSaveNostrSettings={saveUserSettingsToNostr}
                onOpenHowItWorks={() => setView("how")}
                onRepairMailbox={requestMailboxRepair}
              />
            </Suspense>
          )}
	        </div>
	      </main>

        <footer className="mt-auto border-t border-white/10">
          <div className="mx-auto w-full max-w-[1600px] px-4 py-4 md:px-6 lg:px-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="text-xs text-white/50">Built by</div>
                <button
                  type="button"
                  onClick={() => {
                    copyText(FOOTER_NPUB).then((ok) => showToast(ok ? "Copied npub" : "Copy failed"));
                  }}
                  className="group inline-flex items-center gap-2 rounded-2xl bg-slate-950/40 px-3 py-2 ring-1 ring-white/10 transition hover:bg-slate-950/60 hover:ring-white/20"
                  aria-label="Copy author npub"
                >
                  <span className="font-mono text-[11px] text-white/80 max-w-[72vw] sm:max-w-[360px] truncate">
                    {FOOTER_NPUB}
                  </span>
                  <Copy className="h-4 w-4 text-white/50 group-hover:text-white/80" />
                </button>
              </div>

              <a
                href={FOOTER_REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-2xl bg-slate-950/40 px-3 py-2 ring-1 ring-white/10 transition hover:bg-slate-950/60 hover:ring-white/20"
              >
                <Github className="h-4 w-4 text-white/60" />
                <span className="text-xs font-medium text-white/80">GitHub</span>
                <span className="font-mono text-[11px] text-indigo-200">{FOOTER_REPO_LABEL}</span>
              </a>
            </div>
          </div>
        </footer>

		      {/* Dialogs */}
        <Dialog
          open={onboardingOpen}
          onOpenChange={(open) => {
            if (open) return;
            snoozeOnboarding();
          }}
        >
          <DialogContent className="rounded-3xl sm:max-w-lg">
            <div className="relative">
              <button
                type="button"
                onClick={snoozeOnboarding}
                className="absolute right-3 top-3 rounded-xl p-2 text-white/60 transition hover:bg-white/5 hover:text-white"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
	              <DialogHeader>
	                <DialogTitle>Welcome to Pidgeon</DialogTitle>
	                <DialogDescription>
	                  Schedule Nostr posts and DMs for later
	                </DialogDescription>
	              </DialogHeader>

              <div className="space-y-3 px-6 pb-2">
                <div className="rounded-2xl bg-slate-950/50 p-4 ring-1 ring-white/10">
                  <div className="text-sm font-semibold text-white/90">How it works</div>
                  <div className="mt-3 space-y-3 text-sm text-white/75">
                    <div className="flex gap-3">
	                      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white/80 ring-1 ring-white/10">
	                        1
	                      </span>
	                      <div className="min-w-0">
	                        <div className="font-medium text-white/90">Login with Nostr</div>
	                        <div className="mt-0.5 text-white/70">You can login via browser extension or remote signer</div>
	                      </div>
	                    </div>
                    <div className="flex gap-3">
	                      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white/80 ring-1 ring-white/10">
	                        2
	                      </span>
                      <div className="min-w-0">
                        <div className="font-medium text-white/90">Write, pick a time, schedule</div>
                        <div className="mt-0.5 text-white/70">Save drafts anytime to back up what you’re writing.</div>
                      </div>
                    </div>
                    <div className="flex gap-3">
	                      <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white/80 ring-1 ring-white/10">
	                        3
	                      </span>
	                      <div className="min-w-0">
	                        <div className="font-medium text-white/90">We will post it at your chosen time</div>
	                        <div className="mt-0.5 text-white/70">
	                          Sit back and relax. You can come back any time and cancel the scheduled post or reschedule the
	                          posting time.
	                        </div>
	                      </div>
	                    </div>
	                  </div>
	                </div>
	              </div>

	              <DialogFooter className="gap-2">
	                <Button type="button" variant="outline" onClick={hideOnboardingForever}>
	                  Don’t show this again
	                </Button>
                <Button type="button" onClick={snoozeOnboarding}>
                  Continue
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

	        <Dialog
	          open={draftCleanupPrompt.open}
	          onOpenChange={(open) => {
	            if (open) return;
	            setDraftCleanupPrompt({ open: false, id: "", preview: "" });
          }}
        >
          <DialogContent className="rounded-3xl sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Draft scheduled</DialogTitle>
              <DialogDescription>
                This was scheduled from a draft. Remove it from your drafts list?
              </DialogDescription>
            </DialogHeader>
            {draftCleanupPrompt.preview ? (
              <div className="rounded-2xl bg-slate-950/50 p-3 text-sm text-white/80 ring-1 ring-white/10">
                {draftCleanupPrompt.preview}
              </div>
            ) : null}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setDraftCleanupPrompt({ open: false, id: "", preview: "" })}>
                Keep
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  const id = String(draftCleanupPrompt.id || "").trim();
                  if (id) deleteDraft(id);
                  setDraftCleanupPrompt({ open: false, id: "", preview: "" });
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <Trash2 className="h-4 w-4" />
                  Remove draft
                </span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

	      <Dialog
	        open={supportDialog.open}
	        onOpenChange={(open) => {
	          if (open) return;
	          handleSupportDialogAction(supportDialog.source === "mailbox" ? "maybe_later" : "close");
        }}
      >
        <DialogContent className="rounded-3xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {supportDialog?.prompt?.type === "gate"
                ? (String(supportDialog?.prompt?.reason || "") === "horizon"
                    ? `Schedule beyond ${Number(supportDialog?.prompt?.horizonDays ?? mailboxSupport?.policy?.horizonDays ?? 0) || 0} days`
                    : `Unlock ${String(supportDialog?.prompt?.feature || "this feature")}`)
                : "Support Pidgeon"}
            </DialogTitle>
            <DialogDescription>
              {supportDialog?.prompt?.type === "gate"
                ? "This action is reserved for supporters, but you can always keep using the service for free."
                : `You’ve scheduled ${Number(supportDialog?.prompt?.scheduleCount ?? mailboxSupport?.state?.scheduleCount ?? 0) || 0} item(s). If this is useful, consider supporting the service.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 pb-2">
            {String(mailboxSupport?.policy?.cta?.message || "").trim() ? (
              <div className="rounded-2xl bg-slate-950/50 p-4 text-sm text-white/80 ring-1 ring-white/10">
                {String(mailboxSupport?.policy?.cta?.message || "").trim()}
              </div>
            ) : null}

            {supportShowInvoice ? (
              <div className="space-y-3 rounded-2xl bg-slate-950/50 p-4 ring-1 ring-white/10">
                <div className="text-xs text-white/60">Lightning invoice</div>
                {!supportHasInvoice ? (
                  <div className="text-sm text-white/80">Generating invoice…</div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs text-white/60">Amount (sats)</div>
                        <Input
                          type="number"
                          min={supportMinInvoiceSats || 0}
                          step={100}
                          placeholder={supportDefaultInvoiceSats ? String(supportDefaultInvoiceSats) : "1000"}
                          value={supportInvoiceSats ? String(supportInvoiceSats) : ""}
                          onChange={(e) => {
                            const raw = String(e.target.value || "");
                            if (raw === "") {
                              setSupportInvoiceSats(0);
                              return;
                            }
                            const n = Math.floor(Number(raw) || 0);
                            if (!Number.isFinite(n) || n < 0) return;
                            setSupportInvoiceSats(n);
                          }}
                          className="mt-1 w-40"
                        />
                        <div className="mt-1 text-[11px] text-white/60">
                          {supportMinInvoiceSats ? `Min ${supportMinInvoiceSats.toLocaleString()} sats.` : " "}
                        </div>
                      </div>
                      <div className="text-sm text-white/80">
                        {Number(supportInvoice?.sats || 0)
                          ? `Current invoice: ${Number(supportInvoice.sats).toLocaleString()} sats`
                          : "Current invoice"}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm text-white/80">
                        {Number(supportInvoice?.sats || 0)
                          ? `${Number(supportInvoice.sats).toLocaleString()} sats`
                          : "Invoice"}
                      </div>
                      {Number(supportInvoice?.expiresAt || 0) ? (
                        <div className="text-xs text-white/50">
                          Expires {new Date(Number(supportInvoice.expiresAt) * 1000).toLocaleString()}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex justify-center">
                      <div className="rounded-2xl bg-white p-3">
                        <QRCode value={`lightning:${String(supportInvoice?.pr || "").trim()}`} size={196} />
                      </div>
                    </div>
                    <div className="truncate rounded-xl bg-slate-950/60 px-3 py-2 font-mono text-xs text-white/80 ring-1 ring-white/10">
                      {String(supportInvoice?.pr || "").trim()}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const pr = String(supportInvoice?.pr || "").trim();
                          if (!pr) return;
                          copyText(pr).then((ok) => ok && showToast("Copied"));
                        }}
                      >
                        Copy
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openInvoiceLink(String(supportInvoice?.pr || "").trim())}
                      >
                        Open
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          handleSupportDialogAction("check_invoice", {
                            invoiceId: String(supportInvoice?.id || "").trim()
                          })
                        }
                      >
                        Check
                      </Button>
                      {(() => {
                        const current = Math.max(0, Math.floor(Number(supportInvoice?.sats) || 0));
                        const desired = Math.max(0, Math.floor(Number(supportDesiredInvoiceSats) || 0));
                        if (!current || !desired || desired === current) return null;
                        return (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSupportPayment({ active: true, startedAt: Date.now() });
                              publishSupportAction("support", {
                                promptId: String(supportDialog?.prompt?.id || "").trim(),
                                source: String(supportDialog?.prompt?.type || "") || "support",
                                sats: desired
                              });
                            }}
                          >
                            Update invoice
                          </Button>
                        );
                      })()}
                    </div>
                    <div className="text-xs text-white/60">
                      After paying, click “Check” (or just wait a moment for confirmation).
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {!supportShowInvoice && supportPayMode === "lnurl_verify" ? (
              <div className="space-y-3 rounded-2xl bg-slate-950/50 p-4 ring-1 ring-white/10">
                <div className="text-xs text-white/60">Amount (sats)</div>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <Input
                      type="number"
                      min={supportMinInvoiceSats || 0}
                      step={100}
                      placeholder={supportDefaultInvoiceSats ? String(supportDefaultInvoiceSats) : "1000"}
                      value={supportInvoiceSats ? String(supportInvoiceSats) : ""}
                      onChange={(e) => {
                        const raw = String(e.target.value || "");
                        if (raw === "") {
                          setSupportInvoiceSats(0);
                          return;
                        }
                        const n = Math.floor(Number(raw) || 0);
                        if (!Number.isFinite(n) || n < 0) return;
                        setSupportInvoiceSats(n);
                      }}
                      className="w-40"
                    />
                    <div className="mt-1 text-[11px] text-white/60">
                      {supportDefaultInvoiceSats ? `Default ${supportDefaultInvoiceSats.toLocaleString()} sats.` : " "}
                      {supportMinInvoiceSats ? ` Min ${supportMinInvoiceSats.toLocaleString()} sats.` : ""}
                    </div>
                  </div>
                  <div className="text-xs text-white/60">Click “Support” to generate an invoice.</div>
                </div>
              </div>
            ) : null}

            {!supportShowInvoice && supportPayMode !== "lnurl_verify" && String(mailboxSupport?.policy?.cta?.lud16 || "").trim() ? (
              <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-950/50 p-4 ring-1 ring-white/10">
                <div className="min-w-0">
                  <div className="text-xs text-white/60">Lightning</div>
                  <div className="truncate font-mono text-sm">{String(mailboxSupport?.policy?.cta?.lud16 || "").trim()}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const addr = String(mailboxSupport?.policy?.cta?.lud16 || "").trim();
                      if (!addr) return;
                      copyText(addr).then((ok) => ok && showToast("Copied"));
                    }}
                  >
                    Copy
                  </Button>
                  <Button size="sm" variant="secondary" onClick={openSupportLink}>
                    Open
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => handleSupportDialogAction("maybe_later")}>Maybe later</Button>
            <Button variant="outline" onClick={() => handleSupportDialogAction("use_free")}>Use for free</Button>
            <Button
              onClick={() => handleSupportDialogAction("support")}
            >
              {supportPayMode === "lnurl_verify"
                ? (supportHasInvoice ? "Pay invoice" : "Support")
                : "Support"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rescheduleJob} onOpenChange={() => setRescheduleJob(null)}>
        <DialogContent className="rounded-3xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reschedule Post</DialogTitle>
            <DialogDescription>
              Pick a new time for this scheduled post.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Input
              type="datetime-local"
              value={rescheduleWhen}
              onChange={(e) => setRescheduleWhen(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setRescheduleJob(null)}>Cancel</Button>
            <Button
              onClick={() => {
                if (rescheduleJob) {
                  const nextWhen = rescheduleWhen || formatLocalDateTimeInput(new Date(rescheduleJob.scheduledAt));
                  doReschedule(rescheduleJob, nextWhen);
                  setRescheduleJob(null);
                }
              }}
            >
              Reschedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  
      <Dialog open={!!confirmCancel} onOpenChange={() => setConfirmCancel(null)}>
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle className="">Cancel job?</DialogTitle>
            <DialogDescription className="">
              This triggers a placeholder for kind:5 (deletion). Cancellation is not reversable!
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirmCancel(null)}>No</Button>
            <Button variant="destructive" onClick={() => { cancelJob(confirmCancel); setConfirmCancel(null); }}>Cancel job</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={repostOpen} onOpenChange={setRepostOpen}>
        <DialogContent className="rounded-3xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{repostMode === "quote" ? "Schedule quote" : "Schedule repost"}</DialogTitle>
            <DialogDescription>
              Paste a note id, pick a time, and Pidgeon will schedule a {repostMode === "quote" ? "quote" : "repost"}. Preview is fetched when available.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 px-6 py-4">
            <div className="space-y-3 rounded-2xl bg-slate-950/50 p-4 ring-1 ring-white/10">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{repostMode === "quote" ? "Note to quote" : "Note to repost"}</div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={repostMode === "repost" ? "secondary" : "ghost"}
                    onClick={() => setRepostMode("repost")}
                    disabled={Boolean(repostSchedulingStep)}
                  >
                    Repost
                  </Button>
                  <Button
                    size="sm"
                    variant={repostMode === "quote" ? "secondary" : "ghost"}
                    onClick={() => setRepostMode("quote")}
                    disabled={Boolean(repostSchedulingStep)}
                  >
                    Quote
                  </Button>
                </div>
              </div>
              <Input
                value={repostTarget}
                onChange={(e) => {
                  setRepostTarget(e.target.value);
                  setRepostShowAnyway(false);
                  setRepostResolveState({ status: "idle", event: null, relay: "", kind: 0, error: "" });
                }}
                placeholder="note1… / nevent1… / 64-hex id"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={resolveRepostTarget}
                  loading={repostResolveState.status === "resolving"}
                  busyText="Fetching preview…"
                  disabled={!repostTarget.trim()}
                >
                  Preview note
                </Button>

                {repostResolveState.status === "idle" ? (
                  <span className="text-xs text-white/50">Optional, but helps confirm you picked the right note.</span>
                ) : null}
                {repostResolveState.status === "found" ? (
                  <span className="text-xs font-medium text-emerald-200">Preview ready</span>
                ) : null}
                {repostResolveState.status === "wrongkind" ? (
                  <span className="text-xs text-red-300">
                    This isn’t a text note, so it can’t be reposted or quoted.
                  </span>
                ) : null}
                {repostResolveState.status === "notfound" ? (
                  <span className="text-xs text-amber-200">Preview unavailable right now.</span>
                ) : null}
                {repostResolveState.status === "invalid" ? (
                  <span className="text-xs text-red-300">{repostResolveState.error || "Invalid id"}</span>
                ) : null}
                {repostResolveState.error ? (
                  <span className="text-xs text-amber-200">{repostResolveState.error}</span>
                ) : null}
              </div>

              {repostResolveState.status === "found" && repostResolveState.event ? (
                <div className="rounded-2xl bg-black/20 p-3 ring-1 ring-white/10">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="text-[11px] uppercase tracking-wide text-white/50">Preview</div>
                      <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/80 ring-1 ring-white/10">
                      {repostMode === "quote" ? "💬 Quote" : "🔁 Repost"}
                      </span>
                    </div>
                    <div className="custom-scrollbar max-h-56 overflow-y-auto pr-2">
                      <PostContent content={repostResolveState.event?.content || ""} />
                    </div>
                  </div>
                ) : null}
            </div>

            {repostMode === "quote" ? (
              <div className="space-y-3 rounded-2xl bg-slate-950/50 p-4 ring-1 ring-white/10">
                <div className="text-sm font-medium">Your quote</div>
                <Textarea
                  value={repostQuoteText}
                  onChange={(e) => setRepostQuoteText(e.target.value)}
                  placeholder="Add your commentary (optional)…"
                  className="min-h-[96px]"
                />
                <div className="text-xs text-white/50">
                  Pidgeon appends a NIP-21 `nostr:note…` reference so clients can render the quoted note.
                </div>
              </div>
            ) : null}

            <div className="space-y-3 rounded-2xl bg-slate-950/50 p-4 ring-1 ring-white/10">
              <div className="text-sm font-medium">When should it post?</div>
              <Input
                type="datetime-local"
                value={repostScheduleAt}
                onChange={(e) => setRepostScheduleAt(e.target.value)}
              />
            </div>

            {repostShowAnyway ? (
              <div className="rounded-2xl bg-amber-500/10 px-4 py-3 text-sm text-amber-100 ring-1 ring-amber-400/30">
                Couldn’t fetch a preview. You can still schedule — {repostMode === "quote" ? "clients may render it later." : "Pidgeon will retry at publish time."}
              </div>
            ) : null}

            {repostSchedulingStep ? (
              <div className="text-xs rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-white/10 text-white/80">
                {repostSchedulingStep}
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setRepostOpen(false)}>Cancel</Button>
            {repostShowAnyway && repostResolveState.status !== "found" ? (
              <Button
                variant="secondary"
                onClick={() => scheduleRepost({ allowUnresolved: true })}
                loading={Boolean(repostSchedulingStep)}
                busyText={repostSchedulingStep || "Scheduling…"}
                disabled={!repostTarget.trim() || repostResolveState.status === "wrongkind"}
              >
                Schedule anyway
              </Button>
            ) : null}
            <Button
              onClick={async () => {
                const result = await scheduleRepost({ allowUnresolved: false });
                if (!result?.ok && result?.reason === "unresolved") {
                  setRepostShowAnyway(true);
                }
              }}
              loading={Boolean(repostSchedulingStep)}
              busyText={repostSchedulingStep || "Scheduling…"}
              disabled={!repostTarget.trim() || repostResolveState.status === "wrongkind"}
            >
              {repostMode === "quote" ? "Schedule quote" : "Schedule repost"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EventPreview
        event={jobPreview}
        timezone={tz}
        onClose={() => setJobPreview(null)}
        onReschedule={(evt) => {
          const j = jobs.find((job) => job.id === evt.id || job.requestId === evt.id);
          if (j) setRescheduleJob(j);
          setJobPreview(null);
        }}
        onDelete={(evt) => {
          const j = jobs.find((job) => job.id === evt.id || job.requestId === evt.id);
          if (j) cancelJob(j);
          setJobPreview(null);
        }}
      />
    </div>
  );
}

// ---- Components -------------------------------------------------------------
const TopBar = React.memo(function TopBar({
  pubkey,
  npubShort,
  profile,
  onLogin,
  onLogout,
  onMenuToggle,
  userMenuOpen,
  setUserMenuOpen,
  view,
  setView,
  analyticsEnabled = false
}) {
  const displayName = profile?.name || npubShort || "there";
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" ? window.innerWidth < 768 : false);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  return (
    <header className="sticky top-0 z-30 backdrop-blur-sm supports-[backdrop-filter]:bg-white/5 bg-black/20 border-b border-white/10">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-center gap-3 md:gap-6 flex-1">
          {/* Mobile hamburger menu */}
          <button
            onClick={onMenuToggle}
            className="md:hidden rounded-xl p-2 text-white/80 transition hover:bg-white/5 hover:text-white"
            aria-label="Menu"
          >
            <Menu className="h-5 w-5" />
          </button>

		          {/* Branding */}
		          <div className="flex items-center gap-3">
		            <img src="/pidgeon-icon.svg" alt="Pidgeon" className="h-12 w-12" draggable="false" />
		            <div className="flex flex-col items-start md:hidden min-[1080px]:flex">
		              <img src="/pidgeon-wordmark.svg" alt="Pidgeon" className="h-6 w-auto" draggable="false" />
		              <div className="hidden min-[1080px]:block text-[10px] text-white/50 font-medium leading-none">
		                Nostr Scheduler
	              </div>
	            </div>
	          </div>

          {/* Desktop Navigation - Horizontal tabs */}
          <nav className="hidden md:flex items-center gap-1 flex-1">
            <NavItemHorizontal icon={<PenSquare size={16} />} active={view === "compose"} label="Compose" onClick={() => setView("compose")} />
            <NavItemHorizontal icon={<Clock size={16} />} active={view === "jobs"} label="Jobs" onClick={() => setView("jobs")} />
            <NavItemHorizontal icon={<CalendarIcon size={16} />} active={view === "calendar"} label="Calendar" onClick={() => setView("calendar")} />
            <NavItemHorizontal icon={<FileText size={16} />} active={view === "drafts"} label="Drafts" onClick={() => setView("drafts")} />
            <NavItemHorizontal icon={<MessageSquare size={16} />} active={view === "dm"} label="DMs" onClick={() => setView("dm")} />
            {analyticsEnabled && (
              <NavItemHorizontal icon={<BarChart2 size={16} />} active={view === "analytics"} label="Analytics" onClick={() => setView("analytics")} />
            )}
            <NavItemHorizontal icon={<Settings size={16} />} active={view === "settings"} label="Settings" onClick={() => setView("settings")} />
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {pubkey ? (
            <div className="flex items-center gap-2">
              {!isMobile ? (
                <button
                  onClick={() => {
                    setView("feed");
                    setUserMenuOpen(false);
                  }}
                  className={clsx(
                    "group flex items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-sm transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
                    view === "feed"
                      ? "text-white ring-1 ring-indigo-400/40"
                      : "text-white/70 ring-1 ring-white/10 hover:bg-slate-800 hover:text-white hover:ring-indigo-400/30"
                  )}
                >
                  <span className={clsx("opacity-70", view === "feed" && "opacity-100")}>
                    <User size={16} />
                  </span>
                  <span className="hidden lg:inline font-medium">My Feed</span>
                </button>
              ) : null}

              <div className="relative">
                {/* Mobile: Avatar only */}
                {isMobile ? (
                  <>
                    <button
                      onClick={() => setUserMenuOpen(!userMenuOpen)}
                      className="h-9 w-9 rounded-full overflow-hidden bg-slate-900 ring-1 ring-white/10 transition hover:ring-indigo-400/60 flex items-center justify-center"
                    >
                      {profile?.picture ? (
                        <img
                          src={profile.picture}
                          alt={displayName || "avatar"}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <img src="/pidgeon-icon.svg" alt="" className="h-5 w-5" draggable="false" />
                      )}
                    </button>

                    {/* Mobile dropdown */}
                    {userMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                        <div className="absolute right-0 top-12 z-50 w-64 rounded-2xl bg-slate-900 text-white shadow-xl ring-1 ring-white/10">
                          <div className="border-b border-white/10 p-4">
                            <div className="flex items-center gap-3">
                              <div className="h-10 w-10 rounded-full overflow-hidden bg-slate-800 ring-1 ring-white/10 flex items-center justify-center">
                                {profile?.picture ? (
                                  <img
                                    src={profile.picture}
                                    alt={displayName || "avatar"}
                                    className="h-full w-full object-cover"
                                    loading="lazy"
                                  />
                                ) : (
                                  <img src="/pidgeon-icon.svg" alt="" className="h-6 w-6" draggable="false" />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-semibold truncate">{displayName}</div>
                                <div className="text-xs text-white/60 truncate">{npubShort}</div>
                              </div>
                            </div>
                          </div>
                          <div className="p-2">
                            <button
                              onClick={() => {
                                onLogout();
                                setUserMenuOpen(false);
                              }}
                              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/80 transition hover:bg-white/5 hover:text-white"
                            >
                              <LogOut className="h-4 w-4" />
                              <span>Sign out</span>
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  /* Desktop: Full profile with "Hi <name>!" */
                  <>
                    <button
                      onClick={() => setUserMenuOpen(!userMenuOpen)}
                      className="flex items-center gap-3 rounded-2xl bg-slate-900 px-3 py-2 text-white ring-1 ring-white/10 transition hover:ring-indigo-400/60"
                    >
                      <div className="h-9 w-9 rounded-full overflow-hidden bg-slate-800 ring-1 ring-white/10 flex items-center justify-center">
                        {profile?.picture ? (
                          <img
                            src={profile.picture}
                            alt={displayName || "avatar"}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <img src="/pidgeon-icon.svg" alt="" className="h-6 w-6" draggable="false" />
                        )}
                      </div>
                      <div className="max-w-[180px] text-sm leading-tight">
                        <div className="font-semibold truncate">Hi {displayName}!</div>
                        <div className="text-[11px] text-white/60 truncate">Connected</div>
                      </div>
                    </button>

                    {/* Desktop dropdown */}
                    {userMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                        <div className="absolute right-0 top-14 z-50 w-48 rounded-2xl bg-slate-900 text-white shadow-xl ring-1 ring-white/10">
                          <div className="p-2">
                            <button
                              onClick={() => {
                                onLogout();
                                setUserMenuOpen(false);
                              }}
                              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/80 transition hover:bg-white/5 hover:text-white"
                            >
                              <LogOut className="h-4 w-4" />
                              <span>Sign out</span>
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <Button
              onClick={onLogin}
              size={isMobile ? "sm" : "default"}
            >
              {isMobile ? "Login" : "Login with Nostr"}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
});

function NavItem({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "group flex items-center gap-3 rounded-2xl px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        active
          ? "bg-slate-950 text-white ring-1 ring-white/10"
          : "text-white/70 hover:bg-white/5 hover:text-white"
      )}
    >
      <span className={clsx("opacity-70", active && "opacity-100")}>{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

function NavItemHorizontal({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "group flex items-center gap-2 rounded-2xl px-3 py-2 text-sm transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        active
          ? "bg-slate-900 text-white ring-1 ring-indigo-400/40"
          : "text-white/70 hover:bg-white/5 hover:text-white"
      )}
    >
      <span className={clsx("opacity-70", active && "opacity-100")}>{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

function ScheduleSendIcon({ className }) {
  return <CalendarClock className={clsx("h-4 w-4 shrink-0", className)} aria-hidden="true" />;
}

function ComposeView({
  editor,
  setEditor,
  charLimit,
  remaining,
  scheduleAt,
  setScheduleAt,
  onSaveDraft,
  onSchedule,
  onOpenRepost,
  pubkey,
  uploads,
  onUploadStart,
  onUploadProgress,
  onUploadEnd,
  onUploadSuccess,
  onUploadError,
  uploadTags,
  addClientTag,
  setAddClientTag,
  draftSaving,
  draftsLoading,
  mailboxReady,
  mailboxSync,
  mailboxCounts,
  queueMore,
  postedMore,
  nip96Service,
  uploadBackend,
  blossomServers,
  nsfw,
  setNsfw,
  optionsOpen,
  setOptionsOpen,
  schedulingStep,
  supportInvoiceSats = 0,
  jobs,
  drafts,
  onViewJobs,
  onViewDrafts,
  onRescheduleJob,
  onOpenPreview,
  onCancelJob,
  useDraft,
}) {
  const textareaRef = useRef(null);
  const hasSigner = (() => {
    try {
      return Boolean(window?.nostr?.signEvent) && Boolean(window?.nostr?.nip44?.encrypt);
    } catch {
      return false;
    }
  })();
  const composeLocked = !pubkey || !hasSigner;

  const insertEmoji = (emoji) => {
    if (!emoji) return;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? null;
    const end = el?.selectionEnd ?? null;
    const baseValue = typeof el?.value === "string" ? el.value : String(editor?.content || "");
    const safeStart = typeof start === "number" ? start : baseValue.length;
    const safeEnd = typeof end === "number" ? end : safeStart;
    const nextCursor = safeStart + emoji.length;
    setEditor((prev) => {
      const value = String(prev?.content || "");
      const next = value.slice(0, safeStart) + emoji + value.slice(safeEnd);
      return { ...prev, content: next };
    });
    requestAnimationFrame(() => {
      if (!el) return;
      try {
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
      } catch {}
    });
  };

  const { scheduledCount, postedCount, scheduledPreview, postedPreview } = useMemo(() => {
    const list = Array.isArray(jobs) ? jobs : [];
    const scheduled = [];
    const posted = [];
    for (const j of list) {
      const status = j?.status;
      if (status === "scheduled" || status === "queued" || status === "paused" || status === "error") {
        scheduled.push(j);
      } else if (status === "posted" || status === "sent" || status === "published") {
        posted.push(j);
      }
    }
    const scheduledPreview = scheduled
      .slice()
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
      .slice(0, 3);
    const postedPreview = posted
      .slice()
      .sort(
        (a, b) =>
          new Date(b.updatedAt || b.scheduledAt || 0).getTime() -
          new Date(a.updatedAt || a.scheduledAt || 0).getTime()
      )
      .slice(0, 3);
    return {
      scheduledCount: scheduled.length,
      postedCount: posted.length,
      scheduledPreview,
      postedPreview
    };
  }, [jobs]);

  const { draftsCount, recentDrafts } = useMemo(() => {
    const list = Array.isArray(drafts) ? drafts : [];
    return { draftsCount: list.length, recentDrafts: list.slice(0, 3) };
  }, [drafts]);

    const schedulingBusy = Boolean(schedulingStep) && !String(schedulingStep).startsWith("Scheduled for ");
    const canSaveDraft = Boolean(pubkey) && Boolean(String(editor?.content || "").trim());
    const canSchedule = Boolean(pubkey) && Boolean(hasSigner) && Boolean(String(editor?.content || "").trim());
  const canLoadMailbox = Boolean(pubkey);
  const mailboxBusy = mailboxSync?.status === "syncing" || mailboxSync?.status === "retrying";
  const queuedRemote = Number(mailboxCounts?.queued) || 0;
  const postedRemote = Number(mailboxCounts?.posted) || 0;
  const upcomingLoading =
    scheduledCount === 0 &&
    canLoadMailbox &&
    (!mailboxReady || mailboxBusy || Boolean(queueMore?.loading) || Boolean(queueMore?.hasMore) || queuedRemote > 0);
  const recentPostsLoading =
    postedCount === 0 &&
    canLoadMailbox &&
    (!mailboxReady || mailboxBusy || Boolean(postedMore?.loading) || Boolean(postedMore?.hasMore) || postedRemote > 0);
  const recentDraftsLoading = draftsCount === 0 && Boolean(draftsLoading);
  const isRepostedJob = (job) =>
    Number(job?.noteEvent?.kind) === 6 ||
    Boolean(job?.isRepost) ||
    (Array.isArray(job?.tags) &&
      job.tags.some(
        (t) => Array.isArray(t) && t[0] === "pidgeon" && t[1] === "repost"
      ));
  const homeCardClass =
    "bg-slate-900/80 ring-white/15 shadow-[0_1px_0_rgba(255,255,255,0.04),0_18px_60px_rgba(0,0,0,0.45)]";

  return (
    <div className="space-y-8 lg:space-y-10">
      <div className="rounded-3xl bg-slate-900/60 p-2 ring-1 ring-white/10 sm:p-3">
        <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-white/50">
          Quick Status
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => onViewJobs && onViewJobs("queue")}
            className="group flex items-center gap-2 rounded-2xl px-3 py-2 text-left transition hover:bg-white/5"
          >
            <CalendarClock className="h-4 w-4 text-indigo-200/80" />
            <span className="text-xs font-medium text-white/70">Scheduled</span>
            <span className="ml-auto font-mono text-sm font-semibold text-indigo-200">{scheduledCount}</span>
          </button>

          <button
            type="button"
            onClick={() => onViewJobs && onViewJobs("posted")}
            className="group flex items-center gap-2 rounded-2xl px-3 py-2 text-left transition hover:bg-white/5"
          >
            <CheckCircle className="h-4 w-4 text-emerald-200/80" />
            <span className="text-xs font-medium text-white/70">Posted</span>
            <span className="ps-quick-count ps-quick-count--posted ml-auto font-mono text-sm font-semibold text-emerald-200">
              {postedCount}
            </span>
          </button>

          <button
            type="button"
            onClick={onViewDrafts}
            className="group flex items-center gap-2 rounded-2xl px-3 py-2 text-left transition hover:bg-white/5"
          >
            <FileText className="h-4 w-4 text-amber-200/80" />
            <span className="text-xs font-medium text-white/70">Drafts</span>
            <span className="ps-quick-count ps-quick-count--drafts ml-auto font-mono text-sm font-semibold text-amber-200">
              {draftsCount}
            </span>
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:gap-8 lg:grid-cols-2 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className={homeCardClass}>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Compose</CardTitle>
            <CardDescription className="">Write your note. You can schedule them to be posted at any time in the future!</CardDescription>
          </CardHeader>
        <CardContent className="space-y-4">
            <Textarea
              ref={textareaRef}
              value={editor.content}
              onChange={(e) => setEditor({ ...editor, content: e.target.value })}
              placeholder={composeLocked ? "Login with Nostr first" : "Type to schedule your thoughts on Nostr!"}
              className="!min-h-[180px] resize-vertical"
              disabled={composeLocked}
            />
          <div className="flex flex-wrap items-center gap-3">
            <Uploader
              onUploadStart={onUploadStart}
              onUploadProgress={onUploadProgress}
              onUploadEnd={onUploadEnd}
              onUploadSuccess={onUploadSuccess}
              onError={onUploadError}
              serviceUrl={nip96Service}
              backend={uploadBackend}
              blossomServers={blossomServers}
            >
              <Button variant="outline" size="icon" className="rounded-xl" title="Upload media">
                <Image className="h-4 w-4" />
              </Button>
            </Uploader>
            <EmojiPickerButton
              title="Insert emoji"
              onSelect={(emoji) => insertEmoji(emoji)}
            />
            <Button
              variant="outline"
              size="icon"
              className="rounded-xl"
              title="Post options"
              onClick={() => setOptionsOpen(true)}
            >
              <Settings className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="rounded-xl"
              title="Schedule repost or quote"
              onClick={() => onOpenRepost?.()}
            >
              <Repeat2 className="h-4 w-4" />
            </Button>
            <Input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="!w-auto min-w-[200px]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="draft"
              onClick={onSaveDraft}
              loading={draftSaving}
              busyText="Saving draft…"
              disabled={!canSaveDraft}
            >
              <span className="relative -top-px">Save Draft</span>
            </Button>
            <Button
              onClick={onSchedule}
              loading={schedulingBusy}
              busyText={schedulingStep || "Scheduling…"}
              className="whitespace-nowrap"
              disabled={!canSchedule}
            >
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <ScheduleSendIcon className="text-white/90" />
                <span>Schedule Send</span>
              </span>
            </Button>
            {schedulingStep && (
              <span className="text-xs rounded-full bg-white/10 px-3 py-1 ring-1 ring-white/10 text-white/80">
                {schedulingStep}
              </span>
            )}
          </div>

	          {uploads.length > 0 && (
	            <div className="rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
	              <div className="text-xs font-semibold text-white/70 mb-2">Uploads</div>
	              <div className="space-y-2">
                {uploads.map((u, idx) => (
                  <div key={`${u.name}-${idx}`} className="flex items-center gap-2 text-xs">
                    <div className="truncate flex-1">{u.name}</div>
                    <div className="w-24 bg-white/10 h-1 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-400 transition-all" style={{ width: `${u.progress}%` }} />
                    </div>
                    <button
                      type="button"
                      className="text-white/60 hover:text-white"
                      onClick={() => u.cancel?.()}
                      title="Cancel upload"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
	                ))}
	              </div>
	            </div>
	          )}

	        </CardContent>
	      </Card>

      <Card className={homeCardClass}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Preview</CardTitle>
              <CardDescription className="">Render-only preview, uses your Nostr login if connected.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <PostPreview
            content={editor.content}
            manualTags={editor.tags}
            pubkey={pubkey}
            when={scheduleAt}
            addClientTag={addClientTag}
            nsfw={nsfw}
            uploadTags={uploadTags}
          />
        </CardContent>
        <CardFooter className="text-xs text-white/50">Tip: preview updates live as you type.</CardFooter>
      </Card>

      <Dialog open={optionsOpen} onOpenChange={setOptionsOpen}>
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle>Post options</DialogTitle>
            <DialogDescription>
              Tune tagging before scheduling.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex items-center justify-between rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
              <div>
                <div className="text-sm font-medium">Add client tag</div>
                <div className="text-xs text-white/60">Show others this was sent via Pidgeon</div>
              </div>
              <Switch checked={addClientTag} onCheckedChange={(v) => setAddClientTag(v)} />
            </div>
            <div className="flex items-center justify-between rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
              <div>
                <div className="text-sm font-medium">NSFW</div>
                <div className="text-xs text-white/60">Mark this post as sensitive</div>
              </div>
              <Switch checked={nsfw} onCheckedChange={(v) => setNsfw(v)} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setOptionsOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      </div>

      {/* Upcoming Jobs, Recent Posts & Drafts */}
      <div className="grid gap-6 lg:gap-8 lg:grid-cols-2 xl:grid-cols-3">
        <Card className={homeCardClass}>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Upcoming Jobs</CardTitle>
            <CardDescription>Next scheduled posts</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
		              {scheduledPreview.map((job, idx) => (
	                  <div
	                    key={job.id}
	                    className={clsx(
	                      "group rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10 transition-colors cursor-pointer hover:bg-slate-950/80 hover:ring-white/20",
	                      idx >= 2 ? "hidden sm:block" : ""
	                    )}
	                    onClick={() => onOpenPreview?.(job)}
	                  >
                    <div className="flex items-start justify-between mb-2">
	                      {isRepostedJob(job) ? (
	                        <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/80 ring-1 ring-white/10">
	                          🔁 Repost
	                        </span>
	                      ) : null}
                      <span className="text-xs font-medium text-indigo-200">
                        {formatTimeAgo(job.scheduledAt)}
                      </span>
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRescheduleJob(job);
                          }}
                          title="Reschedule"
                        >
                          <Clock className="h-3.5 w-3.5 text-white/40 hover:text-white/70" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onCancelJob?.(job);
                          }}
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-300 hover:text-red-200" />
                        </button>
                      </div>
	                    </div>
	                    <div className="text-sm text-white/80 overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] line-clamp-1 sm:line-clamp-2">
	                      {getJobDisplayContent(job) || ""}
	                    </div>
	                  </div>
	                ))}
              {scheduledCount === 0 && upcomingLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="animate-pulse rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
                      <div className="flex items-center justify-between">
                        <div className="h-3 w-24 rounded bg-white/10" />
                        <div className="h-3 w-14 rounded bg-white/10" />
                      </div>
                      <div className="mt-2 h-3 w-full rounded bg-white/10" />
                      <div className="mt-2 h-3 w-2/3 rounded bg-white/10" />
                    </div>
                  ))}
                </div>
              ) : null}
              {scheduledCount === 0 && !upcomingLoading ? (
                <div className="text-center py-8 text-white/50">
                  <CalendarIcon className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No scheduled posts</p>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className={homeCardClass}>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Recent Posts</CardTitle>
            <CardDescription>Latest published notes</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
	              {postedPreview.map((job, idx) => (
	                  <div
	                    key={job.id}
	                    className={clsx(
	                      "group rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10 transition-colors cursor-pointer hover:bg-slate-950/80 hover:ring-white/20",
	                      idx >= 2 ? "hidden sm:block" : ""
	                    )}
	                    onClick={() => onOpenPreview?.(job)}
	                  >
                    <div className="flex items-start justify-between mb-2">
	                      {isRepostedJob(job) ? (
	                        <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/80 ring-1 ring-white/10">
	                          🔁 Repost
	                        </span>
	                      ) : null}
                      <span className="text-xs font-medium text-emerald-200">
                        {job.updatedAt ? formatTimeAgo(job.updatedAt) : "Posted"}
	                      </span>
	                    </div>
	                    <div className="text-sm text-white/80 overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] line-clamp-1 sm:line-clamp-2">
	                      {(getJobDisplayContent(job) || "").trim() || "Loading content…"}
	                    </div>
	                  </div>
	                ))}
              {postedCount === 0 && recentPostsLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="animate-pulse rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
                      <div className="flex items-center justify-between">
                        <div className="h-3 w-24 rounded bg-white/10" />
                        <div className="h-3 w-14 rounded bg-white/10" />
                      </div>
                      <div className="mt-2 h-3 w-full rounded bg-white/10" />
                      <div className="mt-2 h-3 w-2/3 rounded bg-white/10" />
                    </div>
                  ))}
                </div>
              ) : null}
              {postedCount === 0 && !recentPostsLoading ? (
                <div className="text-center py-8 text-white/50">
                  <CheckCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No posts yet</p>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className={homeCardClass}>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Recent Drafts</CardTitle>
            <CardDescription>Your latest drafts</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
	              {recentDrafts.map((draft, idx) => (
	                <div
	                  key={draft.id}
	                  className={clsx(
	                    "group rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10 transition-colors hover:bg-slate-950/80 hover:ring-white/20",
	                    idx >= 2 ? "hidden sm:block" : ""
	                  )}
	                >
	                  <div className="text-xs text-white/60 mb-1">
	                    {new Date(draft.updatedAt).toLocaleDateString()}
	                  </div>
	                  <div className="text-sm text-white/80 overflow-hidden break-all line-clamp-1 sm:line-clamp-2">
	                    {(draft.content || "").trim()}
	                  </div>
	                  <button
	                    onClick={() => useDraft(draft)}
                    className="mt-2 text-xs text-indigo-200 hover:text-indigo-100 font-medium"
                  >
                    Use draft →
                  </button>
                </div>
              ))}
              {draftsCount === 0 && recentDraftsLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="animate-pulse rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
                      <div className="flex items-center justify-between">
                        <div className="h-3 w-24 rounded bg-white/10" />
                        <div className="h-3 w-14 rounded bg-white/10" />
                      </div>
                      <div className="mt-2 h-3 w-full rounded bg-white/10" />
                      <div className="mt-2 h-3 w-2/3 rounded bg-white/10" />
                    </div>
                  ))}
                </div>
              ) : null}
              {draftsCount === 0 && !recentDraftsLoading ? (
                <div className="text-center py-8 text-white/50">
                  <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No drafts yet</p>
                </div>
              ) : null}
            </div>
          </CardContent>
	        </Card>
		      </div>

          <div className="flex justify-center">
            <div className="w-full max-w-2xl">
              <SupportZapFooter defaultSats={supportInvoiceSats} variant="compact" />
            </div>
          </div>

		    </div>
		  );
		}

function PostPreview({ content, manualTags, pubkey, when, addClientTag, nsfw, uploadTags = [] }) {
  const [previewEvent, setPreviewEvent] = useState(null);
  const tagList = useMemo(() => {
    if (!previewEvent?.tags) return [];
    return previewEvent.tags.filter((t) => t[0] === "t").map((t) => t[1]);
  }, [previewEvent]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const draft = buildDraftEvent({
          content,
          manualTags,
          uploadTags,
          addClientTag,
          nsfw,
        });
        draft.created_at = when ? Math.floor(new Date(when).getTime() / 1000) : draft.created_at;
        if (pubkey) draft.pubkey = pubkey;
        // Preview should not spam the signer; render unsigned
        if (!cancelled) setPreviewEvent(draft);
      } catch {
        if (!cancelled) setPreviewEvent(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, manualTags, uploadTags, addClientTag, nsfw, pubkey, when]);

  const lines = useMemo(() => (content || "").split(/\n/), [content]);

  return (
    <div className="rounded-3xl bg-slate-950/60 p-4 ring-1 ring-white/10">
      <div className="text-xs text-white/60">Scheduled · {formatDateTime(when)}</div>
      <div className="mt-1 text-[11px] text-white/60">
        {previewEvent?.id ? `Signed preview · ${previewEvent.id.slice(0, 8)}…` : "Unsigned preview"}
      </div>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed">
        <div className="space-y-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {lines.length === 0 && <div className="">Your post preview will appear here…</div>}
          {lines.map((line, lineIdx) => {
            const trimmed = line.trim();
            if (!trimmed) {
              return <div key={`gap-${lineIdx}`} className="h-2" />;
            }
            const tokens = tokenizeTextWithUrls(line);
            const inlineImages = extractImageUrls(line, { limit: 6 });
            const standaloneImage =
              tokens.length === 1 &&
              tokens[0]?.type === "url" &&
              isImageUrl(tokens[0]?.value) &&
              trimmed === tokens[0]?.value;

            if (standaloneImage) {
              return (
                <div key={`img-${lineIdx}`} className="rounded-2xl bg-black/20 p-2 ring-1 ring-white/10">
                  <img
                    src={tokens[0].value}
                    alt="upload preview"
                    className="w-full max-h-80 object-contain"
                    loading="lazy"
                  />
                </div>
              );
            }
            return (
              <div key={`line-${lineIdx}`} className="space-y-2">
                <div className="text-[15px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {tokens.map((token, idx) => {
                    if (!token?.value) return null;
                    if (token.type === "url") {
                      const href = token.value;
                      return (
                        <a
                          key={`${lineIdx}-${idx}`}
                          href={href}
                          className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {href}
                        </a>
                      );
                    }
                    return (
                      <span key={`${lineIdx}-${idx}`}>{token.value}</span>
                    );
                  })}
                </div>
                {inlineImages.length > 0 && (
                  <div className="space-y-2">
                    {inlineImages.map((url) => (
                      <div key={url} className="rounded-2xl bg-black/20 p-2 ring-1 ring-white/10">
                        <img src={url} alt="" className="w-full max-h-80 object-contain" loading="lazy" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {tagList.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {tagList.map((t) => (
            <span key={t} className="rounded-full bg-white/10 px-2 py-1 text-xs text-white/80 ring-1 ring-white/10">#{t}</span>
          ))}
        </div>
      )}
      <div className="mt-4 flex items-center gap-4 text-white/60">
        <div className="flex items-center gap-1 text-sm"><Heart size={16} /> 0</div>
        <div className="flex items-center gap-1 text-sm"><MessageSquare size={16} /> 0</div>
        <div className="flex items-center gap-1 text-sm"><Zap size={16} /> 0</div>
      </div>
    </div>
  );
}

function CalendarView({ now, setNow, monthDays, jobsByDay, onOpenReschedule, onOpenCancel }) {
  const monthName = now.toLocaleString(undefined, { month: "long", year: "numeric" });

  function go(delta) {
    const d = new Date(now);
    d.setMonth(d.getMonth() + delta);
    setNow(d);
  }

  const statusBadge = (status) => {
    const map = {
      scheduled: "bg-blue-100 text-blue-700 ring-blue-200",
      posted: "bg-green-100 text-green-700 ring-green-200",
      paused: "bg-amber-100 text-amber-700 ring-amber-200",
      canceled: "bg-red-100 text-red-700 ring-red-200",
      sent: "bg-green-100 text-green-700 ring-green-200",
      error: "bg-red-100 text-red-700 ring-red-200",
    };
    return map[status] || "bg-slate-100 text-slate-700 ring-slate-200";
  };

  return (
    <div className="grid gap-6">
      <Card className="rounded-3xl border-none bg-white/90 shadow-sm ring-1 ring-black/5">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Calendar</CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="rounded-xl" onClick={() => go(-1)}><ChevronLeft /></Button>
              <div className="rounded-xl bg-slate-100 px-3 py-1 text-sm font-medium">{monthName}</div>
              <Button variant="ghost" size="icon" className="rounded-xl" onClick={() => go(1)}><ChevronRight /></Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="">
          <div className="grid grid-cols-7 gap-2 text-center text-xs text-slate-500">
            {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => (<div key={d} className="py-1">{d}</div>))}
          </div>
          <div className="mt-2 grid grid-cols-7 gap-2">
            {monthDays.map(({ date, outside }, idx) => {
              const key = date.toDateString();
              const list = jobsByDay.get(key) || [];
              const isToday = new Date().toDateString() === key;
              const sorted = list.slice().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
              return (
                <div key={idx} className={clsx("rounded-xl border p-2 text-sm transition", outside ? "border-slate-200/60 text-slate-400" : "border-slate-200 bg-white hover:shadow-sm")}
                  style={{ background: list.length ? randomColorFromString(key) : undefined }}
                >
                  <div className="flex items-center justify-between">
                    <div className={clsx("h-6 w-6 rounded-md text-center text-[12px] leading-6", isToday ? "bg-[#1F1B16] font-semibold text-white" : "text-slate-700")}>{date.getDate()}</div>
                    {list.length > 0 && (
                      <Badge variant="secondary" className="rounded-md text-[10px]">{list.length}</Badge>
                    )}
                  </div>
                  {list.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {sorted.slice(0, 4).map((j) => (
                        <div
                          key={j.id}
                          className={clsx("flex items-center gap-2 truncate rounded-md px-2 py-1 text-[11px] ring-1 ring-black/5", "bg-white/80")}
                          title={`${formatDateTime(j.scheduledAt)} • ${j.status || "scheduled"} • ${j.content || ""}`}
                        >
                          <span className={clsx("rounded-sm px-1 py-[2px] text-[10px] font-semibold uppercase tracking-tight ring-1", statusBadge(j.status))}>
                            {j.status || "scheduled"}
                          </span>
                          <span className="font-medium">{new Date(j.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                          <span className="text-slate-500">·</span>
                          <span className="truncate">{j.content.trim().slice(0, 36) || "(empty)"}</span>
                        </div>
                      ))}
                      {sorted.length > 4 && (
                        <div className="text-[11px] text-slate-500">+{sorted.length - 4} more</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DraftsView({ drafts, onUse, onDelete, loading = false }) {
  const showLoading = Boolean(loading) && drafts.length === 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Drafts</CardTitle>
        <CardDescription className="">Encrypted drafts synced via Nostr relays</CardDescription>
      </CardHeader>
      <CardContent>
        {showLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="animate-pulse rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
                <div className="flex items-center justify-between">
                  <div className="h-3 w-24 rounded bg-white/10" />
                  <div className="h-7 w-7 rounded-xl bg-white/10" />
                </div>
                <div className="mt-3 h-3 w-full rounded bg-white/10" />
                <div className="mt-2 h-3 w-2/3 rounded bg-white/10" />
                <div className="mt-2 h-3 w-1/2 rounded bg-white/10" />
              </div>
            ))}
          </div>
        ) : drafts.length === 0 ? (
          <EmptyState title="No drafts yet" subtitle="Write something and hit 'Save draft'." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {drafts.map((d) => (
              <div key={d.id} className="group relative min-w-0 rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
                <div className="mb-2 flex items-center justify-between text-xs text-white/60">
                  <span>{new Date(d.updatedAt).toLocaleDateString()}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="rounded-lg opacity-60 hover:opacity-100"><MoreHorizontal /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel className="">Actions</DropdownMenuLabel>
                      <DropdownMenuSeparator className="" />
                      <DropdownMenuItem onClick={() => onUse(d)} className="text-indigo-200">Use in composer</DropdownMenuItem>
                      <DropdownMenuItem className="text-red-200" onClick={() => onDelete(d.id)}>
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="line-clamp-6 min-w-0 max-w-full overflow-hidden whitespace-pre-wrap break-words ![overflow-wrap:anywhere] text-sm leading-relaxed text-white/80">{d.content}</div>
                {d.tags && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {d.tags.split(",").map((t) => (
                      <span key={t} className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70 ring-1 ring-white/10">{t.trim()}</span>
                    ))}
                  </div>
                )}
                {(d.eventId || d.id) && (
                  <div className="absolute bottom-3 right-3">
                    <Tooltip content={<div className="max-w-xs break-all text-left">{d.eventId ? `Nostr Event ID: ${d.eventId}` : `Draft ID: ${d.id}`}</div>}>
                      <span className="cursor-pointer rounded-xl bg-white/10 px-2 py-1 text-[10px] font-semibold text-white/70 ring-1 ring-white/10 shadow-sm">
                        {d.eventId ? "Event ID" : "Draft ID"}
                      </span>
                    </Tooltip>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LoadMoreRow({ loading, hasMore, label, buttonLabel, onClick }) {
  if (!loading && !hasMore) return null;
  return (
    <div className="rounded-3xl bg-slate-900 p-4 ring-1 ring-white/10">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`h-9 w-9 rounded-2xl bg-slate-950/60 ${loading ? "animate-pulse" : ""}`} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-white/80">
              {loading ? label : "Ready"}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className={`h-2.5 w-44 rounded bg-white/10 ${loading ? "animate-pulse" : "opacity-60"}`} />
              <div className={`h-2.5 w-28 rounded bg-white/10 ${loading ? "animate-pulse" : "opacity-40"}`} />
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          loading={loading}
          busyText={label || "Loading…"}
          disabled={loading || !hasMore}
          onClick={onClick}
        >
          {loading ? "Loading…" : buttonLabel}
        </Button>
      </div>
    </div>
  );
}

function JobsView({
  jobs,
  now,
  profileRelays,
  onReschedule,
  onCancel,
  onRepost,
  onPauseResume,
  initialTab,
  onOpenPreview,
  mailboxCounts,
  queueHasMore,
  queueLoading,
  onLoadMoreQueue,
  postedHasMore,
  postedLoading,
  onLoadMorePosted
}) {
  const [activeTab, setActiveTab] = useState(initialTab === "posted" ? "posted" : "queue");

  const onCancelRef = useRef(onCancel);
  const onRescheduleRef = useRef(onReschedule);
  const onRepostRef = useRef(onRepost);
  const onOpenPreviewRef = useRef(onOpenPreview);
  useEffect(() => void (onCancelRef.current = onCancel), [onCancel]);
  useEffect(() => void (onRescheduleRef.current = onReschedule), [onReschedule]);
  useEffect(() => void (onRepostRef.current = onRepost), [onRepost]);
  useEffect(() => void (onOpenPreviewRef.current = onOpenPreview), [onOpenPreview]);

  const handleCancel = useCallback((job) => onCancelRef.current?.(job), []);
  const handleReschedule = useCallback((job) => onRescheduleRef.current?.(job), []);
  const handleRepost = useCallback((job) => onRepostRef.current?.(job), []);
  const handleOpenPreview = useCallback((job) => onOpenPreviewRef.current?.(job), []);

  // Filter jobs by status (memoized)
  const queuedJobs = useMemo(() => {
    return (Array.isArray(jobs) ? jobs : [])
      .filter((j) => j && (j.status === "scheduled" || j.status === "queued" || j.status === "paused" || j.status === "error"))
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  }, [jobs]);

  const postedJobs = useMemo(() => {
    return (Array.isArray(jobs) ? jobs : [])
      .filter((j) => j && (j.status === "posted" || j.status === "sent" || j.status === "published"))
      .sort((a, b) => new Date(b.updatedAt || b.scheduledAt) - new Date(a.updatedAt || a.scheduledAt));
  }, [jobs]);

  const tabs = [
    { id: "queue", label: "Queue", count: mailboxCounts?.queued ?? queuedJobs.length, jobs: queuedJobs },
    { id: "posted", label: "Posted", count: mailboxCounts?.posted ?? postedJobs.length, jobs: postedJobs },
  ];

  const currentJobs = tabs.find((t) => t.id === activeTab)?.jobs || [];
  const remoteCount = Number(activeTab === "queue" ? mailboxCounts?.queued : mailboxCounts?.posted) || 0;
  const showSkeleton = currentJobs.length === 0 && remoteCount > 0;
  const showEmpty =
    currentJobs.length === 0 &&
    !showSkeleton &&
    !(
      (activeTab === "posted" && (postedHasMore || postedLoading)) ||
      (activeTab === "queue" && (queueHasMore || queueLoading))
    );

  return (
    <div className="space-y-4">
      {/* Tab Navigation */}
      <div className="flex gap-1 rounded-3xl bg-slate-900 p-1 ring-1 ring-white/10">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition ${
              activeTab === tab.id
                ? "bg-slate-950 text-white ring-1 ring-white/10"
                : "text-white/70 hover:bg-white/5 hover:text-white"
            }`}
          >
            {tab.label}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                activeTab === tab.id
                  ? "bg-indigo-500/20 text-indigo-100 ring-1 ring-indigo-400/30"
                  : "bg-white/10 text-white/70 ring-1 ring-white/10"
              }`}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Jobs Grid */}
      {showSkeleton ? (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="animate-pulse rounded-3xl bg-slate-900 p-5 ring-1 ring-white/10">
              <div className="flex items-center justify-between">
                <div className="h-3 w-32 rounded bg-white/10" />
                <div className="h-8 w-16 rounded-2xl bg-white/10" />
              </div>
              <div className="mt-4 h-3 w-full rounded bg-white/10" />
              <div className="mt-2 h-3 w-5/6 rounded bg-white/10" />
              <div className="mt-2 h-3 w-2/3 rounded bg-white/10" />
              <div className="mt-6 h-10 w-full rounded-2xl bg-white/10" />
            </div>
          ))}
        </div>
      ) : showEmpty ? (
        <div className="rounded-3xl bg-slate-900 p-12 ring-1 ring-white/10">
          <EmptyState
            title={`No ${activeTab === "queue" ? "queued" : activeTab} posts`}
            subtitle={
              activeTab === "queue"
                ? "Schedule something from the Compose view."
                : `No ${activeTab} posts yet.`
            }
          />
        </div>
      ) : (
	        <JobsGrid
	          jobs={currentJobs}
	          profileRelays={profileRelays}
	          virtualize={currentJobs.length >= 160}
	          showActions={activeTab === "queue"}
	          onCancel={handleCancel}
	          onReschedule={handleReschedule}
          onRepost={handleRepost}
          onOpen={handleOpenPreview}
          footer={
            activeTab === "posted" ? (
              <LoadMoreRow
                loading={postedLoading}
                hasMore={postedHasMore}
                label="Loading older posts…"
                buttonLabel="Load older"
                onClick={onLoadMorePosted}
              />
            ) : (
              <LoadMoreRow
                loading={queueLoading}
                hasMore={queueHasMore}
                label="Loading future scheduled posts…"
                buttonLabel="Load further"
                onClick={onLoadMoreQueue}
              />
            )
          }
        />
      )}
    </div>
  );
}

function JobsGrid({ jobs = [], profileRelays, virtualize = false, showActions, onCancel, onReschedule, onRepost, onOpen, footer }) {
  if (!virtualize) {
    return (
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {jobs.map((job) => (
          <MemoJobCard
            key={job.id}
            job={job}
            onCancel={onCancel}
            onReschedule={onReschedule}
            onRepost={onRepost}
            onOpen={onOpen}
            showActions={showActions}
            profileRelays={profileRelays}
          />
        ))}
        {footer ? <div className="col-span-full">{footer}</div> : null}
      </div>
    );
  }

  return (
    <VirtualizedJobsGrid
      jobs={jobs}
      profileRelays={profileRelays}
      showActions={showActions}
      onCancel={onCancel}
      onReschedule={onReschedule}
      onRepost={onRepost}
      onOpen={onOpen}
      footer={footer}
    />
  );
}

function VirtualizedJobsGrid({ jobs = [], profileRelays, showActions, onCancel, onReschedule, onRepost, onOpen, footer }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width || 0);
    update();

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }

    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const columns = width >= 1280 ? 3 : width >= 1024 ? 2 : 1;
  const rowCount = Math.ceil((Array.isArray(jobs) ? jobs.length : 0) / columns);

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => 360,
    overscan: 6,
    scrollMargin: containerRef.current?.offsetTop ?? 0,
  });

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div ref={containerRef} className="w-full">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualRows.map((row) => {
          const startIndex = row.index * columns;
          const rowJobs = jobs.slice(startIndex, startIndex + columns);
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={row.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
	              <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
	                {rowJobs.map((job) => (
	                  <MemoJobCard
	                    key={job.id}
	                    job={job}
	                    onCancel={onCancel}
	                    onReschedule={onReschedule}
	                    onRepost={onRepost}
	                    onOpen={onOpen}
	                    showActions={showActions}
	                    profileRelays={profileRelays}
	                  />
	                ))}
	              </div>
            </div>
          );
        })}
      </div>
      {footer ? <div className="mt-4">{footer}</div> : null}
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    scheduled: { text: "Scheduled", class: "bg-slate-900 text-white" },
    paused: { text: "Paused", class: "bg-amber-500 text-white" },
    canceled: { text: "Canceled", class: "bg-red-500 text-white" },
    posted: { text: "Posted", class: "bg-green-600 text-white" },
    sent: { text: "Sent", class: "bg-green-600 text-white" },
    error: { text: "Error", class: "bg-red-600 text-white" },
  };
  const s = map[status] || map.scheduled;
  return <span className={clsx("rounded-lg px-2 py-1 text-xs", s.class)}>{s.text}</span>;
}

function EmptyState({ title, subtitle, cta, onClick }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-white/15 bg-slate-900/60 p-10 text-center">
      <div className="mb-3 rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
        <PenSquare className="h-5 w-5 text-white/80" />
      </div>
      <div className="text-lg font-semibold">{title}</div>
      <div className="mt-1 text-sm text-white/60">{subtitle}</div>
      {cta && (
        <Button className="mt-4" onClick={onClick}>{cta}</Button>
      )}
    </div>
  );
}
