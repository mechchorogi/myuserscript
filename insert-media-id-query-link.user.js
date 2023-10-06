// ==UserScript==
// @name         Insert AV/IV query link
// @version      0.6
// @description  Insert AV/IV query link
// @author       mechchorogi
// @match        https://adult.contents.fc2.com/article/*/
// @match        https://www.dmm.co.jp/digital/videoa/*
// @match        http://idolerotic.net/*
// @match        https://idolerotic.net/*
// @grant        none
// ==/UserScript==

const transformForTktube = queryString => queryString.replace(/-/g, "--");

const generateAVQueryURL = queryString => `https://tktube.com/search/${transformForTktube(queryString)}/`;
const generateIVQueryURL = queryString => `https://watchjavidol.com/?s=${queryString}`;


(function() {
    'use strict';

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

    let mediaId, insertSelector, queryUrl;
    switch (document.location.host) {
    case "adult.contents.fc2.com":
        const lastSegment = document.location.href.split('/').slice(-2)[0];
        mediaId = `FC2-PPV-${lastSegment}`;
        insertSelector = ".items_article_headerInfo h3";
        queryUrl = generateAVQueryURL(mediaId);
        break;
    case "www.dmm.co.jp":
        preMediaId = document.location.href.replace(/.*\/cid=[h\d_]*(\D+)(\d+)\/.*/, "$1-$2");
        mediaId = (() => {
            const regex = /(\w+)-0*(\d+)/;
            const match = preMediaId.match(regex);
            if (!match) { return ""; }
            const number = parseInt(match[2], 10);
            const paddedNumber = number.toString().padStart(3, '0');
            return `${match[1]}-${paddedNumber}`;
        })();
        if (mediaId == "") break;
        insertSelector = "div.hreview";
        queryUrl = generateAVQueryURL(mediaId);
        break;
    case "idolerotic.net":
        mediaId = document.querySelector('div.eee p:last-child font:last-child').innerText.split('：').pop();
        insertSelector = "h1.entry-title";
        queryUrl = generateIVQueryURL(mediaId);
        break;
    }
    embedLink(mediaId, insertSelector, queryUrl);
})();
