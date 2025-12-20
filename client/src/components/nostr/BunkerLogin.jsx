import React, { useEffect, useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { createNostrConnectURI } from "nostr-tools/nip46";
import { useNostr } from "../../providers/NostrProvider.jsx";
import { REQUIRED_NIP46_PERMS } from "../../nostr/auth/nip46Perms.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function getConfiguredRelays() {
  const raw = String(import.meta.env.VITE_DVM_RELAYS || "");
  const candidates = raw
    .split(/[, \n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const protocol = typeof window !== "undefined" ? window.location.protocol : "";
  const requiredPrefix = protocol === "https:" ? "wss" : "ws";
  return candidates.filter((u) => u.startsWith(requiredPrefix));
}

export default function BunkerLogin({ onBack, onClose }) {
  const { bunkerLogin, nostrConnectionLogin } = useNostr();

  const [nostrConnectError, setNostrConnectError] = useState("");
  const [nostrConnectStatus, setNostrConnectStatus] = useState("waiting");
  const [clientSecretKey] = useState(() => generateSecretKey());
  const relays = useMemo(() => getConfiguredRelays(), []);

  const connectionString = useMemo(() => {
    if (!relays.length) return "";
    return createNostrConnectURI({
      clientPubkey: getPublicKey(clientSecretKey),
      relays,
      secret: Math.random().toString(36).slice(2),
      perms: REQUIRED_NIP46_PERMS,
      name: window.location.host,
      url: window.location.origin
    });
  }, [clientSecretKey, relays]);

  useEffect(() => {
    let cancelled = false;
    if (!connectionString) return;
    setNostrConnectStatus("connecting");
    setNostrConnectError("");
    nostrConnectionLogin(clientSecretKey, connectionString)
      .then(() => {
        if (cancelled) return;
        setNostrConnectStatus("connected");
        onClose?.();
      })
      .catch((err) => {
        if (cancelled) return;
        setNostrConnectStatus("failed");
        setNostrConnectError(err?.message || "Approve the request in your signer.");
      });
    return () => {
      cancelled = true;
    };
  }, [clientSecretKey, connectionString, nostrConnectionLogin, onClose]);

  useEffect(() => {
    if (relays.length) return;
    setNostrConnectStatus("failed");
    setNostrConnectError("No relays configured for NostrConnect (set VITE_DVM_RELAYS in client/.env)");
  }, [relays.length]);

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setNostrConnectStatus((prev) => (prev === "connected" ? prev : "copied"));
      setTimeout(() => setNostrConnectStatus("waiting"), 1200);
    } catch {
      setNostrConnectError("Copy failed");
    }
  };

  const [bunker, setBunker] = useState("");
  const [bunkerError, setBunkerError] = useState("");
  const [bunkerBusy, setBunkerBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBunkerError("");
    setBunkerBusy(true);
    try {
      await bunkerLogin(bunker.trim());
      onClose?.();
    } catch (err) {
      setBunkerError(err?.message || "Bunker login failed");
    } finally {
      setBunkerBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-slate-900 ring-1 ring-white/10 p-4">
          <div className="p-4 rounded-2xl bg-white shadow-sm ring-1 ring-black/10">
            <QRCode value={connectionString} size={360} bgColor="#ffffff" fgColor="#000000" level="M" />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => copyToClipboard(connectionString)}
              disabled={!connectionString}
              variant="secondary"
              size="sm"
            >
              Copy link
            </Button>
            <a
              href={connectionString}
              aria-disabled={!connectionString}
              onClick={(e) => {
                if (!connectionString) e.preventDefault();
              }}
              className="inline-flex items-center justify-center text-xs px-3 py-2 rounded-2xl bg-slate-800 ring-1 ring-white/10 hover:bg-slate-700 active:translate-y-px"
              aria-label="Open with Nostr signer"
            >
              Open
            </a>
          </div>
        </div>

        {(nostrConnectError || nostrConnectStatus) && (
          <div className="text-xs text-center">
            {nostrConnectError ? (
              <div className="text-rose-300">{nostrConnectError}</div>
            ) : (
              <div className="text-white/60">
                {nostrConnectStatus === "connecting"
                  ? "Waiting for approval…"
                  : nostrConnectStatus === "connected"
                    ? "Connected"
                    : nostrConnectStatus === "failed"
                      ? "Failed – check your signer"
                      : nostrConnectStatus === "copied"
                        ? "Link copied"
                        : "Ready"}
              </div>
            )}
          </div>
        )}
      </div>

      <label className="block text-sm font-semibold text-white/80">
        Bunker URI
        <Input
          value={bunker}
          onChange={(e) => setBunker(e.target.value)}
          className="mt-2"
          placeholder="bunker://... or name@domain.com"
          required
        />
      </label>
      {bunkerError && <div className="text-sm text-rose-300">{bunkerError}</div>}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          loading={bunkerBusy}
          busyText="Connecting…"
          className="flex-1"
          size="lg"
        >
          Connect Bunker
        </Button>
        <Button
          type="button"
          onClick={onBack}
          variant="secondary"
          size="lg"
        >
          Back
        </Button>
      </div>
      <p className="text-xs text-white/50">
        You will be asked to approve this client in your signer app.
      </p>
    </form>
  );
}
