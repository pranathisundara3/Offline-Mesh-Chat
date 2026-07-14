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
import type { Message } from '../types/chat';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_HISTORY = 500;

export const STORAGE_KEYS = {
  /** Key for the public mesh chat history. */
  public: '@bitchat_public_messages' as const,

  /** Key for a private DM conversation with a specific peer. */
  private: (peerId: string): string => `@bitchat_dm_${peerId}`,
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
