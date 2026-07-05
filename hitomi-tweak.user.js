// ==UserScript==
// @name         Hitomi::Tweak
// @namespace    http://hitomi.la/
// @version      1.4.1
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
    const foldedBookIdsKey = 'hitomi-tweak-folded-book-ids';
    const nameMapKey = 'hitomi-tweak-name-map';
    const nameMapPagePath = '/hitomi-tweak-name-map.html';
    const preferredLanguageKey = 'hitomi-tweak-preferred-language';
    const preferredLanguageOptions = [
        ['off', 'Off'],
        ['japanese', 'Japanese'],
        ['english', 'English'],
        ['chinese', 'Chinese'],
        ['korean', 'Korean'],
        ['all', 'All']
    ];
    const maxListDownloadCount = 4;
    const downloadProgressStackClassName = 'hitomi-tweak-download-progress-stack';
    const downloadProgressClassName = 'hitomi-tweak-download-progress';
    const bookDownloadProgressClassName = 'hitomi-tweak-book-download-progress';
    const bookDownloadDoneClassName = 'hitomi-tweak-book-download-done';
    const bookDownloadCanceledClassName = 'hitomi-tweak-book-download-canceled';
    const bookDownloadErrorClassName = 'hitomi-tweak-book-download-error';
    const bookDownloadProgressLabelClassName = 'hitomi-tweak-book-download-progress-label';
    const downloadedBookHeadingClassName = 'hitomi-tweak-downloaded-book-heading';
    const downloadCanceledErrorName = 'HitomiTweakDownloadCanceled';
    const focusedBookClassName = 'hitomi-tweak-focused-book';
    const helpOverlayClassName = 'hitomi-tweak-help-overlay';
    const helpOverlayHiddenClassName = 'hitomi-tweak-help-overlay-hidden';
    const filterPanelId = 'hitomi-tweak-filter-panel';
    const filterBookMap = new WeakMap();
    // Keep the help overlay generated from the same source as key handling so the
    // displayed shortcuts do not drift from the actual behavior.
    const keyboardShortcuts = [
        ['/', 'Toggle this help'],
        ['b', 'Toggle blocklist mode'],
        ['d', 'Download current book (up to 4 on list pages)'],
        ['j', 'Focus next book'],
        ['k', 'Focus previous book'],
        ['t', 'Fold focused book'],
        ['v', 'Open focused book in background tab'],
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
    let galleryInfoLoadQueue = Promise.resolve();
    let listDownloadNotice = null;
    let listDownloadProgressStack = null;
    let nameMap = { version: 1, group: {}, author: {} };

    function isReaderPage() {
        return location.pathname.startsWith('/reader/');
    }

    function isDownloadHistoryPage() {
        // hitomi-download-history.user.js owns the whole document body on this
        // page, so hitomi-tweak.user.js must not install its own panel/filter UI.
        return location.pathname === '/hitomi-tweak-history.html';
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

        const normalized = { version: 1, group: {}, author: {} };
        for (const kind of ['group', 'author']) {
            for (const [key, value] of Object.entries(input[kind])) {
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
            return { version: 1, group: {}, author: {} };
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
        return (kind === 'group' || kind === 'author') && normalized ? nameMap[kind]?.[normalized] || name : name;
    }

    function getNameMapEntries(map = nameMap) {
        return ['group', 'author']
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

        buttonRow.append(markModeRow, backupRow, nameMapHeading, nameMapBackupRow);
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
        for (const kind of ['group', 'author']) {
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
            if (!romaji || !japanese || !['group', 'author'].includes(kind)) {
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

    function showBookPageDownloadProgress() {
        const $ = getPageJQuery();
        const progressbar = document.querySelector('#progressbar');
        const dlButton = getDLButton();

        if ($ && progressbar && typeof $(progressbar).progressbar === 'function') {
            $(dlButton).hide();
            $(progressbar).show();
            $(progressbar).progressbar({ value: false });
            return;
        }

        if (dlButton) dlButton.style.display = 'none';
        if (progressbar) progressbar.style.display = '';
    }

    function updateBookPageDownloadProgress(percent) {
        const $ = getPageJQuery();
        const progressbar = document.querySelector('#progressbar');

        if ($ && progressbar && typeof $(progressbar).progressbar === 'function') {
            $(progressbar).progressbar('value', Math.max(0, Math.min(100, percent)));
        }
    }

    function hideBookPageDownloadProgress() {
        const $ = getPageJQuery();
        const progressbar = document.querySelector('#progressbar');
        const dlButton = getDLButton();

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
        // Book pages hydrate title/author/group from galleryinfo after the initial HTML loads.
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

    function formatDownloadFileNameFromMetadata({ group, authors, title }) {
        const hasGroup = !isMissingMetadataValue(group);
        const normalizedGroup = normalizeMetadataText(group);
        const normalizedAuthors = authors.map(author => normalizeMetadataText(author)).filter(Boolean);
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

        return sanitizeFileName(`[${bracket}] ${title}`);
    }

    function getDownloadFileNameFromBookPageDocument(root, galleryInfo, galleryId) {
        // Both book-page and list-page downloads call this. On list pages, root is just the
        // current document, so the galleryinfo fallback is what supplies the metadata.
        return formatDownloadFileNameFromMetadata({
            group: getBookPageGroup(root, galleryInfo),
            authors: getBookPageAuthors(root, galleryInfo),
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

    function createBookPageDownloadState() {
        // Book-page downloads use Hitomi's original progressbar UI, but the transfer
        // itself is ours so pressing d again can cancel XHR/throttle waits safely.
        return {
            canceled: false,
            cancelWait: null,
            previousText: getDLButtonText(),
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
        hideBookPageDownloadProgress();
        setDLButtonText('CANCELED');
        restoreDLButtonTextWhenIdle(downloadState, 1000);
    }

    async function downloadBook(dlButton) {
        if (!dlButton) return false;

        if (activeBookPageDownload) {
            // On book pages, pressing d while the same page download is active means
            // cancel instead of starting a second archive build.
            cancelBookPageDownload(activeBookPageDownload);
            return false;
        }

        const galleryId = getCurrentGalleryId();
        if (!galleryId) return false;

        const downloadState = createBookPageDownloadState();
        activeBookPageDownload = downloadState;
        try {
            showBookPageDownloadProgress();
            const [gg, galleryInfo] = await Promise.all([
                waitForHitomiGg(),
                loadCurrentBookPageGalleryInfo(galleryId, downloadState)
            ]);
            throwIfDownloadCanceled(downloadState);

            if (galleryInfo.type === 'anime') {
                hideBookPageDownloadProgress();
                setDLButtonText('ANIME NOT SUPPORTED');
                restoreDLButtonTextWhenIdle(downloadState, 1800);
                return false;
            }

            const zip = new JSZip();
            const title = getDownloadFileNameFromBookPageDocument(document, galleryInfo, galleryId);

            for (let i = 0; i < galleryInfo.files.length; i++) {
                const image = galleryInfo.files[i];
                const url = urlFromUrlFromHash(image, 'webp', 'webp', undefined, gg);
                const imageName = image.name.replace(/[^.]*$/, 'webp');

                zip.file(imageName, await retryDownloadBlob(url, downloadState), { binary: true });
                updateBookPageDownloadProgress((i + 1) / galleryInfo.files.length * 100);
                await wait(1000, downloadState);
            }

            throwIfDownloadCanceled(downloadState);
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            throwIfDownloadCanceled(downloadState);
            saveAs(zipBlob, `${title}.zip`);
            throwIfDownloadCanceled(downloadState);
            hideBookPageDownloadProgress();
            markCurrentBookDownloaded(galleryInfo, galleryId);
            return true;
        } catch (e) {
            if (isDownloadCanceledError(e)) {
                return false;
            }

            console.error(e);
            hideBookPageDownloadProgress();
            setDLButtonText('DOWNLOAD FAILED');
            restoreDLButtonTextWhenIdle(downloadState, 1800);
            return false;
        } finally {
            if (activeBookPageDownload === downloadState) {
                activeBookPageDownload = null;
            }
        }
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
        downloadProgress.book.classList.remove(
            bookDownloadProgressClassName,
            bookDownloadDoneClassName,
            bookDownloadCanceledClassName,
            bookDownloadErrorClassName
        );
        downloadProgress.book.style.removeProperty('--hitomi-tweak-download-percent');
    }

    function createDownloadCanceledError() {
        const error = new Error('Download canceled.');
        error.name = downloadCanceledErrorName;
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
            progress: downloadProgress,
            xhr: null
        };
    }

    function cancelListDownload(downloadState) {
        downloadState.canceled = true;
        downloadState.cancelWait?.();
        downloadState.xhr?.abort();
        finishBookDownloadProgress(downloadState.progress, 'Canceled', bookDownloadCanceledClassName);
        window.setTimeout(() => hideBookDownloadProgress(downloadState.progress), 1000);
    }

    async function downloadFocusedBookFromList() {
        const book = focusedBook;
        if (!book) return false;

        const galleryId = getBookIdFromElement(book);
        if (!galleryId) return false;

        if (activeListDownloads.has(galleryId)) {
            cancelListDownload(activeListDownloads.get(galleryId));
            return false;
        }

        if (activeListDownloads.size >= maxListDownloadCount) {
            showListDownloadNotice(`Up to ${maxListDownloadCount} list downloads can run at once.`);
            return false;
        }

        const downloadProgress = createBookDownloadProgress(book);
        const downloadState = createListDownloadState(downloadProgress);
        activeListDownloads.set(galleryId, downloadState);

        try {
            // The list page only has a gallery id. galleryinfo provides files and metadata
            // needed both for image URLs and the final archive name.
            updateBookDownloadProgress(downloadProgress, 'Loading...', 0);
            const [gg, galleryInfo] = await Promise.all([
                waitForHitomiGg(),
                loadGalleryInfo(galleryId)
            ]);
            throwIfDownloadCanceled(downloadState);

            if (galleryInfo.type === 'anime') {
                finishBookDownloadProgress(downloadProgress, 'Anime not supported', bookDownloadErrorClassName);
                window.setTimeout(() => hideBookDownloadProgress(downloadProgress), 1800);
                return false;
            }

            const zip = new JSZip();
            const title = getDownloadFileNameFromBookPageDocument(document, galleryInfo, galleryId);

            for (let i = 0; i < galleryInfo.files.length; i++) {
                const image = galleryInfo.files[i];
                const url = urlFromUrlFromHash(image, 'webp', 'webp', undefined, gg);
                const imageName = image.name.replace(/[^.]*$/, 'webp');

                updateBookDownloadProgress(downloadProgress, `${i + 1} / ${galleryInfo.files.length}`, i / galleryInfo.files.length * 100);
                zip.file(imageName, await retryDownloadBlob(url, downloadState), { binary: true });
                await wait(1000, downloadState);
            }

            throwIfDownloadCanceled(downloadState);
            updateBookDownloadProgress(downloadProgress, 'Zipping...', 100);
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            throwIfDownloadCanceled(downloadState);
            saveAs(zipBlob, `${title}.zip`);
            throwIfDownloadCanceled(downloadState);
            markListBookDownloaded(book, galleryInfo);
            finishBookDownloadProgress(downloadProgress, 'Downloaded', bookDownloadDoneClassName);
            window.setTimeout(() => hideBookDownloadProgress(downloadProgress), 1400);
            return true;
        } catch (e) {
            if (isDownloadCanceledError(e)) {
                return false;
            }

            console.error(e);
            finishBookDownloadProgress(downloadProgress, 'Download failed', bookDownloadErrorClassName);
            return false;
        } finally {
            activeListDownloads.delete(galleryId);
        }
    }

    function installDownloadNavigationGuard() {
        window.addEventListener('beforeunload', e => {
            if (!activeBookPageDownload && activeListDownloads.size === 0) return;

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

    function scrollBookIntoViewIfNeeded(book) {
        const rect = book.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const padding = 12;

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

    function openFocusedBookInBackgroundTab() {
        const link = focusedBook?.querySelector(':scope > h1 > a');
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

    function openFocusedBookReader() {
        if (!focusedBook) return false;

        // List cards do not include a reader link, but Hitomi reader URLs are derived
        // directly from the gallery id used in the book URL.
        const bookId = getBookIdFromElement(focusedBook);
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
        if (!['/', 'b', 'c', 'd', 'j', 'k', 'r', 't', 'v'].includes(e.key) || !hasPlainModifierState(e)) return;
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

        if (e.key === 'd') {
            if (isReaderPage()) return;
            const dlButton = getDLButton();

            e.preventDefault();
            if (dlButton) {
                downloadBook(dlButton);
            } else {
                downloadFocusedBookFromList();
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
            if (clickReadOnlineButton() || openFocusedBookReader()) {
                e.preventDefault();
            }
            return;
        }

        if (e.key === 'v') {
            if (isReaderPage()) return;
            if (openFocusedBookInBackgroundTab()) {
                e.preventDefault();
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
        if (isDownloadHistoryPage()) return;
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
        await installFilter();
    }

    main().catch(() => {});
})();
