// src/screens/PrivateChatScreen.tsx
//
// Private one-to-one chat screen.
// Navigation target: stack route "PrivateChat", param { peer: Peer }.
//
// Uses usePrivateChat() — a lightweight hook that subscribes to the existing
// BLE event stream without starting a second mesh session.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import type { Message } from '../types/chat';
import { usePrivateChat } from '../hooks/usePrivateChat';
import * as Bridge from '../native/BitChatBridge';

type Props = NativeStackScreenProps<RootStackParamList, 'PrivateChat'>;

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({
  item,
  myPeerId,
}: {
  item: Message;
  myPeerId: string;
}) {
  const isOwn = item.senderId === myPeerId;
  const time = new Date(item.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubblePeer]}>
      <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>
        {item.content}
      </Text>
      <Text style={[styles.bubbleTime, isOwn && styles.bubbleTimeOwn]}>
        {time} 🔒
      </Text>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function PrivateChatScreen({ route, navigation }: Props) {
  const { peer } = route.params;
  const insets = useSafeAreaInsets();

  // Fetch our own peer ID once. Needed to distinguish sent vs received bubbles.
  const [myPeerId, setMyPeerId] = useState('');
  useEffect(() => {
    Bridge.getMyPeerId().then(id => setMyPeerId(id)).catch(() => {});
  }, []);

  const { messages, sendMessage, isSending, clearMessages, isConnected } = usePrivateChat({
    peerId: peer.peerId,
    myPeerId,
    initialIsConnected: peer.isConnected,
  });

  const [input, setInput] = useState('');
  const listRef = useRef<FlatList>(null);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isSending || !isConnected) return;
    const text = input.trim();
    setInput('');
    try {
      await sendMessage(text);
      listRef.current?.scrollToEnd({ animated: true });
    } catch {
      Alert.alert('Send Failed', 'Could not deliver the message.');
    }
  }, [input, isSending, isConnected, sendMessage]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#0B0410" />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          accessibilityLabel="Go back to peer list">
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.peerName} numberOfLines={1}>
            {peer.nickname}
          </Text>
          <Text style={styles.peerMeta}>
            {isConnected ? '🟢 Connected' : '⚫ Offline'} ·{' '}
            {peer.peerId.slice(0, 12)}…
          </Text>
        </View>

        <TouchableOpacity
          style={styles.menuBtn}
          onPress={() =>
            Alert.alert(
              'Options',
              undefined,
              [
                {
                  text: '🗑️ Clear Chat',
                  onPress: () =>
                    Alert.alert(
                      `Clear chat with ${peer.nickname}?`,
                      'This will delete your local conversation history. It will not affect the other device.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Clear',
                          style: 'destructive',
                          onPress: clearMessages,
                        },
                      ],
                    ),
                },
                { text: 'Cancel', style: 'cancel' },
              ],
            )
          }
          accessibilityLabel="Open options menu">
          <Text style={styles.menuBtnText}>⋮</Text>
        </TouchableOpacity>
      </View>

      {/* ── Offline banner ────────────────────────────────────────────────── */}
      {!isConnected && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>
            ⚫ Peer is offline — messages cannot be delivered.
          </Text>
        </View>
      )}

      {/* ── Chat area + composer ─────────────────────────────────────────── */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🔒</Text>
            <Text style={styles.emptyTitle}>Private channel open</Text>
            <Text style={styles.emptySubtitle}>
              Messages are delivered directly over Bluetooth.{'\n'}
              Only you and {peer.nickname} can see them.
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <MessageBubble item={item} myPeerId={myPeerId} />
            )}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: true })
            }
          />
        )}

        {/* ── Composer ─────────────────────────────────────────────────── */}
        <View style={[styles.composer, { paddingBottom: insets.bottom > 0 ? insets.bottom + 8 : 12 }]}>
          <TextInput
            style={styles.composerInput}
            value={input}
            onChangeText={setInput}
            placeholder={
              isConnected
                ? `Message ${peer.nickname}…`
                : 'Peer is offline'
            }
            placeholderTextColor="#94A3B8"
            multiline
            maxLength={1000}
            returnKeyType="send"
            editable={isConnected}
            onSubmitEditing={handleSend}
          />
          <TouchableOpacity
            activeOpacity={0.7}
            style={[
              styles.sendBtn,
              (!input.trim() || isSending || !isConnected) &&
                styles.sendBtnDisabled,
            ]}
            onPress={handleSend}
            disabled={!input.trim() || isSending || !isConnected}>
            {isSending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.sendBtnText}>Send</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const PURPLE = '#8B5CF6';
const PURPLE2 = '#A78BFA';
const BG = '#0B0410';
const BG2 = '#170B25';
const CARD = '#1E1233';
const TEXT = '#F8FAFC';
const MUTED = '#94A3B8';

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: BG },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BG,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  backBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 8,
  },
  backArrow: { fontSize: 24, color: TEXT },
  headerCenter: { flex: 1 },
  menuBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  menuBtnText: { fontSize: 22, color: TEXT, fontWeight: '700' },
  peerName: {
    fontSize: 20,
    fontWeight: '800',
    color: TEXT,
    letterSpacing: 0.3,
  },
  peerMeta: { fontSize: 13, color: MUTED, marginTop: 2 },

  // Offline banner
  offlineBanner: {
    backgroundColor: '#7c2d12',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  offlineBannerText: {
    color: '#fed7aa',
    fontSize: 13,
    textAlign: 'center',
  },

  // Messages
  messageList: { padding: 16, paddingBottom: 8 },
  bubble: {
    maxWidth: '82%',
    borderRadius: 18,
    padding: 14,
    marginBottom: 8,
    backgroundColor: CARD,
  },
  bubbleOwn: { alignSelf: 'flex-end', backgroundColor: PURPLE },
  bubblePeer: { alignSelf: 'flex-start' },
  bubbleText: { color: TEXT, fontSize: 15, lineHeight: 20 },
  bubbleTextOwn: { color: '#fff' },
  bubbleTime: { fontSize: 10, color: MUTED, marginTop: 4, textAlign: 'right' },
  bubbleTimeOwn: { color: 'rgba(255,255,255,0.6)' },

  // Composer
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: BG,
    paddingHorizontal: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#2A1A4A',
  },
  composerInput: {
    flex: 1,
    backgroundColor: CARD,
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: TEXT,
    fontSize: 15,
    maxHeight: 120,
    marginRight: 10,
  },
  sendBtn: {
    backgroundColor: PURPLE,
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  sendBtnDisabled: { backgroundColor: '#4b2080' },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  // Empty state
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyIcon: { fontSize: 52, marginBottom: 16 },
  emptyTitle: {
    color: TEXT,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtitle: {
    color: MUTED,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
});
