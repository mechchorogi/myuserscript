// ==UserScript==
// @name         Embed rel attributes
// @namespace    http://tampermonkey.net/
// @version      1.2.2
// @description  Add rel=prev/next to pager links (e.g. for hitomi.la)
// @author       mechchorogi
// @match        http://*/*
// @match        https://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const handlers = {
        'hitomi.la': function () {
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
        },
        'www.iwara.tv': function () {
            let success = false;

            function setRelByIcon(pager, iconSelector, rel) {
                const icon = pager.querySelector(`.pagination__items > li ${iconSelector}`);
                const item = icon?.closest('.pagination__item');
                if (item && !item.classList.contains('pagination__item--disabled')) {
                    item.setAttribute('rel', rel);
                    return true;
                }
                return false;
            }

            document.querySelectorAll('.pagination').forEach(pager => {
                pager.querySelectorAll('[rel="prev"], [rel="next"]').forEach(item => {
                    item.removeAttribute('rel');
                });
                success = setRelByIcon(pager, 'svg.fa-angle-left', 'prev') || success;
                success = setRelByIcon(pager, 'svg.fa-angle-right', 'next') || success;
            });

            return success;
        }
    };

    const host = location.hostname;
    const handler = handlers[host];
    if (!handler) return;

    function embedRel() {
        const ok = handler();
        if (ok) {
            console.log('[EmbedRel] rel=prev/next embedded');
        }
    }

    let timerId = null;

    function scheduleEmbedRel() {
        clearTimeout(timerId);
        timerId = setTimeout(() => {
            embedRel();
            setTimeout(embedRel, 300);
            setTimeout(embedRel, 1000);
        }, 100);
    }

    // Keep watching the body because SPA navigation may replace or rerender the target element.
    const bodyObserver = new MutationObserver(() => {
        scheduleEmbedRel();
    });
    bodyObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
    });

    window.addEventListener('popstate', scheduleEmbedRel);
    ['pushState', 'replaceState'].forEach(method => {
        const original = history[method];
        history[method] = function () {
            const result = original.apply(this, arguments);
            scheduleEmbedRel();
            return result;
        };
    });

    // Check once immediately after page load.
    embedRel();
})();
