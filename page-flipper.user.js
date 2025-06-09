// ==UserScript==
// @name         Page Flipper
// @namespace    http://tampermonkey.net/
// @version      0.2.0
// @description  Use arrow keys to flip pages on supported sites
// @match        https://hitomi.la/*
// @match        https://tktube.com/*
// @match        https://jp.pictoa.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const keyBindingsBySite = {
        'hitomi.la': {
            ArrowLeft: 'a[rel=prev]',
            ArrowRight: 'a[rel=next]'
        },
        'tktube.com': {
            ArrowLeft: 'div.pagination-holder > ul > li.prev a',
            ArrowRight: 'div.pagination-holder > ul > li.next a'
        },
        'pictoa.com': {
            ArrowLeft: 'a#prev',
            ArrowRight: 'a#next',
        },
    };

    const currentHost = location.hostname;
    const keyToSelectorMap = keyBindingsBySite[currentHost];
    if (!keyToSelectorMap) return;

    function handleKeyDown(event) {
        const selector = keyToSelectorMap[event.key];
        if (!selector) return;

        const target = document.querySelector(selector);
        if (target) {
            target.click();
        }
    }

    window.addEventListener('keydown', handleKeyDown);
})();
