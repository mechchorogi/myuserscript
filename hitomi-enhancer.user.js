// ==UserScript==
// @name         Hitomi::Enhancer
// @namespace    http://hitomi.la/
// @version      1.0.0
// @description  Enhance hitomi.la
// @author       mechchorogi
// @match        https://hitomi.la/
// @match        https://hitomi.la/artist/*-all.html
// @match        https://hitomi.la/tag/*-all.html
// @match        https://hitomi.la/series/*-all.html
// @match        https://hitomi.la/character/*-all.html
// @match        https://hitomi.la/group/*-all.html
// @match        https://hitomi.la/type/*-all.html
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const { pathname } = window.location;
    let redirectPath = null;

    if (pathname === '/') {
        redirectPath = '/index-japanese.html';
    } else {
        redirectPath = pathname.replace(
            /^\/(artist|tag|series|character|group|type)\/(.+)-all\.html$/,
            '/$1/$2-japanese.html'
        );

        if (redirectPath === pathname) {
            redirectPath = null;
        }
    }

    if (redirectPath) {
        window.location.replace(new URL(redirectPath, window.location.href).href);
    }
})();
