import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X, Clock, Image, Eye, EyeOff, Settings2 } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Uploader } from "@/components/Uploader.jsx";
import EmojiPickerButton from "@/components/EmojiPickerButton.jsx";
import { extractImageUrls, isImageUrl, tokenizeTextWithUrls } from "@/utils/contentUrls.js";
import type { CalendarEvent } from "./types";
import { toZonedDate } from "./utils";

// PostPreview component copied from App.jsx
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
        // Import the buildDraftEvent function
        const { buildDraftEvent } = await import("@/lib/draft.js");
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

  function formatDateTime(when) {
    if (!when) return null;
    const date = new Date(when);
    return date.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  return (
    <div className="rounded-3xl bg-slate-950/60 p-4 ring-1 ring-white/10">
      {when && (
        <>
          <div className="text-xs text-white/60">Scheduled · {formatDateTime(when)}</div>
          <div className="mt-1 text-[11px] text-white/60">
            {previewEvent?.id ? `Signed preview · ${previewEvent.id.slice(0, 8)}…` : "Unsigned preview"}
          </div>
        </>
      )}
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed">
        <div className="space-y-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {lines.length === 0 && <div className="">Your post preview will appear here…</div>}
          {lines.map((line, lineIdx) => {
            const trimmed = line.trim();
            if (!trimmed) return <div key={`gap-${lineIdx}`} className="h-2" />;

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
                    return <span key={`${lineIdx}-${idx}`}>{token.value}</span>;
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
        <div className="mt-3 flex flex-wrap gap-1">
          {tagList.map((tag) => (
            <span key={tag} className="rounded-full bg-white/10 px-2 py-1 text-xs text-white/80 ring-1 ring-white/10">
              #{tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface EventComposerProps {
  open: boolean;
  start: Date;
  end: Date;
  timezone: string;
  onClose: () => void;
  onSave: (payload: Partial<CalendarEvent>) => void | Promise<void>;
  pubkey?: string;
  nip96Service?: string;
  uploadBackend?: string;
  blossomServers?: string;
  uploads?: Array<{ file: File; name: string; progress: number; cancel?: () => void }>;
  onUploadStart?: (file: File, cancel: () => void) => void;
  onUploadProgress?: (file: File, progress: number) => void;
  onUploadEnd?: (file: File) => void;
  onUploadSuccess?: (result: { url: string; tags: string[] }) => void;
  onUploadError?: (error: string) => void;
}

function toInputValue(date: Date, tz: string) {
  const zoned = toZonedDate(date, tz);
  return format(zoned, "yyyy-MM-dd'T'HH:mm");
}

function parseInputValue(value: string, tz: string) {
  if (!value) return null;
  const local = new Date(value);
  return toZonedDate(local, tz);
}

export function EventComposer({
  open,
  start,
  end,
  timezone,
  onClose,
  onSave,
  pubkey,
  nip96Service,
  uploadBackend,
  blossomServers,
  uploads = [],
  onUploadStart,
  onUploadProgress,
  onUploadEnd,
  onUploadSuccess,
  onUploadError
}: EventComposerProps) {
  const [content, setContent] = useState("");
  const [scheduleAt, setScheduleAt] = useState<string>(() => toInputValue(start, timezone));
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [addClientTag, setAddClientTag] = useState(true);
  const [nsfw, setNsfw] = useState(false);
  const [uploadTagStore] = useState(() => new Map());
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setScheduleAt(toInputValue(start, timezone));
  }, [start, timezone]);

  const portalTarget = typeof document !== "undefined" ? document.body : null;
  const parsedStart = useMemo(() => parseInputValue(scheduleAt, timezone) || start, [scheduleAt, start, timezone]);

  const collectUploadTags = (content) => {
    const list = [];
    uploadTagStore.forEach((tags, url) => {
      if (content.includes(url)) {
        list.push(...tags);
      }
    });
    return list;
  };

  const handleUploadSuccess = ({ url, tags }) => {
    if (tags && tags.length) {
      uploadTagStore.set(url, tags);
    }
    setContent((prev) => prev ? `${prev}\n${url}` : url);
    onUploadSuccess?.({ url, tags });
  };

  const insertEmoji = (emoji: string) => {
    if (!emoji) return;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? content.length;
    const end = el?.selectionEnd ?? start;
    const next = content.slice(0, start) + emoji + content.slice(end);
    const nextCursor = start + emoji.length;
    setContent(next);
    requestAnimationFrame(() => {
      if (!el) return;
      try {
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
      } catch {}
    });
  };

  if (!portalTarget) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            className="fixed inset-x-4 top-16 z-50 mx-auto max-w-xl rounded-3xl bg-slate-900 text-white shadow-2xl ring-1 ring-white/10"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-white/60">Create</div>
                <div className="font-display text-lg font-semibold text-white">
                  {format(parsedStart, "MMM d, yyyy")} · {timezone.split("/")[1] || timezone}
                </div>
              </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="rounded-lg"
                title={isPreviewMode ? "Back to edit" : "Preview"}
                onClick={() => setIsPreviewMode((v) => !v)}
              >
                {isPreviewMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <button
                onClick={onClose}
                className="rounded-xl p-2 text-white/60 transition hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            </div>

            <div className="p-6 pt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Uploader
                    onUploadStart={onUploadStart}
                    onUploadProgress={onUploadProgress}
                    onUploadEnd={onUploadEnd}
                    onUploadSuccess={handleUploadSuccess}
                    onUploadError={onUploadError}
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
                    disabled={isPreviewMode}
                    onSelect={(emoji: string) => insertEmoji(emoji)}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="rounded-xl"
                    title="Options"
                    onClick={() => setOptionsOpen(true)}
                  >
                    <Settings2 className="h-4 w-4" />
                  </Button>
                </div>

                <Input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="!w-auto min-w-[200px]"
                />
              </div>

              {!isPreviewMode ? (
                <>
                  <Textarea
                    className="!min-h-[180px] resize-none"
                    placeholder="Type to schedule your thoughts on Nostr!"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    ref={textareaRef}
                  />

                  {uploads.length > 0 && (
                    <div className="rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
                      <div className="text-xs font-semibold text-white/70 mb-2">Uploads</div>
                      <div className="space-y-2">
                        {uploads.map((u, idx) => (
                          <div key={`${u.name}-${idx}`} className="flex items-center gap-2 text-xs">
                            <div className="truncate flex-1">{u.name}</div>
                            <div className="w-24 bg-white/10 h-1 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-indigo-400 transition-all duration-300"
                                style={{ width: `${u.progress}%` }}
                              />
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
                </>
              ) : (
                <PostPreview
                  content={content}
                  manualTags={[]}
                  pubkey={pubkey}
                  when={parsedStart.toISOString()}
                  addClientTag={addClientTag}
                  nsfw={nsfw}
                  uploadTags={collectUploadTags(content)}
                />
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={onClose}
                >
                  Cancel
                </Button>
                <Button
                  loading={saving}
                  busyText="Scheduling…"
                  onClick={async () => {
                    if (saving) return;
                    const parsedDate = parseInputValue(scheduleAt, timezone) || start;
                    // Create end date 30 minutes after start
                    const endDate = new Date(parsedDate);
                    endDate.setMinutes(endDate.getMinutes() + 30);

                    const payload: Partial<CalendarEvent> = {
                      title: content.slice(0, 80) || "Untitled",
                      caption: content,
                      start: parsedDate.toISOString(),
                      end: endDate.toISOString(),
                      timezone,
                      status: "scheduled",
                      color: "sky",
                      addClientTag,
                      nsfw
                    };

                    setSaving(true);
                    try {
                      await onSave(payload);
                    } finally {
                      if (mountedRef.current) setSaving(false);
                    }
                  }}
                >
                  <Clock className="mr-2 h-4 w-4" /> Schedule
                </Button>
              </div>
            </div>
          </motion.div>

          <Dialog open={optionsOpen} onOpenChange={setOptionsOpen}>
            <DialogContent className="rounded-3xl">
              <DialogHeader>
                <DialogTitle>Post options</DialogTitle>
                <DialogDescription>Tune tagging before scheduling.</DialogDescription>
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
        </>
      ) : null}
    </AnimatePresence>,
    portalTarget
  );
}

export default EventComposer;
