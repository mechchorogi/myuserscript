// ==UserScript==
// @name         Hitomi::Filter with UI
// @namespace    http://hitomi.la/
// @version      1.0.0
// @description  Filter hitomi.la with local editable blacklist
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const KEYS = ['author', 'language', 'series', 'tag', 'title', 'type'];
    const STORAGE_KEYS = KEYS.map(k => `blacklist_${k}`);

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

    createUI();
})();
