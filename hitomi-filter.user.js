// ==UserScript==
// @name         Hitomi::Filter
// @namespace    http://hitomi.la/
// @version      3.0.0
// @description  Filter hitomi.la using local GM-stored blacklist with integrated UI
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @run-at       document-idle
// ==/UserScript==

const KEYS = ['author', 'language', 'series', 'tag', 'title', 'type'];

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

async function loadBlacklist() {
    const data = {};
    for (let k of KEYS) {
        const value = await GM.getValue(`blacklist_${k}`, '');
        data[k] = value.split('\n').map(s => s.trim()).filter(Boolean);
    }
    return data;
}

async function saveBlacklistFromInputs(container) {
    for (let k of KEYS) {
        const text = container.querySelector(`#blacklist-input-${k}`).value;
        await GM.setValue(`blacklist_${k}`, text);
    }
}

function filter(blackList) {
    const books = Array.from(document.querySelectorAll('body > div > div.gallery-content > div'), elem => new Book(elem));
    books.forEach(book => {
        book.vanish('language', blackList.language);
        book.vanish('authors',  blackList.author);
        book.vanish('tags',     blackList.tag);
        book.vanish('series',   blackList.series);
        book.vanish('title',    blackList.title);
        book.vanish('type',     blackList.type);
    });
}

function observeGallery(blackList) {
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
}

function createUI() {
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'hitomi-filter-toggle';
    toggleBtn.textContent = '⚙️ Filter Settings';
    Object.assign(toggleBtn.style, {
        position: 'fixed',
        top: '10px',
        right: '10px',
        zIndex: 9999,
        fontSize: '14px'
    });

    const panel = document.createElement('div');
    panel.id = 'hitomi-filter-panel';
    panel.style.display = 'none';
    Object.assign(panel.style, {
        position: 'fixed',
        top: '40px',
        right: '10px',
        width: '600px',
        maxHeight: '80vh',
        overflowY: 'auto',
        background: 'white',
        border: '1px solid #ccc',
        padding: '10px',
        zIndex: 9999
    });

    const form = document.createElement('div');
    const state = { dirty: false };

    for (let k of KEYS) {
        const label = document.createElement('label');
        label.textContent = k;
        label.style.display = 'block';
        label.style.marginTop = '8px';

        const textarea = document.createElement('textarea');
        textarea.id = `blacklist-input-${k}`;
        textarea.rows = 4;
        textarea.style.width = '100%';
        textarea.addEventListener('input', () => {
            state.dirty = true;
            saveBtn.disabled = false;
        });

        form.appendChild(label);
        form.appendChild(textarea);
    }

    const saveBtn = document.createElement('button');
    saveBtn.id = 'hitomi-filter-save';
    saveBtn.textContent = 'Save';
    saveBtn.disabled = true;
    saveBtn.style.marginTop = '10px';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'hitomi-filter-close';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginLeft = '10px';
    closeBtn.style.marginTop = '10px';

    saveBtn.addEventListener('click', async () => {
        await saveBlacklistFromInputs(panel);
        const blackList = await loadBlacklist();
        filter(blackList);
        saveBtn.disabled = true;
        state.dirty = false;
    });

    closeBtn.addEventListener('click', () => {
        if (state.dirty) {
            if (confirm('You have unsaved changes. Close without saving?')) {
                panel.style.display = 'none';
                state.dirty = false;
                saveBtn.disabled = true;
            }
        } else {
            panel.style.display = 'none';
        }
    });

    panel.appendChild(form);
    panel.appendChild(saveBtn);
    panel.appendChild(closeBtn);

    toggleBtn.addEventListener('click', async () => {
        if (panel.style.display === 'none') {
            for (let k of KEYS) {
                const value = await GM.getValue(`blacklist_${k}`, '');
                panel.querySelector(`#blacklist-input-${k}`).value = value;
            }
            panel.style.display = 'block';
            state.dirty = false;
            saveBtn.disabled = true;
        } else {
            panel.style.display = 'none';
        }
    });

    document.body.appendChild(toggleBtn);
    document.body.appendChild(panel);
}

(async () => {
    'use strict';
    createUI();
    const blackList = await loadBlacklist();
    observeGallery(blackList);
})();
