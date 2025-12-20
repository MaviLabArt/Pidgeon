import React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function Step({ title, nips = [], text }) {
  return (
    <div className="rounded-2xl bg-slate-950/50 px-4 py-4 ring-1 ring-white/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white/90">{title}</div>
        </div>
        {nips.length ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {nips.map((nip) => (
              <Badge key={nip} variant="secondary" className="bg-white/10 text-white/80 ring-1 ring-white/10">
                {nip}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      <div className="mt-2 whitespace-pre-wrap text-sm text-white/75">{text}</div>
    </div>
  );
}

export function HowItWorksView() {
  const intro =
    "Pidgeon lets you schedule Nostr posts and DMs without keeping your browser open.\n\n" +
    "You prepare something once, choose a time, and an always on scheduler (a NIP 90 DVM) takes care of publishing later.\n\n" +
    "The novel part we built is the Job Ledger. It is a private mailbox style communication channel on Nostr between you and the DVM. The DVM keeps the ledger, updates it as things change, and your app reads it to show your queue quickly and safely.";

  const steps = [
    {
      title: "1) First time: establish a private channel with the DVM",
      nips: ["kind 5901", "kind 1059", "kind 30078", "NIP 44", "NIP 59", "NIP 90"],
      text:
        "Before the DVM can maintain your private queue, your app needs shared secrets it can use to encrypt and decrypt the Job Ledger.\n\n" +
        "So the first time you schedule with a given DVM, Pidgeon sends a setup request (inner kind 5901) to the DVM. It is encrypted (NIP 44) and gift wrapped (NIP 59) as an outer kind 1059 event.\n\n" +
        "The DVM replies with its own gift wrap (kind 1059) that contains a masterkey and an id. Your app stores those locally and derives subkeys from them.\n\n" +
        "Why do this handshake?\n" +
        "That masterkey only exists inside this private channel with the DVM. It lets the DVM collapse many encrypted updates into a bounded set of replaceable pages (kind 30078).\n\n" +
        "This amortizes decrypt cost and makes the DVM (not your client) resolve job state."
    },
    {
      title: "2) Schedule a post",
      nips: ["kind 1", "kind 6", "kind 5905", "kind 1059", "NIP 44", "NIP 59", "NIP 90"],
      text:
        "You write a post, choose a time, and press Schedule.\n\n" +
        "Behind the scenes, Pidgeon builds the exact Nostr event that should exist later (a normal note, kind 1, or a repost, kind 6). Your signer signs that event.\n\n" +
        "Then Pidgeon packages a scheduling request for the DVM (inner kind 5905). The request is encrypted (NIP 44) and gift wrapped for privacy (NIP 59) as an outer kind 1059 event. That wrapped request is published to relays immediately, so the DVM can receive it.\n\n" +
        "At the scheduled time, the DVM publishes the already prepared event to your publish relays.\n\n" +
        "Privacy against third parties:\n" +
        "Relays can store and route the scheduling request, but they cannot read your post while it is waiting. Gift wrap reduces metadata leakage, the outer event uses a one time identity, so observers cannot trivially link it to you. Only when the scheduled time arrives does your public post become public, like any normal Nostr note."
    },
    {
      title: "3) Why we don’t build the queue by decrypting kind 1059 requests",
      nips: ["kind 1059", "kind 30078", "NIP 44", "NIP 46", "NIP 59"],
      text:
        "It’s tempting to think: “We already published the request (kind 1059). Why not just fetch those and show a queue from them?”\n\n" +
        "In practice that makes the UI slow and unreliable:\n\n" +
        "• Gift wraps are addressed to the DVM, not to you. The outer pubkey is one-time, so you cannot efficiently query “all my requests” by author.\n" +
        "• A request is not state. It doesn’t tell you if the DVM accepted it, scheduled it, retried it, published it, or failed.\n" +
        "• Under load, relays can drop events, reorder them, or deliver duplicates. The DVM may also intentionally reject malformed requests. Your UI needs an authoritative answer, not a best-effort reconstruction.\n" +
        "• UX/perf: decrypting many events individually is expensive. With NIP-46 it can mean a round-trip per decrypt (and signer friction). With NIP-07 it can bog down the extension. Either way it becomes unusably slow at scale.\n" +
        "• Abuse resistance: anyone can spam a DVM with wrapped traffic. If clients tried to “decrypt everything to build a queue”, a burst could turn into thousands of decrypt attempts and a frozen UI.\n" +
        "• For DMs, the request must stay unreadable. Showing rich previews from request traffic would either leak content or force your app to do extra sensitive parsing for every historical request.\n\n" +
        "So instead of treating requests as a database, we treat them as an input stream, and we publish a compact encrypted ledger that is meant to be read."
    },
    {
      title: "4) The Job Ledger (our solution)",
      nips: ["NIP 78", "kind 30078", "NIP 44"],
      text:
        "Scheduling is different from normal posting because it has state that changes over time. A job starts as scheduled, then becomes queued, then ends as posted or failed. Sometimes it retries, sometimes it includes useful error details.\n\n" +
        "Nostr does not give you a built in queue database, so we introduced a new pattern: the Job Ledger.\n\n" +
        "In human terms, it is a private mailbox style communication channel between you and the DVM. The DVM keeps the ledger. The DVM updates it every time something changes. Your app reads it to show your queue and history.\n\n" +
        "This is the novelty. Instead of trying to guess state from scattered events, the UI simply reads a compact ledger that is meant for this exact job. That makes it fast, reliable, and easy to recover after refresh or restart.\n\n" +
        "Privacy against third parties:\n" +
        "The ledger is encrypted, so relay operators and scrapers cannot read your queue. The ledger also lives under an unguessable identifier, which makes it much harder to enumerate your scheduling activity by pubkey."
    },
    {
      title: "5) What the Job Ledger contains (so the UI stays helpful)",
      nips: ["NIP 78", "NIP 44"],
      text:
        "The Job Ledger contains what the app needs to render a real queue. It includes what is scheduled and when, current status with helpful details, relay hints, and for posted items a reference to the final published note id.\n\n" +
        "That is why Pidgeon can show your jobs even after a restart. It downloads the ledger pages and decrypts them locally.\n\n" +
        "Privacy against third parties:\n" +
        "Status and previews come from encrypted ledger pages, not from publicly readable status events. When you see a preview, it is decrypted on your device, not on the relay."
    },
    {
      title: "6) Scheduled DMs (private by design)",
      nips: ["NIP 17", "kind 10050", "NIP 44"],
      text:
        "Scheduled DMs use NIP 17 style delivery.\n\n" +
        "The privacy idea is simple:\n" +
        "Your device prepares the encrypted DM payload for each recipient up front, so the DVM does not need your plaintext message to deliver it.\n\n" +
        "At send time, the DVM only does delivery work:\n" +
        "It publishes the already prepared sealed messages to recipients inbox relays (kind 10050). If a recipient has no inbox relays, it marks delivery as failed. It does not spray your DM to random relays.\n\n" +
        "Privacy against third parties:\n" +
        "Relays can route the message, but they cannot read it. The DVM does not need your plaintext DM to deliver it. Delivery stays scoped to the recipients inbox relays instead of broadcasting widely."
    },
    {
      title: "7) DM previews that the DVM can’t read",
      nips: [],
      text:
        "Sometimes you want a preview in your queue without leaking content.\n\n" +
        "So we use two layers. The Job Ledger is the envelope. It contains scheduling state the DVM must manage. The DM preview is a lockbox inside the envelope. It is encrypted with a separate preview key that only your devices can unlock.\n\n" +
        "To make that preview key recoverable on a new device, Pidgeon stores a small recovery capsule encrypted to your pubkey. Only your signer can open it. The DVM can relay the capsule, but it cannot decrypt it.\n\n" +
        "Privacy against third parties:\n" +
        "Even if someone sees the ledger traffic, the preview text stays unreadable without your preview key. The recovery capsule is encrypted to you, so relays and the DVM cannot open it."
    }
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>How it works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-2xl bg-slate-950/50 px-4 py-4 ring-1 ring-white/10">
            <div className="whitespace-pre-wrap text-sm text-white/75">{intro}</div>
          </div>
          {steps.map((s) => (
            <Step key={s.title} title={s.title} nips={s.nips} text={s.text} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
