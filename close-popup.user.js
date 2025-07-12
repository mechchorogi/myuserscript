// ==UserScript==
// @name         Close popup
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Automatically close known popups on supported sites
// @match        https://www.dmm.co.jp/*
// @match        https://www.amazon.co.jp/*
// @match        https://live.fc2.com/*
// @match        https://qiita.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // サイトごとのポップアップ要素のCSSセレクタ定義
    const popupSelectorsByHost = {
        'www.dmm.co.jp': [
            'div#campaign-popup-close'
        ],
        'www.amazon.co.jp': [
            'span#black-curtain-yes-button a'
        ],
        'live.fc2.com': [
            'a#age_ok_btn'
        ],
        'qiita.com': [
            'div[data-testid="popup-login"] button'
        ]
    };

    const currentHost = location.hostname;
    const selectors = popupSelectorsByHost[currentHost];
    if (!selectors) return;

    function closeMatchingPopups() {
        selectors.forEach(selector => {
            const element = document.querySelector(selector);
            if (element) {
                element.click();
            }
        });
    }

    // 初回実行
    closeMatchingPopups();

    // DOM変更を監視して再チェック（ポップアップが遅延表示される対策）
    const observer = new MutationObserver(closeMatchingPopups);
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
})();
