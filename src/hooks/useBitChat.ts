// src/hooks/useBitChat.ts
//
// React hook that manages the full BitChat BLE mesh lifecycle.
// Usage:
//   const { messages, peers, bluetoothState, sendMessage, sendPrivateMessage,
//           clearMessages } = useBitChat({ nickname: 'alice' })
//
// Phase 3 additions:
//   - Loads public chat history from AsyncStorage on mount.
//   - Persists every new public message immediately after it is appended.
//   - clearMessages() removes both in-memory state and stored history.
//   - historyLoaded ref prevents a fast-arriving BLE event from overwriting
//     stored history before the async load has completed.

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message, Peer, BluetoothState } from '../types/chat';
import * as Bridge from '../native/BitChatBridge';
import {
  loadMessages,
  saveMessages,
  clearMessages as storageClear,
  MAX_HISTORY,
  STORAGE_KEYS,
} from '../utils/chatStorage';

interface UseBitChatOptions {
  nickname: string;
}

interface UseBitChatReturn {
  messages: Message[];
  peers: Peer[];
  bluetoothState: BluetoothState;
  myPeerId: string;
  sendMessage: (content: string) => Promise<void>;
  sendPrivateMessage: (content: string, peerId: string) => Promise<void>;
  clearMessages: () => void;
}

export function useBitChat({ nickname }: UseBitChatOptions): UseBitChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [bluetoothState, setBluetoothState] = useState<BluetoothState>('unknown');
  const [myPeerId, setMyPeerId] = useState('');

  // Track seen message IDs to deduplicate across event re-fires.
  // Populated with stored IDs on load so restored messages are never duplicated.
  const seenIds = useRef(new Set<string>());

  // Guard: only persist after the initial history load has completed.
  // Prevents a fast BLE event from saving a 1-message array that would
  // overwrite the full stored history before setMessages() with the loaded
  // data runs.
  const historyLoaded = useRef(false);

  useEffect(() => {
    let isMounted = true;

    // ── Step 1: Load persisted public history ─────────────────────────────────
    loadMessages(STORAGE_KEYS.public).then(stored => {
      if (!isMounted) return;

      // Pre-populate seenIds so arriving BLE events cannot re-add stored msgs
      stored.forEach(m => seenIds.current.add(m.id));

      // Set the restored history as initial state
      setMessages(stored);

      // Only now allow BLE events to persist new messages
      historyLoaded.current = true;
    });

    // ── Step 2: Start mesh and fetch initial data ─────────────────────────────
    Bridge.startMesh(nickname);
    Bridge.getMyPeerId().then(id => { if (isMounted) setMyPeerId(id); }).catch(() => {});
    Bridge.getPeers().then(list => { if (isMounted) setPeers(list); }).catch(() => {});

    // ── Step 3: Subscribe to BLE events ──────────────────────────────────────
    const subs = [
      Bridge.onMessageReceived(msg => {
        if (msg.isPrivate) return;
        if (seenIds.current.has(msg.id)) return;
        seenIds.current.add(msg.id);

        setMessages(prev => {
          const next = [...prev, msg];
          // Pure updater — no side effects.
          // Persistence is handled by the useEffect below.
          return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
        });
      }),

      Bridge.onPeerListUpdated(({ peers: updated }) => {
        if (isMounted) setPeers(updated);
      }),

      Bridge.onBluetoothStateChanged(({ state }) => {
        if (isMounted) setBluetoothState(state);
      }),
    ].filter(Boolean);

    return () => {
      isMounted = false;
      subs.forEach(s => s?.remove());
      Bridge.stopMesh();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist public messages after every state change.
  // This useEffect runs after render — a safe call site for native bridge ops.
  // historyLoaded ref prevents writing before the initial AsyncStorage load
  // completes, so we never overwrite stored history with a partial array.
  useEffect(() => {
    if (!historyLoaded.current) return;
    saveMessages(STORAGE_KEYS.public, messages);
  }, [messages]);

  const sendMessage = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    await Bridge.sendMessage(trimmed);
  }, []);

  const sendPrivateMessage = useCallback(
    async (content: string, peerId: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      await Bridge.sendPrivateMessage(trimmed, peerId);
    },
    [],
  );

  const clearMessages = useCallback(() => {
    // Remove from AsyncStorage first, then clear state and dedup set
    storageClear(STORAGE_KEYS.public);
    setMessages([]);
    seenIds.current.clear();
  }, []);

  return {
    messages,
    peers,
    bluetoothState,
    myPeerId,
    sendMessage,
    sendPrivateMessage,
    clearMessages,
  };
}
