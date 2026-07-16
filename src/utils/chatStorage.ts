// src/utils/chatStorage.ts
//
// Local persistence helpers for public and private chat history.
// All operations are safe: read failures return [] and write/clear
// failures are silently swallowed so the app never crashes on storage errors.
//
// Storage keys:
//   Public chat  →  @bitchat_public_messages
//   Private DMs  →  @bitchat_dm_<peerId>
//
// History limit:
//   MAX_HISTORY = 500 messages per conversation.
//   At ~200 bytes per message this is ~100 KB per conversation,
//   well within AsyncStorage limits on Android.
//   The limit matches the existing in-memory cap in useBitChat (MAX_MESSAGES = 500).
//   Private chats previously capped at 200 are raised to 500 for consistency.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Message, Conversation } from '../types/chat';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_HISTORY = 500;

export const STORAGE_KEYS = {
  /** Key for the public mesh chat history. */
  public: '@bitchat_public_messages' as const,

  /** Key for a private DM conversation with a specific peer. */
  private: (peerId: string): string => `@bitchat_dm_${peerId}`,

  /** Key for the conversation index (Chats tab). */
  conversations: '@bitchat_dm_conversations' as const,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Load saved messages from AsyncStorage.
 * Returns an empty array if the key does not exist, JSON is malformed,
 * or any other read error occurs.
 */
export async function loadMessages(key: string): Promise<Message[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Guard against corrupted data — must be a non-null array
    if (!Array.isArray(parsed)) return [];
    return parsed as Message[];
  } catch {
    // JSON.parse failure or AsyncStorage error — return safe empty state
    return [];
  }
}

/**
 * Persist a message array to AsyncStorage.
 * Silently swallows any write error — the app continues functioning,
 * just without the latest messages being saved.
 *
 * The array is already bounded to MAX_HISTORY by the caller;
 * no additional slicing is done here.
 */
export async function saveMessages(key: string, messages: Message[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(messages));
  } catch {
    // Swallow — storage failure must not crash the app
  }
}

/**
 * Delete a conversation's stored history from AsyncStorage.
 * Silently swallows any error.
 */
export async function clearMessages(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Swallow
  }
}

/**
 * Load the conversation index.
 */
export async function loadConversations(): Promise<Conversation[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.conversations);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Conversation[];
  } catch {
    return [];
  }
}

/**
 * Save the conversation index.
 */
export async function saveConversations(conversations: Conversation[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEYS.conversations, JSON.stringify(conversations));
  } catch {
    // Swallow
  }
}

// ── Global Private Message Queue ──────────────────────────────────────────────

// Promise chain to prevent race conditions when appending messages to AsyncStorage
let privateSaveQueue = Promise.resolve();

/**
 * Safely append a private message to a peer's history.
 * Uses a promise queue to guarantee sequential read-modify-write per invocation.
 */
export function appendPrivateMessageSafe(peerId: string, message: Message): Promise<void> {
  privateSaveQueue = privateSaveQueue.then(async () => {
    try {
      const key = STORAGE_KEYS.private(peerId);
      const history = await loadMessages(key);
      
      // Deduplicate
      if (history.some(m => m.id === message.id)) {
        return;
      }
      
      history.push(message);
      
      // Enforce limit
      if (history.length > MAX_HISTORY) {
        history.shift();
      }
      
      await saveMessages(key, history);
    } catch {
      // Swallow error to prevent blocking the queue
    }
  });
  
  return privateSaveQueue;
}
