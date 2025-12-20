import React from "react";
import QRCode from "react-qr-code";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { lightningDeepLink, resolveLnurlPayUrl } from "@/utils/lightning.js";

const SUPPORT_LNURL_RAW = String(
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_SUPPORT_LNURL) || ""
).trim();

async function fetchLnJson(url, { signal } = {}) {
  const res = await fetch(String(url || ""), {
    method: "GET",
    signal,
    headers: { accept: "application/json" },
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Unexpected response from lightning service");
  }

  if (!res.ok) {
    const msg = String(json?.reason || json?.error || res.statusText || "Request failed").trim();
    throw new Error(msg || "Request failed");
  }

  if (String(json?.status || "").toUpperCase() === "ERROR") {
    const msg = String(json?.reason || "Lightning service error").trim();
    throw new Error(msg || "Lightning service error");
  }

  return json;
}

function toSats(msat) {
  const n = Number(msat) || 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 1000);
}

function clamp(num, { min = 0, max = 0 } = {}) {
  const n = Number(num);
  if (!Number.isFinite(n)) return 0;
  if (max > 0 && n > max) return max;
  if (min > 0 && n < min) return min;
  return n;
}

export function SupportZapFooter({ defaultSats = 0, variant = "" } = {}) {
  const compact = String(variant || "").trim().toLowerCase() === "compact";
  const lnurlpUrl = React.useMemo(() => resolveLnurlPayUrl(SUPPORT_LNURL_RAW), []);
  const walletHref = React.useMemo(() => lightningDeepLink(SUPPORT_LNURL_RAW), []);

  const [open, setOpen] = React.useState(false);
  const [payInfo, setPayInfo] = React.useState(null);
  const [infoStatus, setInfoStatus] = React.useState({ status: "idle", error: "" });

  const [sats, setSats] = React.useState("");
  const [note, setNote] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [invoice, setInvoice] = React.useState(null);
  const [invoiceError, setInvoiceError] = React.useState("");
  const [copied, setCopied] = React.useState(false);

  const minSats = React.useMemo(() => {
    const msat = Number(payInfo?.minSendable) || 0;
    if (!Number.isFinite(msat) || msat <= 0) return 0;
    return Math.ceil(msat / 1000);
  }, [payInfo?.minSendable]);

  const maxSats = React.useMemo(() => toSats(payInfo?.maxSendable), [payInfo?.maxSendable]);

  const commentAllowed = React.useMemo(() => {
    const n = Math.floor(Number(payInfo?.commentAllowed) || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [payInfo?.commentAllowed]);

  const resetModalState = React.useCallback(() => {
    setPayInfo(null);
    setInfoStatus({ status: "idle", error: "" });
    setCreating(false);
    setInvoice(null);
    setInvoiceError("");
    setCopied(false);
    setNote("");
    const preset = Math.max(0, Math.floor(Number(defaultSats) || 0));
    setSats(String(preset > 0 ? preset : 1000));
  }, [defaultSats]);

  React.useEffect(() => {
    if (!open) return;
    resetModalState();
  }, [open, resetModalState]);

  React.useEffect(() => {
    if (!open) return;

    if (!lnurlpUrl) {
      setInfoStatus({
        status: "error",
        error: SUPPORT_LNURL_RAW ? "Invalid support LNURL / lightning address." : "Support is not configured.",
      });
      return;
    }

    const controller = new AbortController();
    let mounted = true;

    (async () => {
      setInfoStatus({ status: "loading", error: "" });
      try {
        const data = await fetchLnJson(lnurlpUrl, { signal: controller.signal });
        if (!mounted) return;

        const callback = String(data?.callback || "").trim();
        const tag = String(data?.tag || "").trim();
        if (tag && tag !== "payRequest") throw new Error("LNURL endpoint is not a pay request");
        if (!callback) throw new Error("LNURL endpoint missing callback");

        setPayInfo(data);
        setInfoStatus({ status: "idle", error: "" });
      } catch (err) {
        if (!mounted) return;
        const msg = String(err?.message || "Unable to load lightning info").trim();
        setInfoStatus({ status: "error", error: msg || "Unable to load lightning info" });
      }
    })();

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [open, lnurlpUrl]);

  const createInvoice = React.useCallback(async () => {
    if (!payInfo?.callback) return;
    if (creating) return;

    setCreating(true);
    setInvoice(null);
    setInvoiceError("");
    setCopied(false);

    try {
      const requested = Math.max(0, Math.floor(Number(sats) || 0));
      if (!requested || requested < 1) {
        throw new Error("Amount must be at least 1 sat.");
      }

      const satsMin = Math.max(0, Math.floor(Number(minSats) || 0));
      const satsMax = Math.max(0, Math.floor(Number(maxSats) || 0));
      const finalSats = clamp(requested, { min: satsMin, max: satsMax });
      if (finalSats !== requested) {
        setSats(String(finalSats));
      }

      if (satsMin > 0 && finalSats < satsMin) throw new Error(`Minimum is ${satsMin.toLocaleString()} sats.`);
      if (satsMax > 0 && finalSats > satsMax) throw new Error(`Maximum is ${satsMax.toLocaleString()} sats.`);

      const msats = finalSats * 1000;
      const cb = new URL(String(payInfo.callback));
      cb.searchParams.set("amount", String(msats));

      const cleanNote = String(note || "")
        .replace(/\s+/g, " ")
        .trim();
      const comment = commentAllowed ? cleanNote.slice(0, commentAllowed) : "";
      if (comment) cb.searchParams.set("comment", comment);

      const data = await fetchLnJson(cb.toString());
      const pr = String(data?.pr || data?.payment_request || "").trim();
      if (!pr) throw new Error("Lightning service did not return an invoice");

      setInvoice({
        pr,
        sats: finalSats,
        msats,
        note: comment || "",
        verify: String(data?.verify || "").trim(),
      });
    } catch (err) {
      const msg = String(err?.message || "Failed to create invoice").trim();
      setInvoiceError(msg || "Failed to create invoice");
    } finally {
      setCreating(false);
    }
  }, [payInfo?.callback, payInfo?.callback, creating, sats, minSats, maxSats, note, commentAllowed]);

  const copyInvoice = React.useCallback(async () => {
    const pr = String(invoice?.pr || "").trim();
    if (!pr) return;
    try {
      await navigator.clipboard.writeText(pr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setInvoiceError("Unable to copy invoice. Please copy it manually.");
    }
  }, [invoice?.pr]);

  if (!SUPPORT_LNURL_RAW) return null;

  const hasInvoice = Boolean(invoice?.pr);
  const displayTarget = SUPPORT_LNURL_RAW.length > 42 ? `${SUPPORT_LNURL_RAW.slice(0, 24)}…${SUPPORT_LNURL_RAW.slice(-12)}` : SUPPORT_LNURL_RAW;

  return (
    <>
      {compact ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-950/40 px-3 py-2 ring-1 ring-white/10">
          <div className="text-xs text-white/60">
            Enjoying Pidgeon? <span className="text-white/80">Support with a zap.</span>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            Zap now
          </Button>
        </div>
      ) : (
        <div className="rounded-2xl bg-slate-950/40 p-3 ring-1 ring-white/10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-white/90">Support</div>
              <div className="mt-1 text-xs text-white/60">
                If you find Pidgeon useful, you can send a zap to help keep the service running.
              </div>
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
              Zap now
            </Button>
          </div>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-3xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send a zap</DialogTitle>
            <DialogDescription className="break-all">
              {displayTarget}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 px-6 pb-2">
            {infoStatus.status === "loading" ? (
              <div className="rounded-2xl bg-slate-950/50 p-4 text-sm text-white/80 ring-1 ring-white/10">
                Loading lightning info…
              </div>
            ) : null}

            {infoStatus.status === "error" ? (
              <div className="rounded-2xl bg-red-950/50 p-4 text-sm text-red-100 ring-1 ring-red-500/20">
                {infoStatus.error}
                <div className="mt-2 text-xs text-red-100/70">
                  Tip: if invoice generation is blocked (CORS), you can still pay via “Open in wallet”.
                </div>
              </div>
            ) : null}

            {!hasInvoice ? (
              <div className="space-y-3 rounded-2xl bg-slate-950/50 p-4 ring-1 ring-white/10">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Amount (sats)</div>
                    <div className="mt-1 text-xs text-white/60">
                      {minSats ? `Min ${minSats.toLocaleString()}` : null}
                      {minSats && maxSats ? " · " : null}
                      {maxSats ? `Max ${maxSats.toLocaleString()}` : null}
                    </div>
                  </div>
                  <a
                    href={walletHref}
                    className="text-xs text-indigo-200 hover:text-indigo-100 underline decoration-white/20"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in wallet
                  </a>
                </div>

                <Input
                  type="number"
                  min={minSats || 1}
                  step={10}
                  value={sats}
                  onChange={(e) => setSats(e.target.value)}
                  placeholder="1000"
                />

                {commentAllowed ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Note (optional)</div>
                    <Textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="!min-h-[88px]"
                      maxLength={commentAllowed}
                      placeholder="Say thanks…"
                    />
                    <div className="text-[11px] text-white/60">Max {commentAllowed} characters.</div>
                  </div>
                ) : null}

                {invoiceError ? (
                  <div className="rounded-xl bg-red-950/40 px-3 py-2 text-xs text-red-100 ring-1 ring-red-500/20">
                    {invoiceError}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3 rounded-2xl bg-slate-950/50 p-4 ring-1 ring-white/10">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">Invoice</div>
                  <div className="text-xs text-white/60">{Number(invoice?.sats || 0).toLocaleString()} sats</div>
                </div>

                <div className="flex justify-center">
                  <div className="rounded-2xl bg-white p-3">
                    <QRCode value={lightningDeepLink(String(invoice?.pr || "").trim())} size={196} />
                  </div>
                </div>

                <div className="truncate rounded-xl bg-slate-950/60 px-3 py-2 font-mono text-xs text-white/80 ring-1 ring-white/10">
                  {String(invoice?.pr || "").trim()}
                </div>

                {invoice?.note ? (
                  <div className="text-xs text-white/60">
                    Note: <span className="text-white/80">{invoice.note}</span>
                  </div>
                ) : null}

                {invoiceError ? (
                  <div className="rounded-xl bg-red-950/40 px-3 py-2 text-xs text-red-100 ring-1 ring-red-500/20">
                    {invoiceError}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            {!hasInvoice ? (
              <>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button type="button" loading={creating} busyText="Creating…" onClick={createInvoice} disabled={infoStatus.status !== "idle"}>
                  Create invoice
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button type="button" variant="outline" onClick={copyInvoice}>
                  {copied ? "Copied!" : "Copy"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    const pr = String(invoice?.pr || "").trim();
                    if (!pr) return;
                    try {
                      window.open(lightningDeepLink(pr), "_blank", "noopener,noreferrer");
                    } catch {}
                  }}
                >
                  Open
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setInvoice(null);
                    setInvoiceError("");
                    setCopied(false);
                  }}
                >
                  Create another
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
