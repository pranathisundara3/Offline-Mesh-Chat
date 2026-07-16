// src/hooks/useConversations.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Conversation } from '../types/chat';
import * as Bridge from '../native/BitChatBridge';
import {
  loadConversations,
  saveConversations,
  appendPrivateMessageSafe,
} from '../utils/chatStorage';

export function useConversations(myPeerId: string) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const historyLoaded = useRef(false);

  // 1. Load initial conversation index
  useEffect(() => {
    let isMounted = true;
    loadConversations().then(stored => {
      if (!isMounted) return;
      // Sort by latest activity first
      stored.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
      setConversations(stored);
      historyLoaded.current = true;
    });
    return () => {
      isMounted = false;
    };
  }, []);

  // 2. Listen globally for private messages
  useEffect(() => {
    if (!myPeerId) return;

    const sub = Bridge.onMessageReceived(msg => {
      if (!msg.isPrivate) return;

      // Determine who the conversation is with
      const remotePeerId = msg.senderId === myPeerId ? msg.recipientId : msg.senderId;
      if (!remotePeerId) return;

      const remoteNickname = msg.senderId === myPeerId ? '' : msg.senderNickname;

      // 3. Append to private storage safely
      appendPrivateMessageSafe(remotePeerId, msg).then(() => {
        // 4. Update conversation index in memory
        setConversations(prev => {
          let updated = [...prev];
          const existingIdx = updated.findIndex(c => c.peerId === remotePeerId);
          
          if (existingIdx !== -1) {
            const existing = updated[existingIdx];
            // Only update nickname if we received a message from them
            const newNickname = (msg.senderId !== myPeerId && remoteNickname) ? remoteNickname : existing.nickname;
            
            // Only update lastMessage if it's newer
            if (!existing.lastMessageAt || msg.timestamp >= existing.lastMessageAt) {
              updated.splice(existingIdx, 1);
              updated.unshift({
                ...existing,
                nickname: newNickname,
                lastMessage: msg.content,
                lastMessageAt: msg.timestamp,
              });
            }
          } else {
            // New conversation
            updated.unshift({
              peerId: remotePeerId,
              nickname: remoteNickname || 'Unknown Peer',
              lastMessage: msg.content,
              lastMessageAt: msg.timestamp,
            });
          }
          return updated;
        });
      });
    });

    return () => {
      sub?.remove();
    };
  }, [myPeerId]);

  // 5. Persist index changes
  useEffect(() => {
    if (!historyLoaded.current) return;
    saveConversations(conversations);
  }, [conversations]);

  // Helper to clear a single conversation's preview (used when clearMessages is called)
  const clearConversationPreview = useCallback((peerId: string) => {
    setConversations(prev => {
      const updated = [...prev];
      const idx = updated.findIndex(c => c.peerId === peerId);
      if (idx !== -1) {
        updated[idx] = {
          ...updated[idx],
          lastMessage: undefined,
          // We keep lastMessageAt so it maintains its sort order
        };
      }
      return updated;
    });
  }, []);

  return { conversations, clearConversationPreview };
}
