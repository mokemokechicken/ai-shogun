# shogun-system 要件

## 目的
王(人間)・将軍・家老・足軽(K人)の階層構造で、ファイルベースのメッセージングを介してタスク指示/報告を行う。中央管理システムが UI とメッセージ配送、セッション管理、busy/queue、停止制御を担う。

## 役割/アカウント
- king: 人間。WebUI で指示/確認/停止。
- shogun: LLM。king から指示を受け、karou に指示、king に報告。
- karou: LLM。shogun から指示を受け、ashigaru に指示、shogun に報告。
- ashigaru1..K: LLM。karou から指示を受け、karou に報告。
- K は可変だが default=5。

## メッセージング仕様
- base_dir = `{PRJ_ROOT}/.shogun/`
- 送信側は以下に md を配置することで送信を表現する。
  - `message_to/{TO_ACCOUNT}/from/{FROM_ACCOUNT}/{message_title}.md`
- 複数スレッド対応のため、`message_title` には `kingThreadId` を含める (例: `{kingThreadId}__{timestamp}-{rand}__{slug}`)
- `kingThreadId` は UUID (英数字 + ハイフン) を採用し、`__` を含めない
- slug は英小文字 + 数字 + ハイフンに正規化する
- timestamp は ISO 8601 (UTC/ミリ秒) を基準にし、衝突回避のため短い乱数を suffix で付与
- 中央管理プロセスが監視し、宛先へ以下形式で送信する。
  - `FROM: {FROM_ACCOUNT}`
  - `DATE: {message_title}.md のタイムスタンプ (fs.mtime, ISO 8601 / UTC)`
  - 本文: md の内容
- king 宛のメッセージは WebUI に表示。
- 人間からの指示は基本 shogun 宛。
- 監視済み md は message_to から history へ移動して履歴として残す (message_to からは消える)。
- 履歴の場所は各 Agent の System Prompt に通知し、必要に応じて参照可能とする。
- 履歴は `.shogun/history/{kingThreadId}/message_to/...` に保存する。

## LLM セッション
- king の会話単位を `kingThreadId` と呼ぶ。
- 各 Agent はそれぞれ独自の provider session/threadId を持ち、king の選択中 `kingThreadId` に対応する provider session を維持する。
- king が新規スレッドを作成した場合、各 Agent も独自の新規 provider session を作成し、以後その session を維持する。
- king が過去のスレッドに戻った場合、各 Agent も対応する過去 session に戻って会話を再開する。

## 中央管理システムの役割
- WebUI 提供
- メッセージ配信/セッション管理
- busy な Agent へのメッセージはキュー (Agent 単位で共有)
- king からの中止指示があれば、実行停止を試みる
- karou には `getAshigaruStatus()` ツールを提供
- 中止指示時はキューを破棄する (履歴には残るが再送しない)

## WebUI
- 左タブで会話スレッドを選択/新規作成
- king の指示は shogun 宛に送信
- Agent 間のメッセージを表示するペイン
- 各 Agent 出力をタイル表示し、表示対象を切替可能
- 中止ボタンで全 Agent を停止

## LLM プロバイダ要件
- まずは codex-sdk を利用
- 将来的に ClaudeCode / GeminiCLI 等へ差し替え可能な設計
- Role ごとに System Prompt を変える
- 共有 System Prompt として、ファイルメッセージング手段を周知
- モデルは環境変数のデフォルトを持ちつつ、設定ファイルで上書き可能
- role 別にモデル設定を切替可能

## システム要件
- Node.js >= 24
- TypeScript

## 未確定/要確認
- なし
