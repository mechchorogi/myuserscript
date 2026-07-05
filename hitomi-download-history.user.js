// ==UserScript==
// @name         Hitomi::Download History
// @namespace    http://hitomi.la/
// @version      1.0.0
// @description  Show a sortable keyboard-navigable table for Hitomi::Tweak download history
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        GM.openInTab
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/* global GM, unsafeWindow */

(function() {
    'use strict';

    const historyPagePath = '/hitomi-tweak-history.html';
    const downloadHistoryKey = 'hitomi-tweak-download-history';
    const metadataFetchDelayMs = 1200;
    const selectedRowClassName = 'hitomi-download-history-selected-row';
    const sortIndicatorClassName = 'hitomi-download-history-sort-indicator';
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
    let headerElems = new Map();

    if (location.pathname !== historyPagePath) {
        installHeaderHistoryLink();
        return;
    }

    function normalizeText(text) {
        return text?.replace(/\s+/g, ' ').trim() || '';
    }

    function installNavLinkStyle() {
        const styleId = 'hitomi-download-history-nav-link-style';
        if (document.getElementById(styleId)) return;

        // The navbar is a fixed max-width row that already fits logo + nav + search
        // box tightly. Shrinking only our added item didn't free enough width to
        // stop the search box from being pushed out of place, so shrink the whole
        // nav (native items included) instead. `.navbar nav` and
        // `.navbar nav > ul > li > a` both out-specificity the site's own
        // `nav` / `nav > ul > li > a` rules, so no !important is needed.
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .navbar nav {
                font-size: 14px;
            }
            .navbar nav > ul > li > a {
                padding: 10px 10px;
            }
        `;
        document.head.appendChild(style);
    }

    function installHeaderHistoryLink() {
        // The header's own LANGUAGE dropdown is managed by page scripts that differ
        // by page type (e.g. list pages load language_support.js, gallery pages
        // don't), so repurposing that link is unreliable and also removes native
        // language switching now that hitomi-tweak.user.js has its own preferred
        // language setting. Add an independent nav item instead.
        const navList = document.querySelector('.navbar nav ul');
        if (!navList || navList.querySelector('.hitomi-download-history-nav-link')) return;

        installNavLinkStyle();

        const li = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'hitomi-download-history-nav-link';
        link.href = new URL(historyPagePath, location.origin).href;
        link.textContent = 'DL HISTORY';
        li.appendChild(link);
        navList.appendChild(li);
    }

    function loadJsonStorage(key, fallback) {
        try {
            const value = JSON.parse(localStorage.getItem(key) || 'null');
            return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function saveJsonStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            // History write failures should not block viewing already loaded entries.
        }
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

    function getBookUrlFromRow(row) {
        if (row?.url) return row.url;
        return '';
    }

    function formatDownloadedAt(value) {
        if (!value) return '';

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return normalizeText(value);

        return date.toLocaleString();
    }

    function getGalleryInfoNames(values, key) {
        if (!Array.isArray(values)) return [];

        return values
            .map(value => normalizeText(typeof value === 'string' ? value : value?.[key] || value?.name))
            .filter(Boolean);
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
        const title = normalizeText(galleryInfo?.japanese_title) || normalizeText(galleryInfo?.title) || fallbackTitle;
        const group = getGalleryInfoNames(galleryInfo?.groups, 'group').join(', ');
        const author = dedupeNames(getGalleryInfoNames(galleryInfo?.artists, 'artist')).join(', ');

        return { title, group, author };
    }

    function createRowsFromHistory(history) {
        return Object.entries(history)
            .map(([key, entry]) => {
                const bookId = getBookIdFromHistoryEntry(key, entry);
                const title = normalizeText(entry?.title);
                const group = normalizeText(entry?.group);
                const author = normalizeText(entry?.author);
                const metadataHydrated = Boolean(entry?.metadataHydrated);

                return {
                    key,
                    bookId,
                    title,
                    group,
                    author,
                    url: getBookUrlFromHistoryEntry(key, entry),
                    downloadedAt: normalizeText(entry?.downloadedAt),
                    metadataStatus: metadataHydrated ? 'stored' : 'pending'
                };
            })
            .filter(row => row.bookId || row.url || row.title);
    }

    function compareValues(a, b, key) {
        if (key === 'bookId') {
            const left = Number(a.bookId);
            const right = Number(b.bookId);
            if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) return left - right;
        }

        return String(a[key] || '').localeCompare(String(b[key] || ''), undefined, { numeric: true, sensitivity: 'base' });
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
        const row = getSelectedRow();
        const url = getBookUrlFromRow(row);
        if (!url) return false;

        if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') {
            GM.openInTab(url, {
                active: false,
                insert: true,
                setParent: true
            });
        } else {
            const opened = window.open(url, '_blank', 'noopener,noreferrer');

            opened?.blur();
            window.focus();
        }
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
                    td.textContent = column.key === 'downloadedAt' ? formatDownloadedAt(row.downloadedAt) : row[column.key] || '';
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
        if (selectedBookId) {
            selectedIndex = rows.findIndex(row => row.bookId === selectedBookId);
        }
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
            .hitomi-download-history-page {
                max-width: 1280px;
                margin: 0 auto;
                padding: 24px;
            }
            .hitomi-download-history-header {
                display: flex;
                align-items: end;
                justify-content: space-between;
                gap: 16px;
                margin-bottom: 16px;
            }
            .hitomi-download-history-header h1 {
                margin: 0;
                font-size: 28px;
                font-weight: 700;
            }
            .hitomi-download-history-status {
                min-height: 20px;
                color: #52606d;
                font-size: 14px;
                text-align: right;
            }
            .hitomi-download-history-table-wrap {
                overflow: auto;
                border: 1px solid #d9e2ec;
                background: #fff;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                table-layout: fixed;
            }
            th,
            td {
                border-bottom: 1px solid #e4e7eb;
                padding: 10px 12px;
                text-align: left;
                vertical-align: top;
                font-size: 14px;
                line-height: 1.4;
                overflow-wrap: anywhere;
            }
            th {
                position: sticky;
                top: 0;
                z-index: 1;
                background: #e9eff5;
                color: #243b53;
                cursor: pointer;
                user-select: none;
                white-space: nowrap;
            }
            th:nth-child(1) {
                width: 110px;
            }
            th:nth-child(2) {
                width: 34%;
            }
            th:nth-child(3),
            th:nth-child(4) {
                width: 18%;
            }
            th:nth-child(5) {
                width: 170px;
            }
            tr.${selectedRowClassName} {
                background: #dbeafe;
                outline: 2px solid #2563eb;
                outline-offset: -2px;
            }
            tr:hover {
                background: #eff6ff;
            }
            a {
                color: #1d4ed8;
            }
            .${sortIndicatorClassName} {
                display: inline-block;
                min-width: 1.2em;
                margin-left: 6px;
                color: #1d4ed8;
            }
            .hitomi-download-history-empty {
                padding: 32px;
                color: #52606d;
                background: #fff;
                border: 1px solid #d9e2ec;
            }
        `;
        document.head.appendChild(style);
    }

    function createPage() {
        document.title = 'Hitomi Download History';
        document.body.replaceChildren();
        createStyle();

        const page = document.createElement('main');
        const header = document.createElement('header');
        const title = document.createElement('h1');
        const tableWrap = document.createElement('div');
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        page.className = 'hitomi-download-history-page';
        header.className = 'hitomi-download-history-header';
        title.textContent = 'Download History';
        statusElem = document.createElement('div');
        statusElem.className = 'hitomi-download-history-status';
        tableWrap.className = 'hitomi-download-history-table-wrap';
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
        page.append(header, tableWrap);
        document.body.appendChild(page);
    }

    function createEmptyPage() {
        createPage();
        const empty = document.createElement('div');

        empty.className = 'hitomi-download-history-empty';
        empty.textContent = 'No download history found.';
        document.querySelector('.hitomi-download-history-table-wrap')?.replaceWith(empty);
        setStatus('');
    }

    function loadGalleryInfoScript(bookId) {
        return new Promise((resolve, reject) => {
            const previousGalleryInfo = unsafeWindow.galleryinfo;
            const script = document.createElement('script');

            // Use the lightweight galleryinfo endpoint instead of fetching book pages.
            // Requests are queued and written back into the shared download history so
            // each book normally needs this enrichment only once.
            script.src = `https://ltn.gold-usergeneratedcontent.net/galleries/${bookId}.js`;
            script.onload = () => {
                const galleryInfo = unsafeWindow.galleryinfo;

                script.remove();
                unsafeWindow.galleryinfo = previousGalleryInfo;
                if (galleryInfo?.id && String(galleryInfo.id) === String(bookId)) {
                    resolve(galleryInfo);
                } else {
                    reject(new Error(`Could not load galleryinfo for ${bookId}.`));
                }
            };
            script.onerror = () => {
                script.remove();
                unsafeWindow.galleryinfo = previousGalleryInfo;
                reject(new Error(`Could not load galleryinfo script for ${bookId}.`));
            };
            document.head.appendChild(script);
        });
    }

    function wait(ms) {
        return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    async function hydrateMissingMetadata(history) {
        const pendingRows = rows.filter(row => row.bookId && row.metadataStatus === 'pending');
        if (!pendingRows.length) {
            setStatus(`${rows.length} books`);
            return;
        }

        let fetchedCount = 0;
        for (const row of pendingRows) {
            setStatus(`Loading metadata ${fetchedCount + 1} / ${pendingRows.length}`);
            try {
                const galleryInfo = await loadGalleryInfoScript(row.bookId);
                const metadata = metadataFromGalleryInfo(galleryInfo, row.title);
                const previousEntry = history[row.key] && typeof history[row.key] === 'object' ? history[row.key] : {};

                Object.assign(row, metadata, { metadataStatus: 'loaded' });
                history[row.key] = {
                    ...previousEntry,
                    bookId: row.bookId,
                    title: row.title,
                    group: row.group,
                    author: row.author,
                    url: row.url,
                    metadataHydrated: true
                };
                fetchedCount += 1;
                saveJsonStorage(downloadHistoryKey, history);
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
        } else if (event.key === 'v') {
            if (openSelectedRow()) event.preventDefault();
        }
    }

    function init() {
        const history = loadJsonStorage(downloadHistoryKey, {});

        rows = createRowsFromHistory(history);
        if (!rows.length) {
            createEmptyPage();
            return;
        }

        createPage();
        window.addEventListener('keydown', handleKeydown, true);
        render();
        setStatus(`${rows.length} books`);
        hydrateMissingMetadata(history).catch(error => {
            console.error(error);
            setStatus(`${rows.length} books`);
        });
    }

    init();
})();
