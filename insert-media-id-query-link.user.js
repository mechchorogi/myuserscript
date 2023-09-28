// ==UserScript==
// @name         Insert AV/IV query link
// @version      0.5
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

    let mediaId = "";
    let insertSelector = "";
    let queryUrl = "";
    switch (document.location.host) {
    case "adult.contents.fc2.com":
        const lastSegment = document.location.href.split('/').slice(-2)[0];
        mediaId = `FC2-PPV-${lastSegment}`;
        insertSelector = ".items_article_headerInfo h3";
        queryUrl = generateAVQueryURL(mediaId);
        break;
    case "www.dmm.co.jp":
        mediaId = document.location.href.replace(/.*\/cid=(\D+)(0*)(\d+)\/.*/, "$1-$3");
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
