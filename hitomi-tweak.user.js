// ==UserScript==
// @name         Hitomi::Tweak
// @namespace    http://hitomi.la/
// @version      1.1.0
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

/* global JSZip, saveAs, unsafeWindow */

(function() {
    'use strict';

    const blacklistKeys = ['author', 'language', 'series', 'tag', 'title', 'type'];
    const downloadHistoryKey = 'hitomi-tweak-download-history';
    const foldedBookIdsKey = 'hitomi-tweak-folded-book-ids';
    const maxListDownloadCount = 4;
    const downloadProgressStackClassName = 'hitomi-tweak-download-progress-stack';
    const downloadProgressClassName = 'hitomi-tweak-download-progress';
    const bookDownloadProgressClassName = 'hitomi-tweak-book-download-progress';
    const bookDownloadDoneClassName = 'hitomi-tweak-book-download-done';
    const bookDownloadErrorClassName = 'hitomi-tweak-book-download-error';
    const bookDownloadProgressLabelClassName = 'hitomi-tweak-book-download-progress-label';
    const downloadedBookHeadingClassName = 'hitomi-tweak-downloaded-book-heading';
    const focusedBookClassName = 'hitomi-tweak-focused-book';
    const helpOverlayClassName = 'hitomi-tweak-help-overlay';
    const helpOverlayHiddenClassName = 'hitomi-tweak-help-overlay-hidden';
    const filterPanelId = 'hitomi-tweak-filter-panel';
    const filterBookMap = new WeakMap();
    const keyboardShortcuts = [
        ['/', 'Toggle this help'],
        ['b', 'Toggle blacklist mode'],
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
    let isHandlingDownload = false;
    let activeListDownloads = new Map();
    let galleryInfoLoadQueue = Promise.resolve();
    let listDownloadNotice = null;
    let listDownloadProgressStack = null;

    function isReaderPage() {
        return location.pathname.startsWith('/reader/');
    }

    function blacklistStorageKey(key) {
        return `hitomi-tweak-blacklist-${key}`;
    }

    function getBookIdFromElement(elem) {
        const link = elem.querySelector(':scope > h1.lillie a[href], :scope > h1 a[href], :scope > a[href]');
        if (!link) return null;

        const pathname = new URL(link.getAttribute('href'), location.href).pathname;
        const pathWithoutExtension = pathname.replace(/\.[^/.]+$/, '');
        return pathWithoutExtension.match(/(\d+)$/)?.[1] || null;
    }

    async function loadFoldedBookIds() {
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
            this.folded = state;

            if (!this.bookId) return;
            if (state) {
                foldedBookIds.add(this.bookId);
            } else {
                foldedBookIds.delete(this.bookId);
            }
            saveFoldedBookIds();
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
        let saveTimer = null;

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

        panel.appendChild(form);

        const buttonRow = document.createElement('div');
        Object.assign(buttonRow.style, {
            marginTop: '10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
        });

        filterMarkModeButton = document.createElement('button');
        filterMarkModeButton.textContent = 'Blacklist Mode';
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

        buttonRow.append(markModeRow, backupRow);
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

        const toggleRow = document.createElement('div');
        Object.assign(toggleRow.style, {
            marginTop: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px'
        });

        const toggleLabel = document.createElement('label');
        toggleLabel.textContent = 'Filter Enabled';
        toggleLabel.htmlFor = 'hitomi-tweak-filter-enabled-toggle';
        Object.assign(toggleLabel.style, {
            flex: '1',
            cursor: 'pointer',
            userSelect: 'none'
        });

        const toggleCheckbox = document.createElement('input');
        toggleCheckbox.id = 'hitomi-tweak-filter-enabled-toggle';
        toggleCheckbox.className = 'hitomi-switch-input';
        toggleCheckbox.type = 'checkbox';
        toggleCheckbox.checked = filterEnabled;
        toggleCheckbox.addEventListener('change', () => {
            filterEnabled = toggleCheckbox.checked;
            if (filterEnabled) {
                loadBlacklist().then(refreshFilter);
            } else {
                clearFilter();
            }
        });

        const toggleSwitch = document.createElement('label');
        toggleSwitch.className = 'hitomi-switch';
        toggleSwitch.htmlFor = toggleCheckbox.id;

        const toggleSlider = document.createElement('span');
        toggleSlider.className = 'hitomi-switch-slider';

        toggleSwitch.append(toggleCheckbox, toggleSlider);
        toggleRow.append(toggleLabel, toggleSwitch);
        panel.appendChild(toggleRow);

        document.body.appendChild(panel);
    }

    function observeGallery(blackList) {
        const gallery = document.querySelector('div.gallery-content');
        if (!gallery) return;

        const observer = new MutationObserver(async () => {
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
        document.querySelectorAll('div.gallery-content > div').forEach(book => {
            const key = getDownloadHistoryKeyFromBook(book);
            const bookId = getBookIdFromElement(book);
            const downloaded = Boolean((key && history[key]) || (bookId && history[bookId]));

            setBookDownloadedIndicator(book, downloaded);
        });
    }

    async function refreshDownloadIndicators() {
        const history = await loadDownloadHistory();
        applyDownloadHistoryToBooks(history);
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

    function markListBookDownloaded(book, galleryInfo) {
        if (!book) return;

        const link = getBookLinkFromElement(book);
        const key = link ? new URL(link.getAttribute('href'), location.href).pathname.replace(/\/$/, '') : String(galleryInfo.id);
        const entry = {
            title: galleryInfo.japanese_title || galleryInfo.title || book.querySelector('h1.lillie')?.textContent.trim() || document.title,
            url: link ? new URL(link.getAttribute('href'), location.href).href : location.href,
            downloadedAt: new Date().toISOString()
        };
        const localHistory = loadLocalDownloadHistory();

        localHistory[key] = entry;
        saveLocalDownloadHistory(localHistory);
        setBookDownloadedIndicator(book, true);
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
        book.classList.remove(bookDownloadDoneClassName, bookDownloadErrorClassName);
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
            bookDownloadErrorClassName
        );
        downloadProgress.book.style.removeProperty('--hitomi-tweak-download-percent');
    }

    function wait(ms) {
        return new Promise(resolve => window.setTimeout(resolve, ms));
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
        const task = galleryInfoLoadQueue.then(
            () => loadGalleryInfoScript(galleryId),
            () => loadGalleryInfoScript(galleryId)
        );

        galleryInfoLoadQueue = task.catch(() => {});
        return task;
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
        return urlFromUrl(urlFromHash(image, dir, ext, gg), base, dir, gg);
    }

    function sanitizeFileName(fileName) {
        return fileName.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'hitomi';
    }

    function downloadBlob(url) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();

            xhr.onreadystatechange = function() {
                if (this.readyState !== 4) return;

                if (this.status === 200) {
                    resolve(this.response);
                } else {
                    reject(new Error(`downloadBlob(${url}) failed with ${this.status}.`));
                }
            };
            xhr.open('GET', url);
            xhr.responseType = 'arraybuffer';
            xhr.send();
        });
    }

    async function retryDownloadBlob(url, retries = 3) {
        let lastError = null;

        for (let i = 0; i < retries; i++) {
            try {
                return await downloadBlob(url);
            } catch (e) {
                lastError = e;
                await wait(500);
            }
        }

        throw lastError;
    }

    async function downloadFocusedBookFromList() {
        const book = focusedBook;
        if (!book) return false;

        const galleryId = getBookIdFromElement(book);
        if (!galleryId) return false;

        if (activeListDownloads.has(galleryId)) {
            showListDownloadNotice('This book is already downloading.');
            return false;
        }

        if (activeListDownloads.size >= maxListDownloadCount) {
            showListDownloadNotice(`Up to ${maxListDownloadCount} list downloads can run at once.`);
            return false;
        }

        const downloadProgress = createBookDownloadProgress(book);
        activeListDownloads.set(galleryId, downloadProgress);

        try {
            updateBookDownloadProgress(downloadProgress, 'Loading...', 0);
            const [gg, galleryInfo] = await Promise.all([
                waitForHitomiGg(),
                loadGalleryInfo(galleryId)
            ]);

            if (galleryInfo.type === 'anime') {
                finishBookDownloadProgress(downloadProgress, 'Anime not supported', bookDownloadErrorClassName);
                window.setTimeout(() => hideBookDownloadProgress(downloadProgress), 1800);
                return false;
            }

            const zip = new JSZip();
            const title = sanitizeFileName(galleryInfo.japanese_title || galleryInfo.title || `hitomi-${galleryId}`);

            for (let i = 0; i < galleryInfo.files.length; i++) {
                const image = galleryInfo.files[i];
                const url = urlFromUrlFromHash(image, 'webp', 'webp', undefined, gg);
                const imageName = image.name.replace(/[^.]*$/, 'webp');

                updateBookDownloadProgress(downloadProgress, `${i + 1} / ${galleryInfo.files.length}`, i / galleryInfo.files.length * 100);
                zip.file(imageName, await retryDownloadBlob(url), { binary: true });
                await wait(1000);
            }

            updateBookDownloadProgress(downloadProgress, 'Zipping...', 100);
            saveAs(await zip.generateAsync({ type: 'blob' }), `${title}.zip`);
            markListBookDownloaded(book, galleryInfo);
            finishBookDownloadProgress(downloadProgress, 'Downloaded', bookDownloadDoneClassName);
            window.setTimeout(() => hideBookDownloadProgress(downloadProgress), 1400);
            return true;
        } catch (e) {
            console.error(e);
            finishBookDownloadProgress(downloadProgress, 'Download failed', bookDownloadErrorClassName);
            return false;
        } finally {
            activeListDownloads.delete(galleryId);
        }
    }

    function installDownloadNavigationGuard() {
        window.addEventListener('beforeunload', e => {
            if (activeListDownloads.size === 0) return;

            e.preventDefault();
            e.returnValue = '';
        });
    }

    function installDownloadClickHistory() {
        const dlButton = getDLButton();
        if (!dlButton) return;

        dlButton.addEventListener('click', () => {
            if (isHandlingDownload) return;

            markCurrentBookDownloaded();
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
        if (currentIndex <= 0) return false;

        focusBook(books[currentIndex - 1]);
        return true;
    }

    function handleFoldFocusedBook() {
        if (!focusedBook) return false;

        getFilterBook(focusedBook).setManualFolded(true);
        return true;
    }

    function handleGlobalKeydown(e) {
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
        installStyles();
        document.addEventListener('keydown', handleGlobalKeydown);

        if (isReaderPage()) {
            installReaderProgress();
            return;
        }

        installEnhancer();
        installDownloadNavigationGuard();
        installHistory();
        await installFilter();
    }

    main().catch(() => {});
})();
