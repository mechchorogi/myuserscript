// Minimal GM.* shim for running hitomi-tweak.user.js / hitomi-download-history.user.js
// under plain Playwright (no real userscript manager extension installed).
//
// GM.getValue/GM.setValue are namespaced under a separate localStorage prefix so this
// shim mirrors the real Tampermonkey/Violentmonkey behavior: GM storage is private per
// script and NOT the same store as the page's own localStorage. Some history entries in
// this project are intentionally kept in sync across both stores by the userscript code
// itself (see hitomi-tweak.user.js's saveDownloadHistory), so collapsing them here would
// hide real bugs in that sync logic.
(function() {
    'use strict';

    const gmPrefix = '__gm__:';

    function readGmValue(key, fallback) {
        try {
            const raw = window.localStorage.getItem(gmPrefix + key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    }

    function writeGmValue(key, value) {
        window.localStorage.setItem(gmPrefix + key, JSON.stringify(value));
    }

    window.GM = {
        getValue(key, fallback) {
            return Promise.resolve(readGmValue(key, fallback));
        },
        setValue(key, value) {
            writeGmValue(key, value);
            return Promise.resolve();
        },
        openInTab(url) {
            console.log('[gm-shim] GM.openInTab', url);
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    };

    window.unsafeWindow = window;
})();
