// ==UserScript==
// @name         Embed rel attributes
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Add rel=prev/next to pager links (e.g. for hitomi.la)
// @author       mechchorogi
// @match        http*://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const handlers = {
        'hitomi.la': {
            selectors: [
                'div.container',
                'div.page-container > ul'
            ],

            getTargets() {
                return this.selectors
                    .map(selector => document.querySelector(selector))
                    .filter(Boolean); // null を除外
            },

            embedRelAttributes() {
                const pager = document.querySelector('div.page-container > ul');
                if (!pager) return;

                const pageItems = Array.from(pager.querySelectorAll('li'));
                const current = pageItems.find(
                    item => item.childElementCount === 0 && item.innerText.trim() !== '...'
                );
                if (!current) return;

                if (current.previousElementSibling) {
                    const prevLink = current.previousElementSibling.querySelector('a');
                    if (prevLink) prevLink.rel = 'prev';
                }

                if (current.nextElementSibling) {
                    const nextLink = current.nextElementSibling.querySelector('a');
                    if (nextLink) nextLink.rel = 'next';
                }
            }
        }
    };

    const host = location.hostname;
    const handler = handlers[host];
    if (!handler) return;

    // 初回実行
    handler.embedRelAttributes();

    // DOM変化を監視して再付与（例: Ajax等で再描画された場合）
    const observer = new MutationObserver(() => {
        handler.embedRelAttributes();
        console.log('[EmbedRel] rel=prev/next embedded');
    });

    handler.getTargets().forEach(target => {
        observer.observe(target, { childList: true, subtree: true });
    });
})();
