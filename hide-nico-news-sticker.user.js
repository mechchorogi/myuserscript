// ==UserScript==
// @name         Hide nico news sticker
// @namespace    https://www.nicovideo.jp/
// @version      1.0.0
// @description  Hide nico news sticker
// @author       You
// @match        https://www.nicovideo.jp/watch/*
// @icon         https://www.google.com/s2/favicons?domain=nicovideo.jp
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    document.querySelector('div.MainContainer-marquee').style.display = "none"
})();
