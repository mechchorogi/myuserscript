// ==UserScript==
// @name         Insert AV ID link
// @version      0.2
// @description  hehe
// @author       mechchorogi
// @match        https://adult.contents.fc2.com/article/*/
// @match        https://www.dmm.co.jp/digital/videoa/*
// @grant        none
// ==/UserScript==

let generateQueryURL = (queryString) => {
    let transformForTktube = (queryString) => {
        return queryString.replace(/([a-zA-Z]+)-(\d+)/, "$1--$2");
    };
    return "https://tktube.com/search/" + transformForTktube(queryString) + "/";
};

(function() {
    'use strict';
    let extractContentsId;
    let embedContentsLink;
    switch (document.location.host) {
        case "adult.contents.fc2.com":
            extractContentsId = () => {
                return "FC2-PPV-" + document.location.toString().split('/').slice(-2)[0];
            }
            embedContentsLink = (contentsId) => {
                let queryURL = generateQueryURL(contentsId);
                let appendTarget = document.querySelector('div.items_article_headerInfo > ul');
                let listNode = document.createElement('li');
                let linkNode = document.createElement('a');
                linkNode.text = contentsId;
                linkNode.href = queryURL;
                linkNode.target = '_blank';
                linkNode.rel = 'noopener noreferrer';
                listNode.appendChild(linkNode);
                appendTarget.appendChild(listNode);
            };
            break;
        case "www.dmm.co.jp":
            extractContentsId = () => {
                let cid = document.location.href.split("/").filter(word => word.startsWith("cid="))[0];
                let match = cid.match(/cid=\d*(\D+)(\d+)/);
                return match[1] + "-" + match[2].slice(-3);
            };
            embedContentsLink = (contentsId) => {
                let queryURL = generateQueryURL(contentsId);
                let appendTarget = document.querySelector('div.box-rank ~ table tbody');
                let trNode = document.createElement('tr');
                let tdNode1 = document.createElement('td');
                tdNode1.innerText = "Query：";
                tdNode1.align = "right";
                tdNode1.valign = "top";
                tdNode1.class = "nw";
                let tdNode2 = document.createElement('td');
                let linkNode = document.createElement('a');
                linkNode.text = contentsId;
                linkNode.href = queryURL;
                linkNode.target = '_blank';
                linkNode.rel = 'noopener noreferrer';
                tdNode2.appendChild(linkNode);
                trNode.appendChild(tdNode1);
                trNode.appendChild(tdNode2);
                appendTarget.appendChild(trNode);
            };
            break;
    }

    let contentsId = extractContentsId();
    embedContentsLink(contentsId);
})();
