// src/hooks/usePrivateChat.ts
//
// Lightweight hook for a single private conversation.
// Does NOT start or stop the BLE mesh — that lifecycle is owned by useBitChat
// running in ChatScreen. This hook only subscribes to the existing event stream
// and filters for messages that belong to the conversation with `peerId`.
//
// Routing logic (mirrors what BitChatModule emits):
//   Sent echo:  msg.senderId === myPeerId  && msg.recipientId === peerId
//   Received:   msg.senderId === peerId    && msg.recipientId === myPeerId
//
// Phase 3 additions:
//   - Loads per-peer DM history from AsyncStorage on mount.
//   - Persists every new message immediately after it is appended.
//   - Reloads correctly when peerId/myPeerId change (effect dependency).
//   - clearMessages() removes only this peer's conversation.
//   - historyLoaded ref prevents race between async load and live BLE events.

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message } from '../types/chat';
import * as Bridge from '../native/BitChatBridge';
import {
  loadMessages,
  clearMessages as storageClear,
  MAX_HISTORY,
  STORAGE_KEYS,
} from '../utils/chatStorage';

interface UsePrivateChatOptions {
  /** The remote peer we are chatting with. */
  peerId: string;
  /** Our own peer ID — obtained from useBitChat or Bridge.getMyPeerId(). */
  myPeerId: string;
  /** Initial connection status from route params */
  initialIsConnected: boolean;
}

interface UsePrivateChatReturn {
  messages: Message[];
  sendMessage: (content: string) => Promise<void>;
  isSending: boolean;
  clearMessages: () => void;
  isConnected: boolean;
}

export function usePrivateChat({
  peerId,
  myPeerId,
  initialIsConnected,
}: UsePrivateChatOptions): UsePrivateChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isConnected, setIsConnected] = useState(initialIsConnected);

  // Dedup: the event bus fires once per packet but guard against re-renders.
  // Pre-populated with stored IDs on load so restored messages cannot be
  // re-added by a BLE re-fire.
  const seenIds = useRef(new Set<string>());

  // Guard: only persist after the initial history load is complete.
  // Prevents a fast BLE event from overwriting the full stored history with
  // a single-message array during the async load window.
  const historyLoaded = useRef(false);

  // Stable storage key for this conversation — derived from peerId, NOT nickname.
  // Must be computed inside the effect so it re-derives correctly if peerId changes.

  useEffect(() => {
    // Each time peerId/myPeerId changes we reset state and reload from storage.
    // This correctly handles navigating between different peers' chat screens.
    if (!peerId || !myPeerId) return;

    let isMounted = true;
    const dmKey = STORAGE_KEYS.private(peerId);

    // Reset dedup and history guard for this peer's conversation
    seenIds.current = new Set<string>();
    historyLoaded.current = false;
    setMessages([]);

    // ── Step 1: Load persisted DM history for this peer ──────────────────────
    loadMessages(dmKey).then(stored => {
      if (!isMounted) return;

      // Pre-populate seenIds so live BLE events cannot duplicate stored messages
      stored.forEach(m => seenIds.current.add(m.id));

      setMessages(stored);

      // Allow saving only after the stored history is in state
      historyLoaded.current = true;
    });

    // ── Step 2: Subscribe to BLE events for this conversation ─────────────────
    const sub = Bridge.onMessageReceived(msg => {
      if (!msg.isPrivate) return;

      // Determine whether this DM belongs to our conversation.
      // Echo of message we sent: senderId is us, recipientId is the peer.
      // Message received from peer: senderId is the peer.
      const remoteParty =
        msg.senderId === myPeerId
          ? msg.recipientId   // echo path
          : msg.senderId;     // receive path

      if (remoteParty !== peerId) return;
      if (seenIds.current.has(msg.id)) return;
      seenIds.current.add(msg.id);

      setMessages(prev => {
        const next = [...prev, msg];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
    });

    const connSub = Bridge.onPeerConnected(data => {
      if (data.peerId === peerId) setIsConnected(true);
    });

    const disconnSub = Bridge.onPeerDisconnected(data => {
      if (data.peerId === peerId) setIsConnected(false);
    });

    return () => {
      isMounted = false;
      sub?.remove();
      connSub?.remove();
      disconnSub?.remove();
    };
  }, [peerId, myPeerId]);

  // Note: Persistence of private messages is now handled globally by useConversations
  // to avoid race conditions when receiving private messages while this screen is unmounted.

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      setIsSending(true);
      try {
        await Bridge.sendPrivateMessage(trimmed, peerId);
      } finally {
        setIsSending(false);
      }
    },
    [peerId],
  );

  const clearMessages = useCallback(() => {
    const dmKey = STORAGE_KEYS.private(peerId);
    // Clear only this peer's conversation — other peers are unaffected
    storageClear(dmKey);
    setMessages([]);
    seenIds.current.clear();
  }, [peerId]);

  return { messages, sendMessage, isSending, clearMessages, isConnected };
}
