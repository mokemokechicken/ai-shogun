# サーバ再起動に関する恒久知識

- 我々の振る舞いは `server/src/` 配下のソースコードで規定される。
- `server/src/` を改修してサーバを再起動することで、異なる振る舞いを得られる。
- 再起動は SKILLS の手順に従って実行可能。
  - 現状の具体例: `ai-shogun-restart-watcher`（参照: `.shogun/skills/index.md`）
