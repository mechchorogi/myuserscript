// ==UserScript==
// @name         Hitomi::Tweak
// @namespace    http://hitomi.la/
// @version      1.14.0
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
// - Download books immediately and keep a unified history, with up to four list downloads at once.
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
    const unifiedDownloadsKey = 'hitomi-tweak-downloads';
    const unifiedDownloadsLockName = 'hitomi-tweak-downloads-lock';
    const foldedBookIdsKey = 'hitomi-tweak-folded-book-ids';
    const nameMapKey = 'hitomi-tweak-name-map';
    const nameMapLockName = 'hitomi-tweak-name-map-lock';
    const favoritesKey = 'hitomi-tweak-favorites';
    const favoritesLockName = 'hitomi-tweak-favorites-lock';
    const favoritesWatchKey = 'hitomi-tweak-favorites-watch';
    const favoritesWatchLockName = 'hitomi-tweak-favorites-watch-lock';
    const nameMapPagePath = '/hitomi-tweak-name-map.html';
    const favoritesPagePath = '/hitomi-tweak-favorites.html';
    const downloadPagePath = '/hitomi-tweak-download.html';
    const preferredLanguageKey = 'hitomi-tweak-preferred-language';
    const closeBookPageAfterDownloadKey = 'hitomi-tweak-close-book-page-after-download';
    const pageCountCacheKey = 'hitomi-tweak-page-count-cache';
    const pageCountCacheMaxEntries = 3000;
    const pageCountFetchConcurrency = 1;
    const pageCountFetchTimeoutMs = 10000;
    const listPageCountBadgesEnabledKey = 'hitomi-tweak-list-page-count-badges-enabled';
    const preferredLanguageOptions = [
        ['off', 'Off'],
        ['japanese', 'Japanese'],
        ['english', 'English'],
        ['chinese', 'Chinese'],
        ['korean', 'Korean'],
        ['all', 'All']
    ];
    const maxListDownloadCount = 4;
    const downloadPageQueueRefreshInterval = 2500;
    const downloadProgressStackClassName = 'hitomi-tweak-download-progress-stack';
    const downloadProgressClassName = 'hitomi-tweak-download-progress';
    const bookDownloadProgressClassName = 'hitomi-tweak-book-download-progress';
    const bookDownloadDoneClassName = 'hitomi-tweak-book-download-done';
    const bookDownloadCanceledClassName = 'hitomi-tweak-book-download-canceled';
    const bookDownloadErrorClassName = 'hitomi-tweak-book-download-error';
    const bookDownloadProgressLabelClassName = 'hitomi-tweak-book-download-progress-label';
    const bookPageProgressLabelClassName = 'hitomi-tweak-book-page-progress-label';
    const downloadedBookHeadingClassName = 'hitomi-tweak-downloaded-book-heading';
    const pageCountBadgeClassName = 'hitomi-tweak-page-count-badge';
    const downloadCanceledErrorName = 'HitomiTweakDownloadCanceled';
    const downloadAnimeNotSupportedErrorName = 'HitomiTweakDownloadAnimeNotSupported';
    const focusedBookClassName = 'hitomi-tweak-focused-book';
    const helpOverlayClassName = 'hitomi-tweak-help-overlay';
    const helpOverlayHiddenClassName = 'hitomi-tweak-help-overlay-hidden';
    const shakeBlockedClassName = 'hitomi-tweak-shake-blocked';
    const blocklistModeActiveClassName = 'hitomi-tweak-blocklist-mode-active';
    const filterPanelId = 'hitomi-tweak-filter-panel';
    const filterBookMap = new WeakMap();
    // Keep the help overlay generated from the same source as key handling so the
    // displayed shortcuts do not drift from the actual behavior.
    const keyboardShortcuts = [
        ['/', 'Toggle this help'],
        ['a', 'Open author link'],
        ['s', 'Favorite all authors of focused book'],
        ['b', 'Toggle blocklist mode'],
        ['d', 'Download current book (up to 4 on list pages)'],
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
    let pendingListDownloads = [];
    let galleryInfoLoadQueue = Promise.resolve();
    let listDownloadNotice = null;
    let listDownloadProgressStack = null;
    let nameMap = { version: 1, group: {}, author: {}, series: {} };
    let nameMapWriteQueue = Promise.resolve();
    let favorites = { version: 1, author: {}, group: {}, tag: {} };
    let favoritesWriteQueue = Promise.resolve();
    let favoritesWatch = { version: 1, author: {}, group: {}, tag: {} };
    let favoritesWatchWriteQueue = Promise.resolve();
    // Map insertion order is the eviction order; numeric-looking object keys would
    // be reordered and could not preserve this lightweight LRU behavior.
    let pageCountCache = new Map();
    let pageCountCacheSaveTimer = null;
    let activePageCountFetches = 0;
    let pendingPageCountFetchQueue = [];
    let pageCountFetchTargets = new Map();
    let isListPageCountBadgesEnabled = true;
    let titleBeforeListDownloads = null;
    let titleBeforeBookPageDownloadTitle = null;
    let unifiedDownloadsWriteQueue = Promise.resolve();

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

    function isFavoritesPage() {
        return location.pathname === favoritesPagePath;
    }

    function isAllArtistsPage() {
        return /^\/allartists-/.test(location.pathname);
    }

    function installDownloadNavLinkStyle() {
        const styleId = 'hitomi-tweak-download-nav-link-style';
        if (document.getElementById(styleId)) return;

        // The navbar is a fixed max-width row that already fits logo + nav + search
        // box tightly. Shrinking only our added item does not free enough width to
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

    function installConsolidatedNavMenu() {
        const navList = document.querySelector('.navbar nav ul');
        if (!navList || document.getElementById('hitomi-tweak-more-nav')) return;

        const targetItems = [...new Set([
            navList.querySelector('a[href^="/alltags-"]')?.closest('li'),
            navList.querySelector('a[href^="/allseries-"]')?.closest('li'),
            navList.querySelector('a[href^="/allcharacters-"]')?.closest('li')
        ].filter(item => item?.parentElement === navList))];
        if (!targetItems.length) return;

        const moreItem = document.createElement('li');
        const trigger = document.createElement('a');
        const languageArrow = document.querySelector('#lang > a img[src*="down-arrow.png"]');
        const arrow = languageArrow?.cloneNode(false) || document.createElement('img');
        const dropdown = document.createElement('div');
        const dropdownList = document.createElement('ul');

        moreItem.id = 'hitomi-tweak-more-nav';
        arrow.src = '//ltn.gold-usergeneratedcontent.net/down-arrow.png';
        arrow.alt = '';
        trigger.append('MORE ', arrow);
        dropdown.id = 'hitomi-tweak-more-nav-drop';
        dropdown.appendChild(dropdownList);
        moreItem.append(trigger, dropdown);

        // Insert the container before moving the original nodes so ARTISTS and the
        // site's language menu retain their existing relative positions.
        navList.insertBefore(moreItem, targetItems[0]);
        targetItems.forEach(item => dropdownList.appendChild(item));
    }

    function installDownloadNavLink() {
        // The LANGUAGE dropdown is managed differently across page types, so it
        // cannot be reused reliably. Add an independent download navigation item.
        const navList = document.querySelector('.navbar nav ul');
        if (!navList || navList.querySelector('.hitomi-tweak-download-nav-link')) return;

        installDownloadNavLinkStyle();

        const li = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'hitomi-tweak-download-nav-link';
        link.href = new URL(downloadPagePath, location.origin).href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'DOWNLOADS';
        li.appendChild(link);
        navList.appendChild(li);
    }

    function installFavoritesNavLink() {
        const navList = document.querySelector('.navbar nav ul');
        if (!navList || navList.querySelector('.hitomi-tweak-favorites-nav-link')) return;

        installDownloadNavLinkStyle();

        const li = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'hitomi-tweak-favorites-nav-link';
        link.href = new URL(favoritesPagePath, location.origin).href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'FAVORITES';
        li.appendChild(link);
        navList.appendChild(li);
    }

    function installNameMapNavLink() {
        const navList = document.querySelector('.navbar nav ul');
        if (!navList || navList.querySelector('.hitomi-tweak-name-map-nav-link')) return;

        installDownloadNavLinkStyle();

        const li = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'hitomi-tweak-name-map-nav-link';
        link.href = new URL(nameMapPagePath, location.origin).href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'NAME-MAP';
        li.appendChild(link);
        navList.appendChild(li);
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

    async function withNameMapLock(task) {
        if (navigator.locks?.request) {
            return navigator.locks.request(nameMapLockName, async () => task());
        }

        // Keep name-map writes ordered in this tab when Web Locks are unavailable.
        const next = nameMapWriteQueue.then(task, task);
        nameMapWriteQueue = next.catch(() => {});
        return next;
    }

    async function updateNameMap(mutator) {
        return withNameMapLock(async () => {
            const fresh = normalizeNameMap(await GM.getValue(nameMapKey, loadLocalNameMap()));
            const before = JSON.stringify(fresh);
            const result = await mutator(fresh);

            if (JSON.stringify(fresh) !== before) {
                await saveNameMap(fresh);
            }
            return result;
        });
    }

    function normalizeFavorites(input) {
        if (!isPlainObject(input) || input.version !== 1 || !isPlainObject(input.author) || !isPlainObject(input.group)) {
            throw new Error('Invalid favorites format');
        }

        const normalized = { version: 1, author: {}, group: {}, tag: {} };
        for (const kind of ['author', 'group', 'tag']) {
            const source = isPlainObject(input[kind]) ? input[kind] : {};
            for (const [key, value] of Object.entries(source)) {
                const normalizedKey = normalizeNameMapKey(key);
                // Favorites are boolean flags; discard malformed persisted values.
                if (normalizedKey && value === true) normalized[kind][normalizedKey] = true;
            }
        }
        return normalized;
    }

    function loadLocalFavorites() {
        try {
            return normalizeFavorites(JSON.parse(localStorage.getItem(favoritesKey) || 'null'));
        } catch (e) {
            return { version: 1, author: {}, group: {}, tag: {} };
        }
    }

    function saveLocalFavorites(map) {
        try {
            localStorage.setItem(favoritesKey, JSON.stringify(map));
        } catch (e) {
            // Favorites mirroring is best-effort; GM storage remains the canonical copy.
        }
    }

    async function loadFavorites() {
        const localMap = loadLocalFavorites();
        try {
            favorites = normalizeFavorites(await GM.getValue(favoritesKey, localMap));
        } catch (e) {
            favorites = localMap;
        }
        saveLocalFavorites(favorites);
        return favorites;
    }

    async function saveFavorites(map) {
        favorites = normalizeFavorites(map);
        saveLocalFavorites(favorites);
        await GM.setValue(favoritesKey, favorites);
    }

    async function withFavoritesLock(task) {
        if (navigator.locks?.request) {
            return navigator.locks.request(favoritesLockName, async () => task());
        }

        // Keep favorite writes ordered in this tab when Web Locks are unavailable.
        const next = favoritesWriteQueue.then(task, task);
        favoritesWriteQueue = next.catch(() => {});
        return next;
    }

    async function updateFavorites(mutator) {
        return withFavoritesLock(async () => {
            const fresh = normalizeFavorites(await GM.getValue(favoritesKey, loadLocalFavorites()));
            const before = JSON.stringify(fresh);
            const result = await mutator(fresh);

            if (JSON.stringify(fresh) !== before) {
                await saveFavorites(fresh);
            }
            return result;
        });
    }

    function isFavorite(kind, romaji) {
        return favorites[kind]?.[romaji] === true;
    }

    function normalizeFavoritesWatch(input) {
        if (!isPlainObject(input) || input.version !== 1 || !isPlainObject(input.author) || !isPlainObject(input.group)) {
            throw new Error('Invalid favorites watch format');
        }

        const normalized = { version: 1, author: {}, group: {}, tag: {} };
        for (const kind of ['author', 'group', 'tag']) {
            const source = isPlainObject(input[kind]) ? input[kind] : {};
            for (const [key, value] of Object.entries(source)) {
                const normalizedKey = normalizeNameMapKey(key);
                if (normalizedKey && Number.isInteger(value) && value > 0) normalized[kind][normalizedKey] = value;
            }
        }
        return normalized;
    }

    function loadLocalFavoritesWatch() {
        try {
            return normalizeFavoritesWatch(JSON.parse(localStorage.getItem(favoritesWatchKey) || 'null'));
        } catch (e) {
            return { version: 1, author: {}, group: {}, tag: {} };
        }
    }

    function saveLocalFavoritesWatch(map) {
        try {
            localStorage.setItem(favoritesWatchKey, JSON.stringify(map));
        } catch (e) {
            // Watch-state mirroring is best-effort; GM storage remains canonical.
        }
    }

    async function loadFavoritesWatch() {
        const localMap = loadLocalFavoritesWatch();
        try {
            favoritesWatch = normalizeFavoritesWatch(await GM.getValue(favoritesWatchKey, localMap));
        } catch (e) {
            favoritesWatch = localMap;
        }
        saveLocalFavoritesWatch(favoritesWatch);
        return favoritesWatch;
    }

    async function saveFavoritesWatch(map) {
        favoritesWatch = normalizeFavoritesWatch(map);
        saveLocalFavoritesWatch(favoritesWatch);
        await GM.setValue(favoritesWatchKey, favoritesWatch);
    }

    async function withFavoritesWatchLock(task) {
        if (navigator.locks?.request) {
            return navigator.locks.request(favoritesWatchLockName, async () => task());
        }

        // Keep watch-state writes ordered in this tab when Web Locks are unavailable.
        const next = favoritesWatchWriteQueue.then(task, task);
        favoritesWatchWriteQueue = next.catch(() => {});
        return next;
    }

    async function updateFavoritesWatch(mutator) {
        return withFavoritesWatchLock(async () => {
            const fresh = normalizeFavoritesWatch(await GM.getValue(favoritesWatchKey, loadLocalFavoritesWatch()));
            const before = JSON.stringify(fresh);
            const result = await mutator(fresh);

            if (JSON.stringify(fresh) !== before) {
                await saveFavoritesWatch(fresh);
            }
            return result;
        });
    }

    function getLastSeenGalleryId(kind, romaji) {
        return favoritesWatch[kind]?.[romaji] ?? null;
    }

    async function fetchLatestGalleryId(kind, romaji) {
        const area = kind === 'author' ? 'artist' : kind === 'tag' ? 'tag' : 'group';
        const language = await loadPreferredLanguage();
        const languageSegment = language === 'off' ? 'all' : language;
        const url = `https://ltn.gold-usergeneratedcontent.net/${area}/${encodeURIComponent(romaji)}-${languageSegment}.nozomi`;
        try {
            const response = await fetch(url, { headers: { Range: 'bytes=0-3' } });
            if (!response.ok) return null;
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength < 4) return null;
            return new DataView(buffer).getInt32(0, false);
        } catch (e) {
            return null;
        }
    }

    function resolveJapaneseName(name, kind) {
        const normalized = normalizeNameMapKey(name);
        return (kind === 'group' || kind === 'author' || kind === 'series') && normalized ? nameMap[kind]?.[normalized] || name : name;
    }

    function getNameMapEntries(map = nameMap) {
        return ['group', 'author', 'series']
            .flatMap(kind => Object.entries(map[kind] || {}).map(([romaji, japanese]) => ({ kind, romaji, japanese })))
            .sort((a, b) => {
                const aUnfilled = a.japanese === '';
                const bUnfilled = b.japanese === '';
                if (aUnfilled !== bUnfilled) return aUnfilled ? -1 : 1;
                return a.romaji.localeCompare(b.romaji, undefined, { numeric: true, sensitivity: 'base' }) || a.kind.localeCompare(b.kind);
            });
    }

    function countNameMapEntries(map = nameMap) {
        return getNameMapEntries(map).length;
    }

    function getNameMapEntryStatus(map = nameMap) {
        const entries = getNameMapEntries(map);
        return `${entries.length} entries, ${entries.filter(entry => !entry.japanese).length} unfilled`;
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

    function normalizePageCountCache(input) {
        const entries = Array.isArray(input) ? input : [];
        const map = new Map();
        for (const entry of entries) {
            const [id, count] = Array.isArray(entry) ? entry : [];
            const normalizedId = String(id || '').trim();
            if (normalizedId && Number.isInteger(count) && count > 0) map.set(normalizedId, count);
        }
        while (map.size > pageCountCacheMaxEntries) map.delete(map.keys().next().value);
        return map;
    }

    async function loadPageCountCache() {
        pageCountCache = normalizePageCountCache(await GM.getValue(pageCountCacheKey, []));
    }

    function touchPageCountCache(galleryId, pageCount) {
        pageCountCache.delete(galleryId);
        pageCountCache.set(galleryId, pageCount);
        if (pageCountCache.size > pageCountCacheMaxEntries) pageCountCache.delete(pageCountCache.keys().next().value);
        schedulePageCountCacheSave();
    }

    function schedulePageCountCacheSave() {
        clearTimeout(pageCountCacheSaveTimer);
        pageCountCacheSaveTimer = window.setTimeout(() => {
            GM.setValue(pageCountCacheKey, Array.from(pageCountCache.entries())).catch(() => {});
        }, 1000);
    }

    async function fetchGalleryPageCount(galleryId) {
        const url = `https://ltn.gold-usergeneratedcontent.net/galleries/${galleryId}.js`;
        const response = await fetch(url, { signal: AbortSignal.timeout(pageCountFetchTimeoutMs) });
        if (!response.ok) throw new Error(`Unexpected status ${response.status} for gallery ${galleryId}.`);
        const text = await response.text();
        const galleryInfo = JSON.parse(text.replace(/^\s*var\s+galleryinfo\s*=\s*/, ''));
        if (!galleryInfo?.id || String(galleryInfo.id) !== String(galleryId) || !Array.isArray(galleryInfo.files)) {
            throw new Error(`Could not verify galleryinfo for ${galleryId}.`);
        }
        return galleryInfo.files.length;
    }

    function enqueuePageCountFetch(card) {
        const galleryId = card.dataset.hitomiPageCountGalleryId;
        if (!galleryId) return;
        const existingTargets = pageCountFetchTargets.get(galleryId);
        if (existingTargets) {
            existingTargets.add(card);
            return;
        }
        pageCountFetchTargets.set(galleryId, new Set([card]));
        pendingPageCountFetchQueue.push(galleryId);
        pumpPageCountFetchQueue();
    }

    function pumpPageCountFetchQueue() {
        while (activePageCountFetches < pageCountFetchConcurrency && pendingPageCountFetchQueue.length) {
            runPageCountFetch(pendingPageCountFetchQueue.shift());
        }
    }

    async function runPageCountFetch(galleryId) {
        activePageCountFetches++;
        try {
            const pageCount = await fetchGalleryPageCount(galleryId);
            touchPageCountCache(galleryId, pageCount);
            for (const card of pageCountFetchTargets.get(galleryId) || []) {
                if (!card.isConnected) continue;
                const heading = getListCardHeading(card);
                if (heading) renderGalleryCountBadge(heading, pageCount);
            }
        } catch (e) {
            // Fetch failures stay silent and are not retried during this page session.
        } finally {
            activePageCountFetches--;
            pageCountFetchTargets.delete(galleryId);
            pumpPageCountFetchQueue();
        }
    }

    function getListCardHeading(card) {
        return card.querySelector(':scope > h1.lillie, :scope > h1');
    }

    function annotatePageCountBadges(root) {
        if (!isListPageCountBadgesEnabled || !root) return;
        for (const card of root.querySelectorAll(':scope > div')) {
            if (card.dataset.hitomiPageCountGalleryId) continue;

            const heading = getListCardHeading(card);
            if (!heading) continue;

            const galleryId = getBookIdFromElement(card);
            if (!galleryId) continue;

            card.dataset.hitomiPageCountGalleryId = galleryId;

            const cachedCount = pageCountCache.get(galleryId);
            if (cachedCount != null) {
                card.dataset.hitomiPageCountHandled = '1';
                renderGalleryCountBadge(heading, cachedCount);
            }
        }
    }

    function triggerPageCountFetchForFocusedBook(book) {
        if (!isListPageCountBadgesEnabled || !book) return;
        if (book.classList.contains('hitomi-folded')) return;
        if (book.dataset.hitomiPageCountHandled) return;

        const galleryId = book.dataset.hitomiPageCountGalleryId;
        if (!galleryId) return;

        const heading = getListCardHeading(book);
        if (!heading) return;

        book.dataset.hitomiPageCountHandled = '1';
        enqueuePageCountFetch(book);
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
            /* The .container ancestor clips with overflow:hidden, which disables
               position:sticky, so relax it to keep the header pinned on scroll. */
            div.container {
                overflow: visible;
            }

            div.navbar {
                position: sticky;
                top: 0;
                z-index: 1000;
            }

            div.top-content {
                position: sticky;
                top: 40px;
                z-index: 999;
            }

            #hitomi-page-progress-bar {
                cursor: pointer;
            }

            #hitomi-page-progress-bar:hover #hitomi-page-progress-track {
                box-shadow: 0 0 4px limegreen;
                transition: box-shadow 120ms ease;
            }

            #hitomi-page-progress-tooltip {
                position: absolute;
                bottom: calc(100% + 4px);
                padding: 2px 6px;
                border-radius: 3px;
                background: rgba(0, 0, 0, 0.8);
                color: #fff;
                font-size: 11px;
                pointer-events: none;
                white-space: nowrap;
                transform: translateX(-50%);
            }

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

            .hitomi-name-map-edit-button {
                margin-left: 0.3em;
                padding: 0 0.2em;
                border: 0;
                background: transparent;
                color: inherit;
                font-size: 0.75em;
                line-height: 1.2;
                cursor: pointer;
                vertical-align: baseline;
            }

            .hitomi-name-map-inline-input {
                box-sizing: border-box;
                width: 8em;
                height: 1.5em;
                margin-left: 0.3em;
                padding: 0 0.2em;
                font: inherit;
                font-size: 0.75em;
                line-height: 1.2;
                vertical-align: baseline;
            }

            .hitomi-name-map-resolved {
                text-transform: none !important;
            }

            .hitomi-tweak-favorite-star {
                margin-right: 0.3em;
                padding: 0;
                border: 0;
                background: transparent;
                color: inherit;
                cursor: pointer;
                vertical-align: baseline;
                line-height: 1;
            }

            .hitomi-tweak-favorite-star svg {
                display: block;
            }

            .hitomi-tweak-favorite-star svg path {
                fill: none;
                stroke: #888;
                stroke-width: 1.5;
            }

            .hitomi-tweak-favorite-star.is-favorited svg path {
                fill: #ffaa00;
                stroke: #4a3200;
                stroke-width: 2;
            }

            #hitomi-tweak-more-nav {
                position: relative;
            }

            #hitomi-tweak-more-nav-drop {
                display: none;
                position: absolute;
                margin: 0;
                padding: 0 15px;
                z-index: 99999;
                background-color: #29313d;
                left: 0;
                min-width: 100%;
                max-height: 500px;
                overflow-y: auto;
                white-space: nowrap;
            }

            #hitomi-tweak-more-nav:hover #hitomi-tweak-more-nav-drop {
                display: block;
            }

            #hitomi-tweak-more-nav-drop ul {
                list-style: none;
                display: block;
                margin: 0;
                padding: 10px 0;
            }

            #hitomi-tweak-more-nav-drop li {
                color: #aaaaaa;
                display: block;
                position: relative;
                margin-bottom: 10px;
            }

            #hitomi-tweak-more-nav-drop li:last-child {
                margin-bottom: 0;
            }

            #hitomi-tweak-more-nav-drop a {
                padding: 0;
                color: inherit;
                text-decoration: none;
                text-transform: uppercase;
                font-weight: normal;
                display: inline-block;
            }

            #hitomi-tweak-more-nav-drop a:hover {
                color: #fff;
                font-weight: bold;
            }

            @keyframes hitomi-tweak-shake-blocked {
                0%, 100% { transform: translateX(0); }
                15%, 45%, 75% { transform: translateX(-7px); }
                30%, 60%, 90% { transform: translateX(7px); }
            }

            .${shakeBlockedClassName} {
                animation: hitomi-tweak-shake-blocked 0.4s ease;
            }

            body.${blocklistModeActiveClassName} {
                background: #ffd9d9 !important;
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

            div.gallery-content > div.${focusedBookClassName},
            div.gallery.${focusedBookClassName} {
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

            h1#gallery-brand,
            h1.lillie {
                position: relative;
                padding-right: 48px;
            }

            .${pageCountBadgeClassName} {
                position: absolute;
                top: 50%;
                right: 8px;
                transform: translateY(-50%);
                padding: 2px 6px;
                background: #999999;
                color: #fff;
                border-radius: 4px;
                font-size: 12px;
                font-weight: bold;
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

        isBlocked() {
            // Read the blacklist highlight from the DOM instead of a cached flag: Hitomi
            // recycles card elements on lazy-load, so a fresh FilterBook instance can miss
            // the last setFiltered() while the .hitomi-match class stays on the element.
            return this.#isFolded() && Boolean(this.elem.querySelector('.hitomi-match'));
        }

        shake() {
            this.elem.classList.remove(shakeBlockedClassName);
            // Force a reflow so repeated v presses restart the animation.
            void this.elem.offsetWidth;
            this.elem.classList.add(shakeBlockedClassName);
            this.elem.addEventListener('animationend', () => this.elem.classList.remove(shakeBlockedClassName), { once: true });
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
            const values = Array.from(this.elem.querySelectorAll(selector), item => {
                const link = item.querySelector('a');
                return link?.dataset.hitomiNameMapOriginal || item.textContent;
            });
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
                const text = a.dataset.hitomiNameMapOriginal || a.textContent.trim();
                if (lowerMatchedValues.includes(text.toLowerCase())) {
                    a.classList.add('hitomi-match');
                    a.closest('li')?.classList.add('hitomi-match');
                }
            }
        }

        set folded(state) {
            if (state) {
                this.fold();
            } else {
                const wasFolded = this.#isFolded();
                this.elem.classList.remove('hitomi-folded');
                this.elem.querySelectorAll(':scope > *:not(h1.lillie):not(.hitomi-toggle)').forEach(c => {
                    c.style.display = '';
                });
                if (wasFolded) triggerPageCountFetchForFocusedBook(this.elem);
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

    function highlightBookPageBlacklistMatches(blackList) {
        // The main book page's own metadata panel isn't a gallery-content card, so
        // filter()/clearFilter() never touch it; strike through matches here instead.
        const gallery = document.querySelector('div.gallery');
        if (!gallery) return;

        gallery.querySelectorAll('.hitomi-match').forEach(el => el.classList.remove('hitomi-match'));

        gallery.querySelectorAll('a').forEach(link => {
            const key = getBlacklistKeyFromLink(link);
            if (!key || key === 'title') return;

            const value = (link.dataset.hitomiNameMapOriginal || link.textContent.trim()).toLowerCase();
            if (blackList[key].some(x => x.toLowerCase() === value)) {
                link.classList.add('hitomi-match');
                link.closest('li')?.classList.add('hitomi-match');
            }
        });

        const titleHeading = gallery.querySelector('h1#gallery-brand');
        const titleText = titleHeading?.querySelector('a')?.textContent.trim();
        if (titleHeading && titleText) {
            const titleMatched = blackList.title.some(x => {
                try {
                    return new RegExp(x, 'i').test(titleText);
                } catch (e) {
                    return false;
                }
            });
            titleHeading.classList.toggle('hitomi-match', titleMatched);
        }
    }

    function clearBookPageBlacklistHighlights() {
        document.querySelector('div.gallery')?.querySelectorAll('.hitomi-match').forEach(el => {
            el.classList.remove('hitomi-match');
        });
    }

    function refreshFilter(blackList) {
        clearFilter();
        filter(blackList);
        // clearFilter()/filter() only know about foldedBookIds and blacklist matches, so a
        // book folded because it was already downloaded (a separate, unrecorded fold) would
        // otherwise be left open here. Reapply that fold too.
        refreshDownloadIndicators().catch(() => {});
        if (filterEnabled) {
            highlightBookPageBlacklistMatches(blackList);
        } else {
            clearBookPageBlacklistHighlights();
        }
    }

    function getBlacklistKeyFromLink(link) {
        // Both list cards and book pages link fields to the same category pages, so
        // classify by href instead of page-specific markup (list-card classes like
        // div.artist-list don't exist on book pages, and vice versa).
        const href = link.getAttribute('href') || '';
        const hrefPatterns = [
            [/^\/artist\//, 'author'],
            [/^\/tag\//, 'tag'],
            [/^\/series\//, 'series'],
            [/^\/type\//, 'type'],
            [/^\/index-/, 'language']
        ];
        for (const [pattern, key] of hrefPatterns) {
            if (pattern.test(href)) return key;
        }

        // Title has no dedicated category URL, so match it by the heading classes
        // list cards (h1.lillie) and book pages (h1#gallery-brand) each use.
        if (link.matches('h1.lillie a, h1#gallery-brand a')) return 'title';

        return null;
    }

    function getNameMapKindFromLink(link) {
        const href = link.getAttribute('href') || '';
        const hrefPatterns = [[/^\/artist\//, 'author'], [/^\/group\//, 'group'], [/^\/series\//, 'series']];
        for (const [pattern, kind] of hrefPatterns) {
            if (pattern.test(href)) return kind;
        }
        return null;
    }

    function getTagIdentifierFromLink(link) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/tag\/(.+)-all\.html$/);
        if (!match) return null;
        try {
            return decodeURIComponent(match[1]);
        } catch (e) {
            return match[1];
        }
    }

    function insertFavoriteStar(link, kind, romaji, label) {
        if (link.dataset.hitomiFavoriteAnnotated) return;
        const favoriteButton = document.createElement('button');
        favoriteButton.type = 'button';
        favoriteButton.className = 'hitomi-tweak-favorite-star';
        favoriteButton.title = `Toggle favorite for ${label}`;
        favoriteButton.setAttribute('aria-label', `Toggle favorite for ${label}`);
        favoriteButton.dataset.hitomiFavoriteKind = kind;
        favoriteButton.dataset.hitomiFavoriteRomaji = romaji;
        favoriteButton.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 .587l3.668 7.568L24 9.306l-6.064 5.828 1.48 8.279L12 19.771l-7.416 3.642 1.48-8.279L0 9.306l8.332-1.151Z"/></svg>';
        favoriteButton.classList.toggle('is-favorited', isFavorite(kind, romaji));
        link.dataset.hitomiFavoriteAnnotated = '1';
        link.insertAdjacentElement('beforebegin', favoriteButton);
    }

    function annotateNameMapLinks(root) {
        // Unlike blacklist matching/highlighting, this only rewrites a link's own label
        // based on its own href+text, so it is safe to also annotate the "related
        // galleries" widget on book pages (other books' links, not excluded here).
        if (!root) return;
        root.querySelectorAll('a[href]').forEach(link => {
            const kind = getNameMapKindFromLink(link);

            if (!kind) {
                if (getBlacklistKeyFromLink(link) === 'tag') {
                    const tagIdentifier = getTagIdentifierFromLink(link);
                    if (tagIdentifier) insertFavoriteStar(link, 'tag', normalizeNameMapKey(tagIdentifier), tagIdentifier);
                }
                return;
            }

            const romajiText = link.dataset.hitomiNameMapOriginal || normalizeMetadataText(link.textContent);
            const romaji = normalizeNameMapKey(romajiText);
            if (kind === 'author' || kind === 'group') {
                insertFavoriteStar(link, kind, romaji, romajiText);
            }

            if (link.dataset.hitomiNameMapAnnotated) return;

            const japanese = nameMap[kind]?.[romaji];

            link.dataset.hitomiNameMapAnnotated = '1';
            // Preserve the canonical romaji for metadata readers after changing the visible label.
            link.dataset.hitomiNameMapOriginal = romajiText;
            if (!japanese) {
                if (kind !== 'author' && kind !== 'group' && kind !== 'series') return;

                const editButton = document.createElement('button');
                editButton.type = 'button';
                editButton.className = 'hitomi-name-map-edit-button';
                editButton.textContent = '✎';
                editButton.title = 'Add Japanese name';
                editButton.setAttribute('aria-label', `Add Japanese name for ${romajiText}`);
                editButton.dataset.hitomiNameMapKind = kind;
                editButton.dataset.hitomiNameMapRomaji = romaji;
                link.insertAdjacentElement('afterend', editButton);
                return;
            }

            link.textContent = japanese;
            if (kind === 'author' || kind === 'group' || kind === 'series') link.classList.add('hitomi-name-map-resolved');
        });
    }

    function applyInlineNameMapUpdate(kind, romaji, japanese) {
        // Compare dataset values in JavaScript because names may contain characters
        // that are unsafe to interpolate into a CSS attribute selector.
        document.querySelectorAll('button[data-hitomi-name-map-kind]').forEach(button => {
            if (button.dataset.hitomiNameMapKind !== kind || button.dataset.hitomiNameMapRomaji !== romaji) return;

            const input = button.previousElementSibling?.matches('.hitomi-name-map-inline-input')
                ? button.previousElementSibling
                : null;
            const link = (input?.previousElementSibling || button.previousElementSibling);
            if (link?.matches('a[href]')) {
                link.textContent = japanese;
                link.classList.add('hitomi-name-map-resolved');
            }
            input?.remove();
            button.remove();
        });
    }

    function installInlineNameMapEditor() {
        document.body.addEventListener('click', event => {
            const button = event.target.closest('button[data-hitomi-name-map-kind]');
            if (!button) return;

            event.preventDefault();
            event.stopPropagation();

            const kind = button.dataset.hitomiNameMapKind;
            const romaji = button.dataset.hitomiNameMapRomaji;
            if ((kind !== 'author' && kind !== 'group' && kind !== 'series') || !romaji || button.hidden) return;

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'hitomi-name-map-inline-input';
            input.setAttribute('aria-label', `Japanese name for ${romaji}`);
            button.insertAdjacentElement('beforebegin', input);
            button.hidden = true;
            input.focus();

            let canceled = false;
            input.addEventListener('keydown', keyEvent => {
                if (keyEvent.isComposing) return;
                if (keyEvent.key === 'Enter') {
                    keyEvent.preventDefault();
                    input.blur();
                } else if (keyEvent.key === 'Escape') {
                    keyEvent.preventDefault();
                    canceled = true;
                    input.blur();
                }
            });

            input.addEventListener('blur', async () => {
                const japanese = input.value.trim();
                if (canceled || !japanese) {
                    input.remove();
                    button.hidden = false;
                    return;
                }

                input.disabled = true;
                try {
                    await updateNameMap(map => {
                        map[kind][romaji] = japanese;
                        return true;
                    });
                    applyInlineNameMapUpdate(kind, romaji, japanese);
                } catch (error) {
                    input.remove();
                    button.hidden = false;
                    console.error('Failed to update name map.', error);
                }
            }, { once: true });
        });
    }

    function installFavoriteStars() {
        document.body.addEventListener('click', async event => {
            const button = event.target.closest('button[data-hitomi-favorite-kind]');
            if (!button) return;

            event.preventDefault();
            event.stopPropagation();

            const kind = button.dataset.hitomiFavoriteKind;
            const romaji = button.dataset.hitomiFavoriteRomaji;
            if ((kind !== 'author' && kind !== 'group' && kind !== 'tag') || !romaji) return;

            try {
                const favorited = await updateFavorites(map => {
                    const nextFavorited = map[kind][romaji] !== true;
                    if (nextFavorited) {
                        map[kind][romaji] = true;
                    } else {
                        delete map[kind][romaji];
                    }
                    return nextFavorited;
                });

                if (favorited) {
                    fetchLatestGalleryId(kind, romaji).then(latestId => {
                        // The fetch is intentionally non-blocking; do not restore watch
                        // state if the favorite was removed while the request was pending.
                        if (!isFavorite(kind, romaji) || !Number.isInteger(latestId) || latestId <= 0) return;
                        return updateFavoritesWatch(map => {
                            map[kind][romaji] = latestId;
                            return true;
                        });
                    }).catch(() => {});
                } else {
                    updateFavoritesWatch(map => {
                        delete map[kind][romaji];
                        return true;
                    }).catch(() => {});
                }

                // Compare dataset values in JavaScript because names may contain
                // characters that are unsafe to interpolate into a CSS selector.
                document.querySelectorAll('button[data-hitomi-favorite-kind]').forEach(candidate => {
                    if (candidate.dataset.hitomiFavoriteKind !== kind
                        || candidate.dataset.hitomiFavoriteRomaji !== romaji) return;
                    candidate.classList.toggle('is-favorited', favorited);
                });
            } catch (error) {
                console.error('Failed to update favorites.', error);
            }
        });
    }

    function annotateAllArtistsPage(root) {
        // Unlike the list/book-page annotation, this page has no other context for the
        // name (just the bare romaji link followed by a "(count)" text node), so show
        // both: the Japanese name first, with the original romaji kept but shrunk.
        if (!root) return;
        root.querySelectorAll('a[href^="/artist/"]').forEach(link => {
            if (link.dataset.hitomiNameMapAnnotated) return;

            const romajiText = normalizeMetadataText(link.textContent);
            const romaji = normalizeNameMapKey(romajiText);
            const japanese = nameMap.author?.[romaji];

            link.dataset.hitomiNameMapAnnotated = '1';
            link.dataset.hitomiNameMapOriginal = romajiText;
            if (!japanese) return;

            const romajiSpan = document.createElement('span');
            romajiSpan.textContent = romajiText;
            romajiSpan.style.fontSize = '0.6em';

            link.textContent = '';
            link.append(`${japanese} `, romajiSpan);
        });
    }

    function annotateArtistPageHeading() {
        const heading = document.querySelector('h3#artistname');
        if (!heading || heading.dataset.hitomiNameMapAnnotated) return;

        const kind = location.pathname.startsWith('/artist/')
            ? 'author'
            : location.pathname.startsWith('/group/') ? 'group' : null;
        if (!kind) return;

        const romajiText = normalizeMetadataText(heading.textContent);
        const romaji = normalizeNameMapKey(romajiText);
        const japanese = nameMap[kind]?.[romaji];

        heading.dataset.hitomiNameMapAnnotated = '1';
        heading.dataset.hitomiNameMapOriginal = romajiText;
        if (!japanese) return;

        // Match the all-artists page format so the canonical romaji remains visible.
        const romajiSpan = document.createElement('span');
        romajiSpan.textContent = romajiText;
        romajiSpan.style.fontSize = '0.6em';

        heading.textContent = '';
        heading.append(`${japanese} `, romajiSpan);
    }

    async function blacklistClickHandler(e) {
        if (e.target.closest(`#${filterPanelId}`)) return;

        const link = e.target.closest('a');
        if (!link) return;

        // Suppress every link click while the mode is active, matching the existing
        // "clicking anywhere should not navigate away" behavior, even for links this
        // handler will not blacklist.
        e.preventDefault();
        e.stopPropagation();

        // Book pages embed other books' fields in a "related galleries" widget;
        // skip it so clicks only ever blacklist values from the book being viewed.
        if (e.target.closest('#related-content')) return;

        const key = getBlacklistKeyFromLink(link);
        if (!key) return;

        const value = link.dataset.hitomiNameMapOriginal || link.textContent.trim();
        const current = await GM.getValue(blacklistStorageKey(key), '');
        const lines = new Set(current.split('\n').map(l => l.trim()).filter(Boolean));
        lines.add(value);
        await GM.setValue(blacklistStorageKey(key), [...lines].join('\n'));

        const input = document.querySelector(`#blacklist-input-${key}`);
        if (input) input.value = [...lines].join('\n');

        const blackList = await loadBlacklist();
        refreshFilter(blackList);
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
        const pageCountBadgesToggleRow = document.createElement('div');
        const pageCountBadgesToggleLabel = document.createElement('label');
        const pageCountBadgesToggleCheckbox = document.createElement('input');
        const pageCountBadgesToggleSwitch = document.createElement('label');
        const pageCountBadgesToggleSlider = document.createElement('span');

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

        pageCountBadgesToggleLabel.textContent = 'Page count';
        pageCountBadgesToggleLabel.htmlFor = 'hitomi-tweak-page-count-badges-toggle';
        Object.assign(pageCountBadgesToggleLabel.style, {
            cursor: 'pointer',
            userSelect: 'none'
        });

        pageCountBadgesToggleCheckbox.id = pageCountBadgesToggleLabel.htmlFor;
        pageCountBadgesToggleCheckbox.className = 'hitomi-switch-input';
        pageCountBadgesToggleCheckbox.type = 'checkbox';
        pageCountBadgesToggleCheckbox.checked = isListPageCountBadgesEnabled;
        pageCountBadgesToggleCheckbox.setAttribute('aria-label', 'Page count badges enabled');
        pageCountBadgesToggleCheckbox.addEventListener('change', () => {
            isListPageCountBadgesEnabled = pageCountBadgesToggleCheckbox.checked;
            GM.setValue(listPageCountBadgesEnabledKey, isListPageCountBadgesEnabled).catch(() => {});
            if (isListPageCountBadgesEnabled) {
                document.querySelectorAll('div.gallery-content').forEach(gallery => annotatePageCountBadges(gallery));
            }
        });

        pageCountBadgesToggleSwitch.className = 'hitomi-switch';
        pageCountBadgesToggleSwitch.htmlFor = pageCountBadgesToggleCheckbox.id;
        pageCountBadgesToggleSlider.className = 'hitomi-switch-slider';
        pageCountBadgesToggleSwitch.append(pageCountBadgesToggleCheckbox, pageCountBadgesToggleSlider);

        Object.assign(pageCountBadgesToggleRow.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            fontWeight: 'bold',
            marginTop: '8px'
        });
        pageCountBadgesToggleRow.append(pageCountBadgesToggleLabel, pageCountBadgesToggleSwitch);
        form.insertBefore(pageCountBadgesToggleRow, blocklistHeading);

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
        nameMapEditLink.target = '_blank';
        nameMapEditLink.rel = 'noopener noreferrer';
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
            document.body.classList.toggle(blocklistModeActiveClassName, !active);
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
                annotateNameMapLinks(gallery);
                annotateArtistPageHeading();
                annotatePageCountBadges(gallery);
                refreshDownloadIndicators().catch(() => {});
            }
        });
        observer.observe(gallery, { childList: true });

        const hasContent = Array.from(gallery.children).some(c => c.id !== 'loader-content');
        if (hasContent) {
            filter(blackList);
            annotateNameMapLinks(gallery);
            annotateArtistPageHeading();
            annotatePageCountBadges(gallery);
            refreshDownloadIndicators().catch(() => {});
        }
    }

    async function waitForBookPageGallery() {
        // div.gallery itself, and even verified galleryinfo, can be present before the
        // site's own rendering finishes populating the actual author/group/series link
        // markup inside the container, so wait for at least one such link directly
        // rather than a proxy signal.
        for (let i = 0; i < 50; i++) {
            const gallery = document.querySelector('div.gallery');
            if (gallery && gallery.querySelector('a[href^="/artist/"], a[href^="/group/"], a[href^="/series/"]')) return true;
            await new Promise(resolve => window.setTimeout(resolve, 100));
        }
        return false;
    }

    async function installFilter() {
        await loadFoldedBookIds();
        isListPageCountBadgesEnabled = await GM.getValue(listPageCountBadgesEnabledKey, true);
        await loadPageCountCache();
        await createFilterUI();
        const blackList = await loadBlacklist();
        observeGallery(blackList);
        // observeGallery only paints once div.gallery-content (the related-galleries
        // widget) exists; a book page without related galleries never gets that far,
        // so highlight the book's own fields unconditionally here too.
        if (await waitForBookPageGallery()) {
            if (filterEnabled) highlightBookPageBlacklistMatches(blackList);
            annotateNameMapLinks(document.querySelector('div.gallery'));
            annotateArtistPageHeading();
        }
    }

    async function renderFavoritesPage() {
        await loadNameMap();
        await loadFavorites();
        await loadFavoritesWatch();

        document.title = 'Hitomi::Tweak Favorites';
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
            .hitomi-favorites-page {
                box-sizing: border-box;
                min-height: 100vh;
                padding: 24px;
            }
            .hitomi-favorites-page h1 {
                margin: 0 0 16px;
                font-size: 24px;
            }
            .hitomi-favorites-search {
                box-sizing: border-box;
                width: min(100%, 420px);
                margin-bottom: 16px;
                padding: 8px 10px;
                border: 1px solid #d0d7de;
                border-radius: 6px;
                font: inherit;
            }
            .hitomi-favorites-table-wrap {
                overflow-x: auto;
                border: 1px solid #d0d7de;
                border-radius: 6px;
                background: #fff;
            }
            .hitomi-favorites-table {
                width: 100%;
                border-collapse: collapse;
            }
            .hitomi-favorites-table th,
            .hitomi-favorites-table td {
                padding: 10px 12px;
                border-bottom: 1px solid #d8dee4;
                text-align: left;
                vertical-align: middle;
            }
            .hitomi-favorites-table th {
                background: #f6f8fa;
            }
            .hitomi-favorites-table tr:last-child td {
                border-bottom: 0;
            }
            .hitomi-favorites-table tr.hitomi-favorites-selected-row {
                background: #eef2ff;
            }
            .hitomi-favorites-table button {
                padding: 4px 8px;
                border: 1px solid #d0d7de;
                border-radius: 6px;
                background: #fff;
                color: #cf222e;
                cursor: pointer;
            }
            .hitomi-favorites-empty {
                margin: 16px 0 0;
                color: #57606a;
            }
            .hitomi-favorites-spinner {
                display: inline-block;
                width: 14px;
                height: 14px;
                border: 2px solid #d0d7de;
                border-top-color: #57606a;
                border-radius: 50%;
                animation: hitomi-favorites-spin 0.8s linear infinite;
            }
            @keyframes hitomi-favorites-spin {
                to { transform: rotate(360deg); }
            }
            .hitomi-favorites-new-badge {
                display: inline-block;
                padding: 2px 6px;
                background: #cf222e;
                color: #fff;
                border-radius: 4px;
                font-size: 12px;
                font-weight: bold;
            }
            .hitomi-favorites-uptodate {
                color: #57606a;
                font-size: 12px;
            }
        `;
        document.head.appendChild(style);

        const page = document.createElement('main');
        const title = document.createElement('h1');
        const searchInput = document.createElement('input');
        const tableWrap = document.createElement('div');
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        const tbody = document.createElement('tbody');
        const emptyMessage = document.createElement('p');

        page.className = 'hitomi-favorites-page';
        title.textContent = 'Favorites';
        searchInput.type = 'search';
        searchInput.className = 'hitomi-favorites-search';
        searchInput.placeholder = 'Search romaji or Japanese name';
        searchInput.setAttribute('aria-label', 'Search favorites');
        tableWrap.className = 'hitomi-favorites-table-wrap';
        table.className = 'hitomi-favorites-table';
        emptyMessage.className = 'hitomi-favorites-empty';

        for (const label of ['Kind', 'Name', 'Status', 'Link', 'Remove']) {
            const th = document.createElement('th');
            th.textContent = label;
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.append(thead, tbody);
        tableWrap.appendChild(table);
        page.append(title, searchInput, tableWrap, emptyMessage);
        document.body.appendChild(page);

        const latestGalleryResults = new Map();
        const visibleStatusCells = new Map();
        const selectedRowClassName = 'hitomi-favorites-selected-row';
        let selectedIndex = -1;

        function getFavoriteEntryKey(entry) {
            return JSON.stringify([entry.kind, entry.romaji]);
        }

        function renderStatus(statusTd, result) {
            statusTd.replaceChildren();
            if (!result || result.state === 'loading') {
                const spinner = document.createElement('span');
                spinner.className = 'hitomi-favorites-spinner';
                spinner.title = 'Checking for updates';
                spinner.setAttribute('aria-label', 'Checking for updates');
                statusTd.appendChild(spinner);
                return;
            }

            const status = document.createElement('span');
            if (result.latestId === null) {
                status.className = 'hitomi-favorites-uptodate';
                status.textContent = '?';
                status.title = 'Could not check for updates';
            } else if (result.lastSeenId === null) {
                status.className = 'hitomi-favorites-uptodate';
                status.textContent = '—';
                status.title = 'Open this favorite to start tracking updates';
            } else if (result.latestId > result.lastSeenId) {
                status.className = 'hitomi-favorites-new-badge';
                status.textContent = 'NEW';
            } else {
                status.className = 'hitomi-favorites-uptodate';
                status.textContent = 'Up to date';
            }
            statusTd.appendChild(status);
        }

        function refreshVisibleStatus(entry) {
            const key = getFavoriteEntryKey(entry);
            const statusTd = visibleStatusCells.get(key);
            if (statusTd) renderStatus(statusTd, latestGalleryResults.get(key));
        }

        function markFavoriteSeen(entry, entryKey) {
            const result = latestGalleryResults.get(entryKey);
            if (!Number.isInteger(result?.latestId) || result.latestId <= 0) return;

            updateFavoritesWatch(map => {
                map[entry.kind][entry.romaji] = result.latestId;
                return true;
            }).then(() => {
                result.lastSeenId = result.latestId;
                refreshVisibleStatus(entry);
            }).catch(error => console.error('Failed to update favorite watch state.', error));
        }

        function openFavoriteInBackground(entry) {
            const hitomiCategoryPath = entry.kind === 'author' ? 'artist' : entry.kind === 'tag' ? 'tag' : 'group';
            const url = `https://hitomi.la/${hitomiCategoryPath}/${encodeURIComponent(entry.romaji)}-all.html`;
            if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') {
                GM.openInTab(url, { active: false, insert: true, setParent: false });
            } else {
                const opened = window.open(url, '_blank', 'noopener,noreferrer');
                opened?.blur();
                window.focus();
            }
            markFavoriteSeen(entry, getFavoriteEntryKey(entry));
        }

        function getFavoriteEntries() {
            return ['author', 'group', 'tag']
                .flatMap(kind => Object.keys(favorites[kind] || {}).map(romaji => ({ kind, romaji })))
                .sort((a, b) => a.kind.localeCompare(b.kind)
                    || a.romaji.localeCompare(b.romaji, undefined, { numeric: true, sensitivity: 'base' }));
        }

        function getFilteredFavoriteEntries() {
            const allEntries = getFavoriteEntries();
            const query = searchInput.value.trim().toLowerCase();
            return allEntries.filter(entry => {
                const japanese = nameMap[entry.kind]?.[entry.romaji] || '';
                return !query || entry.romaji.toLowerCase().includes(query) || japanese.toLowerCase().includes(query);
            });
        }

        function applySelectionHighlight() {
            tbody.querySelectorAll('tr').forEach((tr, index) => {
                tr.classList.toggle(selectedRowClassName, index === selectedIndex);
            });
        }

        function focusRow(index, { scrollIntoView = true } = {}) {
            const entries = getFilteredFavoriteEntries();
            if (!entries.length) {
                selectedIndex = -1;
                return;
            }

            selectedIndex = Math.max(0, Math.min(entries.length - 1, index));
            applySelectionHighlight();
            if (scrollIntoView) tbody.children[selectedIndex]?.scrollIntoView({ block: 'nearest' });
        }

        function handleKeydown(event) {
            if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

            if (event.key === 'j') {
                event.preventDefault();
                focusRow(selectedIndex + 1);
            } else if (event.key === 'k') {
                event.preventDefault();
                const entries = getFilteredFavoriteEntries();
                focusRow(selectedIndex === -1 ? entries.length - 1 : selectedIndex - 1);
            } else if (event.key === 'v') {
                const entries = getFilteredFavoriteEntries();
                const entry = entries[selectedIndex];
                if (entry) {
                    event.preventDefault();
                    openFavoriteInBackground(entry);
                }
            }
        }

        function renderTable() {
            const allEntries = getFavoriteEntries();
            const entries = getFilteredFavoriteEntries();

            visibleStatusCells.clear();
            const rows = entries.map((entry, index) => {
                const tr = document.createElement('tr');
                const kindTd = document.createElement('td');
                const nameTd = document.createElement('td');
                const statusTd = document.createElement('td');
                const linkTd = document.createElement('td');
                const removeTd = document.createElement('td');
                const link = document.createElement('a');
                const removeButton = document.createElement('button');
                const japanese = nameMap[entry.kind]?.[entry.romaji];
                const hitomiCategoryPath = entry.kind === 'author' ? 'artist' : entry.kind === 'tag' ? 'tag' : 'group';
                const entryKey = getFavoriteEntryKey(entry);

                tr.tabIndex = -1;
                tr.classList.toggle(selectedRowClassName, index === selectedIndex);
                tr.addEventListener('click', () => focusRow(index));
                kindTd.textContent = entry.kind;
                nameTd.textContent = japanese ? `${japanese} (${entry.romaji})` : entry.romaji;
                visibleStatusCells.set(entryKey, statusTd);
                renderStatus(statusTd, latestGalleryResults.get(entryKey));
                link.href = `https://hitomi.la/${hitomiCategoryPath}/${encodeURIComponent(entry.romaji)}-all.html`;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = 'Open';
                link.addEventListener('click', () => markFavoriteSeen(entry, entryKey));
                removeButton.type = 'button';
                removeButton.textContent = 'Remove';
                removeButton.addEventListener('click', async () => {
                    await updateFavorites(map => {
                        delete map[entry.kind][entry.romaji];
                        return true;
                    });
                    await updateFavoritesWatch(map => {
                        delete map[entry.kind][entry.romaji];
                        return true;
                    });
                    latestGalleryResults.delete(entryKey);
                    renderTable();
                });

                linkTd.appendChild(link);
                removeTd.appendChild(removeButton);
                tr.append(kindTd, nameTd, statusTd, linkTd, removeTd);
                return tr;
            });
            tbody.replaceChildren(...rows);
            applySelectionHighlight();

            tableWrap.hidden = entries.length === 0;
            emptyMessage.hidden = entries.length !== 0;
            emptyMessage.textContent = allEntries.length === 0 ? 'No favorites yet.' : 'No matching favorites.';
        }

        searchInput.addEventListener('input', renderTable);
        window.addEventListener('keydown', handleKeydown, true);
        const initialEntries = getFavoriteEntries();
        initialEntries.forEach(entry => {
            latestGalleryResults.set(getFavoriteEntryKey(entry), { state: 'loading', latestId: null, lastSeenId: null });
        });
        renderTable();
        initialEntries.forEach(entry => {
            fetchLatestGalleryId(entry.kind, entry.romaji).then(latestId => {
                latestGalleryResults.set(getFavoriteEntryKey(entry), {
                    state: 'complete',
                    latestId,
                    lastSeenId: getLastSeenGalleryId(entry.kind, entry.romaji)
                });
                refreshVisibleStatus(entry);
            });
        });
    }

    async function renderNameMapPage() {
        await loadNameMap();
        const blackList = await loadBlacklist();
        const unifiedModel = await loadUnifiedStoreOnly();
        const groupDownloadCounts = new Map();
        const authorDownloadCounts = new Map();
        for (const item of unifiedModel.items) {
            if (item.status !== 'done' && !item.downloadedAt) continue;
            for (const [rawValue, countMap] of [[item.group, groupDownloadCounts], [item.author, authorDownloadCounts]]) {
                for (const token of String(rawValue || '').split(',')) {
                    const key = normalizeNameMapKey(token);
                    if (!key) continue;
                    countMap.set(key, (countMap.get(key) || 0) + 1);
                }
            }
        }

        let selectedIndex = -1;
        const selectedRowClassName = 'hitomi-name-map-selected-row';
        const sortIndicatorClassName = 'hitomi-name-map-sort-indicator';
        const columns = [
            { key: 'romaji', label: 'romaji' },
            { key: 'japanese', label: 'Japanese name' },
            { key: 'kind', label: 'kind' },
            { key: 'downloads', label: 'downloads' }
        ];
        let sortState = { key: 'unfilled', direction: 'asc' };

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
            .hitomi-name-map-table tr.${selectedRowClassName} {
                background: #ddf4ff;
            }
            .hitomi-name-map-table tr:hover {
                background: #f6f8fa;
            }
            .hitomi-match {
                text-decoration: line-through;
            }
            .hitomi-name-map-search-link {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                margin-left: 6px;
                color: #57606a;
                vertical-align: middle;
            }
            .hitomi-name-map-search-link:hover {
                color: #0969da;
            }
            .hitomi-name-map-japanese-input {
                box-sizing: border-box;
                width: 100%;
                min-height: 30px;
                padding: 4px 6px;
                border: 1px solid #d0d7de;
                border-radius: 4px;
                background: #fff;
                font: inherit;
            }
            .hitomi-name-map-japanese-input:focus {
                border-color: #0969da;
                outline: none;
            }
            .hitomi-name-map-downloads-cell {
                text-align: right;
            }
            .${sortIndicatorClassName} {
                margin-left: 4px;
                font-size: 11px;
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
        const headerElems = new Map();

        page.className = 'hitomi-name-map-page';
        header.className = 'hitomi-name-map-header';
        status.className = 'hitomi-name-map-status';
        notice.className = 'hitomi-name-map-notice';
        controls.className = 'hitomi-name-map-controls';
        addForm.className = 'hitomi-name-map-add-form';
        tableWrap.className = 'hitomi-name-map-table-wrap';
        table.className = 'hitomi-name-map-table';

        title.textContent = 'Name Map';
        status.textContent = getNameMapEntryStatus();
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

        columns.forEach(column => {
            const th = document.createElement('th');
            const indicator = document.createElement('span');

            th.textContent = column.label;
            indicator.className = sortIndicatorClassName;
            th.appendChild(indicator);
            th.style.cursor = 'pointer';
            th.addEventListener('click', () => setSort(column.key));
            headerElems.set(column.key, th);
            headerRow.appendChild(th);
        });
        headerRow.appendChild(document.createElement('th'));

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

        function getDownloadCount(entry) {
            if (entry.kind === 'series') return 0;
            const countMap = entry.kind === 'group' ? groupDownloadCounts : authorDownloadCounts;
            const romajiKey = entry.romaji;
            const japaneseKey = normalizeNameMapKey(entry.japanese);
            return (countMap.get(romajiKey) || 0)
                + (japaneseKey && japaneseKey !== romajiKey ? (countMap.get(japaneseKey) || 0) : 0);
        }

        function compareEntries(a, b) {
            const direction = sortState.direction === 'asc' ? 1 : -1;
            if (sortState.key === 'unfilled') {
                const aUnfilled = a.japanese === '';
                const bUnfilled = b.japanese === '';
                if (aUnfilled !== bUnfilled) return (aUnfilled ? -1 : 1) * direction;
                return a.romaji.localeCompare(b.romaji, undefined, { numeric: true, sensitivity: 'base' }) * direction;
            }
            if (sortState.key === 'downloads') {
                const aIsSeries = a.kind === 'series';
                const bIsSeries = b.kind === 'series';
                if (aIsSeries !== bIsSeries) return aIsSeries ? 1 : -1;
                return (getDownloadCount(a) - getDownloadCount(b)) * direction;
            }
            const aValue = String(a[sortState.key] || '');
            const bValue = String(b[sortState.key] || '');
            return aValue.localeCompare(bValue, undefined, { numeric: true, sensitivity: 'base' }) * direction;
        }

        function getFilteredEntries() {
            const query = searchInput.value.trim().toLowerCase();
            return getNameMapEntries().filter(entry => !query
                || entry.romaji.toLowerCase().includes(query)
                || entry.japanese.toLowerCase().includes(query))
                .sort(compareEntries);
        }

        function renderHeaders() {
            headerElems.forEach((heading, key) => {
                const indicator = heading.querySelector(`.${sortIndicatorClassName}`);
                if (!indicator) return;
                indicator.textContent = sortState.key === key ? (sortState.direction === 'asc' ? '▲' : '▼') : '';
            });
        }

        function setSort(key) {
            const selectedEntry = selectedIndex >= 0 ? getFilteredEntries()[selectedIndex] : null;
            if (sortState.key === key) {
                sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
            } else {
                sortState = { key, direction: 'asc' };
            }
            renderTable();
            if (selectedEntry) {
                const newIndex = getFilteredEntries().findIndex(entry => entry.kind === selectedEntry.kind
                    && entry.romaji === selectedEntry.romaji);
                if (newIndex !== -1) focusRow(newIndex, { scrollIntoView: false });
            }
        }

        function applySelectionHighlight() {
            tbody.querySelectorAll('tr').forEach((tr, index) => {
                tr.classList.toggle(selectedRowClassName, index === selectedIndex);
            });
        }

        function focusRow(index, { scrollIntoView = true } = {}) {
            const entries = getFilteredEntries();
            if (!entries.length) {
                selectedIndex = -1;
                return;
            }

            selectedIndex = Math.max(0, Math.min(entries.length - 1, index));
            applySelectionHighlight();
            if (scrollIntoView) tbody.children[selectedIndex]?.scrollIntoView({ block: 'nearest' });
        }

        function renderTable() {
            const entries = getFilteredEntries();
            tbody.replaceChildren(...entries.map((entry, index) => {
                const tr = document.createElement('tr');
                tr.classList.toggle(selectedRowClassName, index === selectedIndex);
                tr.tabIndex = -1;
                tr.addEventListener('click', () => focusRow(index));

                const romajiTd = document.createElement('td');
                const japaneseTd = document.createElement('td');
                const kindTd = document.createElement('td');
                const downloadsTd = document.createElement('td');
                const actionTd = document.createElement('td');
                const deleteBtn = document.createElement('button');

                const hitomiCategoryPath = entry.kind === 'author' ? 'artist' : entry.kind === 'series' ? 'series' : 'group';
                const romajiLink = document.createElement('a');
                romajiLink.href = `https://hitomi.la/${hitomiCategoryPath}/${encodeURIComponent(entry.romaji)}-all.html`;
                romajiLink.target = '_blank';
                romajiLink.rel = 'noopener noreferrer';
                romajiLink.textContent = entry.romaji;
                // The blacklist has no "group" category, so only author/series entries can match.
                const blacklistValues = blackList[entry.kind] || [];
                if (blacklistValues.some(value => value.toLowerCase() === entry.romaji)) {
                    romajiLink.classList.add('hitomi-match');
                }

                const searchLink = document.createElement('a');
                searchLink.href = `https://www.google.com/search?q=${encodeURIComponent(entry.romaji)}`;
                searchLink.target = '_blank';
                searchLink.rel = 'noopener noreferrer';
                searchLink.className = 'hitomi-name-map-search-link';
                searchLink.title = 'Search on Google';
                searchLink.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M11 6.5A4.5 4.5 0 1 1 6.5 2a4.5 4.5 0 0 1 4.5 4.5Z"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M10 10l4 4"/></svg>';

                romajiTd.append(romajiLink, searchLink);
                const japaneseInput = document.createElement('input');
                japaneseInput.type = 'text';
                japaneseInput.className = 'hitomi-name-map-japanese-input';
                japaneseInput.value = entry.japanese;
                japaneseInput.placeholder = '';
                japaneseTd.appendChild(japaneseInput);
                kindTd.textContent = entry.kind;
                downloadsTd.textContent = entry.kind === 'series' ? '-' : String(getDownloadCount(entry));
                downloadsTd.className = 'hitomi-name-map-downloads-cell';
                deleteBtn.type = 'button';
                deleteBtn.textContent = 'Delete';

                japaneseInput.addEventListener('keydown', event => {
                    if (event.isComposing) return;
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        japaneseInput.blur();
                    } else if (event.key === 'Escape') {
                        japaneseInput.value = entry.japanese;
                        japaneseInput.blur();
                    }
                });

                japaneseInput.addEventListener('blur', async () => {
                    const nextValue = japaneseInput.value.trim();
                    if (nextValue === entry.japanese) return;

                    entry.japanese = nextValue;
                    const nextEntry = entries[index + 1] || null;
                    await updateNameMap(map => {
                        map[entry.kind][entry.romaji] = nextValue;
                        return true;
                    });
                    setStatus(`Updated ${entry.romaji}. ${getNameMapEntryStatus()}`);
                    renderTable();

                    if (nextEntry) {
                        const newEntries = getFilteredEntries();
                        const newIndex = newEntries.findIndex(candidate => candidate.kind === nextEntry.kind
                            && candidate.romaji === nextEntry.romaji);
                        if (newIndex !== -1) focusRow(newIndex);
                    } else {
                        focusRow(selectedIndex);
                    }
                });

                deleteBtn.addEventListener('click', async () => {
                    await updateNameMap(map => {
                        delete map[entry.kind][entry.romaji];
                        return true;
                    });
                    setStatus(`Deleted ${entry.romaji}. ${getNameMapEntryStatus()}`);
                    renderTable();
                });

                actionTd.appendChild(deleteBtn);
                tr.append(romajiTd, japaneseTd, kindTd, downloadsTd, actionTd);
                return tr;
            }));

            if (!entries.length) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 5;
                td.textContent = 'No entries found.';
                tr.appendChild(td);
                tbody.appendChild(tr);
            }

            applySelectionHighlight();
            renderHeaders();
        }

        function handleKeydown(event) {
            if (isEditableTarget(event.target)
                || event.ctrlKey
                || event.metaKey
                || event.altKey
                || event.shiftKey) return;

            if (event.key === 'j') {
                event.preventDefault();
                focusRow(selectedIndex + 1);
            } else if (event.key === 'k') {
                event.preventDefault();
                const entries = getFilteredEntries();
                focusRow(selectedIndex === -1 ? entries.length - 1 : selectedIndex - 1);
            } else if (event.key === 'Enter') {
                const input = tbody.children[selectedIndex]?.querySelector('.hitomi-name-map-japanese-input');
                if (input) {
                    event.preventDefault();
                    input.focus();
                    input.select();
                }
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
                    const unfilledCount = getNameMapEntries().filter(entry => !entry.japanese).length;
                    setStatus(`${beforeCount} -> ${afterCount} entries, ${unfilledCount} unfilled`);
                    renderTable();
                } catch (e) {
                    setStatus('Invalid name map format.');
                }
            });
            input.click();
        });
        searchInput.addEventListener('input', renderTable);
        window.addEventListener('keydown', handleKeydown, true);

        addForm.addEventListener('submit', async event => {
            event.preventDefault();

            const romaji = normalizeNameMapKey(romajiInput.value);
            const japanese = japaneseInput.value.trim();
            const kind = kindSelect.value;
            if (!romaji || !japanese || !['group', 'author', 'series'].includes(kind)) {
                setStatus('Romaji, Japanese name, and kind are required.');
                return;
            }

            let existed = false;
            await updateNameMap(map => {
                existed = Object.prototype.hasOwnProperty.call(map[kind], romaji);
                map[kind][romaji] = japanese;
                return true;
            });
            romajiInput.value = '';
            japaneseInput.value = '';
            setStatus(`${existed ? 'Updated' : 'Added'} ${romaji}. ${getNameMapEntryStatus()}`);
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
            { key: 'updatedAt', label: 'updated at' }
        ];
        let rows = [];
        let selectedIndex = -1;
        let sortState = { key: 'bookId', direction: 'desc' };
        let statusElem = null;
        let tbodyElem = null;
        const headerElems = new Map();
        let lastSnapshot = null;
        let downloadsRefreshTimer = null;
        let tableWrapElem = null;
        let emptyElem = null;

        function resolveJapaneseNameList(text, kind) {
            return normalizeMetadataText(text)
                .split(',')
                .map(name => normalizeMetadataText(name))
                .filter(Boolean)
                .map(name => resolveJapaneseName(name, kind))
                .join(', ');
        }

        function formatDownloadedAt(value) {
            if (!value) return '';

            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return normalizeMetadataText(value);

            return date.toLocaleString();
        }

        async function refreshDownloads() {
            if (document.hidden) return;

            const selectedBookId = getSelectedRow()?.bookId;
            const model = await loadUnifiedDownloads();
            rows = createRowsFromUnified(model.items);
            sortRows();
            const nextSnapshot = JSON.stringify(rows.map(row => ({ ...row })));
            if (nextSnapshot === lastSnapshot) return;

            lastSnapshot = nextSnapshot;
            if (selectedBookId) selectedIndex = rows.findIndex(row => row.bookId === selectedBookId);
            if (selectedIndex < 0 && rows.length) selectedIndex = 0;
            if (!rows.length) selectedIndex = -1;
            if (tableWrapElem && emptyElem) {
                tableWrapElem.hidden = rows.length === 0;
                emptyElem.hidden = rows.length > 0;
            }
            render();
            setStatus(`${rows.length} books`);
        }

        function installDownloadsRefresh() {
            if (downloadsRefreshTimer) return;

            refreshDownloads().catch(error => console.error(error));
            downloadsRefreshTimer = window.setInterval(() => {
                refreshDownloads().catch(error => console.error(error));
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

        function metadataFromGalleryInfo(galleryInfo, existingTitle) {
            const title = normalizeMetadataText(galleryInfo?.japanese_title)
                || normalizeMetadataText(galleryInfo?.title)
                || existingTitle;
            const group = getGalleryInfoNames(galleryInfo?.groups, 'group').join(', ');
            const author = dedupeNames(getGalleryInfoNames(galleryInfo?.artists, 'artist')).join(', ');

            return { title, group, author };
        }

        function createRowsFromUnified(items) {
            return items
                .map(item => ({
                    key: item.galleryId,
                    bookId: item.galleryId,
                    title: item.title,
                    group: item.group,
                    author: item.author,
                    url: item.url,
                    downloadedAt: item.downloadedAt,
                    updatedAt: item.updatedAt || item.downloadedAt || '',
                    galleryId: item.galleryId,
                    metadataHydrated: item.metadataHydrated
                }))
                .filter(row => row.bookId || row.url || row.title);
        }

        function getDisplayValue(row, key) {
            if (key === 'group') return resolveJapaneseNameList(row.group, 'group');
            if (key === 'author') return resolveJapaneseNameList(row.author, 'author');
            if (key === 'updatedAt') return formatDownloadedAt(row.updatedAt);
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
            renderBody(true);
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

        function renderBody(scrollToSelection = false) {
            tbodyElem.replaceChildren(...rows.map((row, index) => {
                const tr = document.createElement('tr');
                tr.classList.toggle(selectedRowClassName, index === selectedIndex);
                tr.dataset.galleryId = String(row.galleryId || row.bookId);
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

            if (scrollToSelection) {
                tbodyElem.querySelector(`.${selectedRowClassName}`)?.scrollIntoView({ block: 'nearest' });
            }
            renderHeaders();
        }

        function render() {
            const selectedBookId = getSelectedRow()?.bookId;

            sortRows();
            if (selectedBookId) selectedIndex = rows.findIndex(row => row.bookId === selectedBookId);
            if (selectedIndex === -1 && rows.length) selectedIndex = 0;
            renderBody(false);
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
            renderBody(true);
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
                .hitomi-download-page-table th:nth-child(1) { width: 100px; }
                .hitomi-download-page-table th:nth-child(2) { width: 30%; }
                .hitomi-download-page-table th:nth-child(3) { width: 15%; }
                .hitomi-download-page-table th:nth-child(4) { width: 15%; }
                .hitomi-download-page-table th:nth-child(5) { width: 160px; }
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

        function createPage() {
            document.title = 'Hitomi Downloads';
            document.body.replaceChildren();
            createStyle();

            const page = document.createElement('main');
            const header = document.createElement('header');
            const title = document.createElement('h1');
            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');

            page.className = 'hitomi-download-page-main';
            header.className = 'hitomi-download-page-header';
            title.textContent = 'Downloads';
            statusElem = document.createElement('div');
            statusElem.className = 'hitomi-download-page-status';
            tableWrapElem = document.createElement('div');
            tableWrapElem.className = 'hitomi-download-page-table-wrap';
            tableWrapElem.hidden = true;
            table.className = 'hitomi-download-page-table';
            tbodyElem = document.createElement('tbody');
            emptyElem = document.createElement('div');
            emptyElem.className = 'hitomi-download-page-empty';
            emptyElem.textContent = 'No downloads found.';

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
            tableWrapElem.appendChild(table);
            header.append(title, statusElem);
            page.append(header, tableWrapElem, emptyElem);
            document.body.appendChild(page);
        }

        function wait(ms) {
            return new Promise(resolve => window.setTimeout(resolve, ms));
        }

        async function hydrateMissingMetadata() {
            const attemptedIds = new Set();
            let fetchedCount = 0;
            while (true) {
                const model = await loadUnifiedDownloads();
                const target = model.items.find(item =>
                    (item.status === 'done' || item.downloadedAt)
                    && !item.metadataHydrated
                    && !attemptedIds.has(String(item.galleryId))
                    && item.status !== 'running'
                    && item.status !== 'pending'
                );
                if (!target) break;

                attemptedIds.add(String(target.galleryId));
                setStatus(`Loading metadata ${fetchedCount + 1}`);
                try {
                    const galleryInfo = await loadGalleryInfo(target.galleryId);
                    const metadata = metadataFromGalleryInfo(galleryInfo, target.title);
                    await upsertUnifiedDownload(target.galleryId, {
                        title: metadata.title,
                        group: metadata.group,
                        author: metadata.author,
                        metadataHydrated: true,
                        downloadedAt: target.downloadedAt
                    });
                    await refreshDownloads();
                } catch (e) {
                    // attemptedIds prevents repeated failures from blocking later records.
                }

                fetchedCount += 1;
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
        createPage();
        window.addEventListener('keydown', handleKeydown, true);
        await refreshDownloads();
        hydrateMissingMetadata().catch(error => {
            console.error(error);
            setStatus(`${rows.length} books`);
        });
        installDownloadsRefresh();
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
                        id: `gallery-${galleryId}`,
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
        const [history, unified] = await Promise.all([
            loadDownloadHistory(),
            GM.getValue(unifiedDownloadsKey, { version: 1, items: [] }).then(normalizeUnifiedDownloads)
        ]);
        const historyRecords = selectHistoryRecords(history);
        const unifiedRecords = selectUnifiedRecords(unified.items);
        const galleryIds = new Set([
            ...historyRecords.keys(),
            ...unifiedRecords.keys()
        ]);
        const items = [];

        galleryIds.forEach(galleryId => {
            const historyRecord = historyRecords.get(galleryId);
            const unifiedRecord = unifiedRecords.get(galleryId);
            const downloadedAt = historyRecord?.downloadedAt || unifiedRecord?.downloadedAt || '';

            // Ignore unfinished records left by queue-enabled versions; no worker remains to resolve them.
            if (!downloadedAt && unifiedRecord?.status !== 'done' && !historyRecord) return;

            items.push({
                id: `gallery-${galleryId}`,
                galleryId: String(galleryId),
                url: unifiedRecord?.url || historyRecord?.url || '',
                title: unifiedRecord?.title || historyRecord?.title || '',
                group: unifiedRecord?.group || historyRecord?.group || '',
                author: unifiedRecord?.author || historyRecord?.author || '',
                status: 'done',
                updatedAt: unifiedRecord?.updatedAt || '',
                downloadedAt,
                metadataHydrated: historyRecord?.metadataHydrated === true || unifiedRecord?.metadataHydrated === true
            });
        });

        return normalizeUnifiedDownloads({ version: 1, items });
    }

    async function loadUnifiedStoreOnly() {
        return normalizeUnifiedDownloads(await GM.getValue(unifiedDownloadsKey, { version: 1, items: [] }));
    }

    async function saveUnifiedDownloads(store) {
        await GM.setValue(unifiedDownloadsKey, normalizeUnifiedDownloads(store));
    }

    async function withUnifiedDownloadsLock(task) {
        if (navigator.locks?.request) {
            return navigator.locks.request(unifiedDownloadsLockName, async () => task());
        }

        // Keep unified-store writes ordered in this tab when Web Locks are unavailable.
        const next = unifiedDownloadsWriteQueue.then(task, task);
        unifiedDownloadsWriteQueue = next.catch(() => {});
        return next;
    }

    async function updateUnifiedDownloads(mutator) {
        return withUnifiedDownloadsLock(async () => {
            const store = await loadUnifiedStoreOnly();
            const before = JSON.stringify(store);

            // Queue-era unfinished records have no worker now; remove them whenever the history is next saved.
            store.items = store.items.filter(item => item.status === 'done' || item.downloadedAt);
            const result = await mutator(store);

            if (JSON.stringify(store) !== before) {
                await saveUnifiedDownloads(store);
            }
            return result;
        });
    }

    function upsertUnifiedDownload(galleryId, changes) {
        const normalizedGalleryId = String(galleryId);
        return updateUnifiedDownloads(store => {
            let item = store.items.find(candidate => candidate.galleryId === normalizedGalleryId);
            if (!item) {
                const now = new Date().toISOString();
                item = {
                    id: `gallery-${normalizedGalleryId}`,
                    galleryId: normalizedGalleryId,
                    url: '',
                    title: '',
                    group: '',
                    author: '',
                    source: '',
                    status: 'done',
                    createdAt: now,
                    updatedAt: now,
                    startedAt: null,
                    finishedAt: null,
                    downloadedAt: '',
                    heartbeatAt: null,
                    workerId: null,
                    error: '',
                    metadataHydrated: false
                };
                store.items.push(item);
            }

            const nextChanges = typeof changes === 'function' ? changes(item) : changes;
            if (!nextChanges) return item;

            Object.assign(item, nextChanges, { updatedAt: new Date().toISOString() });
            return item;
        });
    }

    function recordUnifiedDownloadDone({ galleryId, url, title, group, author, source, metadataHydrated }) {
        const now = new Date().toISOString();
        return upsertUnifiedDownload(galleryId, item => ({
            status: 'done',
            downloadedAt: now,
            finishedAt: now,
            heartbeatAt: null,
            workerId: null,
            error: '',
            ...(url ? { url } : {}),
            ...(title ? { title } : {}),
            ...(group ? { group } : {}),
            ...(author ? { author } : {}),
            ...(source && !item.source ? { source } : {}),
            ...(metadataHydrated ? { metadataHydrated: true } : {})
        }));
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

    function getVerifiedPageGalleryInfo(galleryId) {
        return unsafeWindow.galleryinfo?.id && String(unsafeWindow.galleryinfo.id) === String(galleryId)
            ? unsafeWindow.galleryinfo
            : null;
    }

    function normalizeMetadataText(text) {
        return text?.replace(/\s+/g, ' ').trim() || '';
    }

    function isMissingMetadataValue(value) {
        return !value || value.toLowerCase() === 'n/a';
    }

    function getMetadataListText(root, headingSelector) {
        return normalizeMetadataText(Array.from(root.querySelectorAll(`${headingSelector} a`), link => link.dataset.hitomiNameMapOriginal || link.textContent.trim())
            .filter(Boolean)
            .join(', ') || root.querySelector(headingSelector)?.textContent);
    }

    function getGalleryInfoNames(values, key) {
        if (!Array.isArray(values)) return [];

        return values
            .map(value => normalizeMetadataText(typeof value === 'string' ? value : value?.[key] || value?.name))
            .filter(Boolean);
    }

    function harvestNameMapKeys(galleryInfo) {
        if (!galleryInfo) return Promise.resolve();

        return updateNameMap(map => {
            let changed = false;
            for (const [values, kind] of [
                [galleryInfo.groups, 'group'],
                [galleryInfo.artists, 'author'],
                [galleryInfo.parodys, 'series']
            ]) {
                const infoKey = kind === 'author' ? 'artist' : kind === 'series' ? 'parody' : 'group';
                for (const raw of getGalleryInfoNames(values, infoKey)) {
                    const key = normalizeNameMapKey(raw);
                    if (key && !(key in map[kind])) {
                        map[kind][key] = '';
                        changed = true;
                    }
                }
            }
            return changed;
        });
    }

    function createPageCountBadgeElement(pageCount) {
        const badge = document.createElement('span');
        badge.className = pageCountBadgeClassName;
        badge.textContent = `${pageCount}P`;
        return badge;
    }

    function renderGalleryCountBadge(heading, pageCount) {
        if (!heading || heading.dataset.hitomiPageCountAnnotated || !(pageCount > 0)) return;
        heading.dataset.hitomiPageCountAnnotated = '1';
        heading.appendChild(createPageCountBadgeElement(pageCount));
    }

    function renderBookPageGalleryCountBadge(galleryInfo, galleryId) {
        if (!galleryInfo?.id || String(galleryInfo.id) !== String(galleryId)) return;
        const pageCount = Array.isArray(galleryInfo.files) ? galleryInfo.files.length : 0;
        if (!pageCount) return;
        renderGalleryCountBadge(document.querySelector('h1#gallery-brand'), pageCount);
    }

    function getBookPageTitle(root, galleryInfo, galleryId) {
        // Prefer ID-verified galleryinfo so stale SPA DOM or neighboring list cards cannot leak metadata.
        // The DOM remains a fallback for pages where galleryinfo is not available yet.
        return normalizeMetadataText(galleryInfo?.japanese_title)
            || normalizeMetadataText(galleryInfo?.title)
            || normalizeMetadataText(root.querySelector('h1#gallery-brand > a')?.textContent)
            || `hitomi-${galleryId}`;
    }

    function getCellDisplayText(cell) {
        const links = Array.from(cell?.querySelectorAll('a') || []);
        if (links.length) return links.map(link => link.dataset.hitomiNameMapOriginal || link.textContent).join(', ');
        return cell?.textContent;
    }

    function getBookPageGroup(root, galleryInfo) {
        // Prefer ID-verified galleryinfo; inspect the DOM only when the canonical metadata is missing.
        const infoGroups = getGalleryInfoNames(galleryInfo?.groups, 'group');
        if (infoGroups.length) return infoGroups.map(group => resolveJapaneseName(group, 'group')).join(', ');

        const tableRows = Array.from(root.querySelectorAll('table tr'));
        for (const row of tableRows) {
            const cells = Array.from(row.children);
            if (normalizeMetadataText(cells[0]?.textContent).toLowerCase() === 'group') {
                const group = normalizeMetadataText(getCellDisplayText(cells[1]));
                if (!isMissingMetadataValue(group)) return resolveJapaneseName(group, 'group');
            }
        }

        const labels = Array.from(root.querySelectorAll('dt, th, td, h2, h3, strong, b'));
        const groupLabel = labels.find(label => normalizeMetadataText(label.textContent).toLowerCase() === 'group');
        if (groupLabel) {
            const group = normalizeMetadataText(getCellDisplayText(groupLabel.nextElementSibling));
            if (!isMissingMetadataValue(group)) return resolveJapaneseName(group, 'group');
        }

        return '';
    }

    function getBookPageAuthors(root, galleryInfo) {
        const infoAuthors = getGalleryInfoNames(galleryInfo?.artists, 'artist');
        const authorText = getMetadataListText(root, 'h2#artists');
        const authorNames = infoAuthors.length ? infoAuthors : (isMissingMetadataValue(authorText) ? [] : authorText.split(','));

        const names = authorNames
            .map(name => normalizeMetadataText(name))
            .filter(Boolean)
            .map(name => resolveJapaneseName(name, 'author'));
        return [...new Set(names)];
    }

    function getBookPageSeries(root, galleryInfo) {
        // Prefer ID-verified galleryinfo; inspect the DOM only when the canonical metadata is missing.
        const infoSeries = getGalleryInfoNames(galleryInfo?.parodys, 'parody');
        if (infoSeries.length) return infoSeries.map(series => resolveJapaneseName(series, 'series')).join(', ');

        const tableRows = Array.from(root.querySelectorAll('table tr'));
        for (const row of tableRows) {
            const cells = Array.from(row.children);
            if (normalizeMetadataText(cells[0]?.textContent).toLowerCase() === 'series') {
                const series = normalizeMetadataText(getCellDisplayText(cells[1]));
                if (!isMissingMetadataValue(series)) return resolveJapaneseName(series, 'series');
            }
        }

        const labels = Array.from(root.querySelectorAll('dt, th, td, h2, h3, strong, b'));
        const seriesLabel = labels.find(label => normalizeMetadataText(label.textContent).toLowerCase() === 'series');
        if (seriesLabel) {
            const series = normalizeMetadataText(getCellDisplayText(seriesLabel.nextElementSibling));
            if (!isMissingMetadataValue(series)) return resolveJapaneseName(series, 'series');
        }

        return '';
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
        // Without verified galleryinfo, the filename may still use transient DOM metadata and cannot be corrected later.
        return formatDownloadFileNameFromMetadata({
            group: getBookPageGroup(root, galleryInfo),
            authors: getBookPageAuthors(root, galleryInfo),
            series: getBookPageSeries(root, galleryInfo),
            title: getBookPageTitle(root, galleryInfo, galleryId)
        });
    }

    function getDownloadHistoryMetadata(root, galleryInfo, galleryId) {
        // Store normalized metadata in the unified download record so every download
        // path and the integrated page share the same enrichment state.
        const authors = getBookPageAuthors(root, galleryInfo);

        return {
            title: getBookPageTitle(root, galleryInfo, galleryId),
            group: getBookPageGroup(root, galleryInfo),
            author: authors.join(', '),
            metadataHydrated: Boolean(galleryInfo)
        };
    }

    function getBookLinkFromElement(elem) {
        return elem?.querySelector(':scope > h1.lillie a[href], :scope > h1 a[href], :scope > a[href]') || null;
    }

    function setBookDownloadedIndicator(book, downloaded) {
        const heading = book.querySelector(':scope > h1.lillie');
        if (!heading) return;

        heading.classList.toggle(downloadedBookHeadingClassName, downloaded);
    }

    function applyDownloadedIdsToBooks(downloadedIds) {
        // Downloaded markers are derived from the unified model used on book pages.
        // Downloaded books are folded visually to keep list pages compact, but this
        // does not write foldedBookIds because it is download-record-driven state.
        document.querySelectorAll('div.gallery-content > div').forEach(book => {
            const bookId = getBookIdFromElement(book);
            const downloaded = Boolean(bookId && downloadedIds.has(String(bookId)));

            setBookDownloadedIndicator(book, downloaded);
            if (downloaded) {
                getFilterBook(book).fold();
            }
        });
    }

    async function refreshDownloadIndicators() {
        const model = await loadUnifiedDownloads();
        const downloadedIds = new Set(model.items
            .filter(item => item.status === 'done' || item.downloadedAt)
            .map(item => String(item.galleryId)));
        applyDownloadedIdsToBooks(downloadedIds);
    }

    function markCurrentBookDownloaded(galleryInfo = null, galleryId = getCurrentGalleryId()) {
        const metadata = getDownloadHistoryMetadata(document, galleryInfo, galleryId);
        recordUnifiedDownloadDone({
            galleryId: String(galleryId),
            url: location.href,
            title: metadata.title,
            group: metadata.group,
            author: metadata.author,
            source: 'book',
            metadataHydrated: metadata.metadataHydrated
        }).catch(() => {});

        markDLButtonDownloaded();
    }

    function markListBookDownloaded(book, galleryInfo) {
        if (!book) return;

        // List-page downloads should immediately affect the visible card so users do
        // not need a reload to see the downloaded marker and compact folded state.
        const link = getBookLinkFromElement(book);
        const metadata = getDownloadHistoryMetadata(document, galleryInfo, galleryInfo.id);
        recordUnifiedDownloadDone({
            galleryId: String(galleryInfo.id),
            url: link ? new URL(link.getAttribute('href'), location.href).href : '',
            title: metadata.title,
            group: metadata.group,
            author: metadata.author,
            source: 'list',
            metadataHydrated: metadata.metadataHydrated
        }).catch(() => {});

        setBookDownloadedIndicator(book, true);
        getFilterBook(book).fold();
    }

    async function markPageIfDownloaded() {
        if (!getDLButton()) return;

        const model = await loadUnifiedDownloads();
        if (model.items.some(item =>
            String(item.galleryId) === String(getCurrentGalleryId())
            && (item.status === 'done' || item.downloadedAt)
        )) {
            markDLButtonDownloaded();
        }
    }

    async function harvestCurrentBookPage() {
        const galleryId = getCurrentGalleryId();
        if (!galleryId) return;

        try {
            const galleryInfo = await loadCurrentBookPageGalleryInfo(galleryId);
            await harvestNameMapKeys(galleryInfo);
            renderBookPageGalleryCountBadge(galleryInfo, galleryId);
        } catch (e) {
            // Name-map harvesting and the page-count badge are both best-effort and must not affect page setup.
        }
    }

    function createBookPageDownloadState(previousText = getDLButtonText()) {
        // Book-page downloads use Hitomi's original progressbar UI, but the transfer
        // itself is ours so pressing d again can cancel XHR/throttle waits safely.
        return {
            canceled: false,
            cancelWait: null,
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
        hideBookPageDownloadProgress();
        setDLButtonText('CANCELED');
        restoreDLButtonTextWhenIdle(downloadState, 1000);
    }

    async function buildAndSaveGalleryArchive(galleryId, downloadState, onProgress) {
        galleryId = String(galleryId);
        const [gg, galleryInfo] = await Promise.all([
            waitForHitomiGg(),
            String(getCurrentGalleryId()) === galleryId
                ? loadCurrentBookPageGalleryInfo(galleryId, downloadState)
                : loadGalleryInfo(galleryId)
        ]);
        throwIfDownloadCanceled(downloadState);
        harvestNameMapKeys(galleryInfo).catch(() => {});

        if (galleryInfo.type === 'anime') {
            throw createAnimeNotSupportedError();
        }

        const zip = new JSZip();
        const metadataRoot = String(getCurrentGalleryId()) === galleryId ? document : document.createElement('div');

        for (let i = 0; i < galleryInfo.files.length; i++) {
            const image = galleryInfo.files[i];
            const url = urlFromUrlFromHash(image, 'webp', 'webp', undefined, gg);
            const imageName = image.name.replace(/[^.]*$/, 'webp');

            zip.file(imageName, await retryDownloadBlob(url, downloadState), { binary: true });
            onProgress(`${i + 1} / ${galleryInfo.files.length}`, (i + 1) / galleryInfo.files.length * 100);
            await wait(1000, downloadState);
        }

        throwIfDownloadCanceled(downloadState);
        // Refresh the name map right before naming the file so a Japanese name registered
        // (possibly from another tab) while the images were downloading is still picked up.
        await loadNameMap().catch(() => {});
        const title = getDownloadFileNameFromBookPageDocument(metadataRoot, galleryInfo, galleryId);
        onProgress('Zipping...', 100);
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        throwIfDownloadCanceled(downloadState);
        saveAs(zipBlob, `${title}.zip`);
        throwIfDownloadCanceled(downloadState);

        return galleryInfo;
    }

    async function downloadBook(dlButton) {
        if (!dlButton) return false;
        if (activeBookPageDownload) {
            cancelBookPageDownload(activeBookPageDownload);
            return false;
        }

        const galleryId = getCurrentGalleryId();
        if (!galleryId) return false;

        const downloadState = createBookPageDownloadState();
        activeBookPageDownload = downloadState;
        try {
            showBookPageDownloadProgress();
            updateBookPageDownloadProgress(0, 'Loading...');
            updateBookPageDownloadTitle(0);
            const galleryInfo = await buildAndSaveGalleryArchive(galleryId, downloadState, (text, percent) => {
                updateBookPageDownloadProgress(percent, text);
                updateBookPageDownloadTitle(percent);
            });
            hideBookPageDownloadProgress();
            updateBookPageDownloadTitle(null);
            markCurrentBookDownloaded(galleryInfo, galleryId);
            if (await loadCloseBookPageAfterDownload()) closeCurrentTab();
            return true;
        } catch (e) {
            const canceled = isDownloadCanceledError(e);
            const animeNotSupported = isAnimeNotSupportedError(e);
            if (!canceled && !animeNotSupported) console.error(e);
            hideBookPageDownloadProgress();
            updateBookPageDownloadTitle(null);
            setDLButtonText(canceled ? 'CANCELED' : animeNotSupported ? 'ANIME NOT SUPPORTED' : 'DOWNLOAD FAILED');
            restoreDLButtonTextWhenIdle(downloadState, 1800);
            return false;
        } finally {
            if (activeBookPageDownload === downloadState) activeBookPageDownload = null;
        }
    }

    async function startListDownload(book, galleryId, existingProgress = null) {
        const downloadProgress = existingProgress || createBookDownloadProgress(book);
        const downloadState = createListDownloadState(downloadProgress);
        activeListDownloads.set(galleryId, downloadState);
        updateListDownloadTitle();
        try {
            updateBookDownloadProgress(downloadProgress, 'Loading...', 0);
            const galleryInfo = await buildAndSaveGalleryArchive(galleryId, downloadState, (text, percent) => {
                updateBookDownloadProgress(downloadProgress, text, percent);
            });
            markListBookDownloaded(book, galleryInfo);
            finishBookDownloadProgress(downloadProgress, 'Downloaded', bookDownloadDoneClassName);
            window.setTimeout(() => hideBookDownloadProgress(downloadProgress), 1400);
            return true;
        } catch (e) {
            const canceled = isDownloadCanceledError(e);
            const animeNotSupported = isAnimeNotSupportedError(e);
            if (!canceled && !animeNotSupported) console.error(e);
            if (canceled) return false;
            finishBookDownloadProgress(downloadProgress, animeNotSupported ? 'Anime not supported' : 'Download failed', bookDownloadErrorClassName);
            window.setTimeout(() => hideBookDownloadProgress(downloadProgress), 1800);
            return false;
        } finally {
            activeListDownloads.delete(galleryId);
            updateListDownloadTitle();
            processListDownloadQueue();
        }
    }

    function processListDownloadQueue() {
        while (activeListDownloads.size < maxListDownloadCount && pendingListDownloads.length) {
            const next = pendingListDownloads.shift();
            if (!next.book.isConnected) {
                hideBookDownloadProgress(next.progress);
                continue;
            }
            startListDownload(next.book, next.galleryId, next.progress);
        }
    }

    function downloadFocusedBookFromList() {
        const book = focusedBook;
        if (!book) return;

        const galleryId = getBookIdFromElement(book);
        if (!galleryId) return;

        if (activeListDownloads.has(galleryId)) {
            cancelListDownload(activeListDownloads.get(galleryId));
            return;
        }

        const pendingIndex = pendingListDownloads.findIndex(item => item.galleryId === galleryId);
        if (pendingIndex !== -1) {
            const [removed] = pendingListDownloads.splice(pendingIndex, 1);
            hideBookDownloadProgress(removed.progress);
            showListDownloadNotice('Removed from queue');
            return;
        }

        if (activeListDownloads.size < maxListDownloadCount) {
            startListDownload(book, galleryId);
            return;
        }

        const progress = createBookDownloadProgress(book);
        updateBookDownloadProgress(progress, 'Queued', 0);
        pendingListDownloads.push({ galleryId, book, progress });
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
            const galleryInfo = getVerifiedPageGalleryInfo(galleryId);
            if (galleryInfo) return galleryInfo;
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

    function updateBookPageDownloadTitle(percent) {
        if (percent === null) {
            if (titleBeforeBookPageDownloadTitle !== null) {
                document.title = titleBeforeBookPageDownloadTitle;
                titleBeforeBookPageDownloadTitle = null;
            }
            return;
        }

        titleBeforeBookPageDownloadTitle ||= document.title.replace(/^\[\d+%\]\s*/, '');
        document.title = `[${Math.round(percent)}%] ${titleBeforeBookPageDownloadTitle}`;
    }

    function cancelListDownload(downloadState) {
        downloadState.canceled = true;
        downloadState.cancelWait?.();
        downloadState.xhr?.abort();
        if (downloadState.progress) {
            finishBookDownloadProgress(downloadState.progress, 'Canceled', bookDownloadCanceledClassName);
            window.setTimeout(() => hideBookDownloadProgress(downloadState.progress), 1000);
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
            const galleryInfo = getVerifiedPageGalleryInfo(galleryId);

            markCurrentBookDownloaded(galleryInfo, galleryId);
        }, true);
    }

    function installHistory() {
        markPageIfDownloaded().catch(() => {});
        harvestCurrentBookPage().catch(() => {});
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
        const relatedBooks = Array.from(document.querySelectorAll('div.gallery-content > div'));
        const mainBook = document.querySelector('div.gallery');
        return mainBook ? [mainBook, ...relatedBooks] : relatedBooks;
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
        triggerPageCountFetchForFocusedBook(book);
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
                setParent: false
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

    function getFocusedBookAuthorLinks() {
        const book = getFocusedBook();
        return book?.matches('div.gallery-content > div')
            ? book.querySelectorAll(':scope div.artist-list li a[href]')
            : document.querySelectorAll('h2#artists > ul > li > a[href]');
    }

    function openAuthorLinks() {
        const links = getFocusedBookAuthorLinks();
        const urls = [...new Set(Array.from(links, link => new URL(link.getAttribute('href'), location.href).href))];
        if (urls.length === 0) return false;

        urls.forEach(openUrlInNewTab);
        return true;
    }

    function favoriteAuthorsOfFocusedBook() {
        const links = Array.from(getFocusedBookAuthorLinks());
        if (links.length === 0) return false;

        const entries = links
            .map(link => ({
                link,
                romaji: normalizeNameMapKey(link.dataset.hitomiNameMapOriginal || normalizeMetadataText(link.textContent))
            }))
            .filter(entry => entry.romaji);
        if (entries.length === 0) return false;

        const romajiSet = [...new Set(entries.map(entry => entry.romaji))];
        const allFavorited = romajiSet.every(romaji => isFavorite('author', romaji));
        const nextFavorited = !allFavorited;

        updateFavorites(map => {
            const changed = [];
            romajiSet.forEach(romaji => {
                if (nextFavorited) {
                    if (map.author[romaji] !== true) {
                        map.author[romaji] = true;
                        changed.push(romaji);
                    }
                } else if (map.author[romaji] === true) {
                    delete map.author[romaji];
                    changed.push(romaji);
                }
            });
            return changed;
        }).then(changed => {
            entries.forEach(({ link }) => {
                const star = link.previousElementSibling;
                if (star?.matches('.hitomi-tweak-favorite-star') && star.dataset.hitomiFavoriteKind === 'author') {
                    star.classList.toggle('is-favorited', nextFavorited);
                }
            });

            if (nextFavorited) {
                changed.forEach(romaji => {
                    fetchLatestGalleryId('author', romaji).then(latestId => {
                        if (!isFavorite('author', romaji) || !Number.isInteger(latestId) || latestId <= 0) return;
                        return updateFavoritesWatch(map => {
                            map.author[romaji] = latestId;
                            return true;
                        });
                    }).catch(() => {});
                });
            } else {
                changed.forEach(romaji => {
                    updateFavoritesWatch(map => {
                        delete map.author[romaji];
                        return true;
                    }).catch(() => {});
                });
            }
        }).catch(error => {
            console.error('Failed to update favorites.', error);
        });

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
        loadGalleryInfo(bookId).then(harvestNameMapKeys).catch(() => {});
        return true;
    }

    function clickReadOnlineButton() {
        const readOnlineButton = document.querySelector('a#read-online-button');
        if (!readOnlineButton) return false;

        readOnlineButton.click();
        harvestCurrentBookPage().catch(() => {});
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
        if (!focusedBook || !focusedBook.matches('div.gallery-content > div')) return false;

        getFilterBook(focusedBook).toggleManualFolded();
        return true;
    }

    function handleGlobalKeydown(e) {
        // Global shortcuts are plain-key only so browser/system shortcuts and text
        // entry fields keep their native behavior.
        if (!['/', 'a', 'b', 'c', 'd', 'j', 'k', 'r', 's', 't', 'v'].includes(e.key) || !hasPlainModifierState(e)) return;
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

        if (e.key === 's') {
            if (isReaderPage()) return;
            if (favoriteAuthorsOfFocusedBook()) {
                e.preventDefault();
            }
            return;
        }

        if (e.key === 'd') {
            if (isReaderPage()) return;

            e.preventDefault();
            const focused = getFocusedBook();
            if (focused?.matches('div.gallery-content > div')) {
                downloadFocusedBookFromList();
                return;
            }

            const dlButton = getDLButton();
            if (dlButton) {
                downloadBook(dlButton);
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
            const focused = getFocusedBook();
            if (focused) {
                const filterBook = getFilterBook(focused);
                if (filterBook.isBlocked()) {
                    e.preventDefault();
                    filterBook.shake();
                    return;
                }
            }
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
        progressContainer.style.minWidth = '240px';

        const progressBar = document.createElement('div');
        progressBar.id = 'hitomi-page-progress-bar';
        progressBar.style.width = '100%';
        progressBar.style.marginTop = '4px';
        progressBar.style.boxSizing = 'border-box';
        progressBar.style.padding = '8px 0';
        progressBar.style.cursor = 'pointer';
        progressBar.style.position = 'relative';

        const progressTrack = document.createElement('div');
        progressTrack.id = 'hitomi-page-progress-track';
        progressTrack.style.height = '4px';
        progressTrack.style.background = '#555';
        progressTrack.style.borderRadius = '2px';
        progressTrack.style.direction = 'rtl';
        progressTrack.style.position = 'relative';

        const progressFill = document.createElement('div');
        progressFill.id = 'hitomi-page-progress-fill';
        progressFill.style.height = '100%';
        progressFill.style.background = 'limegreen';
        progressFill.style.width = '0%';
        progressFill.style.borderRadius = '2px';
        progressFill.style.marginLeft = 'auto';

        const progressTooltip = document.createElement('span');
        progressTooltip.id = 'hitomi-page-progress-tooltip';
        progressTooltip.style.position = 'absolute';
        progressTooltip.style.pointerEvents = 'none';
        progressTooltip.style.display = 'none';

        progressTrack.appendChild(progressFill);
        progressBar.append(progressTrack, progressTooltip);
        progressContainer.append(progressDisplay, progressBar);
        li.appendChild(progressContainer);

        function pageFromClientX(clientX) {
            const barRect = progressBar.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (barRect.right - clientX) / barRect.width));
            const total = document.querySelector('#single-page-select')?.options.length || 1;
            return ratio === 0 ? 1 : Math.ceil(ratio * total);
        }

        function applyPreview(page) {
            const total = document.querySelector('#single-page-select')?.options.length || 1;
            progressDisplay.textContent = `${page} / ${total}`;
            progressFill.style.width = `${(page / total) * 100}%`;
        }

        function commitNavigation(page) {
            const select = document.querySelector('#single-page-select');
            if (!select) return;

            select.value = String(page);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            applyPreview(page);
        }

        function updateTooltipPosition(clientX) {
            const barRect = progressBar.getBoundingClientRect();
            const left = Math.min(barRect.width, Math.max(0, clientX - barRect.left));
            progressTooltip.textContent = String(pageFromClientX(clientX));
            progressTooltip.style.display = 'block';
            progressTooltip.style.left = `${left}px`;
        }

        function showTooltipAt(clientX) {
            updateTooltipPosition(clientX);
        }

        function hideTooltip() {
            progressTooltip.style.display = 'none';
        }

        let isDragging = false;
        progressBar.addEventListener('pointerenter', event => showTooltipAt(event.clientX));
        progressBar.addEventListener('pointerleave', hideTooltip);
        progressBar.addEventListener('pointermove', event => {
            if (isDragging) {
                applyPreview(pageFromClientX(event.clientX));
                updateTooltipPosition(event.clientX);
            } else if (progressTooltip.style.display !== 'none') {
                updateTooltipPosition(event.clientX);
            }
        });
        progressBar.addEventListener('pointerdown', event => {
            isDragging = true;
            progressBar.setPointerCapture(event.pointerId);
            applyPreview(pageFromClientX(event.clientX));
            showTooltipAt(event.clientX);
        });
        progressBar.addEventListener('pointerup', event => {
            if (!isDragging) return;

            isDragging = false;
            progressBar.releasePointerCapture(event.pointerId);
            const page = pageFromClientX(event.clientX);
            commitNavigation(page);
            hideTooltip();
        });

        document.addEventListener('keydown', event => {
            if (isEditableTarget(event.target)) return;
            if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

            if (event.key === 'a') {
                event.preventDefault();
                commitNavigation(1);
            } else if (event.key === 'e') {
                event.preventDefault();
                const total = document.querySelector('#single-page-select')?.options.length || 1;
                commitNavigation(total);
            }
        });

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
        if (isFavoritesPage()) {
            await renderFavoritesPage();
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
        if (isAllArtistsPage()) {
            installStyles();
            installConsolidatedNavMenu();
            installDownloadNavLink();
            installFavoritesNavLink();
            installNameMapNavLink();
            await loadNameMap();
            annotateAllArtistsPage(document.querySelector('div.content'));
            return;
        }
        if (await maybeRedirectToPreferredLanguage()) return;

        installStyles();
        document.addEventListener('keydown', handleGlobalKeydown);
        installConsolidatedNavMenu();
        installDownloadNavLink();
        installFavoritesNavLink();
        installNameMapNavLink();

        if (isReaderPage()) {
            installReaderProgress();
            return;
        }

        await loadNameMap();
        installInlineNameMapEditor();
        await loadFavorites();
        installFavoriteStars();
        installEnhancer();
        installDownloadNavigationGuard();
        installHistory();
        await installFilter();
    }

    main().catch(() => {});
})();
