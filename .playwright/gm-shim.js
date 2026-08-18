// Minimal GM.* shim for running hitomi-tweak.user.js under plain Playwright
// (no real userscript manager extension installed).
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

    // Real Tampermonkey exposes registered menu commands via its own extension UI,
    // which doesn't exist under plain Playwright. Keep a simple id->{label,onClick}
    // registry on window so tests can inspect labels and invoke onClick directly.
    let nextMenuCommandId = 1;
    window.__gmMenuCommands__ = new Map();
    window.GM_registerMenuCommand = function(label, onClick) {
        const id = nextMenuCommandId++;
        window.__gmMenuCommands__.set(id, { label, onClick });
        console.log('[gm-shim] GM_registerMenuCommand', id, label);
        return id;
    };
    window.GM_unregisterMenuCommand = function(id) {
        window.__gmMenuCommands__.delete(id);
    };

    window.unsafeWindow = window;
})();
