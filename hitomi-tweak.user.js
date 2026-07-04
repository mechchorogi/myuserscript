// ==UserScript==
// @name         Hitomi::Tweak
// @namespace    http://hitomi.la/
// @version      1.0.0
// @description  Combine hitomi.la filtering, download history, reader progress, and keyboard tweaks
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.openInTab
// @grant        window.close
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const blacklistKeys = ['author', 'language', 'series', 'tag', 'title', 'type'];
    const downloadHistoryKey = 'hitomi-tweak-download-history';
    const focusedBookClassName = 'hitomi-tweak-focused-book';
    const helpOverlayClassName = 'hitomi-tweak-help-overlay';
    const helpOverlayHiddenClassName = 'hitomi-tweak-help-overlay-hidden';
    const filterPanelId = 'hitomi-tweak-filter-panel';
    const filterBookMap = new WeakMap();
    const keyboardShortcuts = [
        ['/', 'Toggle this help'],
        ['b', 'Toggle blacklist mode'],
        ['d', 'Download on book page'],
        ['j', 'Focus next book'],
        ['k', 'Focus previous book'],
        ['v', 'Open focused book in background tab'],
        ['r', 'Open read online link'],
        ['c', 'Close current tab']
    ];

    let filterEnabled = true;
    let filterMarkModeButton = null;
    let focusedBook = null;
    let helpOverlay = null;
    let isHandlingDownload = false;

    function isReaderPage() {
        return location.pathname.startsWith('/reader/');
    }

    function blacklistStorageKey(key) {
        return `hitomi-tweak-blacklist-${key}`;
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
        `;
        document.head.appendChild(style);
    }

    class FilterBook {
        constructor(elem) {
            this.elem = elem;
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
                    this.#unfold();
                } else {
                    this.#fold();
                }
            });

            const header = this.elem.querySelector('h1.lillie');
            if (header) {
                header.style.cursor = 'pointer';
            }

            this.elem.style.position = 'relative';
            this.#unfold();
        }

        refresh() {
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
                this.folded = false;
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
        document.querySelectorAll('body > div > div.gallery-content > div').forEach(elem => {
            const book = getFilterBook(elem);
            book.setFiltered(getMatches(book, blackList));
        });
    }

    function clearFilter() {
        document.querySelectorAll('body > div > div.gallery-content > div').forEach(elem => {
            getFilterBook(elem).folded = false;
        });
        document.querySelectorAll('body > div > div.gallery-content .hitomi-match').forEach(el => {
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
            }
        });
        observer.observe(gallery, { childList: true });

        const hasContent = Array.from(gallery.children).some(c => c.id !== 'loader-content');
        if (hasContent) {
            filter(blackList);
        }
    }

    async function installFilter() {
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

    function handleGlobalKeydown(e) {
        if (!['/', 'b', 'c', 'd', 'j', 'k', 'r', 'v'].includes(e.key) || !hasPlainModifierState(e)) return;
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
            if (!dlButton) return;

            e.preventDefault();
            downloadBook(dlButton);
            return;
        }

        if (e.key === 'c') {
            e.preventDefault();
            closeCurrentTab();
            return;
        }

        if (e.key === 'r') {
            if (isReaderPage()) return;
            if (clickReadOnlineButton()) {
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
        installHistory();
        await installFilter();
    }

    main().catch(() => {});
})();
