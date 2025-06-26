// ==UserScript==
// @name         Hitomi::Filter
// @namespace    http://hitomi.la/
// @version      3.5.1
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

let filterEnabled = true;

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

        this.elem.addEventListener('click', (e) => {
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
    if (!filterEnabled) return;
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

async function blacklistClickHandler(e) {
    if (e.target.closest('#hitomi-filter-panel')) return;

    // prevent link navigation in blacklist mode
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
    for (let { selector, key } of map) {
        if (elem.matches(selector)) {
            const value = elem.textContent.trim();
            const current = await GM.getValue(`blacklist_${key}`, '');
            const lines = new Set(current.split('\n').map(l => l.trim()).filter(Boolean));
            lines.add(value);
            await GM.setValue(`blacklist_${key}`, [...lines].join('\n'));
            const input = document.querySelector(`#blacklist-input-${key}`);
            if (input) input.value = [...lines].join('\n');
            const blackList = await loadBlacklist();
            filter(blackList);
            break;
        }
    }
}

async function createUI() {
    const panel = document.createElement('div');
    panel.id = 'hitomi-filter-panel';
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

    saveBtn.addEventListener('click', async () => {
        await saveBlacklistFromInputs(panel);
        const blackList = await loadBlacklist();
        filter(blackList);
        saveBtn.disabled = true;
        state.dirty = false;
    });

    // Insert Export and Import buttons
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';

    const importBtn = document.createElement('button');
    importBtn.textContent = 'Import';

    exportBtn.addEventListener('click', async () => {
        const data = {};
        for (let k of KEYS) {
            const value = await GM.getValue(`blacklist_${k}`, '');
            data[k] = value;
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hitomi-filter-backup.json';
        a.click();
        URL.revokeObjectURL(url);
    });

    importBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
            if (!input.files.length) return;
            const file = input.files[0];
            const text = await file.text();
            try {
                const data = JSON.parse(text);
                for (let k of KEYS) {
                    if (typeof data[k] === 'string') {
                        await GM.setValue(`blacklist_${k}`, data[k]);
                        panel.querySelector(`#blacklist-input-${k}`).value = data[k];
                    }
                }
                const blackList = await loadBlacklist();
                filter(blackList);
            } catch (e) {
                alert('Invalid file format');
            }
        });
        input.click();
    });

    panel.appendChild(form);

    // Group Save, Blacklist Mode, and Export/Import buttons into three vertical rows
    const buttonRow = document.createElement('div');
    Object.assign(buttonRow.style, {
        marginTop: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px'
    });

    const group1 = document.createElement('div');
    Object.assign(group1.style, {
        display: 'flex',
        gap: '10px'
    });
    group1.appendChild(saveBtn);

    // Add the new "Blacklist Mode" toggle button
    const markModeBtn = document.createElement('button');
    markModeBtn.textContent = '🖊️ Blacklist Mode';
    markModeBtn.dataset.active = 'false';

    const group2 = document.createElement('div');
    Object.assign(group2.style, {
        display: 'flex',
        gap: '10px'
    });
    group2.appendChild(markModeBtn);

    const group3 = document.createElement('div');
    Object.assign(group3.style, {
        display: 'flex',
        gap: '10px'
    });
    group3.appendChild(exportBtn);
    group3.appendChild(importBtn);

    buttonRow.appendChild(group1);
    buttonRow.appendChild(group2);
    buttonRow.appendChild(group3);
    panel.appendChild(buttonRow);

    // Load and populate existing blacklist values
    for (let k of KEYS) {
        const value = await GM.getValue(`blacklist_${k}`, '');
        panel.querySelector(`#blacklist-input-${k}`).value = value;
    }

    markModeBtn.addEventListener('click', () => {
        const active = markModeBtn.dataset.active === 'true';
        markModeBtn.dataset.active = String(!active);
        markModeBtn.style.background = !active ? '#ffcccc' : '';
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
        justifyContent: 'space-between'
    });

    const toggleLabel = document.createElement('label');
    toggleLabel.textContent = 'Filter Enabled';

    const toggleCheckbox = document.createElement('input');
    toggleCheckbox.type = 'checkbox';
    toggleCheckbox.checked = filterEnabled;
    toggleCheckbox.addEventListener('change', () => {
        filterEnabled = toggleCheckbox.checked;
        if (filterEnabled) {
            loadBlacklist().then(filter);
        } else {
            document.querySelectorAll('body > div > div.gallery-content > div').forEach(elem => {
                const book = new Book(elem);
                book.folded = false;
            });
        }
    });

    toggleRow.appendChild(toggleLabel);
    toggleRow.appendChild(toggleCheckbox);
    panel.appendChild(toggleRow);

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
    if (location.pathname.startsWith('/reader/')) return;
    await createUI();
    const blackList = await loadBlacklist();
    observeGallery(blackList);
})();
