// ==UserScript==
// @name         Page Flipper
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  Use arrow keys to flip pages via rel=next/prev links on any site
// @match        http://*/*
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function handleKeyDown(event) {
        if (event.code === 'ArrowRight') {
            clickElem(nextElem);
        } else if (event.code === 'ArrowLeft') {
            clickElem(prevElem);
        }
    }

    let nextElem = null;
    let prevElem = null;

    function updateLinks() {
        // a[rel=next]優先、なければ他の[rel=next]
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
        } else {
            // aタグでなければ親aを探してクリック
            const a = elem.closest('a');
            if (a && typeof a.click === 'function') a.click();
        }
    }

    // 初期キャッシュ
    updateLinks();

    // DOM変化時にキャッシュを更新
    const observer = new MutationObserver(updateLinks);
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('keydown', handleKeyDown, true);
})();
