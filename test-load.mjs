const noop = () => {};

globalThis.window = {
    addEventListener: noop,
    dispatchEvent: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    location: { hostname: 'localhost', href: 'http://localhost/', pathname: '/', search: '', hash: '' }
};
globalThis.document = {
    readyState: 'loading',
    visibilityState: 'visible',
    addEventListener: noop,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
};

await import('./src/js/main.js');
