// ==UserScript==
// @name         Auto redirection
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  Unified script to handle automatic redirection/click for various sites
// @author       mechchorogi
// @match        http://www.pinktower.com/*
// @match        https://www.tumblr.com/safe-mode?*
// @match        https://jump.5ch.net/*
// @match        https://imgur.com/*
// @match        https://www.pixiv.net/jump.php*
// @match        https://getpocket.com/read/*
// @match        https://getpocket.com/ja/read/*
// @match        https://www.dmm.co.jp/age_check/*
// @match        http://newpuru.doorblog.jp/*
// @match        http://newmofu.doorblog.jp/*
// @match        https://imgur.com/*
// @match        https://giko-antenna.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    /**
     * 指定されたURLへページをリダイレクトする。
     * @param {string} url - リダイレクト先のURL
     */
    function redirect(url) {
        location.href = url;
    }

    /**
     * 指定したセレクタに合致する要素が存在しない場合、body配下に要素が追加されるのを監視し、見つかった時点でコールバックを実行する。
     * 既に要素が存在する場合は即座にコールバックを呼び出す。
     * @param {string} selector - 監視対象となる要素のセレクタ
     * @param {Function} callback - 要素が見つかったときに実行されるコールバック関数
     */
    function observeAndAct(selector, callback) {
        const existing = document.querySelector(selector);
        if (existing) {
            callback(existing);
            return;
        }
        const observer = new MutationObserver(() => {
            const elem = document.querySelector(selector);
            if (elem) {
                callback(elem);
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * 指定したセレクタに合致する要素を即座にクリックする。要素が既に存在する場合に使う。
     * @param {string} selector - クリック対象の要素のセレクタ
     */
    function click(selector) {
        const elem = document.querySelector(selector);
        if (elem) {
            elem.removeAttribute('target');
            elem.click();
        }
    }

    /**
     * 指定したセレクタに合致する要素が存在しない場合、要素が生成されるまで監視し、見つかった時点でクリックする。動的に追加される要素に対して有効。
     * @param {string} selector - クリック対象となる要素のセレクタ
     */
    function delayedClick(selector) {
        observeAndAct(selector, elem => {
            elem.click();
        });
    }

    switch (document.location.host) {
        case 'www.pinktower.com':
        case 'jump.5ch.net': {
            // URLの「?」より後ろを取り出してリダイレクト
            const newUrl = location.href.split('?')[1];
            if (newUrl) {
                redirect(newUrl);
            }
            break;
        }

        case 'www.tumblr.com': {
            // safe-mode?url=... の "url=" の後ろを取り出してリダイレクト先を組み立て
            const param = location.href.split('=')[1];
            if (param) {
                const decoded = decodeURIComponent(param);
                const blogHost = new URL(decoded).hostname.split('.')[0];
                redirect(`https://www.tumblr.com/blog/view/${blogHost}`);
            }
            break;
        }

        case 'www.pixiv.net': {
            // jump.phpの「?」の後ろをdecodeしてリダイレクト
            const newUrl = decodeURIComponent(location.href.split('?')[1]);
            if (newUrl) {
                redirect(newUrl);
            }
            break;
        }

        case 'getpocket.com': {
            // 動的に生成されるリンクが見つかり次第クリック
            delayedClick('a#reader\\.external-link\\.view-original');
            break;
        }

        case 'www.dmm.co.jp': {
            // URLを"="で分割し、インデックス2をdecodeしてリダイレクト
            const parts = location.href.split('=');
            if (parts[2]) {
                redirect(decodeURIComponent(parts[2]));
            }
            break;
        }

        case 'newpuru.doorblog.jp':
            click('a.titlelink');
            break;

        case 'newmofu.doorblog.jp':
            click('div.title_link a');
            break;

        case 'imgur.com':
            // 動的に生成される可能性がある要素を監視してクリック
            delayedClick('div.btn-wall--yes');
            break;
        case 'giko-antenna.com':
            click('a.article_link');
            break;
    }
})();
