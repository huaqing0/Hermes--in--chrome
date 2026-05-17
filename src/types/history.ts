import type { UserSettings } from './messages';

export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; args: unknown; status: 'pending' | 'ok' | 'error'; result?: unknown; error?: string }
  | { kind: 'approval'; id: string; tool: string; args: unknown; status: 'pending' | 'approved' | 'denied'; session_id: string };

export interface StoredConversation {
  id: string;
  groupId: number | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  entries: Entry[];
  settings: UserSettings;
}

export type StoredConversationMap = Record<string, StoredConversation>;

export const HISTORY_STORAGE_KEY = 'hermes_conversation_history_v1';
