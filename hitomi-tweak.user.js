// ==UserScript==
// @name         Hitomi::Tweak
// @namespace    http://hitomi.la/
// @version      1.7.0
// @description  Filter, fold, track downloads, show reader progress, and add keyboard shortcuts on hitomi.la
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.openInTab
// @grant        window.close
// @grant        unsafeWindow
// @require      https://ltn.gold-usergeneratedcontent.net/FileSaver.min.js
// @require      https://ltn.gold-usergeneratedcontent.net/jszip.min.js
// @run-at       document-idle
// ==/UserScript==

// Features:
// - Filter gallery books with a GM-stored blacklist.
// - Import and export blacklist JSON backups.
// - Fold gallery books and persist the folded state.
// - Download and track books from book and list pages, with up to four list downloads at once.
// - Show page progress in the reader.
// - Add keyboard shortcuts for help, filtering, downloads, navigation, reading, folding, and page closing.

// Maintenance notes:
// - A "book" on list pages is always treated as `div.gallery-content > div`; do not
//   rely on `.dj`, because Hitomi uses multiple class names for book containers.
// - Book ids come from the trailing number in the book URL. The same id powers fold
//   persistence, reader URL inference, list-page downloads, and downloaded markers.

/* global JSZip, saveAs, unsafeWindow */

(function() {
    'use strict';

    const blacklistKeys = ['author', 'language', 'series', 'tag', 'title', 'type'];
    const downloadHistoryKey = 'hitomi-tweak-download-history';
    const downloadQueueKey = 'hitomi-tweak-download-queue';
    const unifiedDownloadsKey = 'hitomi-tweak-downloads';
    const downloadQueueLockName = 'hitomi-tweak-download-queue-lock';
    const foldedBookIdsKey = 'hitomi-tweak-folded-book-ids';
    const nameMapKey = 'hitomi-tweak-name-map';
    const nameMapPagePath = '/hitomi-tweak-name-map.html';
    const downloadPagePath = '/hitomi-tweak-download.html';
    const preferredLanguageKey = 'hitomi-tweak-preferred-language';
    const closeBookPageAfterDownloadKey = 'hitomi-tweak-close-book-page-after-download';
    const preferredLanguageOptions = [
        ['off', 'Off'],
        ['japanese', 'Japanese'],
        ['english', 'English'],
        ['chinese', 'Chinese'],
        ['korean', 'Korean'],
        ['all', 'All']
    ];
    const maxGlobalDownloadCount = 4;
    const downloadQueueWorkerInterval = 2500;
    const downloadPageQueueRefreshInterval = 2500;
    const downloadQueueHeartbeatInterval = 5000;
    const downloadQueueStaleRunningMs = 180000;
    const downloadQueueTerminalTtlMs = 60000;
    const downloadProgressStackClassName = 'hitomi-tweak-download-progress-stack';
    const downloadProgressClassName = 'hitomi-tweak-download-progress';
    const bookDownloadProgressClassName = 'hitomi-tweak-book-download-progress';
    const bookDownloadDoneClassName = 'hitomi-tweak-book-download-done';
    const bookDownloadCanceledClassName = 'hitomi-tweak-book-download-canceled';
    const bookDownloadErrorClassName = 'hitomi-tweak-book-download-error';
    const bookDownloadProgressLabelClassName = 'hitomi-tweak-book-download-progress-label';
    const bookPageProgressLabelClassName = 'hitomi-tweak-book-page-progress-label';
    const downloadedBookHeadingClassName = 'hitomi-tweak-downloaded-book-heading';
    const downloadCanceledErrorName = 'HitomiTweakDownloadCanceled';
    const downloadAnimeNotSupportedErrorName = 'HitomiTweakDownloadAnimeNotSupported';
    const focusedBookClassName = 'hitomi-tweak-focused-book';
    const helpOverlayClassName = 'hitomi-tweak-help-overlay';
    const helpOverlayHiddenClassName = 'hitomi-tweak-help-overlay-hidden';
    const filterPanelId = 'hitomi-tweak-filter-panel';
    const filterBookMap = new WeakMap();
    // Keep the help overlay generated from the same source as key handling so the
    // displayed shortcuts do not drift from the actual behavior.
    const keyboardShortcuts = [
        ['/', 'Toggle this help'],
        ['a', 'Open author link'],
        ['b', 'Toggle blocklist mode'],
        ['d', 'Queue, remove, or cancel current book download'],
        ['j', 'Focus next book'],
        ['k', 'Focus previous book'],
        ['t', 'Fold focused book'],
        ['v', 'Open focused book in background tab and focus next book'],
        ['r', 'Open read online link'],
        ['c', 'Close current tab']
    ];

    let filterEnabled = true;
    let filterMarkModeButton = null;
    let focusedBook = null;
    let foldedBookIds = new Set();
    let helpOverlay = null;
    let activeBookPageDownload = null;
    let activeListDownloads = new Map();
    let activeQueuedDownloads = new Map();
    let galleryInfoLoadQueue = Promise.resolve();
    let listDownloadNotice = null;
    let listDownloadProgressStack = null;
    let nameMap = { version: 1, group: {}, author: {}, series: {} };
    let queuedBookProgress = new Map();
    let titleBeforeListDownloads = null;
    let downloadQueueWriteQueue = Promise.resolve();
    let downloadQueueWorkerTimer = null;
    let downloadQueueWorkerRunning = false;
    const downloadQueueWorkerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    function isReaderPage() {
        return location.pathname.startsWith('/reader/');
    }

    function isDownloadHistoryPage() {
        // Keep the legacy route only as an entry point to the integrated page.
        return location.pathname === '/hitomi-tweak-history.html';
    }

    function isDownloadPage() {
        return location.pathname === downloadPagePath;
    }

    function isNameMapPage() {
        return location.pathname === nameMapPagePath;
    }

    function blacklistStorageKey(key) {
        return `hitomi-tweak-blacklist-${key}`;
    }

    function normalizeNameMapKey(value) {
        return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function isPlainObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value);
    }

    function normalizeNameMap(input) {
        if (!isPlainObject(input) || input.version !== 1 || !isPlainObject(input.group) || !isPlainObject(input.author)) {
            throw new Error('Invalid name map format');
        }

        const normalized = { version: 1, group: {}, author: {}, series: {} };
        for (const kind of ['group', 'author', 'series']) {
            // `series` was added after the initial schema, so older complete-map
            // exports are accepted and treated as an empty series namespace.
            const source = isPlainObject(input[kind]) ? input[kind] : {};
            for (const [key, value] of Object.entries(source)) {
                const normalizedKey = normalizeNameMapKey(key);
                if (normalizedKey && typeof value === 'string') {
                    normalized[kind][normalizedKey] = value.trim();
                }
            }
        }
        return normalized;
    }

    function loadLocalNameMap() {
        try {
            return normalizeNameMap(JSON.parse(localStorage.getItem(nameMapKey) || 'null'));
        } catch (e) {
            return { version: 1, group: {}, author: {}, series: {} };
        }
    }

    function saveLocalNameMap(map) {
        try {
            localStorage.setItem(nameMapKey, JSON.stringify(map));
        } catch (e) {
            // Name-map mirroring is best-effort; GM storage remains the canonical copy.
        }
    }

    async function loadNameMap() {
        const localMap = loadLocalNameMap();
        try {
            nameMap = normalizeNameMap(await GM.getValue(nameMapKey, localMap));
        } catch (e) {
            nameMap = localMap;
        }
        saveLocalNameMap(nameMap);
        return nameMap;
    }

    async function saveNameMap(map) {
        nameMap = normalizeNameMap(map);
        saveLocalNameMap(nameMap);
        await GM.setValue(nameMapKey, nameMap);
    }

    function resolveJapaneseName(name, kind) {
        const normalized = normalizeNameMapKey(name);
        return (kind === 'group' || kind === 'author' || kind === 'series') && normalized ? nameMap[kind]?.[normalized] || name : name;
    }

    function getNameMapEntries(map = nameMap) {
        return ['group', 'author', 'series']
            .flatMap(kind => Object.entries(map[kind] || {}).map(([romaji, japanese]) => ({ kind, romaji, japanese })))
            .sort((a, b) => a.romaji.localeCompare(b.romaji, undefined, { numeric: true, sensitivity: 'base' }) || a.kind.localeCompare(b.kind));
    }

    function countNameMapEntries(map = nameMap) {
        return getNameMapEntries(map).length;
    }

    function normalizePreferredLanguage(value) {
        return preferredLanguageOptions.some(([option]) => option === value) ? value : 'off';
    }

    async function loadPreferredLanguage() {
        return normalizePreferredLanguage(await GM.getValue(preferredLanguageKey, 'off'));
    }

    async function loadCloseBookPageAfterDownload() {
        return Boolean(await GM.getValue(closeBookPageAfterDownloadKey, false));
    }

    function getPreferredLanguageRedirectPath(pathname, language) {
        if (language === 'off') return null;

        if (pathname === '/') {
            return `/index-${language}.html`;
        }

        const redirectPath = pathname.replace(
            /^\/(artist|tag|series|character|group|type)\/(.+)-all\.html$/,
            `/$1/$2-${language}.html`
        );

        return redirectPath === pathname ? null : redirectPath;
    }

    async function maybeRedirectToPreferredLanguage() {
        const language = await loadPreferredLanguage();
        const redirectPath = getPreferredLanguageRedirectPath(location.pathname, language);
        if (!redirectPath) return false;

        window.location.replace(new URL(redirectPath, location.href).href);
        return true;
    }

    function getBookIdFromElement(elem) {
        // List-page features must work for both old and current Hitomi markup, so
        // prefer direct child title/anchor links and derive the id from the URL.
        const link = elem.querySelector(':scope > h1.lillie a[href], :scope > h1 a[href], :scope > a[href]');
        if (!link) return null;

        const pathname = new URL(link.getAttribute('href'), location.href).pathname;
        const pathWithoutExtension = pathname.replace(/\.[^/.]+$/, '');
        return pathWithoutExtension.match(/(\d+)$/)?.[1] || null;
    }

    async function loadFoldedBookIds() {
        // The current format is an array, but an older object map is accepted so
        // manual folded state survives earlier development versions.
        const value = await GM.getValue(foldedBookIdsKey, []);
        if (Array.isArray(value)) {
            foldedBookIds = new Set(value.map(String));
            return;
        }

        if (value && typeof value === 'object') {
            foldedBookIds = new Set(Object.entries(value).filter(([, folded]) => folded).map(([id]) => id));
        }
    }

    function saveFoldedBookIds() {
        GM.setValue(foldedBookIdsKey, [...foldedBookIds]).catch(() => {});
    }

    function isEditableTarget(target) {
        if (!(target instanceof Element)) return false;

        return Boolean(target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable);
    }

    function hasPlainModifierState(e) {
        return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    }

    function installStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .hitomi-folded h1.lillie {
                padding-left: 0 !important;
                font-size: 0.9em !important;
            }

            .hitomi-match {
                background-color: rgba(220, 50, 50, 0.2) !important;
                background-image: none !important;
                border-radius: 3px;
                text-decoration: line-through !important;
            }

            .hitomi-switch {
                position: relative;
                display: inline-flex;
                flex: 0 0 auto;
                width: 44px;
                height: 24px;
                cursor: pointer;
                -webkit-tap-highlight-color: transparent;
            }

            .hitomi-switch-input {
                position: absolute;
                opacity: 0;
                width: 0;
                height: 0;
            }

            .hitomi-switch-slider {
                position: absolute;
                inset: 0;
                border-radius: 999px;
                background: #c7ced8;
                box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
                transition: background 160ms ease, box-shadow 160ms ease;
            }

            .hitomi-switch-slider::before {
                content: "";
                position: absolute;
                top: 3px;
                left: 3px;
                width: 18px;
                height: 18px;
                border-radius: 50%;
                background: #fff;
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.22);
                transition: transform 160ms ease;
            }

            .hitomi-switch-input:checked + .hitomi-switch-slider {
                background: #2563eb;
                box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.18);
            }

            .hitomi-switch-input:checked + .hitomi-switch-slider::before {
                transform: translateX(20px);
            }

            .hitomi-switch-input:focus-visible + .hitomi-switch-slider {
                outline: 2px solid rgba(37, 99, 235, 0.35);
                outline-offset: 3px;
            }

            div.gallery-content > div.${focusedBookClassName} {
                position: relative;
                outline: 3px solid rgba(56, 189, 248, 0.95);
                outline-offset: 8px;
                border-radius: 8px;
                box-shadow:
                    0 0 0 1px rgba(14, 165, 233, 0.45),
                    0 0 26px rgba(56, 189, 248, 0.38),
                    0 12px 34px rgba(15, 23, 42, 0.16);
                transition: outline-color 120ms ease, box-shadow 120ms ease;
            }

            .${helpOverlayClassName} {
                position: fixed;
                inset: 0;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 24px;
                background: rgba(15, 23, 42, 0.58);
                color: #e5edf7;
                font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }

            .${helpOverlayHiddenClassName} {
                display: none;
            }

            .${helpOverlayClassName} > div {
                width: min(460px, 100%);
                padding: 18px;
                border: 1px solid rgba(148, 163, 184, 0.38);
                border-radius: 8px;
                background: rgba(17, 24, 39, 0.96);
                box-shadow: 0 22px 70px rgba(0, 0, 0, 0.34);
            }

            .${helpOverlayClassName} h2 {
                margin: 0 0 14px;
                color: #f8fafc;
                font-size: 16px;
                font-weight: 700;
                letter-spacing: 0;
            }

            .${helpOverlayClassName} dl {
                display: grid;
                grid-template-columns: max-content 1fr;
                gap: 10px 14px;
                margin: 0;
            }

            .${helpOverlayClassName} dt {
                min-width: 32px;
                padding: 2px 8px;
                border: 1px solid rgba(148, 163, 184, 0.5);
                border-radius: 6px;
                background: rgba(30, 41, 59, 0.92);
                color: #f8fafc;
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                font-size: 13px;
                line-height: 1.45;
                text-align: center;
            }

            .${helpOverlayClassName} dd {
                margin: 0;
                color: #cbd5e1;
            }

            .${downloadProgressStackClassName} {
                position: fixed;
                right: 176px;
                bottom: 16px;
                z-index: 10000;
                width: min(320px, calc(100vw - 32px));
                display: flex;
                flex-direction: column;
                gap: 8px;
                pointer-events: none;
            }

            .${downloadProgressClassName} {
                padding: 12px;
                border: 1px solid rgba(15, 23, 42, 0.16);
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.96);
                box-shadow: 0 12px 34px rgba(15, 23, 42, 0.22);
                color: #0f172a;
                font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }

            .${downloadProgressClassName} div {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            div.gallery-content > div.${bookDownloadProgressClassName} {
                --hitomi-tweak-download-percent: 0%;
                background-image:
                    linear-gradient(
                        90deg,
                        rgba(59, 130, 246, 0.22) 0 var(--hitomi-tweak-download-percent),
                        rgba(255, 255, 255, 0) var(--hitomi-tweak-download-percent) 100%
                    ) !important;
                background-repeat: no-repeat !important;
                transition: background-image 160ms ease;
            }

            div.gallery-content > div.${bookDownloadDoneClassName} {
                background-image:
                    linear-gradient(
                        90deg,
                        rgba(59, 130, 246, 0.32) 0 100%,
                        rgba(255, 255, 255, 0) 100%
                    ) !important;
            }

            div.gallery-content > div.${bookDownloadCanceledClassName} {
                background-image:
                    linear-gradient(
                        90deg,
                        rgba(248, 113, 113, 0.24) 0 100%,
                        rgba(255, 255, 255, 0) 100%
                    ) !important;
            }

            div.gallery-content > div.${bookDownloadErrorClassName} {
                background-image:
                    linear-gradient(
                        90deg,
                        rgba(239, 68, 68, 0.24) 0 100%,
                        rgba(255, 255, 255, 0) 100%
                    ) !important;
            }

            .${bookDownloadProgressLabelClassName} {
                position: absolute;
                top: 8px;
                right: 8px;
                z-index: 2;
                max-width: calc(100% - 16px);
                padding: 3px 8px;
                border-radius: 6px;
                background: rgba(15, 23, 42, 0.82);
                color: #f8fafc;
                font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                pointer-events: none;
            }

            #progressbar {
                position: relative;
                box-sizing: border-box !important;
                height: 21px;
                padding: 3px !important;
                border: none !important;
                border-radius: 10.5px;
                background: #0f172a !important;
                overflow: hidden;
            }

            #progressbar .ui-progressbar-value {
                height: 100%;
                margin: 0;
                border: none !important;
                border-radius: 7.5px;
                background:
                    repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.25) 0 6px, transparent 6px 12px),
                    #38bdf8 !important;
                animation: hitomi-tweak-progress-stripes 0.9s linear infinite;
                transition: width 0.25s ease;
            }

            #progressbar > .${bookPageProgressLabelClassName} {
                position: absolute;
                top: 0;
                right: 9px;
                z-index: 2;
                height: 21px;
                display: flex;
                align-items: center;
                background: transparent !important;
                border: none !important;
                color: #e2e8f0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-size: 11px;
                font-weight: 600;
                line-height: 1;
                font-variant-numeric: tabular-nums;
                text-shadow: 0 0 2px rgba(2, 6, 23, 0.6);
                white-space: nowrap;
                pointer-events: none;
            }

            #progressbar > .${bookPageProgressLabelClassName}:empty {
                display: none;
            }

            #progressbar .ui-progressbar-overlay {
                display: none;
            }

            @keyframes hitomi-tweak-progress-stripes {
                from { background-position: 0 0; }
                to { background-position: 16.97px 0; }
            }

            h1.lillie.${downloadedBookHeadingClassName}::before {
                content: "✓";
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                margin-right: 6px;
                border: 1px solid rgba(37, 99, 235, 0.42);
                border-radius: 50%;
                background: rgba(59, 130, 246, 0.16);
                color: #2563eb;
                font: 700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                vertical-align: 2px;
            }
        `;
        document.head.appendChild(style);
    }

    // FilterBook is the shared list-card abstraction for filtering, folding,
    // keyboard focus, downloaded markers, and download progress overlays.
    class FilterBook {
        constructor(elem) {
            this.elem = elem;
            this.bookId = getBookIdFromElement(elem);
            this.title = this.#getText('h1.lillie');
            this.authors = this.#getList('div.artist-list li');
            this.series = this.#getList('table.dj-desc tr:nth-of-type(1) td:nth-of-type(2) li');
            this.type = this.#getText('table.dj-desc tr:nth-of-type(2) td:nth-of-type(2)');
            this.language = this.#getText('table.dj-desc tr:nth-of-type(3) td:nth-of-type(2)');
            this.tags = this.#getList('td.relatedtags li', tag => tag !== '...');

            this.elem.addEventListener('click', e => {
                const header = this.elem.querySelector('h1.lillie');
                if (!header) return;

                const withinHeader = header.contains(e.target);
                const isLink = e.target.tagName === 'A';

                if (!withinHeader) return;

                if (this.#isFolded()) {
                    if (isLink) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                    this.setManualFolded(false);
                } else {
                    this.setManualFolded(true);
                }
            });

            const header = this.elem.querySelector('h1.lillie');
            if (header) {
                header.style.cursor = 'pointer';
            }

            this.elem.style.position = 'relative';
            this.applySavedFoldState();
        }

        refresh() {
            this.bookId = getBookIdFromElement(this.elem);
            this.title = this.#getText('h1.lillie');
            this.authors = this.#getList('div.artist-list li');
            this.series = this.#getList('table.dj-desc tr:nth-of-type(1) td:nth-of-type(2) li');
            this.type = this.#getText('table.dj-desc tr:nth-of-type(2) td:nth-of-type(2)');
            this.language = this.#getText('table.dj-desc tr:nth-of-type(3) td:nth-of-type(2)');
            this.tags = this.#getList('td.relatedtags li', tag => tag !== '...');
        }

        #isFolded() {
            return this.elem.classList.contains('hitomi-folded');
        }

        fold() {
            if (this.#isFolded()) return;
            this.#fold();
        }

        setManualFolded(state) {
            // Only explicit user toggles write foldedBookIds. Automatic folds from
            // blacklist matches or downloaded history should not become permanent.
            this.folded = state;

            if (!this.bookId) return;
            if (state) {
                foldedBookIds.add(this.bookId);
            } else {
                foldedBookIds.delete(this.bookId);
            }
            saveFoldedBookIds();
        }

        toggleManualFolded() {
            this.setManualFolded(!this.#isFolded());
        }

        applySavedFoldState() {
            this.folded = Boolean(this.bookId && foldedBookIds.has(this.bookId));
        }

        #fold() {
            this.elem.classList.add('hitomi-folded');
            this.elem.querySelectorAll(':scope > *:not(h1.lillie):not(.hitomi-toggle)').forEach(c => {
                c.style.display = 'none';
            });
        }

        #unfold() {
            this.elem.classList.remove('hitomi-folded');
            this.elem.querySelectorAll(':scope > *:not(h1.lillie):not(.hitomi-toggle)').forEach(c => {
                c.style.display = '';
            });
        }

        #getText(selector) {
            const node = this.elem.querySelector(selector);
            return node ? node.textContent : '';
        }

        #getList(selector, filter) {
            const values = Array.from(this.elem.querySelectorAll(selector), item => item.textContent);
            return filter ? values.filter(filter) : values;
        }

        setFiltered(matches) {
            // Filtering folds matches visually, but restoring the filter should return
            // the book to the saved manual fold state instead of overwriting it.
            this.elem.querySelectorAll('.hitomi-match').forEach(el => el.classList.remove('hitomi-match'));

            if (matches.matched) {
                this.fold();
                this.#applyHighlights(matches);
            } else {
                this.applySavedFoldState();
            }
        }

        #applyHighlights(matches) {
            if (matches.titleMatched) {
                this.elem.querySelector('h1.lillie')?.classList.add('hitomi-match');
            }
            if (matches.authors.length > 0) {
                this.#highlightLinks('div.artist-list li a', matches.authors);
            }
            if (matches.tags.length > 0) {
                this.#highlightLinks('td.relatedtags li a', matches.tags);
            }
            if (matches.series.length > 0) {
                this.#highlightLinks('table.dj-desc tr:nth-of-type(1) td:nth-of-type(2) li a', matches.series);
            }
            if (matches.type.length > 0) {
                this.#highlightLinks('table.dj-desc tr:nth-of-type(2) td:nth-of-type(2) a', matches.type);
            }
            if (matches.language.length > 0) {
                this.#highlightLinks('table.dj-desc tr:nth-of-type(3) td:nth-of-type(2) a', matches.language);
            }
        }

        #highlightLinks(selector, matchedValues) {
            const lowerMatchedValues = matchedValues.map(v => v.toLowerCase());
            for (const a of this.elem.querySelectorAll(selector)) {
                if (lowerMatchedValues.includes(a.textContent.trim().toLowerCase())) {
                    a.classList.add('hitomi-match');
                    a.closest('li')?.classList.add('hitomi-match');
                }
            }
        }

        set folded(state) {
            if (state) {
                this.fold();
            } else {
                this.elem.classList.remove('hitomi-folded');
                this.elem.querySelectorAll(':scope > *:not(h1.lillie):not(.hitomi-toggle)').forEach(c => {
                    c.style.display = '';
                });
            }
        }
    }

    function getFilterBook(elem) {
        let book = filterBookMap.get(elem);
        if (!book) {
            book = new FilterBook(elem);
            filterBookMap.set(elem, book);
        } else {
            book.refresh();
        }
        return book;
    }

    function getMatches(book, blackList) {
        const lowerLanguage = book.language.toLowerCase();
        const language = blackList.language.filter(x => lowerLanguage === x.toLowerCase());

        const lowerAuthors = book.authors.map(a => a.toLowerCase());
        const authors = blackList.author.filter(x => lowerAuthors.includes(x.toLowerCase()));

        const lowerTags = book.tags.map(t => t.toLowerCase());
        const tags = blackList.tag.filter(x => lowerTags.includes(x.toLowerCase()));

        const lowerSeries = book.series.map(s => s.toLowerCase());
        const series = blackList.series.filter(x => lowerSeries.includes(x.toLowerCase()));

        const titleMatched = blackList.title.some(x => {
            try {
                return new RegExp(x, 'i').test(book.title);
            } catch (e) {
                return false;
            }
        });

        const lowerType = book.type.toLowerCase();
        const type = blackList.type.filter(x => lowerType === x.toLowerCase());

        return {
            matched: language.length > 0 || authors.length > 0 || tags.length > 0 || series.length > 0 || titleMatched || type.length > 0,
            language,
            authors,
            tags,
            series,
            titleMatched,
            type
        };
    }

    async function loadBlacklist() {
        const data = {};
        for (const key of blacklistKeys) {
            const value = await GM.getValue(blacklistStorageKey(key), '');
            data[key] = value.split('\n').map(s => s.trim()).filter(Boolean);
        }
        return data;
    }

    async function saveBlacklistFromInputs(container) {
        for (const key of blacklistKeys) {
            const text = container.querySelector(`#blacklist-input-${key}`).value;
            await GM.setValue(blacklistStorageKey(key), text);
        }
    }

    function filter(blackList) {
        if (!filterEnabled) return;
        // The stable book boundary is the direct child of gallery-content, not a
        // specific card class. Several Hitomi card classes have appeared over time.
        document.querySelectorAll('div.gallery-content > div').forEach(elem => {
            const book = getFilterBook(elem);
            book.setFiltered(getMatches(book, blackList));
        });
    }

    function clearFilter() {
        document.querySelectorAll('div.gallery-content > div').forEach(elem => {
            getFilterBook(elem).applySavedFoldState();
        });
        document.querySelectorAll('div.gallery-content .hitomi-match').forEach(el => {
            el.classList.remove('hitomi-match');
        });
    }

    function refreshFilter(blackList) {
        clearFilter();
        filter(blackList);
    }

    async function blacklistClickHandler(e) {
        if (e.target.closest(`#${filterPanelId}`)) return;

        const link = e.target.closest('a');
        if (link) {
            e.preventDefault();
            e.stopPropagation();
        }

        const elem = e.target;
        const map = [
            { selector: 'div.artist-list li a', key: 'author' },
            { selector: 'td.relatedtags li a', key: 'tag' },
            { selector: 'table.dj-desc tr:nth-of-type(1) td:nth-of-type(2) li a', key: 'series' },
            { selector: 'table.dj-desc tr:nth-of-type(2) td:nth-of-type(2) a', key: 'type' },
            { selector: 'table.dj-desc tr:nth-of-type(3) td:nth-of-type(2) a', key: 'language' },
            { selector: 'h1.lillie a', key: 'title' }
        ];

        for (const { selector, key } of map) {
            if (elem.matches(selector)) {
                const value = elem.textContent.trim();
                const current = await GM.getValue(blacklistStorageKey(key), '');
                const lines = new Set(current.split('\n').map(l => l.trim()).filter(Boolean));
                lines.add(value);
                await GM.setValue(blacklistStorageKey(key), [...lines].join('\n'));

                const input = document.querySelector(`#blacklist-input-${key}`);
                if (input) input.value = [...lines].join('\n');

                const blackList = await loadBlacklist();
                refreshFilter(blackList);
                break;
            }
        }
    }

    async function createFilterUI() {
        const panel = document.createElement('div');
        panel.id = filterPanelId;
        Object.assign(panel.style, {
            position: 'fixed',
            top: '10px',
            bottom: '10px',
            right: '10px',
            width: '150px',
            overflowY: 'auto',
            background: 'rgba(255, 255, 255, 0.85)',
            border: '1px solid rgba(0, 0, 0, 0.1)',
            borderRadius: '8px',
            padding: '16px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
            fontSize: '14px',
            zoom: '0.95',
            zIndex: 9999
        });

        const form = document.createElement('div');
        const preferredLanguageRow = document.createElement('div');
        const preferredLanguageLabel = document.createElement('label');
        const preferredLanguageSelect = document.createElement('select');
        let saveTimer = null;

        Object.assign(preferredLanguageRow.style, {
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            marginBottom: '12px'
        });

        preferredLanguageLabel.textContent = 'Preferred Language:';
        preferredLanguageLabel.htmlFor = 'hitomi-tweak-preferred-language-select';
        Object.assign(preferredLanguageLabel.style, {
            fontWeight: 'bold'
        });

        preferredLanguageSelect.id = preferredLanguageLabel.htmlFor;
        preferredLanguageSelect.style.width = '100%';
        // This setting is intentionally saved before redirect behavior exists. Keeping
        // the first step inert makes the later hitomi-redirect merge easier to verify.
        for (const [value, label] of preferredLanguageOptions) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            preferredLanguageSelect.appendChild(option);
        }
        preferredLanguageSelect.value = await loadPreferredLanguage();
        preferredLanguageSelect.addEventListener('change', () => {
            GM.setValue(preferredLanguageKey, preferredLanguageSelect.value).catch(() => {});
        });

        preferredLanguageRow.append(preferredLanguageLabel, preferredLanguageSelect);
        form.appendChild(preferredLanguageRow);

        // Preferred language redirects to a language page; the blocklist below folds
        // books by condition. Separate them visually so they don't read as one setting.
        const blocklistHeading = document.createElement('div');
        const blocklistHeadingText = document.createElement('label');
        const toggleCheckbox = document.createElement('input');
        const toggleSwitch = document.createElement('label');
        const toggleSlider = document.createElement('span');

        blocklistHeadingText.textContent = 'Blocklist';
        blocklistHeadingText.htmlFor = 'hitomi-tweak-filter-enabled-toggle';
        Object.assign(blocklistHeadingText.style, {
            cursor: 'pointer',
            userSelect: 'none'
        });

        toggleCheckbox.id = blocklistHeadingText.htmlFor;
        toggleCheckbox.className = 'hitomi-switch-input';
        toggleCheckbox.type = 'checkbox';
        toggleCheckbox.checked = filterEnabled;
        toggleCheckbox.setAttribute('aria-label', 'Blocklist enabled');
        toggleCheckbox.addEventListener('change', () => {
            filterEnabled = toggleCheckbox.checked;
            if (filterEnabled) {
                loadBlacklist().then(refreshFilter);
            } else {
                clearFilter();
            }
        });

        toggleSwitch.className = 'hitomi-switch';
        toggleSwitch.htmlFor = toggleCheckbox.id;

        toggleSlider.className = 'hitomi-switch-slider';
        toggleSwitch.append(toggleCheckbox, toggleSlider);

        Object.assign(blocklistHeading.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            fontWeight: 'bold',
            marginTop: '12px',
            paddingTop: '12px',
            borderTop: '1px solid rgba(0, 0, 0, 0.3)'
        });
        blocklistHeading.append(blocklistHeadingText, toggleSwitch);
        form.appendChild(blocklistHeading);

        for (const key of blacklistKeys) {
            const label = document.createElement('label');
            label.textContent = `${key.charAt(0).toUpperCase()}${key.slice(1).toLowerCase()}:`;
            if (key === 'title') label.textContent += ' (regex supported)';
            label.style.display = 'block';
            label.style.marginTop = '8px';

            const textarea = document.createElement('textarea');
            textarea.id = `blacklist-input-${key}`;
            textarea.rows = 4;
            textarea.style.width = '100%';
            textarea.addEventListener('input', () => {
                clearTimeout(saveTimer);
                saveTimer = setTimeout(async () => {
                    await saveBlacklistFromInputs(panel);
                    const blackList = await loadBlacklist();
                    refreshFilter(blackList);
                }, 400);
            });

            form.append(label, textarea);
        }

        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export';

        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import';

        const nameMapExportBtn = document.createElement('button');
        nameMapExportBtn.textContent = 'Export';

        const nameMapImportBtn = document.createElement('button');
        nameMapImportBtn.textContent = 'Import';

        const closeAfterDownloadSection = document.createElement('div');
        const closeAfterDownloadLabel = document.createElement('label');
        const closeAfterDownloadCheckbox = document.createElement('input');
        const closeAfterDownloadSwitch = document.createElement('label');
        const closeAfterDownloadSlider = document.createElement('span');

        closeAfterDownloadLabel.textContent = 'Auto tab close';
        closeAfterDownloadLabel.htmlFor = 'hitomi-tweak-close-after-download-toggle';
        Object.assign(closeAfterDownloadLabel.style, {
            cursor: 'pointer',
            userSelect: 'none'
        });

        closeAfterDownloadCheckbox.id = closeAfterDownloadLabel.htmlFor;
        closeAfterDownloadCheckbox.className = 'hitomi-switch-input';
        closeAfterDownloadCheckbox.type = 'checkbox';
        closeAfterDownloadCheckbox.checked = await loadCloseBookPageAfterDownload();
        closeAfterDownloadCheckbox.setAttribute('aria-label', 'Close tab after book page download');
        closeAfterDownloadCheckbox.addEventListener('change', () => {
            GM.setValue(closeBookPageAfterDownloadKey, closeAfterDownloadCheckbox.checked).catch(() => {});
        });

        closeAfterDownloadSwitch.className = 'hitomi-switch';
        closeAfterDownloadSwitch.htmlFor = closeAfterDownloadCheckbox.id;

        closeAfterDownloadSlider.className = 'hitomi-switch-slider';
        closeAfterDownloadSwitch.append(closeAfterDownloadCheckbox, closeAfterDownloadSlider);

        exportBtn.addEventListener('click', async () => {
            const data = {};
            for (const key of blacklistKeys) {
                data[key] = await GM.getValue(blacklistStorageKey(key), '');
            }

            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'hitomi-tweak-blacklist-backup.json';
            a.click();
            URL.revokeObjectURL(url);
        });

        importBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.addEventListener('change', async () => {
                if (!input.files.length) return;

                const text = await input.files[0].text();
                try {
                    const data = JSON.parse(text);
                    for (const key of blacklistKeys) {
                        if (typeof data[key] === 'string') {
                            await GM.setValue(blacklistStorageKey(key), data[key]);
                            panel.querySelector(`#blacklist-input-${key}`).value = data[key];
                        }
                    }

                    const blackList = await loadBlacklist();
                    refreshFilter(blackList);
                } catch (e) {
                    alert('Invalid file format');
                }
            });
            input.click();
        });

        nameMapExportBtn.addEventListener('click', async () => {
            const data = normalizeNameMap(await GM.getValue(nameMapKey, nameMap));
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'hitomi-tweak-name-map-backup.json';
            a.click();
            URL.revokeObjectURL(url);
        });

        nameMapImportBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.addEventListener('change', async () => {
                if (!input.files.length) return;

                const text = await input.files[0].text();
                try {
                    const beforeCount = countNameMapEntries();
                    await saveNameMap(JSON.parse(text));
                    alert(`Name map imported: ${beforeCount} -> ${countNameMapEntries()} entries`);
                } catch (e) {
                    alert('Invalid name map format');
                }
            });
            input.click();
        });

        panel.appendChild(form);

        const buttonRow = document.createElement('div');
        Object.assign(buttonRow.style, {
            marginTop: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
        });

        filterMarkModeButton = document.createElement('button');
        filterMarkModeButton.textContent = 'Blocklist Mode';
        filterMarkModeButton.dataset.active = 'false';

        const markModeRow = document.createElement('div');
        Object.assign(markModeRow.style, {
            display: 'flex',
            gap: '10px'
        });
        markModeRow.appendChild(filterMarkModeButton);

        const backupRow = document.createElement('div');
        Object.assign(backupRow.style, {
            display: 'flex',
            gap: '10px'
        });
        backupRow.append(exportBtn, importBtn);

        const nameMapHeading = document.createElement('div');
        const nameMapEditLink = document.createElement('a');

        nameMapEditLink.href = nameMapPagePath;
        nameMapEditLink.textContent = 'Edit';
        Object.assign(nameMapEditLink.style, {
            fontWeight: 'normal'
        });
        Object.assign(nameMapHeading.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            fontWeight: 'bold',
            marginTop: '2px',
            paddingTop: '12px',
            borderTop: '1px solid rgba(0, 0, 0, 0.3)'
        });
        nameMapHeading.append('Name Map', nameMapEditLink);

        const nameMapBackupRow = document.createElement('div');
        Object.assign(nameMapBackupRow.style, {
            display: 'flex',
            gap: '10px'
        });
        nameMapBackupRow.append(nameMapExportBtn, nameMapImportBtn);

        Object.assign(closeAfterDownloadSection.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            fontWeight: 'bold',
            marginTop: '2px',
            paddingTop: '12px',
            borderTop: '1px solid rgba(0, 0, 0, 0.3)'
        });
        closeAfterDownloadSection.append(closeAfterDownloadLabel, closeAfterDownloadSwitch);

        buttonRow.append(markModeRow, backupRow, nameMapHeading, nameMapBackupRow, closeAfterDownloadSection);
        panel.appendChild(buttonRow);

        for (const key of blacklistKeys) {
            const value = await GM.getValue(blacklistStorageKey(key), '');
            panel.querySelector(`#blacklist-input-${key}`).value = value;
        }

        filterMarkModeButton.addEventListener('click', () => {
            const active = filterMarkModeButton.dataset.active === 'true';
            filterMarkModeButton.dataset.active = String(!active);
            filterMarkModeButton.style.background = !active ? '#ffcccc' : '';
            if (!active) {
                document.body.addEventListener('click', blacklistClickHandler, true);
            } else {
                document.body.removeEventListener('click', blacklistClickHandler, true);
            }
        });

        document.body.appendChild(panel);
    }

    function observeGallery(blackList) {
        const gallery = document.querySelector('div.gallery-content');
        if (!gallery) return;

        const observer = new MutationObserver(async () => {
            // Hitomi list pages lazy-load cards. Reapply both blacklist folding and
            // downloaded indicators whenever real gallery content is inserted.
            const hasContent = Array.from(gallery.children).some(c => c.id !== 'loader-content');
            if (hasContent) {
                const currentBlackList = await loadBlacklist();
                filter(currentBlackList);
                refreshDownloadIndicators().catch(() => {});
            }
        });
        observer.observe(gallery, { childList: true });

        const hasContent = Array.from(gallery.children).some(c => c.id !== 'loader-content');
        if (hasContent) {
            filter(blackList);
            refreshDownloadIndicators().catch(() => {});
        }
    }

    async function installFilter() {
        await loadFoldedBookIds();
        await createFilterUI();
        const blackList = await loadBlacklist();
        observeGallery(blackList);
    }

    async function renderNameMapPage() {
        await loadNameMap();

        document.title = 'Hitomi::Tweak Name Map';
        document.body.replaceChildren();

        const style = document.createElement('style');
        style.textContent = `
            :root {
                color-scheme: light;
            }
            body {
                margin: 0;
                background: #f6f7f9;
                color: #1f2328;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
            }
            .hitomi-name-map-page {
                box-sizing: border-box;
                min-height: 100vh;
                padding: 24px;
            }
            .hitomi-name-map-header {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 16px;
            }
            .hitomi-name-map-header h1 {
                margin: 0;
                font-size: 24px;
                line-height: 1.25;
            }
            .hitomi-name-map-status {
                min-height: 20px;
                color: #57606a;
                font-size: 14px;
            }
            .hitomi-name-map-notice {
                margin-bottom: 16px;
                padding: 10px 12px;
                border: 1px solid #d0d7de;
                background: #fff8c5;
                border-radius: 6px;
                font-size: 14px;
            }
            .hitomi-name-map-controls,
            .hitomi-name-map-add-form {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-bottom: 16px;
            }
            .hitomi-name-map-controls input,
            .hitomi-name-map-add-form input,
            .hitomi-name-map-add-form select {
                box-sizing: border-box;
                min-height: 34px;
                padding: 6px 8px;
                border: 1px solid #d0d7de;
                border-radius: 6px;
                background: #fff;
                font: inherit;
            }
            .hitomi-name-map-controls input {
                flex: 1 1 280px;
            }
            .hitomi-name-map-add-form input {
                flex: 1 1 180px;
            }
            .hitomi-name-map-controls button,
            .hitomi-name-map-add-form button,
            .hitomi-name-map-table button {
                min-height: 34px;
                padding: 6px 10px;
                border: 1px solid #d0d7de;
                border-radius: 6px;
                background: #fff;
                color: #1f2328;
                font: inherit;
                cursor: pointer;
            }
            .hitomi-name-map-table-wrap {
                overflow: auto;
                border: 1px solid #d0d7de;
                border-radius: 6px;
                background: #fff;
            }
            .hitomi-name-map-table {
                width: 100%;
                border-collapse: collapse;
                table-layout: fixed;
            }
            .hitomi-name-map-table th,
            .hitomi-name-map-table td {
                padding: 8px 10px;
                border-bottom: 1px solid #d8dee4;
                text-align: left;
                vertical-align: middle;
                word-break: break-word;
            }
            .hitomi-name-map-table th {
                position: sticky;
                top: 0;
                background: #f6f8fa;
                font-weight: 600;
            }
            .hitomi-name-map-table tr:last-child td {
                border-bottom: 0;
            }
            .hitomi-name-map-editable {
                cursor: text;
            }
            .hitomi-name-map-editable input {
                box-sizing: border-box;
                width: 100%;
                min-height: 30px;
                padding: 4px 6px;
                border: 1px solid #0969da;
                border-radius: 4px;
                font: inherit;
            }
        `;
        document.head.appendChild(style);

        const page = document.createElement('main');
        const header = document.createElement('div');
        const title = document.createElement('h1');
        const status = document.createElement('div');
        const notice = document.createElement('div');
        const controls = document.createElement('div');
        const searchInput = document.createElement('input');
        const exportBtn = document.createElement('button');
        const importBtn = document.createElement('button');
        const addForm = document.createElement('form');
        const romajiInput = document.createElement('input');
        const japaneseInput = document.createElement('input');
        const kindSelect = document.createElement('select');
        const addBtn = document.createElement('button');
        const tableWrap = document.createElement('div');
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const tbody = document.createElement('tbody');
        const headerRow = document.createElement('tr');

        page.className = 'hitomi-name-map-page';
        header.className = 'hitomi-name-map-header';
        status.className = 'hitomi-name-map-status';
        notice.className = 'hitomi-name-map-notice';
        controls.className = 'hitomi-name-map-controls';
        addForm.className = 'hitomi-name-map-add-form';
        tableWrap.className = 'hitomi-name-map-table-wrap';
        table.className = 'hitomi-name-map-table';

        title.textContent = 'Name Map';
        status.textContent = `${countNameMapEntries()} entries`;
        notice.textContent = 'Imports replace the entire map. Manual edits here are lost on the next external dictionary import, so keep permanent fixes in the external dictionary too.';

        searchInput.type = 'search';
        searchInput.placeholder = 'Search romaji or Japanese name';
        exportBtn.type = 'button';
        exportBtn.textContent = 'Export';
        importBtn.type = 'button';
        importBtn.textContent = 'Import';

        romajiInput.type = 'text';
        romajiInput.placeholder = 'romaji';
        japaneseInput.type = 'text';
        japaneseInput.placeholder = 'Japanese name';
        addBtn.type = 'submit';
        addBtn.textContent = 'Add';
        for (const kind of ['group', 'author', 'series']) {
            const option = document.createElement('option');
            option.value = kind;
            option.textContent = kind;
            kindSelect.appendChild(option);
        }

        ['romaji', 'Japanese name', 'kind', ''].forEach(label => {
            const th = document.createElement('th');
            th.textContent = label;
            headerRow.appendChild(th);
        });

        function setStatus(text) {
            status.textContent = text;
        }

        function downloadNameMap() {
            const blob = new Blob([JSON.stringify(nameMap, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'hitomi-tweak-name-map-backup.json';
            a.click();
            URL.revokeObjectURL(url);
        }

        function getFilteredEntries() {
            const query = searchInput.value.trim().toLowerCase();
            return getNameMapEntries().filter(entry => !query
                || entry.romaji.toLowerCase().includes(query)
                || entry.japanese.toLowerCase().includes(query));
        }

        function renderTable() {
            const entries = getFilteredEntries();
            tbody.replaceChildren(...entries.map(entry => {
                const tr = document.createElement('tr');
                const romajiTd = document.createElement('td');
                const japaneseTd = document.createElement('td');
                const kindTd = document.createElement('td');
                const actionTd = document.createElement('td');
                const deleteBtn = document.createElement('button');

                romajiTd.textContent = entry.romaji;
                japaneseTd.textContent = entry.japanese;
                japaneseTd.className = 'hitomi-name-map-editable';
                japaneseTd.title = 'Click to edit';
                kindTd.textContent = entry.kind;
                deleteBtn.type = 'button';
                deleteBtn.textContent = 'Delete';

                japaneseTd.addEventListener('click', () => {
                    if (japaneseTd.querySelector('input')) return;

                    const input = document.createElement('input');
                    let canceled = false;
                    input.type = 'text';
                    input.value = entry.japanese;
                    japaneseTd.replaceChildren(input);
                    input.focus();
                    input.select();

                    input.addEventListener('keydown', event => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            input.blur();
                        } else if (event.key === 'Escape') {
                            canceled = true;
                            renderTable();
                        }
                    });

                    input.addEventListener('blur', async () => {
                        if (canceled) return;

                        const nextValue = input.value.trim();
                        if (!nextValue) {
                            setStatus('Japanese name is required.');
                            renderTable();
                            return;
                        }

                        if (nextValue !== entry.japanese) {
                            const nextMap = normalizeNameMap(nameMap);
                            nextMap[entry.kind][entry.romaji] = nextValue;
                            await saveNameMap(nextMap);
                            setStatus(`Updated ${entry.romaji}`);
                        }
                        renderTable();
                    }, { once: true });
                });

                deleteBtn.addEventListener('click', async () => {
                    const nextMap = normalizeNameMap(nameMap);
                    delete nextMap[entry.kind][entry.romaji];
                    await saveNameMap(nextMap);
                    setStatus(`Deleted ${entry.romaji}. ${countNameMapEntries()} entries`);
                    renderTable();
                });

                actionTd.appendChild(deleteBtn);
                tr.append(romajiTd, japaneseTd, kindTd, actionTd);
                return tr;
            }));

            if (!entries.length) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 4;
                td.textContent = 'No entries found.';
                tr.appendChild(td);
                tbody.appendChild(tr);
            }
        }

        exportBtn.addEventListener('click', downloadNameMap);
        importBtn.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.addEventListener('change', async () => {
                if (!input.files.length) return;

                const beforeCount = countNameMapEntries();
                try {
                    const imported = normalizeNameMap(JSON.parse(await input.files[0].text()));
                    await saveNameMap(imported);
                    const afterCount = countNameMapEntries();
                    setStatus(`${beforeCount} -> ${afterCount} entries`);
                    renderTable();
                } catch (e) {
                    setStatus('Invalid name map format.');
                }
            });
            input.click();
        });
        searchInput.addEventListener('input', renderTable);

        addForm.addEventListener('submit', async event => {
            event.preventDefault();

            const romaji = normalizeNameMapKey(romajiInput.value);
            const japanese = japaneseInput.value.trim();
            const kind = kindSelect.value;
            if (!romaji || !japanese || !['group', 'author', 'series'].includes(kind)) {
                setStatus('Romaji, Japanese name, and kind are required.');
                return;
            }

            const nextMap = normalizeNameMap(nameMap);
            const existed = Object.prototype.hasOwnProperty.call(nextMap[kind], romaji);
            nextMap[kind][romaji] = japanese;
            await saveNameMap(nextMap);
            romajiInput.value = '';
            japaneseInput.value = '';
            setStatus(`${existed ? 'Updated' : 'Added'} ${romaji}. ${countNameMapEntries()} entries`);
            renderTable();
        });

        header.append(title, status);
        controls.append(searchInput, exportBtn, importBtn);
        addForm.append(romajiInput, japaneseInput, kindSelect, addBtn);
        thead.appendChild(headerRow);
        table.append(thead, tbody);
        tableWrap.appendChild(table);
        page.append(header, notice, controls, addForm, tableWrap);
        document.body.appendChild(page);
        renderTable();
    }

    async function renderDownloadPage() {
        const metadataFetchDelayMs = 1200;
        const selectedRowClassName = 'hitomi-download-page-selected-row';
        const sortIndicatorClassName = 'hitomi-download-page-sort-indicator';
        const columns = [
            { key: 'bookId', label: 'book ID' },
            { key: 'title', label: 'title' },
            { key: 'group', label: 'group' },
            { key: 'author', label: 'author' },
            { key: 'downloadedAt', label: 'downloaded at' }
        ];
        let rows = [];
        let selectedIndex = -1;
        let sortState = { key: 'bookId', direction: 'desc' };
        let statusElem = null;
        let tbodyElem = null;
        const headerElems = new Map();
        let queueTbodyElem = null;
        let queueCountElem = null;
        let queueEmptyElem = null;
        let queueSnapshot = null;
        let queueRefreshTimer = null;

        function resolveJapaneseNameList(text, kind) {
            return normalizeMetadataText(text)
                .split(',')
                .map(name => normalizeMetadataText(name))
                .filter(Boolean)
                .map(name => resolveJapaneseName(name, kind))
                .join(', ');
        }

        function getBookIdFromText(text) {
            return String(text || '').replace(/\.[^/.]+$/, '').match(/(\d+)$/)?.[1] || '';
        }

        function getBookIdFromHistoryEntry(key, entry) {
            return getBookIdFromText(entry?.url) || getBookIdFromText(key);
        }

        function getBookUrlFromHistoryEntry(key, entry) {
            if (entry?.url) return new URL(entry.url, location.href).href;
            if (String(key).startsWith('/')) return new URL(key, location.origin).href;
            return '';
        }

        function formatDownloadedAt(value) {
            if (!value) return '';

            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return normalizeMetadataText(value);

            return date.toLocaleString();
        }

        function sortQueueItems(items) {
            const statusPriority = { running: 0, pending: 1, error: 2, canceled: 3, done: 4 };

            return [...items].sort((a, b) => {
                const statusDifference = statusPriority[a.status] - statusPriority[b.status];
                if (statusDifference !== 0) return statusDifference;

                if (a.status === 'pending') {
                    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
                }
                return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
            });
        }

        function cancelQueuedDownload(item) {
            const activeDownload = activeQueuedDownloads.get(String(item.galleryId));
            if (!activeDownload) return;

            if (activeDownload === activeBookPageDownload) {
                cancelBookPageDownload(activeDownload);
            } else {
                cancelListDownload(activeDownload);
            }
        }

        function createQueueRow(item) {
            const tr = document.createElement('tr');
            const bookIdTd = document.createElement('td');
            const titleTd = document.createElement('td');
            const statusTd = document.createElement('td');
            const updatedAtTd = document.createElement('td');
            const actionTd = document.createElement('td');
            const statusBadge = document.createElement('span');

            if (item.url) {
                const link = document.createElement('a');
                link.href = item.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = item.galleryId;
                bookIdTd.appendChild(link);
            } else {
                bookIdTd.textContent = item.galleryId;
            }

            titleTd.textContent = item.title || item.galleryId;
            statusBadge.className = `hitomi-download-page-status-badge hitomi-download-page-status-${item.status}`;
            statusBadge.textContent = item.status;
            statusTd.appendChild(statusBadge);
            updatedAtTd.textContent = formatDownloadedAt(item.updatedAt);

            if (item.status === 'pending') {
                const removeButton = document.createElement('button');
                removeButton.type = 'button';
                removeButton.textContent = 'Remove';
                removeButton.addEventListener('click', async () => {
                    removeButton.disabled = true;
                    try {
                        await removeQueuedDownload(item.id);
                        await refreshQueue();
                    } catch (e) {
                        removeButton.disabled = false;
                        console.error(e);
                    }
                });
                actionTd.appendChild(removeButton);
            } else if (item.status === 'running' && activeQueuedDownloads.has(String(item.galleryId))) {
                const cancelButton = document.createElement('button');
                cancelButton.type = 'button';
                cancelButton.textContent = 'Cancel';
                cancelButton.addEventListener('click', () => {
                    cancelButton.disabled = true;
                    cancelQueuedDownload(item);
                });
                actionTd.appendChild(cancelButton);
            }

            tr.append(bookIdTd, titleTd, statusTd, updatedAtTd, actionTd);
            return tr;
        }

        function renderQueue(items) {
            queueCountElem.textContent = `(${items.length})`;
            queueEmptyElem.hidden = items.length > 0;
            queueTbodyElem.closest('.hitomi-download-page-queue-table-wrap').hidden = items.length === 0;
            queueTbodyElem.replaceChildren(...items.map(createQueueRow));
        }

        async function refreshQueue() {
            if (document.hidden) return;

            const queue = await loadDownloadQueue();
            // Normalize stale and expired items on a display-only copy. Persistence
            // remains the responsibility of workers and explicit queue actions.
            const displayQueue = prepareDownloadQueueForWrite({
                ...queue,
                items: queue.items.map(item => ({ ...item }))
            });
            const items = sortQueueItems(displayQueue.items);
            const nextSnapshot = JSON.stringify(items);
            if (nextSnapshot === queueSnapshot) return;

            queueSnapshot = nextSnapshot;
            renderQueue(items);
        }

        function installQueueRefresh() {
            if (queueRefreshTimer) return;

            refreshQueue().catch(error => console.error(error));
            queueRefreshTimer = window.setInterval(() => {
                refreshQueue().catch(error => console.error(error));
            }, downloadPageQueueRefreshInterval);
        }

        function dedupeNames(names) {
            const seen = new Set();
            return names.filter(name => {
                const normalized = name.toLowerCase();
                if (seen.has(normalized)) return false;
                seen.add(normalized);
                return true;
            });
        }

        function metadataFromGalleryInfo(galleryInfo, fallbackTitle) {
            const title = normalizeMetadataText(galleryInfo?.japanese_title)
                || normalizeMetadataText(galleryInfo?.title)
                || fallbackTitle;
            const group = getGalleryInfoNames(galleryInfo?.groups, 'group').join(', ');
            const author = dedupeNames(getGalleryInfoNames(galleryInfo?.artists, 'artist')).join(', ');

            return { title, group, author };
        }

        function createRowsFromHistory(history) {
            return Object.entries(history)
                .map(([key, entry]) => {
                    const bookId = getBookIdFromHistoryEntry(key, entry);
                    const metadataHydrated = Boolean(entry?.metadataHydrated);

                    return {
                        key,
                        bookId,
                        title: normalizeMetadataText(entry?.title),
                        group: normalizeMetadataText(entry?.group),
                        author: normalizeMetadataText(entry?.author),
                        url: getBookUrlFromHistoryEntry(key, entry),
                        downloadedAt: normalizeMetadataText(entry?.downloadedAt),
                        metadataStatus: metadataHydrated ? 'stored' : 'pending'
                    };
                })
                .filter(row => row.bookId || row.url || row.title);
        }

        function getDisplayValue(row, key) {
            if (key === 'group') return resolveJapaneseNameList(row.group, 'group');
            if (key === 'author') return resolveJapaneseNameList(row.author, 'author');
            if (key === 'downloadedAt') return formatDownloadedAt(row.downloadedAt);
            return String(row[key] || '');
        }

        function compareValues(a, b, key) {
            if (key === 'bookId') {
                const left = Number(a.bookId);
                const right = Number(b.bookId);
                if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) return left - right;
            }

            return getDisplayValue(a, key).localeCompare(getDisplayValue(b, key), undefined, { numeric: true, sensitivity: 'base' });
        }

        function sortRows() {
            const direction = sortState.direction === 'asc' ? 1 : -1;

            rows.sort((a, b) => {
                const result = compareValues(a, b, sortState.key);
                if (result !== 0) return result * direction;
                return compareValues(a, b, 'bookId') * -1;
            });
        }

        function setStatus(text) {
            if (statusElem) statusElem.textContent = text;
        }

        function getSelectedRow() {
            if (selectedIndex < 0 || selectedIndex >= rows.length) return null;
            return rows[selectedIndex];
        }

        function focusRow(index) {
            if (!rows.length) {
                selectedIndex = -1;
                return;
            }

            selectedIndex = Math.max(0, Math.min(rows.length - 1, index));
            renderBody();
        }

        function openSelectedRow() {
            const url = getSelectedRow()?.url;
            if (!url) return false;

            GM.openInTab(url, {
                active: false,
                insert: true,
                setParent: true
            });
            return true;
        }

        function renderHeaders() {
            headerElems.forEach((heading, key) => {
                const indicator = heading.querySelector(`.${sortIndicatorClassName}`);
                if (!indicator) return;
                indicator.textContent = sortState.key === key ? (sortState.direction === 'asc' ? '▲' : '▼') : '';
            });
        }

        function renderBody() {
            tbodyElem.replaceChildren(...rows.map((row, index) => {
                const tr = document.createElement('tr');
                tr.classList.toggle(selectedRowClassName, index === selectedIndex);
                tr.tabIndex = -1;
                tr.addEventListener('click', () => focusRow(index));

                columns.forEach(column => {
                    const td = document.createElement('td');
                    if (column.key === 'bookId' && row.url) {
                        const link = document.createElement('a');
                        link.href = row.url;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        link.textContent = row.bookId || row.url;
                        td.appendChild(link);
                    } else {
                        td.textContent = getDisplayValue(row, column.key);
                    }
                    tr.appendChild(td);
                });

                return tr;
            }));

            tbodyElem.querySelector(`.${selectedRowClassName}`)?.scrollIntoView({ block: 'nearest' });
            renderHeaders();
        }

        function render() {
            const selectedBookId = getSelectedRow()?.bookId;

            sortRows();
            if (selectedBookId) selectedIndex = rows.findIndex(row => row.bookId === selectedBookId);
            if (selectedIndex === -1 && rows.length) selectedIndex = 0;
            renderBody();
        }

        function setSort(key) {
            if (sortState.key === key) {
                sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
            } else {
                sortState = { key, direction: 'asc' };
            }

            const selectedBookId = getSelectedRow()?.bookId;
            sortRows();
            selectedIndex = selectedBookId ? rows.findIndex(row => row.bookId === selectedBookId) : selectedIndex;
            if (selectedIndex < 0 && rows.length) selectedIndex = 0;
            renderBody();
        }

        function createStyle() {
            const style = document.createElement('style');
            style.textContent = `
                :root {
                    color-scheme: light;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    background: #f4f6f8;
                    color: #1f2933;
                }
                body {
                    margin: 0;
                    background: #f4f6f8;
                }
                .hitomi-download-page-main {
                    max-width: 1280px;
                    margin: 0 auto;
                    padding: 24px;
                }
                .hitomi-download-page-header {
                    display: flex;
                    align-items: end;
                    justify-content: space-between;
                    gap: 16px;
                    margin-bottom: 16px;
                }
                .hitomi-download-page-header h1 {
                    margin: 0;
                    font-size: 28px;
                    font-weight: 700;
                }
                .hitomi-download-page-status {
                    min-height: 20px;
                    color: #52606d;
                    font-size: 14px;
                    text-align: right;
                }
                .hitomi-download-page-queue-section {
                    margin-bottom: 24px;
                }
                .hitomi-download-page-queue-heading {
                    display: flex;
                    align-items: baseline;
                    gap: 8px;
                    margin: 0 0 10px;
                    font-size: 20px;
                }
                .hitomi-download-page-queue-count {
                    color: #52606d;
                    font-size: 14px;
                    font-weight: 400;
                }
                .hitomi-download-page-queue-table-wrap {
                    overflow: visible;
                    border: 1px solid #d9e2ec;
                    background: #fff;
                }
                .hitomi-download-page-queue-table {
                    width: 100%;
                    border-collapse: collapse;
                    table-layout: fixed;
                }
                .hitomi-download-page-queue-table th,
                .hitomi-download-page-queue-table td {
                    padding: 8px 12px;
                    border-bottom: 1px solid #e4e7eb;
                    text-align: left;
                    vertical-align: middle;
                    font-size: 14px;
                    line-height: 1.4;
                    overflow-wrap: anywhere;
                }
                .hitomi-download-page-queue-table th {
                    background: #e9eff5;
                    color: #243b53;
                    font-weight: 600;
                }
                .hitomi-download-page-queue-table th:nth-child(1) { width: 110px; }
                .hitomi-download-page-queue-table th:nth-child(2) { width: 38%; }
                .hitomi-download-page-queue-table th:nth-child(3) { width: 110px; }
                .hitomi-download-page-queue-table th:nth-child(4) { width: 170px; }
                .hitomi-download-page-queue-table th:nth-child(5) { width: 90px; }
                .hitomi-download-page-queue-table tr:last-child td { border-bottom: 0; }
                .hitomi-download-page-queue-table a { color: #1d4ed8; }
                .hitomi-download-page-queue-table button {
                    min-height: 30px;
                    padding: 4px 10px;
                    border: 1px solid #bcccdc;
                    border-radius: 4px;
                    background: #fff;
                    color: #243b53;
                    font: inherit;
                    cursor: pointer;
                }
                .hitomi-download-page-queue-table button:disabled {
                    cursor: default;
                    opacity: 0.6;
                }
                .hitomi-download-page-status-badge {
                    display: inline-block;
                    padding: 2px 7px;
                    border-radius: 999px;
                    font-size: 12px;
                    font-weight: 600;
                }
                .hitomi-download-page-status-pending { background: #fff3bf; color: #7a5d00; }
                .hitomi-download-page-status-running { background: #dbeafe; color: #1e40af; }
                .hitomi-download-page-status-done { background: #dcfce7; color: #166534; }
                .hitomi-download-page-status-error { background: #fee2e2; color: #991b1b; }
                .hitomi-download-page-status-canceled { background: #e5e7eb; color: #4b5563; }
                .hitomi-download-page-queue-empty {
                    padding: 16px;
                    border: 1px solid #d9e2ec;
                    background: #fff;
                    color: #7b8794;
                    font-size: 14px;
                }
                .hitomi-download-page-table-wrap {
                    overflow: visible;
                    border: 1px solid #d9e2ec;
                    background: #fff;
                }
                .hitomi-download-page-table {
                    width: 100%;
                    border-collapse: collapse;
                    table-layout: fixed;
                }
                .hitomi-download-page-table th,
                .hitomi-download-page-table td {
                    padding: 10px 12px;
                    border-bottom: 1px solid #e4e7eb;
                    text-align: left;
                    vertical-align: top;
                    font-size: 14px;
                    line-height: 1.4;
                    overflow-wrap: anywhere;
                }
                .hitomi-download-page-table th {
                    position: sticky;
                    top: 0;
                    z-index: 1;
                    background: #e9eff5;
                    color: #243b53;
                    cursor: pointer;
                    user-select: none;
                    white-space: nowrap;
                }
                .hitomi-download-page-table th:nth-child(1) { width: 110px; }
                .hitomi-download-page-table th:nth-child(2) { width: 34%; }
                .hitomi-download-page-table th:nth-child(3),
                .hitomi-download-page-table th:nth-child(4) { width: 18%; }
                .hitomi-download-page-table th:nth-child(5) { width: 170px; }
                .hitomi-download-page-table tr.${selectedRowClassName} {
                    background: #dbeafe;
                    outline: 2px solid #2563eb;
                    outline-offset: -2px;
                }
                .hitomi-download-page-table tr:hover { background: #eff6ff; }
                .hitomi-download-page-table a { color: #1d4ed8; }
                .${sortIndicatorClassName} {
                    display: inline-block;
                    min-width: 1.2em;
                    margin-left: 6px;
                    color: #1d4ed8;
                }
                .hitomi-download-page-empty {
                    padding: 32px;
                    color: #52606d;
                    background: #fff;
                    border: 1px solid #d9e2ec;
                }
            `;
            document.head.appendChild(style);
        }

        function createQueueSection() {
            const section = document.createElement('section');
            const heading = document.createElement('h2');
            const headingText = document.createElement('span');
            const tableWrap = document.createElement('div');
            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');

            section.className = 'hitomi-download-page-queue-section';
            heading.className = 'hitomi-download-page-queue-heading';
            headingText.textContent = 'Queue';
            queueCountElem = document.createElement('span');
            queueCountElem.className = 'hitomi-download-page-queue-count';
            queueCountElem.textContent = '(0)';
            tableWrap.className = 'hitomi-download-page-queue-table-wrap';
            tableWrap.hidden = true;
            table.className = 'hitomi-download-page-queue-table';
            queueTbodyElem = document.createElement('tbody');
            queueEmptyElem = document.createElement('div');
            queueEmptyElem.className = 'hitomi-download-page-queue-empty';
            queueEmptyElem.textContent = 'No queued downloads.';

            ['book ID', 'title', 'status', 'updated at', 'action'].forEach(label => {
                const th = document.createElement('th');
                th.textContent = label;
                headerRow.appendChild(th);
            });

            heading.append(headingText, queueCountElem);
            thead.appendChild(headerRow);
            table.append(thead, queueTbodyElem);
            tableWrap.appendChild(table);
            section.append(heading, tableWrap, queueEmptyElem);
            return section;
        }

        function createPage() {
            document.title = 'Hitomi Downloads';
            document.body.replaceChildren();
            createStyle();

            const page = document.createElement('main');
            const header = document.createElement('header');
            const title = document.createElement('h1');
            const queueSection = createQueueSection();
            const tableWrap = document.createElement('div');
            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');

            page.className = 'hitomi-download-page-main';
            header.className = 'hitomi-download-page-header';
            title.textContent = 'Downloads';
            statusElem = document.createElement('div');
            statusElem.className = 'hitomi-download-page-status';
            tableWrap.className = 'hitomi-download-page-table-wrap';
            table.className = 'hitomi-download-page-table';
            tbodyElem = document.createElement('tbody');

            columns.forEach(column => {
                const th = document.createElement('th');
                const indicator = document.createElement('span');

                th.textContent = column.label;
                indicator.className = sortIndicatorClassName;
                th.appendChild(indicator);
                th.addEventListener('click', () => setSort(column.key));
                headerElems.set(column.key, th);
                headerRow.appendChild(th);
            });

            thead.appendChild(headerRow);
            table.append(thead, tbodyElem);
            tableWrap.appendChild(table);
            header.append(title, statusElem);
            page.append(header, queueSection, tableWrap);
            document.body.appendChild(page);
        }

        function createEmptyPage() {
            createPage();
            const empty = document.createElement('div');

            empty.className = 'hitomi-download-page-empty';
            empty.textContent = 'No download history found.';
            document.querySelector('.hitomi-download-page-table-wrap')?.replaceWith(empty);
            setStatus('');
        }

        function wait(ms) {
            return new Promise(resolve => window.setTimeout(resolve, ms));
        }

        async function hydrateMissingMetadata() {
            const pendingRows = rows.filter(row => row.bookId && row.metadataStatus === 'pending');
            if (!pendingRows.length) {
                setStatus(`${rows.length} books`);
                return;
            }

            let fetchedCount = 0;
            for (const row of pendingRows) {
                setStatus(`Loading metadata ${fetchedCount + 1} / ${pendingRows.length}`);
                try {
                    const galleryInfo = await loadGalleryInfo(row.bookId);
                    const metadata = metadataFromGalleryInfo(galleryInfo, row.title);

                    Object.assign(row, metadata, { metadataStatus: 'loaded' });
                    // Re-read before every row update so a concurrent download completion
                    // cannot be erased by this page's metadata enrichment write.
                    const fresh = await loadDownloadHistory();
                    fresh[row.key] = {
                        ...(fresh[row.key] || {}),
                        bookId: row.bookId,
                        title: row.title,
                        group: row.group,
                        author: row.author,
                        url: row.url,
                        metadataHydrated: true
                    };
                    await saveDownloadHistory(fresh);
                    fetchedCount += 1;
                    render();
                } catch (e) {
                    row.metadataStatus = 'error';
                    fetchedCount += 1;
                }

                await wait(metadataFetchDelayMs);
            }

            setStatus(`${rows.length} books`);
        }

        function isEditableTarget(target) {
            if (!(target instanceof Element)) return false;
            return Boolean(target.closest('input, textarea, select') || target.isContentEditable);
        }

        function handleKeydown(event) {
            if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

            if (event.key === 'j') {
                event.preventDefault();
                focusRow(selectedIndex + 1);
            } else if (event.key === 'k') {
                event.preventDefault();
                focusRow(selectedIndex === -1 ? rows.length - 1 : selectedIndex - 1);
            } else if (event.key === 'v' && openSelectedRow()) {
                event.preventDefault();
            }
        }

        await loadNameMap();
        const history = await loadDownloadHistory();
        rows = createRowsFromHistory(history);

        if (!rows.length) {
            createEmptyPage();
        } else {
            createPage();
            window.addEventListener('keydown', handleKeydown, true);
            render();
            setStatus(`${rows.length} books`);
            hydrateMissingMetadata().catch(error => {
                console.error(error);
                setStatus(`${rows.length} books`);
            });
        }
        installQueueRefresh();
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

        // The standalone history page can hydrate metadata only in localStorage, so
        // local entries must win over older GM entries when the stores diverge.
        return {
            ...(history && typeof history === 'object' && !Array.isArray(history) ? history : {}),
            ...localHistory
        };
    }

    async function saveDownloadHistory(history) {
        saveLocalDownloadHistory(history);
        await GM.setValue(downloadHistoryKey, history);
    }

    function normalizeDownloadQueue(input) {
        if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.items)) {
            return { version: 1, items: [] };
        }

        return {
            version: 1,
            items: input.items
                .filter(item => item && typeof item === 'object' && item.galleryId)
                .map(item => ({
                    id: String(item.id || `gallery-${item.galleryId}-${Date.now().toString(36)}`),
                    galleryId: String(item.galleryId),
                    url: String(item.url || ''),
                    title: String(item.title || ''),
                    source: item.source === 'list' ? 'list' : 'book',
                    status: ['pending', 'running', 'done', 'error', 'canceled'].includes(item.status) ? item.status : 'pending',
                    createdAt: String(item.createdAt || new Date().toISOString()),
                    updatedAt: String(item.updatedAt || item.createdAt || new Date().toISOString()),
                    startedAt: item.startedAt || null,
                    finishedAt: item.finishedAt || null,
                    heartbeatAt: item.heartbeatAt || null,
                    workerId: item.workerId || null,
                    error: String(item.error || '')
                }))
        };
    }

    function normalizeUnifiedDownloads(input) {
        if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.items)) {
            return { version: 1, items: [] };
        }

        return {
            version: 1,
            items: input.items
                .filter(item => item && typeof item === 'object' && item.galleryId !== undefined && item.galleryId !== null && String(item.galleryId))
                .map(item => {
                    const galleryId = String(item.galleryId);
                    return {
                        id: String(item.id || `gallery-${galleryId}`),
                        galleryId,
                        url: String(item.url || ''),
                        title: String(item.title || ''),
                        group: String(item.group || ''),
                        author: String(item.author || ''),
                        source: String(item.source || ''),
                        status: ['pending', 'running', 'done', 'error', 'canceled'].includes(item.status) ? item.status : 'pending',
                        createdAt: String(item.createdAt || ''),
                        updatedAt: String(item.updatedAt || ''),
                        startedAt: item.startedAt ? String(item.startedAt) : null,
                        finishedAt: item.finishedAt ? String(item.finishedAt) : null,
                        downloadedAt: String(item.downloadedAt || ''),
                        heartbeatAt: item.heartbeatAt ? String(item.heartbeatAt) : null,
                        workerId: item.workerId ? String(item.workerId) : null,
                        error: String(item.error || ''),
                        metadataHydrated: Boolean(item.metadataHydrated)
                    };
                })
        };
    }

    function getTrailingGalleryId(value) {
        const path = String(value || '').split(/[?#]/, 1)[0].replace(/\.[^/.]+$/, '');
        return path.match(/(\d+)$/)?.[1] || '';
    }

    function getHistoryGalleryId(key, entry) {
        const bookId = entry && typeof entry === 'object' ? entry.bookId : null;
        if (bookId !== undefined && bookId !== null && String(bookId)) return String(bookId);
        return getTrailingGalleryId(entry && typeof entry === 'object' ? entry.url : '') || getTrailingGalleryId(key);
    }

    function getTimestamp(value) {
        const timestamp = Date.parse(value);
        return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
    }

    function selectHistoryRecords(history) {
        const records = new Map();

        Object.entries(history).forEach(([key, value]) => {
            const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
            const galleryId = getHistoryGalleryId(key, entry);
            if (!galleryId) return;

            const candidate = { ...entry, galleryId };
            const current = records.get(galleryId);
            const candidateHasMetadata = candidate.metadataHydrated === true;
            const currentHasMetadata = current?.metadataHydrated === true;
            if (
                !current
                || (candidateHasMetadata && !currentHasMetadata)
                || (candidateHasMetadata === currentHasMetadata
                    && getTimestamp(candidate.downloadedAt) > getTimestamp(current.downloadedAt))
            ) {
                records.set(galleryId, candidate);
            }
        });

        return records;
    }

    function selectQueueRecords(items) {
        const records = new Map();
        const statusPriority = { running: 2, pending: 1, done: 0, error: 0, canceled: 0 };

        items.forEach(item => {
            const galleryId = String(item.galleryId || '');
            if (!galleryId) return;

            const current = records.get(galleryId);
            const candidatePriority = statusPriority[item.status];
            const currentPriority = current ? statusPriority[current.status] : -1;
            if (
                !current
                || candidatePriority > currentPriority
                || (candidatePriority === 0 && currentPriority === 0
                    && getTimestamp(item.updatedAt) > getTimestamp(current.updatedAt))
            ) {
                records.set(galleryId, item);
            }
        });

        return records;
    }

    function selectUnifiedRecords(items) {
        const records = new Map();

        items.forEach(item => {
            const galleryId = String(item.galleryId || '');
            if (!galleryId) return;

            const current = records.get(galleryId);
            if (!current || getTimestamp(item.updatedAt) > getTimestamp(current.updatedAt)) {
                records.set(galleryId, item);
            }
        });

        return records;
    }

    async function loadUnifiedDownloads() {
        const [history, queue, unified] = await Promise.all([
            loadDownloadHistory(),
            loadDownloadQueue().then(value => prepareDownloadQueueForWrite({
                ...value,
                items: value.items.map(item => ({ ...item }))
            })),
            GM.getValue(unifiedDownloadsKey, { version: 1, items: [] }).then(normalizeUnifiedDownloads)
        ]);
        const historyRecords = selectHistoryRecords(history);
        const queueRecords = selectQueueRecords(queue.items);
        const unifiedRecords = selectUnifiedRecords(unified.items);
        const galleryIds = new Set([
            ...historyRecords.keys(),
            ...queueRecords.keys(),
            ...unifiedRecords.keys()
        ]);
        const items = [];

        galleryIds.forEach(galleryId => {
            const historyRecord = historyRecords.get(galleryId);
            const queueRecord = queueRecords.get(galleryId);
            const unifiedRecord = unifiedRecords.get(galleryId);

            items.push({
                id: `gallery-${galleryId}`,
                galleryId: String(galleryId),
                url: unifiedRecord?.url || queueRecord?.url || historyRecord?.url || '',
                title: unifiedRecord?.title || historyRecord?.title || queueRecord?.title || '',
                group: unifiedRecord?.group || historyRecord?.group || '',
                author: unifiedRecord?.author || historyRecord?.author || '',
                source: queueRecord?.source || unifiedRecord?.source || '',
                status: unifiedRecord?.status || queueRecord?.status || (historyRecord ? 'done' : 'pending'),
                createdAt: unifiedRecord?.createdAt || queueRecord?.createdAt || '',
                updatedAt: unifiedRecord?.updatedAt || queueRecord?.updatedAt || '',
                startedAt: unifiedRecord?.startedAt || queueRecord?.startedAt || null,
                finishedAt: unifiedRecord?.finishedAt || queueRecord?.finishedAt || null,
                downloadedAt: historyRecord?.downloadedAt
                    || unifiedRecord?.downloadedAt
                    || (queueRecord?.status === 'done' ? queueRecord.finishedAt : '')
                    || '',
                heartbeatAt: unifiedRecord?.heartbeatAt || queueRecord?.heartbeatAt || null,
                workerId: unifiedRecord?.workerId || queueRecord?.workerId || null,
                error: unifiedRecord?.error || queueRecord?.error || '',
                metadataHydrated: historyRecord?.metadataHydrated === true || unifiedRecord?.metadataHydrated === true
            });
        });

        return normalizeUnifiedDownloads({ version: 1, items });
    }

    async function loadDownloadQueue() {
        return normalizeDownloadQueue(await GM.getValue(downloadQueueKey, { version: 1, items: [] }));
    }

    async function saveDownloadQueue(queue) {
        await GM.setValue(downloadQueueKey, normalizeDownloadQueue(queue));
    }

    function isTerminalDownloadQueueStatus(status) {
        return ['done', 'error', 'canceled'].includes(status);
    }

    function prepareDownloadQueueForWrite(queue) {
        const now = Date.now();
        const nowIso = new Date(now).toISOString();

        queue.items = queue.items
            .map(item => {
                if (
                    item.status === 'running'
                    && item.workerId !== downloadQueueWorkerId
                    && (!item.heartbeatAt || now - Date.parse(item.heartbeatAt) > downloadQueueStaleRunningMs)
                ) {
                    return {
                        ...item,
                        status: 'pending',
                        updatedAt: nowIso,
                        startedAt: null,
                        heartbeatAt: null,
                        workerId: null,
                        error: ''
                    };
                }
                return item;
            })
            .filter(item => !isTerminalDownloadQueueStatus(item.status) || !item.finishedAt || now - Date.parse(item.finishedAt) <= downloadQueueTerminalTtlMs);

        return queue;
    }

    async function withDownloadQueueLock(task) {
        if (navigator.locks?.request) {
            return navigator.locks.request(downloadQueueLockName, async () => task());
        }

        // Web Locks provide cross-tab serialization. This fallback keeps writes in
        // this tab ordered when the API is unavailable.
        const next = downloadQueueWriteQueue.then(task, task);
        downloadQueueWriteQueue = next.catch(() => {});
        return next;
    }

    async function updateDownloadQueue(mutator) {
        return withDownloadQueueLock(async () => {
            const queue = await loadDownloadQueue();
            const before = JSON.stringify(queue);

            prepareDownloadQueueForWrite(queue);
            const result = await mutator(queue);

            if (JSON.stringify(queue) !== before) {
                await saveDownloadQueue(queue);
            }
            return result;
        });
    }

    function removeQueuedDownload(queueItemId) {
        return updateDownloadQueue(queue => {
            queue.items = queue.items.filter(item => !(item.id === queueItemId && item.status === 'pending'));
        });
    }

    async function markQueuedDownload(queueItemId, changes) {
        return updateDownloadQueue(queue => {
            const item = queue.items.find(candidate => candidate.id === queueItemId);
            if (!item) return null;

            const nextChanges = typeof changes === 'function' ? changes(item) : changes;
            if (!nextChanges) return item;

            Object.assign(item, nextChanges, { updatedAt: new Date().toISOString() });
            return item;
        });
    }

    function getBookQueueTarget(book) {
        const link = getBookLinkFromElement(book);
        const galleryId = getBookIdFromElement(book);
        if (!link || !galleryId) return null;

        return {
            galleryId,
            url: new URL(link.getAttribute('href'), location.href).href,
            title: book.querySelector('h1.lillie')?.textContent.trim() || '',
            source: 'list'
        };
    }

    function getCurrentBookQueueTarget() {
        const galleryId = getCurrentGalleryId();
        if (!galleryId) return null;

        return {
            galleryId,
            url: location.href,
            title: getBookTitle(),
            source: 'book'
        };
    }

    function createDownloadQueueItem(target) {
        const now = new Date().toISOString();

        return {
            id: `gallery-${target.galleryId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            galleryId: String(target.galleryId),
            url: target.url,
            title: target.title || '',
            source: target.source,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            finishedAt: null,
            heartbeatAt: null,
            workerId: null,
            error: ''
        };
    }

    async function enqueueDownload(target) {
        return updateDownloadQueue(queue => {
            const existing = queue.items.find(item => item.galleryId === String(target.galleryId) && item.status === 'pending');
            if (existing) {
                queue.items = queue.items.filter(item => item !== existing);
                return { action: 'removed', item: existing };
            }

            const running = queue.items.find(item => item.galleryId === String(target.galleryId) && item.status === 'running');
            if (running) {
                return { action: 'already-running', item: running };
            }

            const item = createDownloadQueueItem(target);
            queue.items.push(item);
            return { action: 'queued', item };
        });
    }

    function markDLButtonDownloaded() {
        const heading = document.querySelector('a#dl-button > h1');
        if (!heading) return false;

        heading.textContent = 'DOWNLOADED';
        return true;
    }

    function getDLButtonText() {
        return document.querySelector('a#dl-button > h1')?.textContent || 'DOWNLOAD';
    }

    function setDLButtonText(text) {
        const heading = document.querySelector('a#dl-button > h1');
        if (!heading) return false;

        heading.textContent = text;
        return true;
    }

    function getPageJQuery() {
        return unsafeWindow.jQuery || unsafeWindow.$;
    }

    function getBookPageDownloadProgressLabel(progressbar) {
        if (!progressbar) return null;

        let label = progressbar.querySelector(`:scope > .${bookPageProgressLabelClassName}`);
        if (!label) {
            label = document.createElement('div');
            label.className = bookPageProgressLabelClassName;
            progressbar.appendChild(label);
        }

        return label;
    }

    function showBookPageDownloadProgress() {
        const $ = getPageJQuery();
        const progressbar = document.querySelector('#progressbar');
        const dlButton = getDLButton();

        if (progressbar) {
            // The page's progressbar is owned by Hitomi/jQuery UI, so establish our
            // own positioning context before overlaying a lightweight text label.
            progressbar.style.position = 'relative';
            const label = getBookPageDownloadProgressLabel(progressbar);
            if (label) label.textContent = '';
        }

        if ($ && progressbar && typeof $(progressbar).progressbar === 'function') {
            $(dlButton).hide();
            $(progressbar).show();
            $(progressbar).progressbar({ value: false });
            return;
        }

        if (dlButton) dlButton.style.display = 'none';
        if (progressbar) progressbar.style.display = '';
    }

    function updateBookPageDownloadProgress(percent, text) {
        const $ = getPageJQuery();
        const progressbar = document.querySelector('#progressbar');
        const label = getBookPageDownloadProgressLabel(progressbar);

        if (label) label.textContent = text || '';

        if ($ && progressbar && typeof $(progressbar).progressbar === 'function') {
            $(progressbar).progressbar('value', Math.max(0, Math.min(100, percent)));
        }
    }

    function hideBookPageDownloadProgress() {
        const $ = getPageJQuery();
        const progressbar = document.querySelector('#progressbar');
        const dlButton = getDLButton();

        progressbar?.querySelector(`:scope > .${bookPageProgressLabelClassName}`)?.remove();

        if ($) {
            if (progressbar) $(progressbar).hide();
            if (dlButton) $(dlButton).show();
            return;
        }

        if (progressbar) progressbar.style.display = 'none';
        if (dlButton) dlButton.style.display = '';
    }

    function getCurrentGalleryId() {
        return location.pathname.replace(/\.[^/.]+$/, '').match(/(\d+)$/)?.[1] || null;
    }

    function normalizeMetadataText(text) {
        return text?.replace(/\s+/g, ' ').trim() || '';
    }

    function isMissingMetadataValue(value) {
        return !value || value.toLowerCase() === 'n/a';
    }

    function getMetadataListText(root, headingSelector) {
        return normalizeMetadataText(Array.from(root.querySelectorAll(`${headingSelector} a`), link => link.textContent.trim())
            .filter(Boolean)
            .join(', ') || root.querySelector(headingSelector)?.textContent);
    }

    function getGalleryInfoNames(values, key) {
        if (!Array.isArray(values)) return [];

        return values
            .map(value => normalizeMetadataText(typeof value === 'string' ? value : value?.[key] || value?.name))
            .filter(Boolean);
    }

    function getBookPageTitle(root, galleryInfo, galleryId) {
        // Book pages hydrate title/author/group/series from galleryinfo after the initial HTML loads.
        // Keep DOM reads first for live book pages, but fall back to galleryinfo so list-page downloads
        // can use the same naming path without fetching and executing the book page.
        return normalizeMetadataText(root.querySelector('h1#gallery-brand > a')?.textContent)
            || galleryInfo?.japanese_title
            || galleryInfo?.title
            || `hitomi-${galleryId}`;
    }

    function getBookPageGroup(root, galleryInfo) {
        // The list page cannot see the rendered Group field. galleryinfo.groups is the source
        // used by Hitomi's own page hydration, so it is the canonical fallback for naming.
        const tableRows = Array.from(root.querySelectorAll('table tr'));
        for (const row of tableRows) {
            const cells = Array.from(row.children);
            if (normalizeMetadataText(cells[0]?.textContent).toLowerCase() === 'group') {
                const group = normalizeMetadataText(cells[1]?.textContent);
                if (!isMissingMetadataValue(group)) return resolveJapaneseName(group, 'group');
            }
        }

        const labels = Array.from(root.querySelectorAll('dt, th, td, h2, h3, strong, b'));
        const groupLabel = labels.find(label => normalizeMetadataText(label.textContent).toLowerCase() === 'group');
        if (groupLabel) {
            const group = normalizeMetadataText(groupLabel.nextElementSibling?.textContent);
            if (!isMissingMetadataValue(group)) return resolveJapaneseName(group, 'group');
        }

        return getGalleryInfoNames(galleryInfo?.groups, 'group')
            .map(group => resolveJapaneseName(group, 'group'))
            .join(', ');
    }

    function getBookPageAuthors(root, galleryInfo) {
        const authorText = getMetadataListText(root, 'h2#artists');
        const authorNames = isMissingMetadataValue(authorText) ? getGalleryInfoNames(galleryInfo?.artists, 'artist') : authorText.split(',');

        const names = authorNames
            .map(name => normalizeMetadataText(name))
            .filter(Boolean)
            .map(name => resolveJapaneseName(name, 'author'));
        return [...new Set(names)];
    }

    function getBookPageSeries(root, galleryInfo) {
        const tableRows = Array.from(root.querySelectorAll('table tr'));
        for (const row of tableRows) {
            const cells = Array.from(row.children);
            if (normalizeMetadataText(cells[0]?.textContent).toLowerCase() === 'series') {
                const series = normalizeMetadataText(cells[1]?.textContent);
                if (!isMissingMetadataValue(series)) return resolveJapaneseName(series, 'series');
            }
        }

        const labels = Array.from(root.querySelectorAll('dt, th, td, h2, h3, strong, b'));
        const seriesLabel = labels.find(label => normalizeMetadataText(label.textContent).toLowerCase() === 'series');
        if (seriesLabel) {
            const series = normalizeMetadataText(seriesLabel.nextElementSibling?.textContent);
            if (!isMissingMetadataValue(series)) return resolveJapaneseName(series, 'series');
        }

        return getGalleryInfoNames(galleryInfo?.parodys, 'parody')
            .map(series => resolveJapaneseName(series, 'series'))
            .join(', ');
    }

    function formatDownloadFileNameFromMetadata({ group, authors, title, series }) {
        const hasGroup = !isMissingMetadataValue(group);
        const normalizedGroup = normalizeMetadataText(group);
        const normalizedAuthors = authors.map(author => normalizeMetadataText(author)).filter(Boolean);
        const normalizedSeries = normalizeMetadataText(series);
        const seriesPart = isMissingMetadataValue(normalizedSeries) ? '' : ` (${normalizedSeries})`;
        let authorPart = '';

        // Preserve one or two credited authors in the filename. Collapse three or more
        // deduplicated authors to Various Artists to keep filenames readable.
        if (normalizedAuthors.length === 1) {
            [authorPart] = normalizedAuthors;
        } else if (normalizedAuthors.length === 2) {
            authorPart = normalizedAuthors.join(', ');
        } else if (normalizedAuthors.length >= 3) {
            authorPart = hasGroup ? 'various artists' : 'Various Artists';
        }

        let bracket = 'Unknown';
        if (hasGroup && authorPart) {
            bracket = `${normalizedGroup} (${authorPart})`;
        } else if (hasGroup) {
            bracket = normalizedGroup;
        } else if (authorPart) {
            bracket = authorPart;
        }

        return sanitizeFileName(`[${bracket}] ${title}${seriesPart}`);
    }

    function getDownloadFileNameFromBookPageDocument(root, galleryInfo, galleryId) {
        // Both book-page and list-page downloads call this. On list pages, root is just the
        // current document, so the galleryinfo fallback is what supplies the metadata.
        return formatDownloadFileNameFromMetadata({
            group: getBookPageGroup(root, galleryInfo),
            authors: getBookPageAuthors(root, galleryInfo),
            series: getBookPageSeries(root, galleryInfo),
            title: getBookPageTitle(root, galleryInfo, galleryId)
        });
    }

    function getDownloadHistoryMetadata(root, galleryInfo, galleryId, fallbackTitle) {
        // Download history is also used by the standalone history viewer, so store the
        // normalized metadata there instead of forcing that page to refetch every time.
        const authors = getBookPageAuthors(root, galleryInfo);

        return {
            bookId: String(galleryId || galleryInfo?.id || ''),
            title: getBookPageTitle(root, galleryInfo, galleryId) || fallbackTitle,
            group: getBookPageGroup(root, galleryInfo),
            author: authors.join(', '),
            metadataHydrated: Boolean(galleryInfo)
        };
    }

    function syncDownloadHistoryEntry(key, entry) {
        loadDownloadHistory()
            .then(history => {
                history[key] = entry;
                return saveDownloadHistory(history);
            })
            .catch(() => {});
    }

    function getBookLinkFromElement(elem) {
        return elem?.querySelector(':scope > h1.lillie a[href], :scope > h1 a[href], :scope > a[href]') || null;
    }

    function getDownloadHistoryKeyFromBook(book) {
        const link = getBookLinkFromElement(book);
        return link ? new URL(link.getAttribute('href'), location.href).pathname.replace(/\/$/, '') : null;
    }

    function setBookDownloadedIndicator(book, downloaded) {
        const heading = book.querySelector(':scope > h1.lillie');
        if (!heading) return;

        heading.classList.toggle(downloadedBookHeadingClassName, downloaded);
    }

    function applyDownloadHistoryToBooks(history) {
        // Downloaded markers are derived from the same history used on book pages.
        // Downloaded books are folded visually to keep list pages compact, but this
        // does not write foldedBookIds because it is history-driven state.
        document.querySelectorAll('div.gallery-content > div').forEach(book => {
            const key = getDownloadHistoryKeyFromBook(book);
            const bookId = getBookIdFromElement(book);
            const downloaded = Boolean((key && history[key]) || (bookId && history[bookId]));

            setBookDownloadedIndicator(book, downloaded);
            if (downloaded) {
                getFilterBook(book).fold();
            }
        });
    }

    async function refreshDownloadIndicators() {
        const history = await loadDownloadHistory();
        applyDownloadHistoryToBooks(history);
    }

    function markCurrentBookDownloaded(galleryInfo = null, galleryId = getCurrentGalleryId()) {
        const key = getDownloadKey();
        const metadata = getDownloadHistoryMetadata(document, galleryInfo, galleryId, getBookTitle());
        const entry = {
            ...metadata,
            url: location.href,
            downloadedAt: new Date().toISOString()
        };
        const localHistory = loadLocalDownloadHistory();

        localHistory[key] = entry;
        saveLocalDownloadHistory(localHistory);
        markDLButtonDownloaded();
        syncDownloadHistoryEntry(key, entry);
    }

    function markListBookDownloaded(book, galleryInfo) {
        if (!book) return;

        // List-page downloads should immediately affect the visible card so users do
        // not need a reload to see the downloaded marker and compact folded state.
        const link = getBookLinkFromElement(book);
        const key = link ? new URL(link.getAttribute('href'), location.href).pathname.replace(/\/$/, '') : String(galleryInfo.id);
        const metadata = getDownloadHistoryMetadata(document, galleryInfo, galleryInfo.id, book.querySelector('h1.lillie')?.textContent.trim() || document.title);
        const entry = {
            ...metadata,
            url: link ? new URL(link.getAttribute('href'), location.href).href : location.href,
            downloadedAt: new Date().toISOString()
        };
        const localHistory = loadLocalDownloadHistory();

        localHistory[key] = entry;
        saveLocalDownloadHistory(localHistory);
        setBookDownloadedIndicator(book, true);
        getFilterBook(book).fold();
        syncDownloadHistoryEntry(key, entry);
    }

    async function markPageIfDownloaded() {
        const history = await loadDownloadHistory();
        if (history[getDownloadKey()]) {
            markDLButtonDownloaded();
        }
    }

    function createBookPageDownloadState(previousText = getDLButtonText()) {
        // Book-page downloads use Hitomi's original progressbar UI, but the transfer
        // itself is ours so pressing d again can cancel XHR/throttle waits safely.
        return {
            canceled: false,
            cancelWait: null,
            heartbeatTimer: null,
            queueItemId: null,
            previousText,
            xhr: null
        };
    }

    function restoreDLButtonTextWhenIdle(downloadState, delay) {
        window.setTimeout(() => {
            if (activeBookPageDownload !== downloadState) {
                setDLButtonText(downloadState.previousText);
            }
        }, delay);
    }

    function cancelBookPageDownload(downloadState) {
        downloadState.canceled = true;
        downloadState.cancelWait?.();
        downloadState.xhr?.abort();
        if (downloadState.heartbeatTimer) {
            window.clearInterval(downloadState.heartbeatTimer);
        }
        hideBookPageDownloadProgress();
        setDLButtonText('CANCELED');
        restoreDLButtonTextWhenIdle(downloadState, 1000);
    }

    function getVisibleBookForGalleryId(galleryId) {
        return getBooks().find(book => getBookIdFromElement(book) === String(galleryId)) || null;
    }

    function getDownloadHistoryKeyFromUrl(url, galleryId) {
        try {
            return new URL(url, location.href).pathname.replace(/\/$/, '');
        } catch (e) {
            return String(galleryId);
        }
    }

    function markQueuedDownloadCompleted(queueItem, galleryInfo, visibleBook) {
        if (visibleBook) {
            markListBookDownloaded(visibleBook, galleryInfo);
            return;
        }

        if (String(getCurrentGalleryId()) === String(queueItem.galleryId)) {
            markCurrentBookDownloaded(galleryInfo, queueItem.galleryId);
            return;
        }

        const metadataRoot = String(getCurrentGalleryId()) === String(queueItem.galleryId) ? document : document.createElement('div');
        const key = getDownloadHistoryKeyFromUrl(queueItem.url, queueItem.galleryId);
        const metadata = getDownloadHistoryMetadata(metadataRoot, galleryInfo, queueItem.galleryId, queueItem.title || document.title);
        const entry = {
            ...metadata,
            url: queueItem.url || location.href,
            downloadedAt: new Date().toISOString()
        };
        const localHistory = loadLocalDownloadHistory();

        localHistory[key] = entry;
        saveLocalDownloadHistory(localHistory);
        syncDownloadHistoryEntry(key, entry);
        refreshDownloadIndicators().catch(() => {});
    }

    function startDownloadQueueHeartbeat(downloadState) {
        if (!downloadState.queueItemId) return;

        downloadState.heartbeatTimer = window.setInterval(() => {
            markQueuedDownload(downloadState.queueItemId, {
                heartbeatAt: new Date().toISOString(),
                workerId: downloadQueueWorkerId
            }).catch(() => {});
        }, downloadQueueHeartbeatInterval);
    }

    function stopDownloadQueueHeartbeat(downloadState) {
        if (!downloadState.heartbeatTimer) return;

        window.clearInterval(downloadState.heartbeatTimer);
        downloadState.heartbeatTimer = null;
    }

    async function buildAndSaveGalleryArchive(queueItem, downloadState, onProgress) {
        const galleryId = String(queueItem.galleryId);
        const [gg, galleryInfo] = await Promise.all([
            waitForHitomiGg(),
            String(getCurrentGalleryId()) === galleryId
                ? loadCurrentBookPageGalleryInfo(galleryId, downloadState)
                : loadGalleryInfo(galleryId)
        ]);
        throwIfDownloadCanceled(downloadState);

        if (galleryInfo.type === 'anime') {
            throw createAnimeNotSupportedError();
        }

        const zip = new JSZip();
        const metadataRoot = String(getCurrentGalleryId()) === galleryId ? document : document.createElement('div');
        const title = getDownloadFileNameFromBookPageDocument(metadataRoot, galleryInfo, galleryId);

        for (let i = 0; i < galleryInfo.files.length; i++) {
            const image = galleryInfo.files[i];
            const url = urlFromUrlFromHash(image, 'webp', 'webp', undefined, gg);
            const imageName = image.name.replace(/[^.]*$/, 'webp');

            zip.file(imageName, await retryDownloadBlob(url, downloadState), { binary: true });
            onProgress(`${i + 1} / ${galleryInfo.files.length}`, (i + 1) / galleryInfo.files.length * 100);
            await markQueuedDownload(queueItem.id, {
                heartbeatAt: new Date().toISOString(),
                workerId: downloadQueueWorkerId
            });
            await wait(1000, downloadState);
        }

        throwIfDownloadCanceled(downloadState);
        onProgress('Zipping...', 100);
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        throwIfDownloadCanceled(downloadState);
        saveAs(zipBlob, `${title}.zip`);
        throwIfDownloadCanceled(downloadState);

        return galleryInfo;
    }

    async function runQueuedDownload(queueItem) {
        const visibleBook = getVisibleBookForGalleryId(queueItem.galleryId);
        const isCurrentBookPage = !visibleBook && String(getCurrentGalleryId()) === String(queueItem.galleryId);
        const downloadProgress = visibleBook ? createBookDownloadProgress(visibleBook) : null;
        const downloadState = isCurrentBookPage ? createBookPageDownloadState('DOWNLOAD') : createListDownloadState(downloadProgress);

        downloadState.queueItemId = queueItem.id;
        activeQueuedDownloads.set(String(queueItem.galleryId), downloadState);
        if (isCurrentBookPage) {
            activeBookPageDownload = downloadState;
            showBookPageDownloadProgress();
        }
        if (visibleBook) {
            activeListDownloads.set(String(queueItem.galleryId), downloadState);
            updateListDownloadTitle();
        }

        startDownloadQueueHeartbeat(downloadState);
        try {
            if (isCurrentBookPage) {
                updateBookPageDownloadProgress(0, 'Loading...');
            } else if (downloadProgress) {
                updateBookDownloadProgress(downloadProgress, 'Loading...', 0);
            } else {
                showListDownloadNotice(`Downloading ${queueItem.title || queueItem.galleryId}`);
            }

            const galleryInfo = await buildAndSaveGalleryArchive(queueItem, downloadState, (text, percent) => {
                if (isCurrentBookPage) {
                    updateBookPageDownloadProgress(percent, text);
                } else if (downloadProgress) {
                    updateBookDownloadProgress(downloadProgress, text, percent);
                }
            });

            markQueuedDownloadCompleted(queueItem, galleryInfo, visibleBook);
            if (isCurrentBookPage) {
                hideBookPageDownloadProgress();
                setDLButtonText('DOWNLOADED');
                if (await loadCloseBookPageAfterDownload()) {
                    closeCurrentTab();
                }
            } else if (downloadProgress) {
                finishBookDownloadProgress(downloadProgress, 'Downloaded', bookDownloadDoneClassName);
                window.setTimeout(() => hideBookDownloadProgress(downloadProgress), 1400);
            } else {
                showListDownloadNotice('Downloaded');
            }
            await markQueuedDownload(queueItem.id, {
                status: 'done',
                finishedAt: new Date().toISOString(),
                heartbeatAt: null,
                workerId: null,
                error: ''
            });
            return true;
        } catch (e) {
            const canceled = isDownloadCanceledError(e);
            const animeNotSupported = isAnimeNotSupportedError(e);
            if (!canceled && !animeNotSupported) console.error(e);
            const failureText = animeNotSupported ? 'Anime not supported' : 'Download failed';

            if (isCurrentBookPage) {
                hideBookPageDownloadProgress();
                setDLButtonText(canceled ? 'CANCELED' : animeNotSupported ? 'ANIME NOT SUPPORTED' : 'DOWNLOAD FAILED');
                restoreDLButtonTextWhenIdle(downloadState, 1800);
            } else if (downloadProgress) {
                finishBookDownloadProgress(downloadProgress, canceled ? 'Canceled' : failureText, canceled ? bookDownloadCanceledClassName : bookDownloadErrorClassName);
                window.setTimeout(() => hideBookDownloadProgress(downloadProgress), 1800);
            } else {
                showListDownloadNotice(canceled ? 'Canceled' : failureText);
            }
            await markQueuedDownload(queueItem.id, {
                status: canceled ? 'canceled' : 'error',
                finishedAt: new Date().toISOString(),
                heartbeatAt: null,
                workerId: null,
                error: canceled ? '' : String(e?.message || e)
            });
            return false;
        } finally {
            stopDownloadQueueHeartbeat(downloadState);
            activeQueuedDownloads.delete(String(queueItem.galleryId));
            if (activeBookPageDownload === downloadState) {
                activeBookPageDownload = null;
            }
            if (activeListDownloads.get(String(queueItem.galleryId)) === downloadState) {
                activeListDownloads.delete(String(queueItem.galleryId));
                updateListDownloadTitle();
            }
            scheduleDownloadQueueWorker();
        }
    }

    async function claimNextQueuedDownload() {
        return updateDownloadQueue(queue => {
            const runningCount = queue.items.filter(item => item.status === 'running').length;
            if (runningCount >= maxGlobalDownloadCount) return null;

            const item = queue.items.find(candidate => candidate.status === 'pending');
            if (!item) return null;

            const now = new Date().toISOString();
            Object.assign(item, {
                status: 'running',
                updatedAt: now,
                startedAt: now,
                heartbeatAt: now,
                workerId: downloadQueueWorkerId,
                error: ''
            });
            return { ...item };
        });
    }

    async function processDownloadQueue() {
        if (downloadQueueWorkerRunning) return;

        downloadQueueWorkerRunning = true;
        try {
            while (activeQueuedDownloads.size < maxGlobalDownloadCount) {
                const item = await claimNextQueuedDownload();
                if (!item) break;

                runQueuedDownload(item).catch(() => {});
            }
        } finally {
            downloadQueueWorkerRunning = false;
        }
    }

    function scheduleDownloadQueueWorker() {
        processDownloadQueue().catch(() => {});
        syncVisibleQueuedBookBadges().catch(() => {});
    }

    function installDownloadQueueWorker() {
        if (downloadQueueWorkerTimer) return;

        scheduleDownloadQueueWorker();
        downloadQueueWorkerTimer = window.setInterval(() => {
            scheduleDownloadQueueWorker();
        }, downloadQueueWorkerInterval);
    }

    async function toggleQueuedDownload(target) {
        const activeDownload = activeQueuedDownloads.get(String(target.galleryId));
        if (activeDownload) {
            if (activeDownload === activeBookPageDownload) {
                cancelBookPageDownload(activeDownload);
            } else {
                cancelListDownload(activeDownload);
            }
            return 'canceled';
        }

        const result = await enqueueDownload(target);
        scheduleDownloadQueueWorker();
        return result.action;
    }

    function showDownloadQueueAction(target, action) {
        const messages = {
            queued: 'Queued',
            removed: 'Removed from queue',
            canceled: 'Canceled',
            'already-running': 'Downloading in another tab'
        };
        const message = messages[action];
        if (!message) return;

        if (target.source === 'book' && String(getCurrentGalleryId()) === String(target.galleryId)) {
            const previousText = getDLButtonText();
            setDLButtonText(message.toUpperCase());
            window.setTimeout(() => {
                if (!activeQueuedDownloads.has(String(target.galleryId))) {
                    setDLButtonText(action === 'queued' ? 'QUEUED' : action === 'already-running' ? previousText : 'DOWNLOAD');
                }
            }, 1200);
            return;
        }

        const visibleBook = getVisibleBookForGalleryId(target.galleryId);
        if (visibleBook) {
            if (action === 'queued') {
                showQueuedBookBadge(visibleBook);
                return;
            }

            const progress = createBookDownloadProgress(visibleBook);
            finishBookDownloadProgress(progress, message, action === 'canceled' ? bookDownloadCanceledClassName : bookDownloadDoneClassName);
            window.setTimeout(() => hideBookDownloadProgress(progress), 1000);
            return;
        }

        showListDownloadNotice(message);
    }

    async function handleQueuedBookPageDownload() {
        const target = getCurrentBookQueueTarget();
        if (!target) return false;

        const action = await toggleQueuedDownload(target);
        showDownloadQueueAction(target, action);
        return true;
    }

    async function handleQueuedFocusedBookDownload() {
        const book = getFocusedBook();
        if (!book) return false;

        const target = getBookQueueTarget(book);
        if (!target) return false;

        const action = await toggleQueuedDownload(target);
        showDownloadQueueAction(target, action);
        return true;
    }

    function getListDownloadProgressStack() {
        if (listDownloadProgressStack) return listDownloadProgressStack;

        listDownloadProgressStack = document.createElement('div');
        listDownloadProgressStack.className = downloadProgressStackClassName;
        document.body.appendChild(listDownloadProgressStack);
        return listDownloadProgressStack;
    }

    function createListDownloadNotice() {
        const container = document.createElement('div');
        const label = document.createElement('div');

        container.className = downloadProgressClassName;
        container.append(label);
        getListDownloadProgressStack().appendChild(container);

        return { container, label };
    }

    function updateListDownloadNotice(notice, text) {
        notice.label.textContent = text;
    }

    function hideListDownloadNotice(notice) {
        if (!notice) return;

        notice.container.remove();
    }

    function showListDownloadNotice(text) {
        if (listDownloadNotice) {
            window.clearTimeout(listDownloadNotice.timer);
        } else {
            listDownloadNotice = createListDownloadNotice();
        }

        updateListDownloadNotice(listDownloadNotice, text);
        listDownloadNotice.timer = window.setTimeout(() => {
            hideListDownloadNotice(listDownloadNotice);
            listDownloadNotice = null;
        }, 1800);
    }

    function createBookDownloadProgress(book) {
        const label = document.createElement('div');

        label.className = bookDownloadProgressLabelClassName;
        book.querySelectorAll(`:scope > .${bookDownloadProgressLabelClassName}`).forEach(elem => elem.remove());
        queuedBookProgress.delete(book);
        book.classList.remove(bookDownloadDoneClassName, bookDownloadCanceledClassName, bookDownloadErrorClassName);
        book.classList.add(bookDownloadProgressClassName);
        book.style.setProperty('--hitomi-tweak-download-percent', '0%');
        book.appendChild(label);

        return { book, label };
    }

    function updateBookDownloadProgress(downloadProgress, text, percent) {
        const normalizedPercent = Math.max(0, Math.min(100, percent));

        downloadProgress.book.style.setProperty('--hitomi-tweak-download-percent', `${normalizedPercent}%`);
        downloadProgress.label.textContent = text;
    }

    function finishBookDownloadProgress(downloadProgress, text, className) {
        updateBookDownloadProgress(downloadProgress, text, 100);
        downloadProgress.book.classList.add(className);
    }

    function hideBookDownloadProgress(downloadProgress) {
        if (!downloadProgress) return;
        if (!downloadProgress.label.isConnected) return;

        downloadProgress.label.remove();
        queuedBookProgress.delete(downloadProgress.book);
        downloadProgress.book.classList.remove(
            bookDownloadProgressClassName,
            bookDownloadDoneClassName,
            bookDownloadCanceledClassName,
            bookDownloadErrorClassName
        );
        downloadProgress.book.style.removeProperty('--hitomi-tweak-download-percent');
    }

    function showQueuedBookBadge(book) {
        if (!book?.isConnected) return null;

        const existing = queuedBookProgress.get(book);
        if (existing?.label.isConnected) {
            updateBookDownloadProgress(existing, 'Queued', 0);
            return existing;
        }

        const progress = createBookDownloadProgress(book);
        updateBookDownloadProgress(progress, 'Queued', 0);
        queuedBookProgress.set(book, progress);
        return progress;
    }

    async function syncVisibleQueuedBookBadges() {
        const pendingIds = new Set((await loadDownloadQueue()).items
            .filter(item => item.status === 'pending')
            .map(item => String(item.galleryId)));

        for (const [book, progress] of Array.from(queuedBookProgress.entries())) {
            const galleryId = getBookIdFromElement(book);
            if (!book.isConnected || !galleryId || !pendingIds.has(galleryId)) {
                hideBookDownloadProgress(progress);
                queuedBookProgress.delete(book);
            }
        }

        getBooks().forEach(book => {
            const galleryId = getBookIdFromElement(book);
            if (galleryId && pendingIds.has(galleryId) && !activeQueuedDownloads.has(galleryId)) {
                showQueuedBookBadge(book);
            }
        });
    }

    function createDownloadCanceledError() {
        const error = new Error('Download canceled.');
        error.name = downloadCanceledErrorName;
        return error;
    }

    function createAnimeNotSupportedError() {
        const error = new Error('Anime not supported.');
        error.name = downloadAnimeNotSupportedErrorName;
        return error;
    }

    function throwIfDownloadCanceled(downloadState) {
        if (downloadState?.canceled) {
            throw createDownloadCanceledError();
        }
    }

    function isDownloadCanceledError(error) {
        return error?.name === downloadCanceledErrorName;
    }

    function isAnimeNotSupportedError(error) {
        return error?.name === downloadAnimeNotSupportedErrorName;
    }

    function wait(ms, downloadState) {
        return new Promise((resolve, reject) => {
            try {
                throwIfDownloadCanceled(downloadState);
            } catch (e) {
                reject(e);
                return;
            }

            const timeout = window.setTimeout(() => {
                if (downloadState?.cancelWait === cancelWait) {
                    downloadState.cancelWait = null;
                }

                try {
                    throwIfDownloadCanceled(downloadState);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }, ms);

            function cancelWait() {
                window.clearTimeout(timeout);
                if (downloadState?.cancelWait === cancelWait) {
                    downloadState.cancelWait = null;
                }
                reject(createDownloadCanceledError());
            }

            if (downloadState) {
                downloadState.cancelWait = cancelWait;
            }
        });
    }

    async function waitForHitomiGg() {
        for (let i = 0; i < 50; i++) {
            if (unsafeWindow?.gg?.m && unsafeWindow.gg.b && unsafeWindow.gg.s) {
                return unsafeWindow.gg;
            }
            await wait(100);
        }

        throw new Error('Hitomi image URL helpers are not ready.');
    }

    function loadGalleryInfoScript(galleryId) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');

            script.src = `https://ltn.gold-usergeneratedcontent.net/galleries/${galleryId}.js`;
            script.onload = () => {
                const galleryInfo = unsafeWindow.galleryinfo;

                script.remove();
                if (galleryInfo?.id && String(galleryInfo.id) === String(galleryId)) {
                    resolve(galleryInfo);
                } else {
                    reject(new Error(`Could not load galleryinfo for ${galleryId}.`));
                }
            };
            script.onerror = () => {
                script.remove();
                reject(new Error(`Could not load galleryinfo script for ${galleryId}.`));
            };
            document.head.appendChild(script);
        });
    }

    function loadGalleryInfo(galleryId) {
        // galleryinfo scripts assign a single global variable. Queue script loads so parallel
        // list downloads do not race and accidentally read another book's metadata.
        const task = galleryInfoLoadQueue.then(
            () => loadGalleryInfoScript(galleryId),
            () => loadGalleryInfoScript(galleryId)
        );

        galleryInfoLoadQueue = task.catch(() => {});
        return task;
    }

    async function loadCurrentBookPageGalleryInfo(galleryId, downloadState) {
        for (let i = 0; i < 50; i++) {
            throwIfDownloadCanceled(downloadState);
            if (unsafeWindow.galleryinfo?.id && String(unsafeWindow.galleryinfo.id) === String(galleryId)) {
                return unsafeWindow.galleryinfo;
            }
            await wait(100, downloadState);
        }

        return loadGalleryInfo(galleryId);
    }

    function subdomainFromUrl(url, base, dir, gg) {
        let retval = '';
        if (!base) {
            if (dir === 'webp') {
                retval = 'w';
            } else if (dir === 'avif') {
                retval = 'a';
            }
        }

        const match = /\/[0-9a-f]{61}([0-9a-f]{2})([0-9a-f])/.exec(url);
        if (!match) return retval;

        const group = parseInt(match[2] + match[1], 16);
        if (Number.isNaN(group)) return retval;

        if (base) {
            return `${String.fromCharCode(97 + gg.m(group))}${base}`;
        }
        return `${retval}${1 + gg.m(group)}`;
    }

    function urlFromUrl(url, base, dir, gg) {
        return url.replace(/\/\/..?\.(?:gold-usergeneratedcontent\.net|hitomi\.la)\//, `//${subdomainFromUrl(url, base, dir, gg)}.gold-usergeneratedcontent.net/`);
    }

    function fullPathFromHash(hash, gg) {
        return `${gg.b}${gg.s(hash)}/${hash}`;
    }

    function urlFromHash(image, dir, ext, gg) {
        const actualExt = ext || dir || image.name.split('.').pop();
        const actualDir = dir === 'webp' || dir === 'avif' ? '' : `${dir}/`;

        return `https://a.gold-usergeneratedcontent.net/${actualDir}${fullPathFromHash(image.hash, gg)}.${actualExt}`;
    }

    function urlFromUrlFromHash(image, dir, ext, base, gg) {
        // These URL helpers mirror Hitomi's common.js/download.js logic so list-page
        // downloads produce the same image URLs as the native book-page downloader.
        return urlFromUrl(urlFromHash(image, dir, ext, gg), base, dir, gg);
    }

    function sanitizeFileName(fileName) {
        return fileName.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'hitomi';
    }

    function downloadBlob(url, downloadState) {
        return new Promise((resolve, reject) => {
            try {
                throwIfDownloadCanceled(downloadState);
            } catch (e) {
                reject(e);
                return;
            }

            const xhr = new XMLHttpRequest();

            xhr.onreadystatechange = function() {
                if (this.readyState !== 4) return;

                if (downloadState?.xhr === xhr) {
                    downloadState.xhr = null;
                }

                if (downloadState?.canceled) {
                    reject(createDownloadCanceledError());
                    return;
                }

                if (this.status === 200) {
                    resolve(this.response);
                } else {
                    reject(new Error(`downloadBlob(${url}) failed with ${this.status}.`));
                }
            };
            xhr.onabort = () => {
                if (downloadState?.xhr === xhr) {
                    downloadState.xhr = null;
                }
                reject(createDownloadCanceledError());
            };
            xhr.onerror = () => {
                if (downloadState?.xhr === xhr) {
                    downloadState.xhr = null;
                }
                reject(new Error(`downloadBlob(${url}) failed.`));
            };
            xhr.open('GET', url);
            xhr.responseType = 'arraybuffer';
            if (downloadState) {
                downloadState.xhr = xhr;
            }
            xhr.send();
        });
    }

    async function retryDownloadBlob(url, downloadState, retries = 3) {
        let lastError = null;

        for (let i = 0; i < retries; i++) {
            try {
                throwIfDownloadCanceled(downloadState);
                return await downloadBlob(url, downloadState);
            } catch (e) {
                if (isDownloadCanceledError(e)) throw e;

                lastError = e;
                await wait(500, downloadState);
            }
        }

        throw lastError;
    }

    function createListDownloadState(downloadProgress) {
        // Keep cancellation state per download because up to four list downloads can run
        // concurrently, each with its own pending XHR or throttle wait.
        return {
            canceled: false,
            cancelWait: null,
            heartbeatTimer: null,
            queueItemId: null,
            progress: downloadProgress,
            xhr: null
        };
    }

    function updateListDownloadTitle() {
        const count = activeListDownloads.size;

        if (count > 0) {
            titleBeforeListDownloads ||= document.title.replace(/^\(\d+\)\s*/, '');
            document.title = `(${count}) ${titleBeforeListDownloads}`;
            return;
        }

        if (titleBeforeListDownloads !== null) {
            document.title = titleBeforeListDownloads;
            titleBeforeListDownloads = null;
        }
    }

    function cancelListDownload(downloadState) {
        downloadState.canceled = true;
        downloadState.cancelWait?.();
        downloadState.xhr?.abort();
        if (downloadState.heartbeatTimer) {
            window.clearInterval(downloadState.heartbeatTimer);
        }
        if (downloadState.progress) {
            finishBookDownloadProgress(downloadState.progress, 'Canceled', bookDownloadCanceledClassName);
            window.setTimeout(() => hideBookDownloadProgress(downloadState.progress), 1000);
        }
    }

    function installDownloadNavigationGuard() {
        window.addEventListener('beforeunload', e => {
            if (!activeBookPageDownload && activeListDownloads.size === 0 && activeQueuedDownloads.size === 0) return;

            e.preventDefault();
            e.returnValue = '';
        });
    }

    function installDownloadClickHistory() {
        const dlButton = getDLButton();
        if (!dlButton) return;

        dlButton.addEventListener('click', () => {
            // The page's own galleries/<id>.js script has already set this global by
            // the time a user can click Download, so use it instead of passing no
            // galleryInfo — otherwise every click-triggered download is recorded
            // without metadata and the history page has to re-fetch it later.
            const galleryId = getCurrentGalleryId();
            const galleryInfo = unsafeWindow.galleryinfo?.id && String(unsafeWindow.galleryinfo.id) === String(galleryId)
                ? unsafeWindow.galleryinfo
                : null;

            markCurrentBookDownloaded(galleryInfo, galleryId);
        }, true);
    }

    function installHistory() {
        markPageIfDownloaded().catch(() => {});
        installDownloadClickHistory();
    }

    function removeAdPlaceholder() {
        const content = document.querySelector('div.content, div.top-content');
        if (!content || content.firstElementChild?.tagName !== 'DIV') return false;

        content.firstElementChild.remove();
        return true;
    }

    function openReadOnlineInNewTab() {
        document
            .querySelectorAll('#read-online-button, div.container > div.content > div.cover-column.lillie > div.cover > a')
            .forEach(link => {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            });
    }

    function getBooks() {
        return Array.from(document.querySelectorAll('div.gallery-content > div'));
    }

    function getListNavigationScrollPadding() {
        // Keep a viewport-relative buffer around focused books. This avoids depending
        // on Hitomi's pagination class names, which have changed across list pages.
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportPadding = Math.min(180, Math.max(96, viewportHeight * 0.16));
        const paginationHeight = Math.max(
            0,
            ...Array.from(document.querySelectorAll('.pagination'), elem => elem.getBoundingClientRect().height)
        );
        return Math.max(viewportPadding, paginationHeight + 12);
    }

    function scrollBookIntoViewIfNeeded(book) {
        const rect = book.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const padding = getListNavigationScrollPadding();

        if (rect.top < padding) {
            window.scrollBy({
                top: rect.top - padding,
                behavior: 'auto'
            });
        } else if (rect.bottom > viewportHeight - padding) {
            window.scrollBy({
                top: rect.bottom - viewportHeight + padding,
                behavior: 'auto'
            });
        }
    }

    function focusBook(book) {
        focusedBook?.classList.remove(focusedBookClassName);
        focusedBook = book;
        focusedBook.classList.add(focusedBookClassName);
        scrollBookIntoViewIfNeeded(focusedBook);
    }

    function getFocusedBook() {
        return focusedBook?.isConnected ? focusedBook : null;
    }

    function openFocusedBookInBackgroundTab() {
        const link = getFocusedBook()?.querySelector(':scope > h1 > a');
        if (!link?.href) return false;

        if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') {
            GM.openInTab(link.href, {
                active: false,
                insert: true,
                setParent: true
            });
        } else {
            const opened = window.open(link.href, '_blank', 'noopener,noreferrer');
            opened?.blur();
            window.focus();
        }

        return true;
    }

    function openUrlInNewTab(url) {
        if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') {
            GM.openInTab(url, {
                active: true,
                insert: true,
                setParent: true
            });
        } else {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }

    function openAuthorLinks() {
        const book = getFocusedBook();
        const links = book
            ? book.querySelectorAll(':scope div.artist-list li a[href]')
            : document.querySelectorAll('h2#artists > ul > li > a[href]');
        const urls = [...new Set(Array.from(links, link => new URL(link.getAttribute('href'), location.href).href))];
        if (urls.length === 0) return false;

        urls.forEach(openUrlInNewTab);
        return true;
    }

    function openFocusedBookReader() {
        const book = getFocusedBook();
        if (!book) return false;

        // List cards do not include a reader link, but Hitomi reader URLs are derived
        // directly from the gallery id used in the book URL.
        const bookId = getBookIdFromElement(book);
        if (!bookId) return false;

        openUrlInNewTab(new URL(`/reader/${bookId}.html`, location.href).href);
        return true;
    }

    function clickReadOnlineButton() {
        const readOnlineButton = document.querySelector('a#read-online-button');
        if (!readOnlineButton) return false;

        readOnlineButton.click();
        return true;
    }

    function closeCurrentTab() {
        window.close();
    }

    function installEnhancer() {
        if (!removeAdPlaceholder()) {
            const observer = new MutationObserver(() => {
                if (removeAdPlaceholder()) {
                    observer.disconnect();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            window.setTimeout(() => observer.disconnect(), 10000);
        }

        openReadOnlineInNewTab();
    }

    function createHelpOverlay() {
        // Keep the help overlay lightweight and generated on demand; '/' toggles it,
        // and other shortcuts intentionally pause while it is open.
        const overlay = document.createElement('div');
        const panel = document.createElement('div');
        const title = document.createElement('h2');
        const list = document.createElement('dl');

        overlay.className = `${helpOverlayClassName} ${helpOverlayHiddenClassName}`;
        title.textContent = 'Keyboard shortcuts';

        keyboardShortcuts.forEach(([key, description]) => {
            const term = document.createElement('dt');
            const detail = document.createElement('dd');

            term.textContent = key;
            detail.textContent = description;
            list.append(term, detail);
        });

        panel.append(title, list);
        overlay.append(panel);
        document.body.append(overlay);

        return overlay;
    }

    function isHelpOverlayOpen() {
        return Boolean(helpOverlay && !helpOverlay.classList.contains(helpOverlayHiddenClassName));
    }

    function toggleHelpOverlay() {
        helpOverlay ||= createHelpOverlay();
        helpOverlay.classList.toggle(helpOverlayHiddenClassName);
    }

    function handleFocusNextBook() {
        const books = getBooks();
        if (books.length === 0) return false;

        const currentIndex = focusedBook ? books.indexOf(focusedBook) : -1;
        if (currentIndex === books.length - 1) return false;

        focusBook(books[currentIndex + 1] || books[0]);
        return true;
    }

    function handleFocusPreviousBook() {
        const books = getBooks();
        if (books.length === 0) return false;

        const currentIndex = focusedBook ? books.indexOf(focusedBook) : -1;
        if (currentIndex === -1) {
            // Mirror j's "start from the first book" behavior: k starts from the last
            // book when nothing is focused yet.
            focusBook(books[books.length - 1]);
            return true;
        }
        if (currentIndex <= 0) return false;

        focusBook(books[currentIndex - 1]);
        return true;
    }

    function handleFoldFocusedBook() {
        if (!focusedBook) return false;

        getFilterBook(focusedBook).toggleManualFolded();
        return true;
    }

    function handleGlobalKeydown(e) {
        // Global shortcuts are plain-key only so browser/system shortcuts and text
        // entry fields keep their native behavior.
        if (!['/', 'a', 'b', 'c', 'd', 'j', 'k', 'r', 't', 'v'].includes(e.key) || !hasPlainModifierState(e)) return;
        if (isEditableTarget(e.target)) return;

        if (e.key === '/') {
            e.preventDefault();
            toggleHelpOverlay();
            return;
        }

        if (isHelpOverlayOpen()) return;

        if (e.key === 'b') {
            if (!filterMarkModeButton || isReaderPage()) return;
            e.preventDefault();
            filterMarkModeButton.click();
            return;
        }

        if (e.key === 'a') {
            if (isReaderPage()) return;
            if (openAuthorLinks()) {
                e.preventDefault();
            }
            return;
        }

        if (e.key === 'd') {
            if (isReaderPage()) return;

            e.preventDefault();
            if (getFocusedBook()) {
                handleQueuedFocusedBookDownload();
                return;
            }

            const dlButton = getDLButton();
            if (dlButton) {
                handleQueuedBookPageDownload();
            }
            return;
        }

        if (e.key === 'c') {
            e.preventDefault();
            closeCurrentTab();
            return;
        }

        if (e.key === 'r') {
            if (isReaderPage()) return;
            if (openFocusedBookReader() || clickReadOnlineButton()) {
                e.preventDefault();
            }
            return;
        }

        if (e.key === 'v') {
            if (isReaderPage()) return;
            if (openFocusedBookInBackgroundTab()) {
                e.preventDefault();
                handleFocusNextBook();
            }
            return;
        }

        if (e.key === 't') {
            if (isReaderPage()) return;
            if (handleFoldFocusedBook()) {
                e.preventDefault();
            }
            return;
        }

        if (e.key === 'j') {
            if (isReaderPage()) return;
            if (handleFocusNextBook()) {
                e.preventDefault();
            }
        } else if (e.key === 'k' && !isReaderPage() && handleFocusPreviousBook()) {
            e.preventDefault();
        }
    }

    function installReaderProgress() {
        // Reader navigation mutates the URL and select state without a full reload,
        // so progress is updated by observing DOM changes as well as initial render.
        let lastUrl = location.href;

        const li = document.createElement('li');
        li.id = 'hitomi-page-progress-li';

        const progressDisplay = document.createElement('span');
        progressDisplay.id = 'hitomi-page-progress-text';
        progressDisplay.style.color = 'white';
        progressDisplay.style.padding = '8px';
        progressDisplay.style.alignSelf = 'center';

        const progressContainer = document.createElement('div');
        progressContainer.id = 'hitomi-page-progress-container';
        progressContainer.style.display = 'flex';
        progressContainer.style.flexDirection = 'column';
        progressContainer.style.alignItems = 'flex-start';
        progressContainer.style.minWidth = '120px';

        const progressBar = document.createElement('div');
        progressBar.id = 'hitomi-page-progress-bar';
        progressBar.style.width = '100%';
        progressBar.style.height = '4px';
        progressBar.style.background = '#555';
        progressBar.style.marginTop = '4px';
        progressBar.style.borderRadius = '2px';
        progressBar.style.direction = 'rtl';

        const progressFill = document.createElement('div');
        progressFill.id = 'hitomi-page-progress-fill';
        progressFill.style.height = '100%';
        progressFill.style.background = 'limegreen';
        progressFill.style.width = '0%';
        progressFill.style.borderRadius = '2px';
        progressFill.style.marginLeft = 'auto';

        progressBar.appendChild(progressFill);
        progressContainer.append(progressDisplay, progressBar);
        li.appendChild(progressContainer);

        function updateProgress() {
            const select = document.querySelector('#single-page-select');
            if (!select || select.options.length === 0) return;

            const total = select.options.length;
            const current = select.selectedIndex + 1;
            progressDisplay.textContent = `${current} / ${total}`;
            progressFill.style.width = `${(current / total) * 100}%`;
        }

        function observePageChange() {
            const urlObserver = new MutationObserver(() => {
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    setTimeout(updateProgress, 50);
                }
            });
            urlObserver.observe(document.body, { childList: true, subtree: true });
        }

        function waitForNav() {
            const nav = document.querySelector('ul.nav');
            if (!nav || !document.querySelector('#single-page-select')?.options.length) {
                setTimeout(waitForNav, 100);
                return;
            }

            nav.appendChild(li);
            updateProgress();
            observePageChange();
        }

        waitForNav();
    }

    async function main() {
        if (isNameMapPage()) {
            await renderNameMapPage();
            return;
        }
        if (isDownloadPage()) {
            await renderDownloadPage();
            return;
        }
        if (isDownloadHistoryPage()) {
            location.replace(new URL(downloadPagePath, location.origin).href);
            return;
        }
        if (await maybeRedirectToPreferredLanguage()) return;

        installStyles();
        document.addEventListener('keydown', handleGlobalKeydown);

        if (isReaderPage()) {
            installReaderProgress();
            return;
        }

        await loadNameMap();
        installEnhancer();
        installDownloadNavigationGuard();
        installHistory();
        installDownloadQueueWorker();
        await installFilter();
    }

    // Temporary Step 3 verification hook; remove at Step 6.
    unsafeWindow.hitomiTweakUnifiedDownloads = () => loadUnifiedDownloads();
    main().catch(() => {});
})();
