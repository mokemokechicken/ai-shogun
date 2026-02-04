# shogun-system 設計

## 概要アーキテクチャ
- `server` が中央管理システム (API + WS + ファイル監視 + Agent 実行) を提供
- `web` が WebUI
- `provider` 層を設け、codex-sdk を Adapter として実装。将来的に別 Provider を追加可能

## モジュール構成 (案)
- `src/server/index.ts` : サーバ起動
- `src/server/agent/*` : Agent ランタイム (busy/queue/stop)
- `src/server/provider/*` : LLM プロバイダ抽象と実装
- `src/server/message/*` : ファイル監視/配信/永続化
- `src/server/state/*` : スレッド/エージェント状態
- `src/shared/*` : 共有型
- `src/web/*` : WebUI (React)

## Provider 抽象
```
interface LlmProvider {
  kind: string;
  createSession(input): Promise<SessionHandle>;
  send(input, signal): Promise<ProviderMessage>;
  cancel(sessionId): Promise<void>;
}
```
- `SessionHandle` に provider 独自の threadId を保持
- `send` は function/tool 呼び出しに対応できる構造
- codex-sdk 実装は `CodexProvider` とし、後から `ClaudeProvider` / `GeminiProvider` を追加できるように DI

## Agent ランタイム
- Agent ごとにキューを持つ (FIFO, thread 間で共有)
- busy 時はキューに積む (busy は Agent 単位)
- 処理完了で次を取り出す
- `stopAll()` で実行中の AbortController を通知、キューを破棄
- stop 時の未配送メッセージは履歴に残るが再送しない (配送保証なし)

## スレッド管理
- `kingThreadId` は king の会話単位
- 1 `kingThreadId` に対し、各 Agent の provider sessionId を保持 (Agent ごとに独自)
- UI で新規 `kingThreadId` を作成すると、server が各 Agent の session を生成
- king が過去 `kingThreadId` を選択した場合、server はその Thread に紐づく各 Agent session を再利用

## メッセージ監視
- `.shogun/message_to/**/from/**/**.md` を chokidar で監視
- 新規 md を検知→宛先 Agent or UI に配送
- 起動時に message_to 内の既存 md も処理する (処理後は履歴へ移動)
- 起動時の既存処理は chokidar の初期 add イベントのみで行い、追加スキャンはしない
- 既処理ファイルは `.shogun/history/{kingThreadId}/message_to/...` へ移動して履歴として保存
- 履歴ディレクトリの場所を各 Agent の System Prompt に通知
- 複数スレッド対応のため、message_title は `"{kingThreadId}__{timestamp}-{rand}__{slug}"` 形式を採用し、監視側で kingThreadId を抽出
  - kingThreadId は UUID (英数字 + ハイフン) を採用し、`__` を含めない
  - slug は英小文字 + 数字 + ハイフンに正規化する
  - timestamp は ISO 8601 (UTC/ミリ秒) を基準にし、衝突回避のため短い乱数を suffix で付与
- md 書き込みは temp ファイル → rename で原子的に配置
- 監視は `.md` のみ対象 (tmp 拡張子は無視)
- DATE は fs.mtime を採用し ISO 8601 (UTC) で送出 (ファイル名 timestamp は routing 用)

## 通信
- WebUI ↔ server: REST + WebSocket
- WebUI からの指示は shogun へのメッセージとして扱う
- Agent からの送信は LLM 出力内の `TOOL:sendMessage` 行を検出し、server が md を作成
- 配送経路は「md 作成 → 監視 → 配送」に一本化し、直接配送はしない
- LLM への入力は `FROM/DATE/本文` 形式で渡し、UI ではメタ情報として表示

## karou ツール
- `getAshigaruStatus()` を tool として提供
- busy/idle を返す (e.g. `idle: [1,2], busy: [3,4,5]`)

## System Prompt 方針
- 共有: メッセージ送信手順、役割階層
- 役割別: 指示/報告の責務と宛先
- 履歴の保存先 `.shogun/history/` を共有に追記

## 設定
- `config/shogun.config.json` を読み込み (存在しない場合は環境変数/デフォルト)
- role 別に model/provider を指定可能

## テスト方針 (案)
- message 監視→配信のユニットテスト
- busy/queue の順序テスト
- stop 操作のキャンセルテスト
- provider 抽象のモックテスト
- 起動時の既存 md 処理/重複防止テスト
- message_title 正規化/衝突回避/境界ケースのテスト
