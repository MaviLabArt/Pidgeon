import { subscribeMailbox } from "@/services/mailboxNostr.js";

function getSignerPubkey() {
  const nostr = window.nostrSigner || window.nostrShim || window.nostr;
  if (!nostr?.getPublicKey) throw new Error("No signer available on window.nostr (need getPublicKey)");
  return nostr.getPublicKey();
}

async function mailboxSnapshot({
  pubkey,
  pendingPages = 1,
  historyPages = 1,
  timeoutMs = 8000
} = {}) {
  const userPubkey = pubkey || (await getSignerPubkey());
  const result = {
    pubkey: userPubkey,
    sync: null,
    counts: null,
    jobs: null,
    timedOut: false
  };

  let sub = null;
  try {
    let lastJobs = null;
    let lastSync = null;
    let lastCounts = null;

    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const timer = setTimeout(() => {
      result.timedOut = true;
      result.jobs = lastJobs;
      result.sync = lastSync;
      result.counts = lastCounts;
      resolveDone(result);
    }, Math.max(1000, Number(timeoutMs) || 8000));

    const maybeFinish = () => {
      if (!lastJobs) return;
      if (lastSync?.status !== "up_to_date") return;
      result.jobs = lastJobs;
      result.sync = lastSync;
      result.counts = lastCounts;
      clearTimeout(timer);
      resolveDone(result);
    };

    sub = await subscribeMailbox(userPubkey, {
      onJobs: (jobs) => {
        lastJobs = jobs;
        maybeFinish();
      },
      onSync: (sync) => {
        lastSync = sync;
        maybeFinish();
      },
      onCounts: (counts) => {
        lastCounts = counts;
      }
    });

    const pp = Math.max(0, Number(pendingPages) || 0);
    const hp = Math.max(0, Number(historyPages) || 0);
    if (pp > 1 && typeof sub?.loadMorePending === "function") {
      await sub.loadMorePending({ pages: pp - 1 });
    }
    if (hp > 0 && typeof sub?.loadMoreHistory === "function") {
      await sub.loadMoreHistory({ pages: hp });
    }

    return await done;
  } catch (err) {
    throw err;
  } finally {
    try {
      sub?.close?.();
    } catch {}
  }
}

async function dumpMailbox(opts = {}) {
  const snap = await mailboxSnapshot(opts);
  console.log("[pidgeonDebug] mailbox snapshot", snap);
  return snap;
}

window.pidgeonDebug = Object.assign(window.pidgeonDebug || {}, {
  mailboxSnapshot,
  dumpMailbox
});

console.log(
  "[pidgeonDebug] enabled. Try: await pidgeonDebug.dumpMailbox() or await pidgeonDebug.mailboxSnapshot({ pendingPages: 5, historyPages: 5 })"
);

