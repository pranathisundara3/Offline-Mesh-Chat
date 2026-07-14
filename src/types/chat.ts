// src/types/chat.ts
// Shared TypeScript types for the BitChat integration.
// These mirror the structures emitted by BitChatModule.kt.

export interface Peer {
  peerId: string;
  nickname: string;
  isConnected: boolean;
}

export interface Message {
  id: string;
  senderId: string;
  senderNickname: string;
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  isPrivate: boolean;
  /**
   * For private (DIRECT_MESSAGE) packets: the remote peer's ID.
   * Used by usePrivateChat to route messages into the correct per-peer bucket.
   * - Received DM:  recipientId === myPeerId  (we are the recipient)
   * - Sent DM echo: recipientId === peer.peerId (the peer we sent to)
   * Absent / "" for public mesh messages.
   */
  recipientId?: string;
}

export type BluetoothState = 'on' | 'off' | 'unauthorized' | 'unknown';
