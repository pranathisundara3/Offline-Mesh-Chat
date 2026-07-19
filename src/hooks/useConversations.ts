// src/hooks/useConversations.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import type { Conversation } from '../types/chat';
import { navigationRef } from '../navigation/navigationRef';
import * as Bridge from '../native/BitChatBridge';
import {
  loadConversations,
  saveConversations,
  appendPrivateMessageSafe,
  clearMessages,
  STORAGE_KEYS,
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
        // Check if chat is currently open
        const isAppActive = AppState.currentState === 'active';
        const route = navigationRef.isReady() ? navigationRef.getCurrentRoute() : null;
        const isViewingThisChat = 
          isAppActive && 
          route?.name === 'PrivateChat' && 
          (route.params as any)?.peer?.peerId === remotePeerId;

        const isSentByMe = msg.senderId === myPeerId;
        const formattedMessage = isSentByMe ? `You: ${msg.content}` : msg.content;

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
              
              let unreadCount = existing.unreadCount || 0;
              if (!isSentByMe && !isViewingThisChat) {
                unreadCount += 1;
              } else if (isViewingThisChat) {
                unreadCount = 0;
              }

              updated.unshift({
                ...existing,
                nickname: newNickname,
                lastMessage: formattedMessage,
                lastMessageAt: msg.timestamp,
                unreadCount,
              });
            }
          } else {
            // New conversation
            let unreadCount = 0;
            if (!isSentByMe && !isViewingThisChat) {
              unreadCount = 1;
            }

            updated.unshift({
              peerId: remotePeerId,
              nickname: remoteNickname || 'Unknown Peer',
              lastMessage: formattedMessage,
              lastMessageAt: msg.timestamp,
              unreadCount,
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
          unreadCount: 0,
          // We keep lastMessageAt so it maintains its sort order
        };
      }
      return updated;
    });
  }, []);

  // Helper to completely delete a conversation
  const deleteConversation = useCallback(async (peerId: string) => {
    // 1. Delete all messages from local storage
    await clearMessages(STORAGE_KEYS.private(peerId));
    
    // 2. Remove conversation entirely from memory
    // (This triggers the effect that saves the conversation index)
    setConversations(prev => prev.filter(c => c.peerId !== peerId));
  }, []);

  // Helper to reset unread count to 0 when chat is opened
  const markConversationAsRead = useCallback((peerId: string) => {
    setConversations(prev => {
      const idx = prev.findIndex(c => c.peerId === peerId);
      if (idx !== -1 && prev[idx].unreadCount !== 0 && prev[idx].unreadCount !== undefined) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], unreadCount: 0 };
        return updated;
      }
      return prev;
    });
  }, []);

  return { conversations, clearConversationPreview, deleteConversation, markConversationAsRead };
}
