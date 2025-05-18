// ==UserScript==
// @name         Hitomi::Filter
// @namespace    http://hitomi.la/
// @version      1.0
// @description  Filter hitomi.la
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        none
// @run-at       document-idle
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
        this.tags     = this.#getList('td.relatedtags li', tag => tag != "...");
    }
    vanish(key, blacklist) {
        let candidates = Array.isArray(this[key]) ? this[key] : [this[key]];
        let lcCandidates = candidates.map(e => e.toLowerCase());
        let lcBlacklist  = blacklist.map(e => e.toLowerCase());

        let match = lcCandidates.find(val => lcBlacklist.includes(val));
        if (match) {
            console.log(`[Filtered] key: ${key}, match: "${match}", title: "${this.title}"`);
            this.elem.style.display = "none";
        }
    }
    #getText(selector) {
        return this.elem.querySelector(selector).textContent;
    }
    #getList(selector, filter) {
        let arr = Array.from(this.elem.querySelectorAll(selector), item => item.textContent);
        filter && (arr = arr.filter(filter));
        return arr;
    }
}

(async () => {
    'use strict';
    let fetchBlackList = async url => {
        const response = await fetch(url);
        const data = await response.json();
        return data;
    };

    let loadBlackList = async () => {
        return {
            author:   await fetchBlackList(AUTHOR_BLACKLIST),
            language: await fetchBlackList(LANGUAGE_BLACKLIST),
            series:   await fetchBlackList(SERIES_BLACKLIST),
            tag:      await fetchBlackList(TAG_BLACKLIST),
            title:    await fetchBlackList(TITLE_BLACKLIST),
            type:     await fetchBlackList(TYPE_BLACKLIST)
        };
    };

    let filter = (blackList) => {
        let books = Array.from(document.querySelectorAll('body > div > div.gallery-content > div'), elem => new Book(elem));
        books.forEach(book => {
            book.vanish('language', blackList.language);
            book.vanish('authors',  blackList.author);
            book.vanish('tags',     blackList.tag);
            book.vanish('series',   blackList.series);
            book.vanish('title',    blackList.title);
            book.vanish('type',     blackList.type);
        });
    };

    let blackList = await loadBlackList();

    const observer = new MutationObserver(records => filter(blackList));

    observer.observe(document.querySelector('div.gallery-content'), {childList: true, subtree: true});
})();
