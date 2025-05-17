// ==UserScript==
// @name         Enable Right Click & Text Selection
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Removes restrictions on right-clicking and text selection on websites
// @author       mechchorogi
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 右クリックを有効化
    document.addEventListener('DOMContentLoaded', () => {
        document.body.oncontextmenu = null;
        document.body.removeAttribute('oncontextmenu');

        // すべての要素の `contextmenu` イベントを解除
        document.body.addEventListener('contextmenu', event => event.stopPropagation(), true);
        document.querySelectorAll('*').forEach(el => {
            el.oncontextmenu = null;
            el.removeAttribute('oncontextmenu');
        });
    });

    // 文字選択を有効化
    function enableTextSelection() {
        const styles = [
            'user-select: auto !important;',
            '-webkit-user-select: auto !important;',
            '-moz-user-select: auto !important;',
            '-ms-user-select: auto !important;'
        ].join(' ');

        // `style` タグを追加して全体の文字選択を有効化
        const styleElement = document.createElement('style');
        styleElement.textContent = `* { ${styles} }`;
        document.head.appendChild(styleElement);

        // すべての要素の `onselectstart` や `oncopy` イベントを解除
        document.querySelectorAll('*').forEach(el => {
            el.onselectstart = null;
            el.removeAttribute('onselectstart');
            el.oncopy = null;
            el.removeAttribute('oncopy');
        });
    }

    // `DOMContentLoaded` イベント後に適用
    document.addEventListener('DOMContentLoaded', enableTextSelection);
})();
