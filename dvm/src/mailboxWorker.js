// Worker thread entrypoint for mailbox flush work.
import { parentPort } from "worker_threads";
import { flushMailboxOnce, repairMailboxOnce } from "./mailboxFlush.js";

if (!parentPort) {
  throw new Error("mailboxWorker must be run as a worker thread");
}

parentPort.on("message", async (msg) => {
  const id = msg?.id;
  if (!id) return;
  if (msg?.type !== "flush" && msg?.type !== "repair") {
    parentPort.postMessage({ id, ok: false, error: "Unknown task type" });
    return;
  }

  try {
    const result =
      msg.type === "repair"
        ? await repairMailboxOnce({
            pubkey: msg.pubkey,
            relays: msg.relays,
            dvmSkHex: msg.dvmSkHex,
            scope: msg.scope
          })
        : await flushMailboxOnce({
            pubkey: msg.pubkey,
            relays: msg.relays,
            dvmSkHex: msg.dvmSkHex
          });
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: err?.message || String(err || "Mailbox flush failed")
    });
  }
});
