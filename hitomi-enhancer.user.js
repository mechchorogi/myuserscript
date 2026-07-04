// ==UserScript==
// @name         Hitomi::Enhancer
// @namespace    http://hitomi.la/
// @version      1.1.0
// @description  Enhance hitomi.la with small layout and navigation tweaks
// @author       mechchorogi
// @match        https://hitomi.la/*
// @icon         https://www.google.com/s2/favicons?domain=hitomi.la
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const focusedBookClassName = 'hitomi-enhancer-focused-book';
    let focusedBook = null;

    function removeAdPlaceholder() {
        const content = document.querySelector('div.content, div.top-content');
        if (!content || content.firstElementChild?.tagName !== 'DIV') return false;

        content.firstElementChild.remove();
        return true;
    }

    function openReadOnlineInNewTab() {
        document
            .querySelectorAll('#read-online-button, div.container > div.content > div.cover-column.lillie > div.cover > a')
            .forEach(link => {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            });
    }

    function installBookNavigationStyle() {
        const style = document.createElement('style');
        style.textContent = `
            div.gallery-content > div.${focusedBookClassName} {
                position: relative;
                outline: 3px solid rgba(56, 189, 248, 0.95);
                outline-offset: 8px;
                border-radius: 8px;
                box-shadow:
                    0 0 0 1px rgba(14, 165, 233, 0.45),
                    0 0 26px rgba(56, 189, 248, 0.38),
                    0 12px 34px rgba(15, 23, 42, 0.16);
                transition: outline-color 120ms ease, box-shadow 120ms ease;
            }
        `;
        document.head.appendChild(style);
    }

    function getBooks() {
        return Array.from(document.querySelectorAll('div.gallery-content > div'));
    }

    function isEditableTarget(target) {
        if (!(target instanceof Element)) return false;

        return Boolean(target.closest('input, textarea, select') || target.isContentEditable);
    }

    function scrollBookIntoViewIfNeeded(book) {
        const rect = book.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const padding = 12;

        if (rect.top < padding) {
            window.scrollBy({
                top: rect.top - padding,
                behavior: 'auto'
            });
        } else if (rect.bottom > viewportHeight - padding) {
            window.scrollBy({
                top: rect.bottom - viewportHeight + padding,
                behavior: 'auto'
            });
        }
    }

    function focusBook(book) {
        focusedBook?.classList.remove(focusedBookClassName);
        focusedBook = book;
        focusedBook.classList.add(focusedBookClassName);
        scrollBookIntoViewIfNeeded(focusedBook);
    }

    function handleBookNavigationKeydown(e) {
        if ((e.key !== 'j' && e.key !== 'k') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if (isEditableTarget(e.target)) return;

        const books = getBooks();
        if (books.length === 0) return;

        const currentIndex = focusedBook ? books.indexOf(focusedBook) : -1;

        if (e.key === 'j') {
            if (currentIndex === books.length - 1) return;

            e.preventDefault();
            focusBook(books[currentIndex + 1] || books[0]);
        } else if (currentIndex > 0) {
            e.preventDefault();
            focusBook(books[currentIndex - 1]);
        }
    }

    if (!removeAdPlaceholder()) {
        const observer = new MutationObserver(() => {
            if (removeAdPlaceholder()) {
                observer.disconnect();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        window.setTimeout(() => observer.disconnect(), 10000);
    }

    installBookNavigationStyle();
    document.addEventListener('keydown', handleBookNavigationKeydown);
    openReadOnlineInNewTab();
})();
