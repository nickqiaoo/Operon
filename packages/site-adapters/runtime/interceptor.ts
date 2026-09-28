/**
 * fetch / XHR response capture (OpenCLI `interceptor.ts`).
 *
 * Patches `fetch` and `XMLHttpRequest` so JSON responses whose URL contains the
 * pattern are pushed onto a hidden window array. The patched functions report
 * native `toString()` so site code that fingerprints them sees nothing unusual.
 *
 * Needs the privileged adapter bridge: the read-only evaluate forbids exactly
 * the `defineProperty` and `fetch` replacement this does.
 */

const CAPTURE_ARRAY = "__operon_xhr"
const PATCH_GUARD = "__operon_interceptor_patched"

/** Source of an arrow function; wrap as `(${src})()` to run it. */
export function interceptorSource(pattern: string): string {
  const patternVar = `${PATCH_GUARD}_pattern`
  return `() => {
  const __defHidden = (obj, key, val) => {
    try { Object.defineProperty(obj, key, { value: val, writable: true, enumerable: false, configurable: true }); }
    catch { obj[key] = val; }
  };
  const __disguise = (fn, name) => {
    const nativeStr = 'function ' + name + '() { [native code] }';
    const origToString = Function.prototype.toString;
    let map = window.__operonDFns;
    if (!map) {
      map = new Map();
      Object.defineProperty(window, '__operonDFns', { value: map, enumerable: false, configurable: true });
      Object.defineProperty(Function.prototype, 'toString', {
        value: function() { const o = map.get(this); return o !== undefined ? o : origToString.call(this); },
        writable: true, configurable: true,
      });
    }
    map.set(fn, nativeStr);
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch {}
    return fn;
  };
  if (!window.${CAPTURE_ARRAY}) __defHidden(window, '${CAPTURE_ARRAY}', []);
  __defHidden(window, '${patternVar}', ${JSON.stringify(pattern)});
  const matches = (url) => window.${patternVar} && String(url || '').includes(window.${patternVar});
  if (window.${PATCH_GUARD}) return;
  const origFetch = window.fetch;
  window.fetch = __disguise(async function(...args) {
    const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || String(args[0] || '');
    const response = await origFetch.apply(this, args);
    if (matches(reqUrl)) {
      try { window.${CAPTURE_ARRAY}.push(await response.clone().json()); } catch {}
    }
    return response;
  }, 'fetch');
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = __disguise(function(method, url) {
    Object.defineProperty(this, '__operonUrl', { value: String(url), writable: true, enumerable: false, configurable: true });
    return origOpen.apply(this, arguments);
  }, 'open');
  proto.send = __disguise(function() {
    if (matches(this.__operonUrl)) {
      this.addEventListener('load', function() {
        try { window.${CAPTURE_ARRAY}.push(JSON.parse(this.responseText)); } catch {}
      });
    }
    return origSend.apply(this, arguments);
  }, 'send');
  __defHidden(window, '${PATCH_GUARD}', true);
}`
}

/** Read and clear the captured payloads. */
export const READ_INTERCEPTED_SOURCE = `(() => {
  const data = window.${CAPTURE_ARRAY};
  if (!Array.isArray(data)) return [];
  const copy = data.slice();
  data.length = 0;
  return copy;
})()`

