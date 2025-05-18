// ==UserScript==
// @name         Hitomi::Filter
// @namespace    http://hitomi.la/
// @version      1.1
// @description  Filter hitomi.la using blacklist
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        none
// @run-at       document-start
// ==/UserScript==

const BLACKLIST_GIST = "https://gist.githubusercontent.com/mechchorogi/03b23ad30b01f1823eacc3ca3dbc6e24";
const GIST_HASH      = "0fbe377e5dd3be92917027d9d2591bcf5c9be101";
const AUTHOR_BLACKLIST   = `${BLACKLIST_GIST}/raw/${GIST_HASH}/author.json`;
const LANGUAGE_BLACKLIST = `${BLACKLIST_GIST}/raw/${GIST_HASH}/language.json`;
const SERIES_BLACKLIST   = `${BLACKLIST_GIST}/raw/${GIST_HASH}/series.json`;
const TAG_BLACKLIST      = `${BLACKLIST_GIST}/raw/${GIST_HASH}/tag.json`;
const TITLE_BLACKLIST    = `${BLACKLIST_GIST}/raw/${GIST_HASH}/title.json`;
const TYPE_BLACKLIST     = `${BLACKLIST_GIST}/raw/${GIST_HASH}/type.json`;

class Book {
    constructor(elem) {
        this.elem     = elem;
        this.title    = this.#getText('h1.lillie');
        this.authors  = this.#getList('div.artist-list li');
        this.series   = this.#getList('table.dj-desc tr:nth-of-type(1) td:nth-of-type(2) li');
        this.type     = this.#getText('table.dj-desc tr:nth-of-type(2) td:nth-of-type(2)');
        this.language = this.#getText('table.dj-desc tr:nth-of-type(3) td:nth-of-type(2)');
        this.tags     = this.#getList('td.relatedtags li', tag => tag !== "...");
    }

    vanish(key, blacklist) {
        const candidates = Array.isArray(this[key]) ? this[key] : [this[key]];
        const lcCandidates = candidates.map(e => e.toLowerCase());
        const lcBlacklist = blacklist.map(e => e.toLowerCase());

        const match = lcCandidates.find(val => lcBlacklist.includes(val));
        if (match) {
            console.log(`[Filtered] key: ${key}, match: "${match}", title: "${this.title}"`);
            this.elem.style.display = "none";
        }
    }

    #getText(selector) {
        const node = this.elem.querySelector(selector);
        return node ? node.textContent : "";
    }

    #getList(selector, filter) {
        let arr = Array.from(this.elem.querySelectorAll(selector), item => item.textContent);
        return filter ? arr.filter(filter) : arr;
    }
}

(async () => {
    'use strict';

    const fetchBlackList = async (url) => {
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`Failed to fetch ${url}`);
            return [];
        }
        return await response.json();
    };

    const loadBlackList = async () => {
        return {
            author:   await fetchBlackList(AUTHOR_BLACKLIST),
            language: await fetchBlackList(LANGUAGE_BLACKLIST),
            series:   await fetchBlackList(SERIES_BLACKLIST),
            tag:      await fetchBlackList(TAG_BLACKLIST),
            title:    await fetchBlackList(TITLE_BLACKLIST),
            type:     await fetchBlackList(TYPE_BLACKLIST)
        };
    };

    const filter = (blackList) => {
        const books = Array.from(document.querySelectorAll('body > div > div.gallery-content > div'), elem => new Book(elem));
        books.forEach(book => {
            book.vanish('language', blackList.language);
            book.vanish('authors',  blackList.author);
            book.vanish('tags',     blackList.tag);
            book.vanish('series',   blackList.series);
            book.vanish('title',    blackList.title);
            book.vanish('type',     blackList.type);
        });
    };

    const blackList = await loadBlackList();

    const waitAndObserveGallery = () => {
        const gallery = document.querySelector('div.gallery-content');
        if (gallery) {
            filter(blackList);
            const observer = new MutationObserver(() => filter(blackList));
            observer.observe(gallery, { childList: true, subtree: true });
        } else {
            const htmlObserver = new MutationObserver(() => {
                const galleryNow = document.querySelector('div.gallery-content');
                if (galleryNow) {
                    htmlObserver.disconnect();
                    filter(blackList);
                    const observer = new MutationObserver(() => filter(blackList));
                    observer.observe(galleryNow, { childList: true, subtree: true });
                }
            });
            htmlObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
    };

    waitAndObserveGallery();
})();
