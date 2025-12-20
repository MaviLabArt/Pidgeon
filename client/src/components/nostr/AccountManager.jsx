import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useNostr } from "../../providers/NostrProvider.jsx";
import { Button } from "@/components/ui/button";

const loadPrivateKeyLogin = () => import("./PrivateKeyLogin.jsx");
const PrivateKeyLogin = React.lazy(loadPrivateKeyLogin);
const loadBunkerLogin = () => import("./BunkerLogin.jsx");
const BunkerLogin = React.lazy(loadBunkerLogin);

const VIEW = {
  HOME: "home",
  NSEC: "nsec",
  BUNKER: "bunker",
  NPUB: "npub"
};

export default function AccountManager({ onClose }) {
  const [view, setView] = useState(VIEW.HOME);
  const { nip07Login, pubkey, hasSigner } = useNostr();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // If already connected with a signer, stop any pending spinner and close.
  useEffect(() => {
    if (hasSigner && pubkey) {
      setBusy(false);
      setError("");
      onClose?.();
    }
  }, [pubkey, hasSigner, onClose]);

  const title = useMemo(() => {
    if (view === VIEW.NSEC) return "Login with Private Key";
    if (view === VIEW.BUNKER) return "Login with Bunker";
    if (view === VIEW.NPUB) return "Login with Public Key (read-only)";
    return "Add a Nostr account";
  }, [view]);

  const handleNip07Login = async () => {
    setError("");
    setBusy(true);
    try {
      await nip07Login();
      onClose?.();
    } catch (err) {
      setError(err?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-sm text-white/60 mt-1">
          Connect a signer to keep carts and orders tied to your Nostr identity.
        </p>
      </div>

      {view === VIEW.HOME && (
        <div className="space-y-3">
          <Button
            onClick={handleNip07Login}
            loading={busy}
            busyText="Connecting…"
            className="w-full"
            size="lg"
          >
            Login with Browser Extension
          </Button>
          <Button
            onClick={() => setView(VIEW.BUNKER)}
            onMouseEnter={() => loadBunkerLogin().catch(() => {})}
            onFocus={() => loadBunkerLogin().catch(() => {})}
            variant="secondary"
            className="w-full"
            size="lg"
          >
            Login with Bunker
          </Button>
          <Button
            onClick={() => setView(VIEW.NSEC)}
            onMouseEnter={() => loadPrivateKeyLogin().catch(() => {})}
            onFocus={() => loadPrivateKeyLogin().catch(() => {})}
            variant="secondary"
            className="w-full"
            size="lg"
          >
            Login with Private Key
          </Button>
        </div>
      )}

      {error && <div className="text-sm text-rose-300">{error}</div>}

      {view === VIEW.NSEC && (
        <Suspense fallback={<div className="text-sm text-white/60">Loading…</div>}>
          <PrivateKeyLogin onBack={() => setView(VIEW.HOME)} onClose={onClose} />
        </Suspense>
      )}
      {view === VIEW.BUNKER && (
        <Suspense fallback={<div className="text-sm text-white/60">Loading…</div>}>
          <BunkerLogin onBack={() => setView(VIEW.HOME)} onClose={onClose} />
        </Suspense>
      )}
      {view === VIEW.NPUB && null}
    </div>
  );
}
