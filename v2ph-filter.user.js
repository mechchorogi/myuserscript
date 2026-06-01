// ==UserScript==
// @name         V2PH::Filter
// @namespace    https://www.v2ph.com/
// @version      1.0.0
// @description  Filter v2ph albums by title keywords, model names, and tags
// @author       mechchorogi
// @match        https://www.v2ph.com/*
// @icon         https://www.google.com/s2/favicons?domain=v2ph.com
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @run-at       document-idle
// ==/UserScript==

const KEYS = ['title', 'model', 'tag'];
let filterEnabled = true;

class Card {
    constructor(elem) {
        this.elem   = elem;
        this.title  = this.#getText('div.media-meta h6');
        this.models = this.#getMetaByLabel('モデル');
        this.tags   = this.#getMetaByLabel('タグ');
    }

    #getText(selector) {
        const node = this.elem.querySelector(selector);
        return node ? node.textContent.trim() : '';
    }

    #getMetaByLabel(label) {
        const dl = this.elem.querySelector('div.media-meta dl');
        if (!dl) return [];
        for (const dt of dl.querySelectorAll('dt')) {
            if (dt.textContent.trim() !== label) continue;
            const dd = dt.nextElementSibling;
            if (!dd) continue;
            const links = dd.querySelectorAll('a');
            const source = links.length > 0
                ? Array.from(links).map(a => a.textContent).join(',')
                : dd.textContent;
            return source.split(',').map(v => v.trim()).filter(Boolean);
        }
        return [];
    }

    setFiltered(matches) {
        const cover = this.elem.querySelector('div.card-cover');
        if (!cover) return;

        this.elem.querySelectorAll('.v2ph-match').forEach(el => el.classList.remove('v2ph-match'));

        if (matches.matched) {
            cover.classList.add('v2ph-filtered');
            if (!cover.querySelector('.v2ph-overlay')) {
                const overlay = document.createElement('div');
                overlay.className = 'v2ph-overlay';
                overlay.textContent = 'Filtered!';
                cover.appendChild(overlay);
            }
            this.#applyHighlights(matches);
        } else {
            cover.classList.remove('v2ph-filtered');
            cover.querySelector('.v2ph-overlay')?.remove();
        }
    }

    #applyHighlights(matches) {
        if (matches.titleMatched) {
            this.elem.querySelector('.media-meta h6')?.classList.add('v2ph-match');
        }
        const dl = this.elem.querySelector('div.media-meta dl');
        if (!dl) return;
        if (matches.models.length > 0) this.#highlightDd(dl, 'モデル', matches.models);
        if (matches.tags.length > 0)   this.#highlightDd(dl, 'タグ',   matches.tags);
    }

    #highlightDd(dl, label, matchedValues) {
        const lcMatched = matchedValues.map(v => v.toLowerCase());
        for (const dt of dl.querySelectorAll('dt')) {
            if (dt.textContent.trim() !== label) continue;
            const dd = dt.nextElementSibling;
            if (!dd) continue;
            for (const a of dd.querySelectorAll('a')) {
                const vals = a.textContent.split(',').map(v => v.trim().toLowerCase());
                if (vals.some(v => lcMatched.includes(v))) a.classList.add('v2ph-match');
            }
        }
    }
}

async function loadBlacklist() {
    const data = {};
    for (const k of KEYS) {
        const value = await GM.getValue(`blacklist_${k}`, '');
        if (k === 'title') {
            // Preserve internal/leading/trailing spaces for regex patterns; only drop blank lines
            data[k] = value.split(/\r?\n/).filter(s => s.trim() !== '');
        } else {
            data[k] = value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        }
    }
    return data;
}


function getMatches(card, blackList) {
    const lcModels = card.models.map(x => x.toLowerCase());
    const models = blackList.model.filter(m => lcModels.includes(m.toLowerCase()));

    const lcTags = card.tags.map(x => x.toLowerCase());
    const tags = blackList.tag.filter(t => lcTags.includes(t.toLowerCase()));

    const titleMatched = blackList.title.some(t => {
        try { return new RegExp(t, 'i').test(card.title); }
        catch { return false; }
    });

    return { matched: models.length > 0 || tags.length > 0 || titleMatched, models, tags, titleMatched };
}

function applyFilter(blackList) {
    if (!filterEnabled) return;
    document.querySelectorAll('main#content .card').forEach(elem => {
        const card = new Card(elem);
        card.setFiltered(getMatches(card, blackList));
    });
}

function clearFilter() {
    document.querySelectorAll('main#content .card-cover.v2ph-filtered').forEach(el => {
        el.querySelector('.v2ph-overlay')?.remove();
        el.classList.remove('v2ph-filtered');
    });
    document.querySelectorAll('main#content .v2ph-match').forEach(el => el.classList.remove('v2ph-match'));
}

async function blacklistClickHandler(e) {
    if (e.target.closest('#v2ph-filter-panel')) return;

    const link = e.target.closest('a');
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();

    const dd = link.closest('dd');
    if (!dd) return;

    let dt = dd.previousElementSibling;
    while (dt && dt.tagName !== 'DT') dt = dt.previousElementSibling;
    if (!dt) return;

    const label = dt.textContent.trim();
    const key = label === 'モデル' ? 'model' : label === 'タグ' ? 'tag' : null;
    if (!key) return;

    const value = link.textContent.trim();
    const current = await GM.getValue(`blacklist_${key}`, '');
    const lines = new Set(current.split('\n').map(l => l.trim()).filter(Boolean));
    lines.add(value);
    await GM.setValue(`blacklist_${key}`, [...lines].join('\n'));

    const input = document.querySelector(`#v2ph-blacklist-input-${key}`);
    if (input) input.value = [...lines].join('\n');

    const blackList = await loadBlacklist();
    applyFilter(blackList);
}

async function createUI() {
    const panel = document.createElement('div');
    panel.id = 'v2ph-filter-panel';
    Object.assign(panel.style, {
        position:   'fixed',
        top:        '10px',
        bottom:     '10px',
        right:      '10px',
        width:      '160px',
        overflowY:  'auto',
        background: 'rgba(255, 255, 255, 0.92)',
        border:     '1px solid rgba(0, 0, 0, 0.1)',
        borderRadius: '8px',
        padding:    '16px',
        boxShadow:  '0 4px 20px rgba(0, 0, 0, 0.1)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
        fontSize:   '14px',
        zIndex:     '9999'
    });

    const labelText = { title: 'Title (regex)', model: 'Model', tag: 'Tag' };
    const form = document.createElement('div');
    let saveTimer = null;

    for (const k of KEYS) {
        const label = document.createElement('label');
        label.textContent = labelText[k] + ':';
        label.style.display = 'block';
        label.style.marginTop = '8px';

        const textarea = document.createElement('textarea');
        textarea.id = `v2ph-blacklist-input-${k}`;
        textarea.rows = 4;
        textarea.style.width = '100%';
        textarea.addEventListener('input', () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(async () => {
                for (const key of KEYS) {
                    const ta = panel.querySelector(`#v2ph-blacklist-input-${key}`);
                    if (ta) await GM.setValue(`blacklist_${key}`, ta.value);
                }
                const blackList = await loadBlacklist();
                applyFilter(blackList);
            }, 400);
        });

        form.appendChild(label);
        form.appendChild(textarea);
    }

    const markModeBtn = document.createElement('button');
    markModeBtn.textContent = '🖊️ Blacklist Mode';
    markModeBtn.dataset.active = 'false';
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

    document.addEventListener('keydown', e => {
        if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            markModeBtn.click();
        }
    });

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.addEventListener('click', async () => {
        const data = {};
        for (const k of KEYS) data[k] = await GM.getValue(`blacklist_${k}`, '');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'v2ph-filter-backup.json';
        a.click();
        URL.revokeObjectURL(url);
    });

    const importBtn = document.createElement('button');
    importBtn.textContent = 'Import';
    importBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
            if (!input.files.length) return;
            const text = await input.files[0].text();
            try {
                const data = JSON.parse(text);
                for (const k of KEYS) {
                    if (typeof data[k] === 'string') {
                        await GM.setValue(`blacklist_${k}`, data[k]);
                        panel.querySelector(`#v2ph-blacklist-input-${k}`).value = data[k];
                    }
                }
                const blackList = await loadBlacklist();
                applyFilter(blackList);
            } catch {
                alert('Invalid file format');
            }
        });
        input.click();
    });

    const toggleCheckbox = document.createElement('input');
    toggleCheckbox.type = 'checkbox';
    toggleCheckbox.checked = true;
    toggleCheckbox.addEventListener('change', async () => {
        filterEnabled = toggleCheckbox.checked;
        if (filterEnabled) {
            const blackList = await loadBlacklist();
            applyFilter(blackList);
        } else {
            clearFilter();
        }
    });

    const buttonRow = document.createElement('div');
    Object.assign(buttonRow.style, {
        marginTop:     '10px',
        display:       'flex',
        flexDirection: 'column',
        gap:           '8px'
    });

    const row2 = document.createElement('div');
    row2.appendChild(markModeBtn);

    const row3 = document.createElement('div');
    row3.style.cssText = 'display:flex;gap:6px';
    row3.appendChild(exportBtn);
    row3.appendChild(importBtn);

    const row4 = document.createElement('div');
    row4.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-top:6px';
    const toggleLabel = document.createElement('label');
    toggleLabel.textContent = 'Filter Enabled';
    row4.appendChild(toggleLabel);
    row4.appendChild(toggleCheckbox);

    buttonRow.appendChild(row2);
    buttonRow.appendChild(row3);
    buttonRow.appendChild(row4);

    panel.appendChild(form);
    panel.appendChild(buttonRow);

    for (const k of KEYS) {
        const value = await GM.getValue(`blacklist_${k}`, '');
        panel.querySelector(`#v2ph-blacklist-input-${k}`).value = value;
    }

    document.body.appendChild(panel);
}

function observeContent() {
    const content = document.querySelector('main#content');
    if (!content) return;

    let timer = null;
    const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            if (!filterEnabled) return;
            const blackList = await loadBlacklist();
            applyFilter(blackList);
        }, 150);
    });
    observer.observe(content, { childList: true, subtree: true });
}

const style = document.createElement('style');
style.textContent = `
  .v2ph-filtered {
    position: relative !important;
  }
  .v2ph-filtered > *:not(.v2ph-overlay) {
    visibility: hidden;
  }
  .v2ph-overlay {
    position: absolute;
    inset: 0;
    background: #cccccc;
    color: #666666;
    font-weight: bold;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9998;
    pointer-events: none;
  }
  .v2ph-match {
    background-color: rgba(220, 50, 50, 0.18);
    border-radius: 3px;
  }
`;
document.head.appendChild(style);

(async () => {
    'use strict';
    await createUI();
    const blackList = await loadBlacklist();
    applyFilter(blackList);
    observeContent();
})();
