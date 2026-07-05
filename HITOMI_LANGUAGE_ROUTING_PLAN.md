# Hitomi language routing integration plan

## 背景

`hitomi-redirect.user.js` は Hitomi の root/all 系ページを Japanese ページへ強制的に移動させるための小さな UserScript です。

一方、`hitomi-tweak.user.js` には一覧上の book を折りたたむ filter 機能がありますが、実態は「見たいものを抽出する filter」ではなく「指定した条件に一致する book を除外・折りたたむ blocklist」です。現在の blocklist 条件には `language` も含まれているため、「表示したい言語へ移動する機能」と「除外したい言語を折りたたむ機能」が名前の上で混線しやすくなっています。

この統合では、`hitomi-redirect.user.js` の固定 Japanese リダイレクトを `hitomi-tweak.user.js` の preferred language 設定へ移し、`hitomi-tweak.user.js` 側でユーザーが好みの言語を選べるようにします。

## 目標

- `hitomi-tweak.user.js` に preferred language 設定を追加する。
- preferred language に従って root/all 系ページを対応する言語ページへ自動移動する。
- 既存の language blocklist は「除外条件」として維持する。
- 十分に確認できた後で `hitomi-redirect.user.js` を削除できる状態にする。

## 非目標

- 既存の blocklist 保存キーをすぐに変更しない。
- 既存の download/history/reader/fold/keyboard shortcut の動作を同時に変更しない。
- 初回実装で `hitomi-redirect.user.js` を即削除しない。

## 概念の分離

### Preferred language

表示したい言語ページへ移動するための設定です。

例:

- `japanese`
- `english`
- `chinese`
- `korean`
- `all`
- `off`

`off` は自動移動を無効化します。`all` は `*-all.html` へ移動する意味として扱えますが、必要性が低ければ初期実装では `off` と各言語だけでも構いません。

### Blocklist language

一覧上の book の `Language` が指定値に一致したときに折りたたむための除外条件です。

これは preferred language とは別の機能です。たとえば preferred language が `japanese` でも、blocklist language に `english` を残す意味はあります。

## 対象 URL

`hitomi-redirect.user.js` と同等の範囲から始めます。

- `/`
- `/artist/*-all.html`
- `/tag/*-all.html`
- `/series/*-all.html`
- `/character/*-all.html`
- `/group/*-all.html`
- `/type/*-all.html`

preferred language が `japanese` の場合:

- `/` -> `/index-japanese.html`
- `/artist/foo-all.html` -> `/artist/foo-japanese.html`

preferred language が `english` の場合:

- `/` -> `/index-english.html`
- `/artist/foo-all.html` -> `/artist/foo-english.html`

将来的には、すでに別言語ページにいる場合も preferred language へ寄せるか検討できます。ただし初期実装では既存挙動に合わせて root/all 系のみを対象にする方が低リスクです。

## 段階的な実装順

### Step 1: 設定 UI だけ追加

`hitomi-tweak.user.js` の右側パネルに `Preferred Language` の select を追加します。

この段階では自動リダイレクトはしません。設定値が `GM` storage に保存されることだけを確認します。

保存キー案:

`hitomi-tweak-preferred-language`

### Step 2: 自動リダイレクトを追加

保存済み preferred language を読み、対象 URL の場合だけ `window.location.replace()` します。

`hitomi-redirect.user.js` はまだ残します。動作確認時は競合を避けるため、どちらか片方だけを有効にします。

### Step 3: UI 表記を blocklist に寄せる

既存の `Filter Enabled` や `Blacklist Mode` 表記を `Blocklist Enabled` / `Blocklist Mode` に寄せます。

内部キーは互換性のため、当面 `hitomi-tweak-blacklist-*` のままでよいです。保存キーまで変える場合は移行処理が必要になります。

### Step 4: `hitomi-redirect.user.js` を削除

`hitomi-tweak.user.js` 側の preferred language redirect が安定してから、別コミットで `hitomi-redirect.user.js` を削除します。

## 実装上の注意

- `@version` はユーザーから明示依頼があるまで変更しません。
- `@run-at document-idle` のまま redirect を入れると、移動が少し遅くなります。
- `@run-at document-start` に変更すると既存 DOM 操作への影響が広がるため、別段階で慎重に扱います。
- 初期実装では `document-idle` のままでもよいです。安定後に必要なら redirect の早期化を検討します。
- `hitomi-download-history.user.js` は `LANGUAGE` リンクを `DL HISTORY` に置き換えています。preferred language UI は `hitomi-tweak.user.js` のパネル側に置くため、この置き換えは維持できます。

## 手動確認項目

- Preferred Language の選択値が保存される。
- ページ再読み込み後も Preferred Language の選択値が復元される。
- `/` が選択言語の index ページへ移動する。
- `/artist/foo-all.html` などが選択言語のページへ移動する。
- reader ページでは redirect が走らない。
- book 詳細ページでは redirect が走らない。
- blocklist の `language` 条件は従来通り book の折りたたみにだけ効く。
- `j/k/v/r/t/d/c` など既存ショートカットが壊れていない。
- `hitomi-download-history.user.js` の `DL HISTORY` リンクが引き続き表示される。
