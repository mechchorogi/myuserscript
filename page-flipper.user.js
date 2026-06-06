// ==UserScript==
// @name         Page Flipper
// @namespace    http://tampermonkey.net/
// @version      2.1.2
// @description  Use arrow keys to flip pages via rel=next/prev links on any site
// @match        http://*/*
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function handleKeyDown(event) {
        if (event.code === 'ArrowRight') {
            clickRel('next');
        } else if (event.code === 'ArrowLeft') {
            clickRel('prev');
        }
    }

    function findRelElem(rel) {
        return document.querySelector(`a[rel~="${rel}"], [rel="${rel}"]`);
    }

    function clickElem(elem) {
        if (!elem) return;

        elem.click();
    }

    function clickRel(rel) {
        clickElem(findRelElem(rel));
    }

    window.addEventListener('keydown', handleKeyDown, true);
})();
