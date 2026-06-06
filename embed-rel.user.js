// ==UserScript==
// @name         Embed rel attributes
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Add rel=prev/next to pager links (e.g. for hitomi.la)
// @author       mechchorogi
// @match        http://*/*
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function defineHandler(selector, embed) {
        return { selector, embed };
    }

    const handlers = {
        'hitomi.la': defineHandler('div.page-container > ul', function () {
            const pager = document.querySelector('div.page-container > ul');
            if (!pager) return false;

            const pages = Array.from(pager.querySelectorAll('li'));
            const current = pages.find(
                item => item.childElementCount === 0 && item.innerText.trim() !== '...'
            );
            if (!current) return false;

            let success = false;

            if (current.previousElementSibling) {
                const prevLink = current.previousElementSibling.querySelector('a');
                if (prevLink) {
                    prevLink.rel = 'prev';
                    success = true;
                }
            }

            if (current.nextElementSibling) {
                const nextLink = current.nextElementSibling.querySelector('a');
                if (nextLink) {
                    nextLink.rel = 'next';
                    success = true;
                }
            }

            return success;
        }),
        'www.iwara.tv': defineHandler('.pagination', function () {
            let success = false;

            function setRelByIcon(iconSelector, rel) {
                const icon = document.querySelector(`.pagination > li ${iconSelector}`);
                const item = icon?.closest('li');
                if (item?.parentElement?.matches('.pagination')) {
                    icon.removeAttribute('rel');
                    item.setAttribute('rel', rel);
                    return true;
                }
                return false;
            }

            success = setRelByIcon('svg.fa-angle-left', 'prev') || success;
            success = setRelByIcon('svg.fa-angle-right', 'next') || success;

            return success;
        })
    };

    const host = location.hostname;
    const handler = handlers[host];
    if (!handler) return;

    // 目的の要素が現れるまでbody全体を監視し、見つかったら本来の監視に切り替える
    const observer = new MutationObserver(() => {
        const ok = handler.embed();
        if (ok) {
            console.log('[EmbedRel] rel=prev/next embedded');
        }
    });

    function tryStartTargetObserver() {
        const target = document.querySelector(handler.selector);
        if (target) {
            observer.observe(target, { childList: true, subtree: true });
            const ok = handler.embed();
            if (ok) {
                console.log('[EmbedRel] rel=prev/next embedded');
            }
            initialObserver.disconnect();
            return true;
        }
        return false;
    }

    // body全体を一時的に監視
    const initialObserver = new MutationObserver(() => {
        tryStartTargetObserver();
    });
    initialObserver.observe(document.body, { childList: true, subtree: true });

    // ページロード直後にも一度チェック
    tryStartTargetObserver();
})();
