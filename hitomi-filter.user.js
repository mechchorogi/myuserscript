// ==UserScript==
// @name         Hitomi::Filter
// @namespace    http://hitomi.la/
// @version      2.0.0
// @description  Filter hitomi.la using local GM-stored blacklist
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        GM.getValue
// @run-at       document-start
// ==/UserScript==

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

    const KEYS = ['author', 'language', 'series', 'tag', 'title', 'type'];

    const loadBlackList = async () => {
        const data = {};
        for (const key of KEYS) {
            const raw = await GM.getValue(`blacklist_${key}`, '');
            data[key] = raw.split('\n').map(s => s.trim()).filter(Boolean);
        }
        return data;
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
