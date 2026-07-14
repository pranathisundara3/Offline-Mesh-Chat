// src/native/BitChatBridge.ts
//
// Typed TypeScript wrapper around NativeModules.BitChatModule +
// NativeEventEmitter. This is the ONLY file in the JS layer that imports
// from 'react-native' NativeModules directly — everything else uses this.

import {
  NativeModules,
  NativeEventEmitter,
  EmitterSubscription,
  Platform,
} from 'react-native';
import type {Message, Peer, BluetoothState} from '../types/chat';

const {BitChatModule} = NativeModules;

// Guard: on iOS or in a test environment the module won't exist
const isAvailable = Platform.OS === 'android' && BitChatModule != null;

const emitter = isAvailable ? new NativeEventEmitter(BitChatModule) : null;

// ── Control ────────────────────────────────────────────────────────────────────

/** Start the BLE mesh. Request BLE permissions before calling this. */
export function startMesh(nickname: string): void {
  if (!isAvailable) return;
  BitChatModule.startMesh(nickname);
}

/** Stop the BLE mesh cleanly (broadcasts LEAVE, closes GATT connections). */
export function stopMesh(): void {
  if (!isAvailable) return;
  BitChatModule.stopMesh();
}

/**
 * Stop then restart the BLE mesh with a (possibly new) nickname.
 * Use this after BLE permissions are granted when startMesh already ran
 * while Bluetooth was off, or when the user changes their nickname.
 */
export function restartMesh(nickname: string): Promise<void> {
  if (!isAvailable) return Promise.resolve();
  return BitChatModule.restartMesh(nickname);
}

/** Update our visible nickname and re-announce to all peers. */
export function setNickname(nickname: string): void {
  if (!isAvailable) return;
  BitChatModule.setNickname(nickname);
}

// ── Messaging ─────────────────────────────────────────────────────────────────

/**
 * Send a public broadcast message on the mesh.
 * Resolves with the generated message ID.
 */
export function sendMessage(content: string): Promise<string> {
  if (!isAvailable) return Promise.reject(new Error('BitChatModule not available'));
  return BitChatModule.sendMessage(content);
}

/**
 * Send an encrypted private message to a peer.
 * Requires an established Noise session (initiated automatically on peer connect).
 */
export function sendPrivateMessage(content: string, peerId: string): Promise<void> {
  if (!isAvailable) return Promise.reject(new Error('BitChatModule not available'));
  return BitChatModule.sendPrivateMessage(content, peerId);
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Fetch the current peer list once (useful for initial load). */
export function getPeers(): Promise<Peer[]> {
  if (!isAvailable) return Promise.resolve([]);
  return BitChatModule.getPeers();
}

/** Get our own peer ID (hex string, 16 chars). */
export function getMyPeerId(): Promise<string> {
  if (!isAvailable) return Promise.resolve('');
  return BitChatModule.getMyPeerId();
}

// ── Event subscriptions ────────────────────────────────────────────────────────

export function onMessageReceived(
  callback: (msg: Message) => void,
): EmitterSubscription | null {
  return emitter?.addListener('onMessageReceived', callback) ?? null;
}

export function onPeerConnected(
  callback: (data: {peerId: string; nickname: string}) => void,
): EmitterSubscription | null {
  return emitter?.addListener('onPeerConnected', callback) ?? null;
}

export function onPeerDisconnected(
  callback: (data: {peerId: string}) => void,
): EmitterSubscription | null {
  return emitter?.addListener('onPeerDisconnected', callback) ?? null;
}

export function onPeerListUpdated(
  callback: (data: {peers: Peer[]}) => void,
): EmitterSubscription | null {
  return emitter?.addListener('onPeerListUpdated', callback) ?? null;
}

export function onBluetoothStateChanged(
  callback: (data: {state: BluetoothState}) => void,
): EmitterSubscription | null {
  return emitter?.addListener('onBluetoothStateChanged', callback) ?? null;
}
