import { resolveRelays } from "./config.js";
import {
  fetchEventsOnce as poolFetchEventsOnce,
  subscribeEvents as poolSubscribeEvents
} from "./pool.js";

export function fetchEventsOnce(relays, filters) {
  const list = resolveRelays(relays);
  return poolFetchEventsOnce(list, filters);
}

export function subscribeEvents(relays, filters, { onEvent, onEose } = {}) {
  const list = resolveRelays(relays);
  const sub = poolSubscribeEvents(list, filters, { onEvent, onEose });
  if (typeof sub === "function") return sub;
  if (sub && typeof sub.close === "function") return () => sub.close();
  return () => {};
}
