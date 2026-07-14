// src/navigation/types.ts
//
// Stack navigator param-list.
// Import this wherever a screen needs typed navigation/route props.

import type { Peer } from '../types/chat';

export type RootStackParamList = {
  /** Public mesh chat */
  Chat: { nickname: string; onChangeNickname: () => void };
  /** One-to-one private chat with a specific peer */
  PrivateChat: { peer: Peer };
};
