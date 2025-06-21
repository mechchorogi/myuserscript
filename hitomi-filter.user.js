// ==UserScript==
// @name         Hitomi::Filter
// @namespace    http://hitomi.la/
// @version      3.1.2
// @description  Filter hitomi.la using local GM-stored blacklist with integrated UI and foldable elements
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

        const header = this.elem.querySelector('h1.lillie');
        if (header) {
            header.style.cursor = 'pointer';
            header.addEventListener('click', () => {
                if (this.#isFolded()) {
                    this.#unfold();
                } else {
                    this.#fold();
                }
            });
        }

        this.elem.style.position = 'relative';
        this.#unfold();
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
    document.querySelectorAll('body > div > div.gallery-content > div').forEach(elem => {
        const book = new Book(elem);
        if (blackList.language.some(x => book.language.toLowerCase() === x.toLowerCase())) book.fold();
        if (blackList.author.some(x => book.authors.map(a => a.toLowerCase()).includes(x.toLowerCase()))) book.fold();
        if (blackList.tag.some(x => book.tags.map(t => t.toLowerCase()).includes(x.toLowerCase()))) book.fold();
        if (blackList.series.some(x => book.series.map(s => s.toLowerCase()).includes(x.toLowerCase()))) book.fold();
        if (blackList.title.some(x => book.title.toLowerCase().includes(x.toLowerCase()))) book.fold();
        if (blackList.type.some(x => book.type.toLowerCase() === x.toLowerCase())) book.fold();
    });
}

function observeGallery(blackList) {
    const gallery = document.querySelector('div.gallery-content');
    if (!gallery) return;

    if (gallery.children.length > 0) {
        filter(blackList);
    } else {
        const observer = new MutationObserver(() => {
            if (gallery.children.length > 0) {
                observer.disconnect();
                filter(blackList);
            }
        });
        observer.observe(gallery, { childList: true });
    }
}

function createUI() {
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'hitomi-filter-toggle';
    toggleBtn.textContent = '⚙️ Filter Settings';
    Object.assign(toggleBtn.style, {
        position: 'fixed',
        top: '10px',
        left: '10px',
        zIndex: 9999,
        fontSize: '14px'
    });

    const panel = document.createElement('div');
    panel.id = 'hitomi-filter-panel';
    panel.style.display = 'none';
    Object.assign(panel.style, {
        position: 'fixed',
        top: '10px',
        bottom: '10px',
        left: '10px',
        width: '600px',
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
    const state = { dirty: false };

    for (let k of KEYS) {
        const label = document.createElement('label');
        label.textContent = k.charAt(0).toUpperCase() + k.slice(1).toLowerCase() + ':';
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

    const closeBtn = document.createElement('button');
    closeBtn.id = 'hitomi-filter-close';
    closeBtn.textContent = 'Close';

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

const style = document.createElement('style');
style.textContent = `
  .hitomi-folded h1.lillie {
    padding-left: 0 !important;
    font-size: 0.9em !important;
  }
`;
document.head.appendChild(style);

(async () => {
    'use strict';
    createUI();
    const blackList = await loadBlacklist();
    observeGallery(blackList);
})();
