// ==UserScript==
// @name         Hitomi::History
// @namespace    http://hitomi.la/
// @version      1.0.0
// @description  Track downloaded hitomi.la books and mark downloaded pages
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        GM.getValue
// @grant        GM.setValue
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const downloadHistoryKey = 'hitomi-history-download-history';
    let isHandlingDownload = false;

    function isEditableTarget(target) {
        if (!(target instanceof Element)) return false;

        return Boolean(target.closest('input, textarea, select') || target.isContentEditable);
    }

    function getDownloadKey() {
        return location.pathname.replace(/\/$/, '') || location.href;
    }

    function getBookTitle() {
        return document.querySelector('h1.lillie')?.textContent.trim() || document.title;
    }

    function getDLButton() {
        return document.querySelector('a#dl-button');
    }

    function loadLocalDownloadHistory() {
        try {
            const history = JSON.parse(localStorage.getItem(downloadHistoryKey) || '{}');
            return history && typeof history === 'object' && !Array.isArray(history) ? history : {};
        } catch (e) {
            return {};
        }
    }

    function saveLocalDownloadHistory(history) {
        try {
            localStorage.setItem(downloadHistoryKey, JSON.stringify(history));
        } catch (e) {
            // Ignore storage failures so download actions are never blocked.
        }
    }

    async function loadDownloadHistory() {
        const localHistory = loadLocalDownloadHistory();
        const history = await GM.getValue(downloadHistoryKey, {});

        return {
            ...localHistory,
            ...(history && typeof history === 'object' && !Array.isArray(history) ? history : {})
        };
    }

    async function saveDownloadHistory(history) {
        saveLocalDownloadHistory(history);
        await GM.setValue(downloadHistoryKey, history);
    }

    function markDLButtonDownloaded() {
        const heading = document.querySelector('a#dl-button > h1');
        if (!heading) return false;

        heading.textContent = 'DOWNLOADED';
        return true;
    }

    function syncDownloadHistoryEntry(key, entry) {
        loadDownloadHistory()
            .then(history => {
                history[key] = entry;
                return saveDownloadHistory(history);
            })
            .catch(() => {});
    }

    function markCurrentBookDownloaded() {
        const key = getDownloadKey();
        const entry = {
            title: getBookTitle(),
            url: location.href,
            downloadedAt: new Date().toISOString()
        };
        const localHistory = loadLocalDownloadHistory();

        localHistory[key] = entry;
        saveLocalDownloadHistory(localHistory);
        markDLButtonDownloaded();
        syncDownloadHistoryEntry(key, entry);
    }

    async function markPageIfDownloaded() {
        const history = await loadDownloadHistory();
        if (history[getDownloadKey()]) {
            markDLButtonDownloaded();
        }
    }

    function downloadBook(dlButton) {
        if (!dlButton || isHandlingDownload) return false;

        isHandlingDownload = true;
        try {
            markCurrentBookDownloaded();
            dlButton.click();
            return true;
        } finally {
            isHandlingDownload = false;
        }
    }

    function installDownloadClickHistory() {
        const dlButton = getDLButton();
        if (!dlButton) return;

        dlButton.addEventListener('click', () => {
            if (isHandlingDownload) return;

            markCurrentBookDownloaded();
        }, true);
    }

    function installDownloadShortcut() {
        document.addEventListener('keydown', e => {
            if (e.key !== 'd' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            if (isEditableTarget(e.target)) return;

            const dlButton = getDLButton();
            if (!dlButton) return;

            e.preventDefault();
            downloadBook(dlButton);
        });
    }

    markPageIfDownloaded().catch(() => {});
    installDownloadClickHistory();
    installDownloadShortcut();
})();
