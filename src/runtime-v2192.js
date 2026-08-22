/* Personal Dashboard v2.19.2
 * Reader summary cleanup (final active path):
 * - retain pre-v2187 runtime behavior needed by other screens
 * - remove v2187/v2188/v2189/v2190/v2191 Reader DOM helpers
 * - send every /api/summary request directly to the server
 * - Reader batching/current-index logic now lives only in reader-focus.js
 */
const nativeFetch2192 = window.fetch.bind(window);
await import('./runtime-v2185.js');
const inheritedFetch2192 = window.fetch.bind(window);

window.fetch = function pdv2192Fetch(input, init) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return inheritedFetch2192(input, init); }

  if (
    url.origin === location.origin
    && url.pathname === '/api/summary'
    && String(init?.method || 'GET').toUpperCase() === 'POST'
  ) {
    return nativeFetch2192(input, init);
  }

  return inheritedFetch2192(input, init);
};

try { localStorage.setItem('pdv2:runtime:v2192', '1'); } catch {}
