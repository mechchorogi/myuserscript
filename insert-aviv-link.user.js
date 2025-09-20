// ==UserScript==
// @name         Insert AV/IV query link
// @version      1.4
// @description  Insert AV/IV query link
// @author       mechchorogi
// @match        https://adult.contents.fc2.com/article/*/
// @match        https://video.dmm.co.jp/*
// @match        http://idolerotic.net/*
// @match        https://idolerotic.net/*
// @match        https://www.mgstage.com/product/product_detail/*
// @match        https://www.dlsite.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const transformForTktube = query => query.replace(/-/g, "--");
    const makeAVUrl = query => `https://tktube.com/search/${transformForTktube(query)}/`;
    const makeIVUrl = query => `https://watchjavidol.com/?s=${query}`;
    const makeHitomiUrl = query => `https://hitomi.la/search.html?${query}`;

    function extractMediaIdFromDmm() {
        const url = new URL(location.href);
        const rawid = url.searchParams.get("id");
        const idMatch = rawid.match(/([a-zA-Z]+)(\d+)/);
        if (!idMatch) {
            console.warn("Could not extract media ID from DMM URL");
            return null;
        }

        const [, prefix, digits] = idMatch;
        const padded = String(Number(digits)).padStart(3, '0');
        return `${prefix}-${padded}`;
    }

    const siteHandlers = {
        "www.mgstage.com": () => {
            const match = location.pathname.match(/\/product\/product_detail\/(?:\d+)?([A-Z]+-\d+)/);
            if (!match) return null;

            const mediaId = match[1];
            return {
                mediaId,
                insertSelector: "h1.tag",
                urlBuilder: makeAVUrl
            };
        },
        "adult.contents.fc2.com": () => {
            const idSegment = location.href.split('/').slice(-2)[0];
            return {
                mediaId: `FC2-PPV-${idSegment}`,
                insertSelector: ".items_article_headerInfo h3",
                urlBuilder: makeAVUrl
            };
        },
        "video.dmm.co.jp": () => {
            const mediaId = extractMediaIdFromDmm();
            if (!mediaId) return null;
            return {
                mediaId,
                insertSelector: "div:has(>h1)",
                urlBuilder: makeAVUrl
            };
        },
        "idolerotic.net": () => {
            const text = document.querySelector('div.eee p:last-child font:last-child')?.innerText;
            if (!text) return null;
            const mediaId = text.split('：').pop();
            return {
                mediaId,
                insertSelector: "h1.entry-title",
                urlBuilder: makeIVUrl
            };
        },
        "www.dlsite.com": () => {
            const text = document.querySelector('h1#work_name')?.innerText;
            if (!text) return null;
            return {
                mediaId: text,
                insertSelector: "div.base_title_br",
                urlBuilder: makeHitomiUrl
            };
        }
    };

    function insertQueryLink(label, selector, url) {
        const container = document.querySelector(selector);
        if (!container) {
            console.warn(`Could not find container with selector: ${selector}`);
            return;
        }

        const link = document.createElement('a');
        link.textContent = `💖 ${label}`;
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';

        container.appendChild(link);
    }

    function waitForElement(selector, callback, timeout = 5000) {
        const element = document.querySelector(selector);
        if (element) {
            callback(element);
            return;
        }

        const observer = new MutationObserver((mutations, obs) => {
            const el = document.querySelector(selector);
            if (el) {
                obs.disconnect();
                callback(el);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        if (timeout) {
            setTimeout(() => {
                observer.disconnect();
            }, timeout);
        }
    }

    const handler = siteHandlers[location.host];
    if (!handler) {
        console.warn(`No handler for host: ${location.host}`);
        return;
    }

    const result = handler();
    if (!result || !result.mediaId) {
        console.warn(`Could not extract media ID on host: ${location.host}`);
        return;
    }

    const { mediaId, insertSelector, urlBuilder } = result;
    const queryUrl = urlBuilder(mediaId);
    waitForElement(insertSelector, (container) => {
        insertQueryLink(mediaId, insertSelector, queryUrl);
    });
})();
