// ==UserScript==
// @name         Hitomi::Enhancer
// @namespace    http://hitomi.la/
// @version      1.0.0
// @description  Enhance hitomi.la with small layout and navigation tweaks
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

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
})();
