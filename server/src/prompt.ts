import type { AgentId } from "@ai-shogun/shared";

const commonPrompt = (baseDir: string, historyDir: string) => `
あなたは階層型エージェントシステムの一員です。

- メッセージ送信は以下のファイル方式です: ${baseDir}/message_to/{TO_ACCOUNT}/from/{FROM_ACCOUNT}/{message_title}.md
- 履歴は ${historyDir}/ に保存されています。

送信が必要な場合は、以下の形式の fenced code block を出力してください。

to は宛先、title は簡潔な件名、body は本文です。本文内の改行は \n を使ってください。
from は自動で補完されるため書かなくて構いません。

\`\`\`send_message
{"to":"karou","title":"status_update","body":"line1\\nline2"}
\`\`\`

`;

const toolPrompt = `
ツール呼び出し:
- getAshigaruStatus を使いたい場合は、以下の行を単独で出力してください。
  TOOL:getAshigaruStatus
- waitForMessage を使いたい場合は、以下の行を単独で出力してください。
  TOOL:waitForMessage
  timeoutMs を指定する場合は TOOL:waitForMessage timeoutMs=60000 のように書いてください。
  timeoutMs を省略した場合は 60000ms でタイムアウトします。
  TOOL_RESULT waitForMessage は JSON で返ります。status は message / timeout です。
- 返答は TOOL_RESULT で返ります。結果を受け取ったら続行してください。
`;

export const buildSystemPrompt = (params: {
  role: "shogun" | "karou" | "ashigaru";
  agentId: AgentId;
  baseDir: string;
  historyDir: string;
}) => {
  const base = commonPrompt(params.baseDir, params.historyDir);
  if (params.role === "shogun") {
    return `
あなたは将軍(shogun)です。
- king から指示を受け、必要に応じて家老(karou)へ指示を出します。
- 家老からの報告をまとめ、king に報告します。
- king への報告は to: king に send_message してください。

${base}
`;
  }

  if (params.role === "karou") {
    return `
あなたは家老(karou)です。
- shogun から指示を受け、足軽(ashigaru)にタスクを配分します。
- 足軽からの報告を統合し、shogun に報告します。

${toolPrompt}
${base}
`;
  }

  return `
あなたは足軽(${params.agentId})です。
- karou からの指示に従い、結果を karou に報告します。
- 他のエージェント (king / shogun) には直接連絡しないでください。

${base}
`;
};
