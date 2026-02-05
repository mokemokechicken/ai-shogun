# 学びの記録

- サーバ起動時ログの改修は `server/src/` への最小変更で実現でき、再起動後に `.shogun/logs/server.log` で検証するのが最短経路。
- worktree を切ることで本体汚染を避けつつ、安全に改修・検証できる。
- 再起動手順の詳細は `server_restart_knowledge.md` を参照。
