import React, { useState } from "react";
import { useNostr } from "../../providers/NostrProvider.jsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function PrivateKeyLogin({ onBack, onClose }) {
  const { nsecLogin } = useNostr();
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isNcrypt = key.trim().startsWith("ncryptsec");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await nsecLogin(key.trim(), password);
      onClose?.();
    } catch (err) {
      setError(err?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm font-semibold text-white/80">
        Private key (nsec or ncryptsec)
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="mt-2"
          placeholder="nsec1..."
          required
        />
      </label>
      {isNcrypt && (
        <label className="block text-sm font-semibold text-white/80">
          Password (for ncryptsec)
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-2"
            placeholder="Your password"
            required
          />
        </label>
      )}
      {error && <div className="text-sm text-rose-300">{error}</div>}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          loading={busy}
          busyText="Signing in…"
          className="flex-1"
          size="lg"
        >
          Sign in
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
        Tip: prefer browser extensions or bunker signers. Saving a raw private key is less secure.
      </p>
    </form>
  );
}
