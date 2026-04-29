// ==UserScript==
// @name         Embed rel attributes
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Add rel=prev/next to pager links (e.g. for hitomi.la)
// @author       mechchorogi
// @match        http*://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const handlers = {
        'hitomi.la': {
            selector: 'div.page-container > ul',

            embedRelAttributes() {
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
            }
        },
        'www.iwara.tv': {
            selector: '.pagination',

            embedRelAttributes() {
                // prev: .pagination li svg.fa-angle-left
                // next: .pagination li svg.fa-angle-right
                let success = false;
                const prevSvg = document.querySelector('.pagination li svg.fa-angle-left');
                if (prevSvg) {
                    const prevLi = prevSvg.closest('li');
                    if (prevLi) {
                        prevLi.setAttribute('rel', 'prev');
                        success = true;
                    }
                }
                const nextSvg = document.querySelector('.pagination li svg.fa-angle-right');
                if (nextSvg) {
                    const nextLi = nextSvg.closest('li');
                    if (nextLi) {
                        nextLi.setAttribute('rel', 'next');
                        success = true;
                    }
                }

                return success;
            }
        }
    };

    const host = location.hostname;
    const handler = handlers[host];
    if (!handler) return;

    // 目的の要素が現れるまでbody全体を監視し、見つかったら本来の監視に切り替える
    const observer = new MutationObserver(() => {
        const ok = handler.embedRelAttributes();
        if (ok) {
            console.log('[EmbedRel] rel=prev/next embedded');
        }
    });

    function tryStartTargetObserver() {
        const target = document.querySelector(handler.selector);
        if (target) {
            observer.observe(target, { childList: true, subtree: true });
            const ok = handler.embedRelAttributes();
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
