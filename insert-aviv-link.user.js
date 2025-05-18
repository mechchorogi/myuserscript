// ==UserScript==
// @name         Insert AV/IV query link
// @version      1.1.0
// @description  Insert AV/IV query link
// @author       mechchorogi
// @match        https://adult.contents.fc2.com/article/*/
// @match        https://www.dmm.co.jp/digital/video*/*
// @match        http://idolerotic.net/*
// @match        https://idolerotic.net/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const transformForTktube = query => query.replace(/-/g, "--");
    const makeAVUrl = query => `https://tktube.com/search/${transformForTktube(query)}/`;
    const makeIVUrl = query => `https://watchjavidol.com/?s=${query}`;

    function extractMediaIdFromDmm() {
        const cidMatch = location.href.match(/.*\/cid=([^\/?&]+)/);
        if (!cidMatch) return null;

        const [, rawId] = cidMatch;
        const idMatch = rawId.match(/([a-zA-Z]+)(\d+)/);
        if (!idMatch) return null;

        const [, prefix, digits] = idMatch;
        const padded = String(Number(digits)).padStart(3, '0');
        return `${prefix}-${padded}`;
    }

    const siteHandlers = {
        "adult.contents.fc2.com": () => {
            const idSegment = location.href.split('/').slice(-2)[0];
            return {
                mediaId: `FC2-PPV-${idSegment}`,
                insertSelector: ".items_article_headerInfo h3",
                urlBuilder: makeAVUrl
            };
        },
        "www.dmm.co.jp": () => {
            const mediaId = extractMediaIdFromDmm();
            if (!mediaId) return null;
            return {
                mediaId,
                insertSelector: "div.hreview",
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
        }
    };

    function insertQueryLink(label, selector, url) {
        const container = document.querySelector(selector);
        if (!container) return;

        const link = document.createElement('a');
        link.textContent = `💖 ${label}`;
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';

        container.appendChild(link);
    }

    const handler = siteHandlers[location.host];
    if (!handler) return;

    const result = handler();
    if (!result || !result.mediaId) return;

    const { mediaId, insertSelector, urlBuilder } = result;
    const queryUrl = urlBuilder(mediaId);
    insertQueryLink(mediaId, insertSelector, queryUrl);
})();
