# ログ抽出: `ERROR`/`WARN` 文字列 grep は誤検知する

ログからエラー/警告を抽出する際、本文中に `ERROR`/`WARN` が含まれるだけでヒットするため誤検知しやすい。可能なら構造化された **level フィールド**（または JSON のキー）で絞り込む。

例:

- `rg -n 'level=(error|warn)'`
- `rg -n '\"level\":\"(error|warn)\"'`

