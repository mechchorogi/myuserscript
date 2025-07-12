// ==UserScript==
// @name         Page Flipper
// @namespace    http://tampermonkey.net/
// @version      0.4.0
// @description  Use arrow keys to flip pages on supported sites
// @match        https://hitomi.la/*
// @match        https://tktube.com/*
// @match        https://jp.pictoa.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const siteConfigs = {
        'hitomi.la': {
            prevSelector: 'a#nextPanel',  // 'a#nextPanel' is actually the previous page link
            nextSelector: 'a#prevPanel',  // 'a#PrevPanel' is actually the next page link
        },
        'tktube.com': {
            prevSelector: 'div.pagination-holder > ul > li.prev a',
            nextSelector: 'div.pagination-holder > ul > li.next a',
        },
        'jp.pictoa.com': {
            prevSelector: 'a#prev',
            nextSelector: 'a#next',
        },
    };

    const currentHost = location.hostname;
    const siteConfig = siteConfigs[currentHost];
    if (!siteConfig) return;

    function handleKeyDown(event) {
        let selector;
        if (event.key === 'ArrowLeft' || (event.key === ' ' && !event.shiftKey)) {
            selector = siteConfig.prevSelector;
        } else if (event.key === 'ArrowRight' || (event.key === ' ' && event.shiftKey)) {
            selector = siteConfig.nextSelector;
        } else {
            return;
        }

        const target = document.querySelector(selector);
        if (target) {
            target.click();
        }
    }

    window.addEventListener('keydown', handleKeyDown);
})();
