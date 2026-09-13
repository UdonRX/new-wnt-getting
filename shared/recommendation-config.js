// Single source of truth for the news recommendation freshness policy.
// Server selectors use this value; clients preserve every item returned by the server.
export const NEWS_RECOMMENDATION_WINDOW_HOURS = 24;
export const NEWS_RECOMMENDATION_WINDOW_MS = NEWS_RECOMMENDATION_WINDOW_HOURS * 60 * 60 * 1000;

// Bump when the client-side recommendation cache shape/semantics change.
export const RECOMMENDATION_CACHE_SCHEMA = 3;
