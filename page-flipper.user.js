// ==UserScript==
// @name         Page Flipper
// @namespace    http://tampermonkey.net/
// @version      2.1.0
// @description  Use arrow keys to flip pages via rel=next/prev links on any site
// @match        http://*/*
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function handleKeyDown(event) {
        if (event.code === 'ArrowRight') {
            updateLinks();
            clickElem(nextElem);
        } else if (event.code === 'ArrowLeft') {
            updateLinks();
            clickElem(prevElem);
        }
    }

    let nextElem = null;
    let prevElem = null;

    function updateLinks() {
        // Prefer a[rel=next], then fall back to any [rel=next].
        nextElem = document.querySelector('a[rel="next"]') || document.querySelector('[rel="next"]');
        prevElem = document.querySelector('a[rel="prev"]') || document.querySelector('[rel="prev"]');
        console.log('[PageFlipper] Links updated', {
            next: nextElem,
            prev: prevElem,
        });
    }

    function clickElem(elem) {
        if (!elem) return;

        if (typeof elem.click === 'function') {
            elem.click();
            return;
        }

        elem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    // Initial cache.
    updateLinks();

    // Update the cache when the DOM changes.
    const observer = new MutationObserver(updateLinks);
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['rel'],
    });

    window.addEventListener('keydown', handleKeyDown, true);
})();
