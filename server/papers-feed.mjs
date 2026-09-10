// Compatibility endpoint for /api/papers-feed.
// The active paper acquisition is centralized in technology-research.mjs so the
// legacy URL remains valid without maintaining a second provider implementation.
import { technologyPapersFeed } from '../lib/technology-research.mjs';

export default technologyPapersFeed;
