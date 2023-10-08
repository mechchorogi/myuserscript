// ==UserScript==
// @name         Insert AV/IV query link
// @version      0.12
// @description  Insert AV/IV query link
// @author       mechchorogi
// @match        https://adult.contents.fc2.com/article/*/
// @match        https://www.dmm.co.jp/digital/videoa/*
// @match        https://www.dmm.co.jp/digital/videoc/*
// @match        http://idolerotic.net/*
// @match        https://idolerotic.net/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const transformForTktube = queryString => queryString.replace(/-/g, "--");

    const generateAVQueryURL = queryString => `https://tktube.com/search/${transformForTktube(queryString)}/`;
    const generateIVQueryURL = queryString => `https://watchjavidol.com/?s=${queryString}`;

    const handlers = {
        "adult.contents.fc2.com": () => {
            const lastSegment = document.location.href.split('/').slice(-2)[0];
            return {
                mediaId: `FC2-PPV-${lastSegment}`,
                insertSelector: ".items_article_headerInfo h3",
                queryUrlGenerator: generateAVQueryURL
            };
        },
        "www.dmm.co.jp": () => {
            const mediaId = (function() {
                const cidMatch = document.location.href.match(/.*\/cid=([^\/?&]+)/);
                if (!cidMatch) return null;

                const [, mediaIdPart] = cidMatch;
                const idMatch = mediaIdPart.match(/([a-zA-Z]+)(\d+)/);
                if (!idMatch) return null;

                const [, alphaPart, digits] = idMatch;
                const numberPart = String(digits).padStart(3, '0');
                return `${alphaPart}-${numberPart}`
            })();
            if (!mediaId) return null;
            return {
                mediaId,
                insertSelector: "div.hreview",
                queryUrlGenerator: generateAVQueryURL
            };
        },
        "idolerotic.net": () => {
            const mediaId = document.querySelector('div.eee p:last-child font:last-child')?.innerText.split('：').pop();
            return {
                mediaId,
                insertSelector: "h1.entry-title",
                queryUrlGenerator: generateIVQueryURL
            };
        }
    };

    const embedLink = (linkText, cssSelector, queryUrl) => {
        const targetElement = document.querySelector(cssSelector);
        if (!targetElement) return;

        const searchLink = document.createElement('a');
        searchLink.textContent = `💖 ${linkText}`;
        searchLink.href = queryUrl;
        searchLink.target = '_blank';
        searchLink.rel = 'noopener noreferrer';
        targetElement.appendChild(searchLink);
    };

    const hostHandler = handlers[document.location.host];

    if (hostHandler) {
        const handlerResult = hostHandler();
        if (!handlerResult) return;
        const { mediaId, insertSelector, queryUrlGenerator } = handlerResult;
        if (!mediaId) return;
        const queryUrl = queryUrlGenerator(mediaId);
        embedLink(mediaId, insertSelector, queryUrl);
    }
})();
