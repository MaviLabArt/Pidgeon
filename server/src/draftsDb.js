// Drafts are no longer stored on the server. All operations must go through Nostr relays.
export function listDrafts() {
  throw new Error("Draft storage is disabled; drafts now live on Nostr relays.");
}

export function upsertDraft() {
  throw new Error("Draft storage is disabled; drafts now live on Nostr relays.");
}

export function deleteDraft() {
  throw new Error("Draft storage is disabled; drafts now live on Nostr relays.");
}
