export interface ProviderThreadHandle {
  id: string;
}

export interface ProviderRunInput {
  threadId: string;
  input: string;
  abortSignal?: AbortSignal;
  onProgress?: (update: ProviderProgressUpdate) => void;
}

export interface ProviderResponse {
  outputText: string;
  raw?: unknown;
}

export interface ProviderProgressUpdate {
  label: string;
  detail?: string;
  kind?: string;
  log?: boolean;
}

export interface LlmProvider {
  kind: string;
  createThread(_options: { workingDirectory: string; initialInput?: string }): Promise<ProviderThreadHandle>;
  resumeThread(_threadId: string): ProviderThreadHandle;
  sendMessage(_input: ProviderRunInput): Promise<ProviderResponse>;
  cancel(_threadId: string): Promise<void>;
}
