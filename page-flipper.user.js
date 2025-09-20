// ==UserScript==
// @name         Page Flipper
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  Use arrow keys to flip pages on supported sites
// @match        https://hitomi.la/*
// @match        https://tktube.com/*
// @match        https://jp.pictoa.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const siteSettings = {
        'hitomi.la': {
            nextSelector: 'a[rel=next]',
            prevSelector: 'a[rel=prev]',
            nextKeys: ['ArrowRight'],
            prevKeys: ['ArrowLeft']
        },
        'tktube.com': {
            nextSelector: 'div.pagination-holder > ul > li.next a',
            prevSelector: 'div.pagination-holder > ul > li.prev a',
            nextKeys: ['ArrowRight'],
            prevKeys: ['ArrowLeft']
        },
        'jp.pictoa.com': {
            nextSelector: 'a#next',
            prevSelector: 'a#prev',
            nextKeys: ['ArrowRight'],
            prevKeys: ['ArrowLeft']
        },
    };

    const currentHost = location.hostname;
    const settings = siteSettings[currentHost];
    if (!settings) return;

    function matchKey(event, keyDef) {
        return event.code === keyDef;
    }

    function handleKeyDown(event) {
        if (settings.nextKeys.some(k => matchKey(event, k))) {
            document.querySelector(settings.nextSelector)?.click();
        } else if (settings.prevKeys.some(k => matchKey(event, k))) {
            document.querySelector(settings.prevSelector)?.click();
        }
    }

    window.addEventListener('keydown', handleKeyDown, true);
})();
