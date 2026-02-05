# Shell/PATH の落とし穴

## zsh の予約変数 `path` を使わない（zsh 使用時のみ）

- zsh では `path` が特別な配列変数で、うっかり `for path in ...` のように使うと `PATH` が壊れて `curl: command not found` などが発生しうる。
- bash では無関係だが、zsh 利用時は注意。
- ループ変数は `rel_path` / `file_path` など別名にする。

## tesseract が絶対パスの画像を読めない場合がある

- この環境では `tesseract /tmp/foo.png ...` が `image file not found` になる一方、`cd /tmp && tesseract foo.png ...` は成功するケースを確認。
- 回避策: 対象ディレクトリへ `cd` して相対パスで実行する。
- スクリプト例:

```bash
img_dir="/tmp"
img_file="foo.png"
(
  cd "$img_dir" || exit 1
  tesseract "$img_file" stdout
)
```
