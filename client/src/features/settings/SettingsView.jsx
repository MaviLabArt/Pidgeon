import React from "react";
import { HelpCircle } from "lucide-react";
import { nip19 } from "nostr-tools";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip.jsx";
import { parseRelayListText } from "@/utils/relayUrls.js";

const LS_DVM_PUBKEY = "pidgeon.dvm.pubkey";
const LS_DVM_RELAYS = "pidgeon.dvm.relays";

function normalizeDvmPubkeyInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded.type === "npub" && typeof decoded.data === "string") return decoded.data;
    } catch {
      return raw;
    }
  }
  return raw;
}

function isHexPubkey(value) {
  return /^[0-9a-f]{64}$/i.test(String(value || "").trim());
}

export function SettingsView({
  theme = "dark",
  setTheme,
  mediaServersMode = "my",
  setMediaServersMode,
  mediaServersPrefer = "blossom",
  setMediaServersPrefer,
  nip96Service,
  setNip96Service,
  uploadBackend,
  setUploadBackend,
  blossomServers,
  setBlossomServers,
  recommendedNip96Services = "https://nostr.build",
  recommendedBlossomServers = "",
  nostrMediaServersBlossom = [],
  nostrMediaServersNip96 = [],
  nostrMediaServersStatus = "idle",
  nostrMediaServersError = "",
  onRefreshNostrMediaServers,
  effectiveMediaUpload,
  publishRelaysMode,
  setPublishRelaysMode,
  publishRelaysCustom,
  setPublishRelaysCustom,
  recommendedPublishRelays = [],
  nip65PublishRelays = [],
  nip65PublishRelaysStatus = "idle",
  nip65PublishRelaysError = "",
  onRefreshNip65PublishRelays,
  relaysLocked = false,
  analyticsEnabled = false,
  setAnalyticsEnabled,
  supportIsSupporter = false,
  supporterUntil = 0,
  dvmPubkeyOverride = "",
  setDvmPubkeyOverride,
  dvmRelaysOverride = "",
  setDvmRelaysOverride,
  pubkey,
  settingsSync,
  settingsDirty = false,
  onLoadNostrSettings,
  onSaveNostrSettings,
  onOpenHowItWorks,
  onRepairMailbox,
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const supporterUntilSec = Math.max(0, Math.floor(Number(supporterUntil) || 0));
  const isSupporterNow = Boolean(supportIsSupporter) && supporterUntilSec > nowSec;
  const supporterUntilLabel = (() => {
    if (!supporterUntilSec) return "";
    try {
      return new Date(supporterUntilSec * 1000).toLocaleString();
    } catch {
      return "";
    }
  })();

  const canSync = Boolean(pubkey);
  const syncStatus = settingsSync?.status || "idle";
  const saving = syncStatus === "saving";
  const loading = syncStatus === "loading";
  const syncError = String(settingsSync?.error || "").trim();
  const hasRemote = Boolean(settingsSync?.eventId);
  const saveDisabled = !canSync || saving || (!settingsDirty && hasRemote);
  const loadDisabled = !canSync || loading || saving;
  const syncStateLabel = (() => {
    if (!canSync) return "Connect a signer to sync across devices.";
    if (loading) return "Loading…";
    if (saving) return "Saving…";
    if (syncError) return syncError;
    if (!hasRemote) return "Not saved yet";
    return settingsDirty ? "Unsaved changes" : "Up to date";
  })();
  const customPreview = parseRelayListText(publishRelaysCustom || "", { max: 20 });
  const recommendedRelays = Array.from(new Set((recommendedPublishRelays || []).filter(Boolean)));
  const nip65Relays = Array.from(new Set((nip65PublishRelays || []).filter(Boolean)));
  const customRelays = Array.from(new Set((customPreview.relays || []).filter(Boolean)));
  const effectivePublishRelays = (() => {
    if (publishRelaysMode === "custom") return customRelays.length ? customRelays : recommendedRelays;
    if (publishRelaysMode === "nip65") return nip65Relays.length ? nip65Relays : recommendedRelays;
    return recommendedRelays;
  })();
  const publishRelayNote = (() => {
    if (publishRelaysMode === "custom") {
      if (customRelays.length) return "";
      return "No valid custom relays; falling back to recommended.";
    }
    if (publishRelaysMode === "nip65") {
      if (nip65Relays.length) return "";
      return "No NIP-65 relay list found; falling back to recommended.";
    }
    return "";
  })();

  const normalizeHttpOrigin = (input) => {
    const trimmed = String(input || "").trim();
    if (!trimmed) return "";
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(withScheme);
      if (url.username || url.password) return "";
      if (!["https:", "http:"].includes(url.protocol)) return "";
      return url.origin;
    } catch {
      return "";
    }
  };

  const parseServerList = (input, { max = 20 } = {}) => {
    const lines = String(input || "")
      .split(/[\n,]/)
      .map((s) => normalizeHttpOrigin(s))
      .filter(Boolean);
    const seen = new Set();
    const servers = [];
    for (const s of lines) {
      if (seen.has(s)) continue;
      seen.add(s);
      servers.push(s);
    }
    return servers.slice(0, max);
  };

  const recommendedNip96List = React.useMemo(
    () => parseServerList(recommendedNip96Services, { max: 20 }),
    [recommendedNip96Services]
  );
  const customNip96List = React.useMemo(() => parseServerList(nip96Service, { max: 20 }), [nip96Service]);
  const customBlossomList = React.useMemo(() => parseServerList(blossomServers, { max: 20 }), [blossomServers]);
  const nostrBlossomList = React.useMemo(
    () => Array.from(new Set((Array.isArray(nostrMediaServersBlossom) ? nostrMediaServersBlossom : []).filter(Boolean))),
    [nostrMediaServersBlossom]
  );
  const nostrNip96List = React.useMemo(
    () => Array.from(new Set((Array.isArray(nostrMediaServersNip96) ? nostrMediaServersNip96 : []).filter(Boolean))),
    [nostrMediaServersNip96]
  );
  const hasNostrBlossom = nostrBlossomList.length > 0;
  const hasNostrNip96 = nostrNip96List.length > 0;
  const effectiveUploadBackend = String(effectiveMediaUpload?.backend || "").trim() || "nip96";
  const effectiveNote = String(effectiveMediaUpload?.note || "").trim();

  const dvmRelaysPreview = React.useMemo(
    () => parseRelayListText(dvmRelaysOverride || "", { max: 20, allowWs: true }),
    [dvmRelaysOverride]
  );
  const normalizedDvmPubkey = normalizeDvmPubkeyInput(dvmPubkeyOverride);
  const dvmPubkeyLooksValid = !normalizedDvmPubkey || isHexPubkey(normalizedDvmPubkey);
  const [repairingMailbox, setRepairingMailbox] = React.useState(""); // "" | "queue" | "full"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Settings</CardTitle>
        <CardDescription className="">Preferences</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isSupporterNow ? (
          <div className="rounded-2xl bg-emerald-950/50 p-4 ring-1 ring-emerald-500/20">
            <div className="text-sm font-medium text-emerald-200">Thank you for supporting Pidgeon!</div>
            {supporterUntilLabel ? (
              <div className="mt-1 text-xs text-emerald-100/70">Supporter until {supporterUntilLabel}</div>
            ) : null}
          </div>
        ) : null}

        <div className="rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Appearance</div>
              <div className="mt-1 text-[11px] text-white/60">Switch between Dark Ink and Light Atelier.</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/60">Light</span>
              <Switch
                checked={theme === "light"}
                onCheckedChange={(on) => setTheme?.(on ? "light" : "dark")}
              />
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-white/90">How it works</div>
              <div className="mt-1 text-xs text-white/60">
                A quick explainer of the mailbox scheduler, privacy, and DM previews.
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenHowItWorks?.()}>
              <HelpCircle className="mr-2 h-4 w-4" /> Open
            </Button>
          </div>
        </div>

        <div className="rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Media servers</div>
            <Tooltip
              content={
                <div className="max-w-[260px]">
                  Pidgeon can upload media using either NIP-96 (file servers) or Blossom (BUD-03). When available, your
                  server lists are pulled from kind:10096 and kind:10063.
                </div>
              }
            >
              <button type="button" className="text-xs text-white/50 hover:text-white/80">
                What’s this?
              </button>
            </Tooltip>
          </div>

          <div className="grid gap-2">
            <label className="flex items-start gap-3 rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10">
              <input
                type="radio"
                name="mediaServersMode"
                value="my"
                checked={mediaServersMode === "my"}
                onChange={() => setMediaServersMode?.("my")}
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">My servers (kinds 10063/10096) (default)</div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onRefreshNostrMediaServers?.()}
                    disabled={!pubkey || nostrMediaServersStatus === "loading"}
                  >
                    Refresh
                  </Button>
                </div>
                <div className="text-xs text-white/60">
                  Uses your Blossom list (kind:10063) or NIP-96 list (kind:10096). Blossom is preferred when both exist.
                </div>

                {nostrMediaServersStatus === "loading" && <div className="mt-2 text-[11px] text-white/50">Loading…</div>}
                {nostrMediaServersError ? <div className="mt-2 text-[11px] text-red-200">{nostrMediaServersError}</div> : null}
                {!pubkey ? (
                  <div className="mt-2 text-[11px] text-white/50">Connect a signer to load your server lists.</div>
                ) : null}

                {mediaServersMode === "my" && (hasNostrBlossom || hasNostrNip96) ? (
                  <div className="mt-2 space-y-2">
                    {hasNostrBlossom && hasNostrNip96 ? (
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setMediaServersPrefer?.("blossom")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
                            mediaServersPrefer !== "nip96"
                              ? "bg-emerald-500/15 text-emerald-100 ring-emerald-400/30"
                              : "bg-white/5 text-white/70 ring-white/10 hover:bg-white/10 hover:text-white"
                          }`}
                        >
                          Blossom (10063)
                        </button>
                        <button
                          type="button"
                          onClick={() => setMediaServersPrefer?.("nip96")}
                          className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
                            mediaServersPrefer === "nip96"
                              ? "bg-indigo-500/15 text-indigo-100 ring-indigo-400/30"
                              : "bg-white/5 text-white/70 ring-white/10 hover:bg-white/10 hover:text-white"
                          }`}
                        >
                          NIP-96 (10096)
                        </button>
                      </div>
                    ) : null}

                    <div className="grid gap-2 sm:grid-cols-2">
                      <div
                        className={`rounded-2xl bg-slate-950/50 p-3 ring-1 ${
                          effectiveUploadBackend === "blossom" ? "ring-emerald-400/20" : "ring-white/10"
                        }`}
                      >
                        <div className="text-[11px] text-white/60">Blossom (kind:10063)</div>
                        <div className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[11px] text-white/80">
                          {hasNostrBlossom ? (
                            nostrBlossomList.map((url) => (
                              <div key={url} className="break-all">
                                {url}
                              </div>
                            ))
                          ) : (
                            <div className="text-white/50">Not found</div>
                          )}
                        </div>
                      </div>

                      <div
                        className={`rounded-2xl bg-slate-950/50 p-3 ring-1 ${
                          effectiveUploadBackend === "nip96" ? "ring-indigo-400/20" : "ring-white/10"
                        }`}
                      >
                        <div className="text-[11px] text-white/60">NIP-96 (kind:10096)</div>
                        <div className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[11px] text-white/80">
                          {hasNostrNip96 ? (
                            nostrNip96List.map((url) => (
                              <div key={url} className="break-all">
                                {url}
                              </div>
                            ))
                          ) : (
                            <div className="text-white/50">Not found</div>
                          )}
                        </div>
                      </div>
                    </div>

                    {effectiveNote ? <div className="text-[11px] text-white/60">{effectiveNote}</div> : null}
                  </div>
                ) : null}

                {mediaServersMode === "my" && pubkey && !hasNostrBlossom && !hasNostrNip96 && nostrMediaServersStatus !== "loading" ? (
                  <div className="mt-2 text-[11px] text-white/60">
                    No kind:10063 or kind:10096 found yet; falling back to recommended.
                  </div>
                ) : null}
              </div>
            </label>

            <label className="flex items-start gap-3 rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10">
              <input
                type="radio"
                name="mediaServersMode"
                value="recommended"
                checked={mediaServersMode === "recommended"}
                onChange={() => setMediaServersMode?.("recommended")}
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Recommended</div>
                <div className="text-xs text-white/60">Uses a default NIP-96 service (fastest setup).</div>
                {mediaServersMode === "recommended" && (
                  <div className="mt-2 rounded-2xl bg-slate-950/50 p-3 ring-1 ring-white/10">
                    <div className="text-[11px] text-white/60">Will upload via NIP-96</div>
                    <div className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[11px] text-white/80">
                      {(recommendedNip96List.length ? recommendedNip96List : [recommendedNip96Services]).map((url) => (
                        <div key={url} className="break-all">
                          {url}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </label>

            <label className="flex items-start gap-3 rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10">
              <input
                type="radio"
                name="mediaServersMode"
                value="custom"
                checked={mediaServersMode === "custom"}
                onChange={() => setMediaServersMode?.("custom")}
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Custom</div>
                <div className="text-xs text-white/60">Bring your own servers.</div>
                {mediaServersMode === "custom" && (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="text-[11px] text-white/60">Upload via</div>
                      <select
                        value={uploadBackend}
                        onChange={(e) => setUploadBackend?.(e.target.value)}
                        className="h-9 rounded-xl bg-slate-950 px-3 text-xs text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      >
                        <option value="nip96">NIP-96</option>
                        <option value="blossom">Blossom</option>
                      </select>
                    </div>

                    {uploadBackend === "blossom" ? (
                      <>
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[11px] text-white/60">Blossom servers (one per line)</div>
                          {recommendedBlossomServers ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setBlossomServers?.(recommendedBlossomServers)}
                            >
                              Use defaults
                            </Button>
                          ) : null}
                        </div>
                        <Textarea
                          value={blossomServers}
                          onChange={(e) => setBlossomServers?.(e.target.value)}
                          className="!min-h-[96px]"
                          placeholder={"https://blossom.example\nhttps://cdn.blossom.example"}
                        />
                        <div className="rounded-2xl bg-slate-950/50 p-3 ring-1 ring-white/10">
                          <div className="text-[11px] text-white/60">
                            {customBlossomList.length ? "Will upload via Blossom to" : "Add at least one Blossom server"}
                          </div>
                          <div className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[11px] text-white/80">
                            {customBlossomList.length ? (
                              customBlossomList.map((url) => (
                                <div key={url} className="break-all">
                                  {url}
                                </div>
                              ))
                            ) : (
                              <div className="text-white/50">No servers configured</div>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[11px] text-white/60">NIP-96 servers (one per line)</div>
                          {recommendedNip96Services ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setNip96Service?.(recommendedNip96Services)}
                            >
                              Use defaults
                            </Button>
                          ) : null}
                        </div>
                        <Textarea
                          value={nip96Service}
                          onChange={(e) => setNip96Service?.(e.target.value)}
                          className="!min-h-[96px]"
                          placeholder={"https://nostr.build\nhttps://file.server.one"}
                        />
                        <div className="rounded-2xl bg-slate-950/50 p-3 ring-1 ring-white/10">
                          <div className="text-[11px] text-white/60">
                            {customNip96List.length ? "Will upload via NIP-96 to" : "Add at least one NIP-96 server"}
                          </div>
                          <div className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[11px] text-white/80">
                            {customNip96List.length ? (
                              customNip96List.map((url) => (
                                <div key={url} className="break-all">
                                  {url}
                                </div>
                              ))
                            ) : (
                              <div className="text-white/50">No servers configured</div>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </label>
          </div>

          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setMediaServersMode?.("recommended")}>
              Reset to recommended
            </Button>
          </div>
        </div>

        <div className="rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Publish relays</div>
            <Tooltip
              content={
                <div className="max-w-[260px]">
                  Where the DVM will publish scheduled notes. This is separate from mailbox relays (used for scheduling + status).
                </div>
              }
            >
              <button type="button" className="text-xs text-white/50 hover:text-white/80">
                What’s this?
              </button>
            </Tooltip>
          </div>

          <div className="grid gap-2">
	            <label className="flex items-start gap-3 rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10">
	              <input
	                type="radio"
	                name="publishRelaysMode"
	                value="recommended"
	                checked={publishRelaysMode === "recommended"}
	                onChange={() => setPublishRelaysMode?.("recommended")}
	                className="mt-1"
	              />
	              <div className="min-w-0">
	                <div className="text-sm font-medium">Recommended</div>
	                <div className="text-xs text-white/60">DVM curated publish relay set (fallback).</div>
	                {publishRelaysMode === "recommended" && (
	                  <div className="mt-2 rounded-2xl bg-slate-950/50 p-3 ring-1 ring-white/10">
	                    <div className="text-[11px] text-white/60">Will publish to</div>
                    <div className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[11px] text-white/80">
                      {effectivePublishRelays.map((url) => (
                        <div key={url} className="break-all">
                          {url}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </label>

            <label className="flex items-start gap-3 rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10">
              <input
                type="radio"
                name="publishRelaysMode"
                value="nip65"
                checked={publishRelaysMode === "nip65"}
                onChange={() => setPublishRelaysMode?.("nip65")}
                className="mt-1"
              />
	              <div className="min-w-0">
	                <div className="flex items-center justify-between gap-2">
	                  <div className="text-sm font-medium">My relays (NIP-65) (default)</div>
	                  <Button
	                    type="button"
	                    variant="outline"
	                    size="sm"
                    onClick={() => onRefreshNip65PublishRelays?.()}
                    disabled={!pubkey || nip65PublishRelaysStatus === "loading"}
                  >
                    Refresh
                  </Button>
                </div>
                <div className="text-xs text-white/60">Uses your kind:10002 write relays (or those without a marker).</div>
                {nip65PublishRelaysStatus === "loading" && <div className="mt-2 text-[11px] text-white/50">Loading…</div>}
                {nip65PublishRelaysError ? (
                  <div className="mt-2 text-[11px] text-red-200">{nip65PublishRelaysError}</div>
                ) : null}
                {publishRelaysMode === "nip65" && (
                  <div className="mt-2 rounded-2xl bg-slate-950/50 p-3 ring-1 ring-white/10">
                    <div className="text-[11px] text-white/60">{publishRelayNote ? publishRelayNote : "Will publish to"}</div>
                    <div className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[11px] text-white/80">
                      {effectivePublishRelays.map((url) => (
                        <div key={url} className="break-all">
                          {url}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </label>

            <label className="flex items-start gap-3 rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10">
              <input
                type="radio"
                name="publishRelaysMode"
                value="custom"
                checked={publishRelaysMode === "custom"}
                onChange={() => setPublishRelaysMode?.("custom")}
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Custom</div>
                <div className="text-xs text-white/60">One relay per line.</div>
                {publishRelaysMode === "custom" && (
                  <div className="mt-2 space-y-2">
                    <Textarea
                      value={publishRelaysCustom || ""}
                      onChange={(e) => setPublishRelaysCustom?.(e.target.value)}
                      className="!min-h-[96px]"
                      placeholder={"wss://relay.example\nwss://nos.lol"}
                    />
                    <div className="rounded-2xl bg-slate-950/50 p-3 ring-1 ring-white/10">
                      <div className="text-[11px] text-white/60">
                        {publishRelayNote ? publishRelayNote : "Will publish to"}
                        {customPreview.invalid?.length ? ` (${customPreview.invalid.length} invalid line(s) ignored)` : ""}
                      </div>
                      <div className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[11px] text-white/80">
                        {effectivePublishRelays.map((url) => (
                          <div key={url} className="break-all">
                            {url}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </label>
          </div>

          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setPublishRelaysMode?.("recommended");
                setPublishRelaysCustom?.("");
              }}
            >
              Reset to recommended
            </Button>
          </div>
        </div>

        <div className="rounded-2xl bg-slate-950/60 p-4 ring-1 ring-white/10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-white/90">Sync Settings</div>
              <div className={`mt-2 text-xs ${syncError ? "text-red-200" : "text-white/70"}`}>{syncStateLabel}</div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onLoadNostrSettings?.()}
                loading={loading}
                busyText="Loading…"
                disabled={loadDisabled}
              >
                Load
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => onSaveNostrSettings?.()}
                loading={saving}
                busyText="Saving…"
                disabled={saveDisabled}
              >
                Save
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Experimental</div>
            <div className="text-xs text-white/40">Optional features</div>
          </div>
          <div className="flex items-center justify-between rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10">
            <div>
              <div className="text-sm font-medium">Analytics</div>
              <div className="text-xs text-white/60">Fetch likes/replies/zaps from relays (extra traffic).</div>
            </div>
            <Switch checked={analyticsEnabled} onCheckedChange={(v) => setAnalyticsEnabled?.(Boolean(v))} />
          </div>
        </div>

        <details className="rounded-2xl bg-slate-950/60 p-3 ring-1 ring-white/10">
          <summary className="cursor-pointer select-none text-sm font-medium text-white/90">Advanced</summary>
          <div className="mt-3 space-y-3">
            <div className="text-sm font-medium text-white/90">Scheduler DVM</div>
            <div className="text-xs text-white/60">
              Override the default Pidgeon DVM for this browser (useful for self-hosting). Changes apply after reload.
            </div>

            <div className="rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10 space-y-2">
              <div className="text-sm font-medium">DVM pubkey</div>
              <div className="text-[11px] text-white/60">Paste an `npub…` or hex pubkey. Leave empty to use default.</div>
              <Input
                value={dvmPubkeyOverride}
                onChange={(e) => setDvmPubkeyOverride?.(e.target.value)}
                placeholder="npub…"
                className={`font-mono ${dvmPubkeyLooksValid ? "" : "ring-2 ring-red-400"}`}
              />
              {!dvmPubkeyLooksValid ? (
                <div className="text-[11px] text-red-200">Invalid pubkey (expected `npub…` or 64-char hex).</div>
              ) : null}
            </div>

            <div className="rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10 space-y-2">
              <div className="text-sm font-medium">DVM relays</div>
              <div className="text-[11px] text-white/60">Optional. One relay per line. Leave empty to use default.</div>
              <Textarea
                value={dvmRelaysOverride}
                onChange={(e) => setDvmRelaysOverride?.(e.target.value)}
                className="!min-h-[96px] font-mono"
                placeholder={"wss://relay.example\nwss://nos.lol"}
              />
              <div className="text-[11px] text-white/60">
                {dvmRelaysPreview.invalid?.length ? `${dvmRelaysPreview.invalid.length} invalid line(s) ignored.` : ""}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  try {
                    localStorage.removeItem(LS_DVM_PUBKEY);
                    localStorage.removeItem(LS_DVM_RELAYS);
                  } catch {}
                  setDvmPubkeyOverride?.("");
                  setDvmRelaysOverride?.("");
                }}
              >
                Reset to default
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!dvmPubkeyLooksValid}
                onClick={() => {
                  try {
                    const pk = normalizeDvmPubkeyInput(dvmPubkeyOverride);
                    if (pk) localStorage.setItem(LS_DVM_PUBKEY, pk);
                    else localStorage.removeItem(LS_DVM_PUBKEY);
                    setDvmPubkeyOverride?.(pk);

                    const relays = parseRelayListText(dvmRelaysOverride || "", { max: 50, allowWs: true }).relays || [];
                    const nextRelaysText = relays.join("\n");
                    if (relays.length) localStorage.setItem(LS_DVM_RELAYS, nextRelaysText);
                    else localStorage.removeItem(LS_DVM_RELAYS);
                    setDvmRelaysOverride?.(nextRelaysText);
                  } catch {}
                  try {
                    window.location.reload();
                  } catch {}
                }}
              >
                Apply & reload
              </Button>
            </div>

	            <div className="rounded-2xl bg-slate-900 p-3 ring-1 ring-white/10 space-y-2">
	              <div className="flex flex-wrap items-start justify-between gap-3">
	                <div className="min-w-0">
	                  <div className="text-sm font-medium">Repair job ledger</div>
	                </div>
                  <div className="flex flex-wrap gap-2">
	                  <Button
	                    type="button"
	                    size="sm"
	                    variant="outline"
                      loading={repairingMailbox === "queue"}
	                    busyText="Requesting…"
	                    disabled={!pubkey || !onRepairMailbox || Boolean(repairingMailbox)}
	                    onClick={async () => {
	                      if (!onRepairMailbox) return;
	                      const ok = window.confirm(
	                        "Repair scheduled jobs only? Recommended not to unless something is broken."
	                      );
	                      if (!ok) return;
	                      setRepairingMailbox("queue");
	                      try {
	                        await onRepairMailbox({ scope: "queue" });
	                      } finally {
	                        setRepairingMailbox("");
	                      }
	                    }}
	                  >
	                    Repair queue
	                  </Button>
	                  <Button
	                    type="button"
	                    size="sm"
	                    variant="outline"
                      loading={repairingMailbox === "full"}
	                    busyText="Requesting…"
	                    disabled={!pubkey || !onRepairMailbox || Boolean(repairingMailbox)}
	                    onClick={async () => {
	                      if (!onRepairMailbox) return;
	                      const ok = window.confirm(
	                        "Repair full job ledger (includes posted/history)? Recommended not to unless Posted is stuck."
	                      );
	                      if (!ok) return;
	                      setRepairingMailbox("full");
	                      try {
	                        await onRepairMailbox({ scope: "full" });
	                      } finally {
	                        setRepairingMailbox("");
	                      }
	                    }}
	                  >
	                    Repair full
	                  </Button>
                  </div>
	              </div>
	              {!pubkey ? (
	                <div className="text-[11px] text-white/50">Connect a signer to request a repair.</div>
              ) : null}
	              {pubkey ? (
	                <div className="text-[11px] text-white/50">
                    Queue repair republishes scheduled jobs; full repair republishes posted/history pages too (use if Posted count is stuck).
                  </div>
	              ) : null}
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
