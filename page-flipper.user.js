// ==UserScript==
// @name         Page Flipper
// @namespace    http://tampermonkey.net/
// @version      2.2.0
// @description  Use arrow keys and h/l to flip pages via rel=next/prev links on any site
// @match        http://*/*
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function handleKeyDown(event) {
        if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

        if (event.code === 'ArrowRight' || event.key === 'l') {
            if (clickRel('next')) {
                event.preventDefault();
            }
        } else if (event.code === 'ArrowLeft' || event.key === 'h') {
            if (clickRel('prev')) {
                event.preventDefault();
            }
        }
    }

    function isEditableTarget(target) {
        if (!(target instanceof Element)) return false;

        return Boolean(target.closest('input, textarea, select') || target.isContentEditable);
    }

    function findRelElem(rel) {
        return document.querySelector(`a[rel~="${rel}"], [rel="${rel}"]`);
    }

    function clickElem(elem) {
        if (!elem) return false;

        elem.click();
        return true;
    }

    function clickRel(rel) {
        return clickElem(findRelElem(rel));
    }

    window.addEventListener('keydown', handleKeyDown, true);
})();
