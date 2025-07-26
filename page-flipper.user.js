// ==UserScript==
// @name         Page Flipper
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Use arrow keys to flip pages on supported sites
// @match        https://tktube.com/*
// @match        https://jp.pictoa.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const siteSettings = {
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

    function handleKeyDown(event) {
        if (settings.nextKeys.includes(event.key)) {
            const target = document.querySelector(settings.nextSelector);
            if (target) target.click();
        } else if (settings.prevKeys.includes(event.key)) {
            const target = document.querySelector(settings.prevSelector);
            if (target) target.click();
        }
    }

    window.addEventListener('keydown', handleKeyDown, true);
})();
