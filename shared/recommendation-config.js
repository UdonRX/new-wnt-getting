// Single source of truth for the news recommendation freshness policy.
// Google News pubDate is the canonical freshness/order timestamp; publisher dates are diagnostic only.
export const NEWS_RECOMMENDATION_WINDOW_HOURS = 24;
export const NEWS_RECOMMENDATION_WINDOW_MS = NEWS_RECOMMENDATION_WINDOW_HOURS * 60 * 60 * 1000;

// Bump when the client-side recommendation cache shape/semantics change.
export const RECOMMENDATION_CACHE_SCHEMA = 4;
