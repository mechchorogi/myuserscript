// ==UserScript==
// @name         Remove pocket cushion page
// @namespace    https://getpocket.com
// @version      1.0.0
// @description  Remove cushion page on getpocket.com
// @author       mechchorogi
// @match        https://getpocket.com/my-list
// @match        https://getpocket.com/my-list/*
// @icon         https://www.google.com/s2/favicons?domain=getpocket.com
// @grant        none
// ==/UserScript==

function remove_cushion() {
    document.querySelectorAll('article.grid').forEach(article => {
        let article_url = article.querySelector('a.publisher').href;
        article.querySelectorAll('a').forEach(a => {a.href = a.href != article_url ? article_url : a.href})
    });
}

(function() {
    'use strict';
    setInterval(remove_cushion, 500);
})();
