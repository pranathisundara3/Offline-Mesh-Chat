// src/screens/ChatScreen.tsx
//
// Main chat UI. Consumes useBitChat() hook.
// Shows: bluetooth status banner, peer list tab, public chat thread, composer.

import React, { useState, useRef, useCallback } from 'react';
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
  PermissionsAndroid,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useBitChat } from '../hooks/useBitChat';
import { useConversations } from '../hooks/useConversations';
import type { Message, Peer, Conversation } from '../types/chat';
import type { RootStackParamList } from '../navigation/types';
import * as Bridge from '../native/BitChatBridge';
import { clearMessages as storageClear, STORAGE_KEYS } from '../utils/chatStorage';

// ── Permission helper (Android 12+) ──────────────────────────────────────────

async function requestBLEPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    if (Platform.Version >= 31) {
      // Android 12+
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      return Object.values(granted).every(
        v => v === PermissionsAndroid.RESULTS.GRANTED,
      );
    } else {
      // Android 6–11
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }
  } catch {
    return false;
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BluetoothBanner({ state }: { state: string }) {
  if (state === 'on') return null;
  const label =
    state === 'off'
      ? '⚠ Bluetooth is off. Turn it on to join the mesh.'
      : state === 'unauthorized'
        ? '⚠ Bluetooth permission denied.'
        : '⏳ Starting Bluetooth…';
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>{label}</Text>
    </View>
  );
}

function MessageBubble({ item, myPeerId }: { item: Message; isOwn: boolean; myPeerId: string }) {
  const isOwn = item.senderId === myPeerId;
  const time = new Date(item.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubblePeer]}>
      {!isOwn && (
        <Text style={styles.bubbleSender}>{item.senderNickname}</Text>
      )}
      <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>
        {item.content}
      </Text>
      <Text style={[styles.bubbleTime, isOwn && styles.bubbleTimeOwn]}>
        {time}{item.isPrivate ? ' 🔒' : ''}
      </Text>
    </View>
  );
}

function PeerRow({
  peer,
  onPress,
}: {
  peer: Peer;
  onPress: () => void;
}) {
  const dot = peer.isConnected ? '🟢' : '⚫';

  return (
    <TouchableOpacity
      style={styles.peerRow}
      onPress={onPress}>
      <Text style={styles.peerDot}>{dot}</Text>

      <View>
        <Text style={styles.peerNick}>{peer.nickname}</Text>
        <Text style={styles.peerId}>
          {peer.peerId.slice(0, 12)}…
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function ChatRow({
  conv,
  isConnected,
  onPress,
  onLongPress,
}: {
  conv: Conversation;
  isConnected: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const dot = isConnected ? '🟢' : '⚫';
  const status = isConnected ? 'Online' : 'Offline';
  
  let timeStr = '';
  if (conv.lastMessageAt) {
    const d = new Date(conv.lastMessageAt);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      timeStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  }

  return (
    <TouchableOpacity style={styles.peerRow} onPress={onPress} onLongPress={onLongPress}>
      <View style={styles.chatRowContent}>
        <View style={styles.chatRowHeader}>
          <Text style={styles.peerNick}>{conv.nickname}</Text>
          <Text style={styles.bubbleTime}>{timeStr}</Text>
        </View>
        <View style={styles.chatRowFooter}>
          <Text style={styles.chatRowPreview} numberOfLines={1}>
            {conv.lastMessage ? conv.lastMessage : 'No messages yet'}
          </Text>
          <Text style={styles.peerId}>
            {dot} {status}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

type Tab = 'chat' | 'chats' | 'peers';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export default function ChatScreen({ route, navigation }: Props) {
  const { nickname } = route.params;
  const [_permissionsGranted, setPermissionsGranted] = useState(false);
  const [permissionChecked, setPermissionChecked] = useState(false);

  // Request BLE permissions on first render, then force a mesh restart so the
  // native layer retries if BT was off or permissions weren't ready at mount time.
  React.useEffect(() => {
    requestBLEPermissions().then(async granted => {
      if (!granted) {
        Alert.alert(
          'Bluetooth Permission Required',
          'BitChat needs Bluetooth to discover nearby peers. Please grant the permission and restart the app.',
        );
      } else {
        // Permissions confirmed — force a clean reinit so the mesh definitely
        // starts even if the initial startMesh call ran while BT was still off.
        try { await Bridge.restartMesh(nickname); } catch { /* ignore */ }
      }
      setPermissionsGranted(granted);
      setPermissionChecked(true);
    });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const { messages, peers, bluetoothState, myPeerId, sendMessage, clearMessages } =
    useBitChat({ nickname });
    
  const { conversations, clearConversationPreview, deleteConversation } = useConversations(myPeerId);

  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [searchQuery, setSearchQuery] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);

  const handleSend = useCallback(async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await sendMessage(input.trim());
      setInput('');
      listRef.current?.scrollToEnd({ animated: true });
    } catch {
      Alert.alert('Send Failed', 'Could not send message. Are you connected to any peers?');
    } finally {
      setSending(false);
    }
  }, [input, sending, sendMessage]);

  if (!permissionChecked) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator size="large" color="#7C3AED" style={{ marginTop: 80 }} />
        <Text style={styles.loadingText}>Requesting permissions…</Text>
      </SafeAreaView>
    );
  }

  const connectedCount = peers.filter(p => p.isConnected).length;

  const filteredConversations = conversations.filter(c => 
    c.nickname.toLowerCase().includes(searchQuery.toLowerCase()) || 
    c.peerId.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#1a0533" />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>⚡ BitChat</Text>
          <Text style={styles.headerSub}>
            {connectedCount} peer{connectedCount !== 1 ? 's' : ''} nearby
          </Text>
        </View>
        <TouchableOpacity
          style={styles.menuBtn}
          onPress={() => {
            Alert.alert(
              'Options',
              undefined,
              [
                {
                  text: '✏️ Change Nickname',
                  onPress: () => route.params.onChangeNickname(),
                },
                {
                  text: '🗑️ Clear Chat',
                  onPress: () =>
                    Alert.alert(
                      'Clear Public Chat',
                      'This will delete your local chat history. Other peers will not be affected.',
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
            );
          }}
          accessibilityLabel="Open options menu">
          <Text style={styles.menuBtnText}>⋮</Text>
        </TouchableOpacity>
      </View>

      <BluetoothBanner state={bluetoothState} />

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <View style={styles.tabBar}>
        {(['chat', 'chats', 'peers'] as Tab[]).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}>
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'chat'
                ? `💬 Mesh`
                : tab === 'chats'
                  ? `Recent`
                  : `👥 Peers`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      {activeTab === 'chat' ? (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

          {messages.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>📡</Text>
              <Text style={styles.emptyTitle}>Listening on the mesh…</Text>
              <Text style={styles.emptySubtitle}>
                {connectedCount > 0
                  ? `${connectedCount} peer${connectedCount > 1 ? 's' : ''} nearby — say hello!`
                  : 'No peers in range yet. Move closer to another BitChat device.'}
              </Text>
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={item => item.id}
              renderItem={({ item }) => (
                <MessageBubble item={item} isOwn={item.senderId === myPeerId} myPeerId={myPeerId} />
              )}
              contentContainerStyle={styles.messageList}
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            />
          )}

          {/* Composer */}
          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              value={input}
              onChangeText={setInput}
              placeholder="Message the mesh…"
              placeholderTextColor="#6b7280"
              multiline
              maxLength={1000}
              returnKeyType="send"
              onSubmitEditing={handleSend}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!input.trim() || sending) && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!input.trim() || sending}>
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.sendBtnText}>Send</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      ) : activeTab === 'chats' ? (
        <View style={styles.flex}>
          <View style={styles.searchContainer}>
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search chats…"
              placeholderTextColor={MUTED}
              returnKeyType="search"
            />
          </View>
          <FlatList
            data={filteredConversations}
            keyExtractor={item => item.peerId}
            renderItem={({ item }) => {
              const isConnected = peers.some(p => p.peerId === item.peerId && p.isConnected);
              return (
                <ChatRow
                  conv={item}
                  isConnected={isConnected}
                  onPress={() => {
                    navigation.navigate('PrivateChat', {
                      peer: { peerId: item.peerId, nickname: item.nickname, isConnected },
                    });
                  }}
                  onLongPress={() => {
                    Alert.alert(
                      'Options',
                      item.nickname,
                      [
                        {
                          text: 'Open',
                          onPress: () => {
                            navigation.navigate('PrivateChat', {
                              peer: { peerId: item.peerId, nickname: item.nickname, isConnected },
                            });
                          }
                        },
                        {
                          text: '🗑️ Clear Chat',
                          onPress: () => {
                            Alert.alert(
                              `Clear chat with ${item.nickname}?`,
                              'This will delete the local conversation history but keep the chat in the list.',
                              [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Clear',
                                  style: 'destructive',
                                  onPress: () => {
                                    storageClear(STORAGE_KEYS.private(item.peerId));
                                    clearConversationPreview(item.peerId);
                                  }
                                }
                              ]
                            );
                          }
                        },
                        {
                          text: '❌ Delete Conversation',
                          style: 'destructive',
                          onPress: () => {
                            Alert.alert(
                              `Delete conversation with ${item.nickname}?`,
                              'This will permanently remove the conversation and its history.',
                              [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Delete',
                                  style: 'destructive',
                                  onPress: () => {
                                    deleteConversation(item.peerId);
                                  }
                                }
                              ]
                            );
                          }
                        },
                        { text: 'Cancel', style: 'cancel' }
                      ]
                    );
                  }}
                />
              );
            }}
            contentContainerStyle={styles.peerList}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyIcon}>📭</Text>
                {conversations.length === 0 ? (
                  <>
                    <Text style={styles.emptyTitle}>No recent chats</Text>
                    <Text style={styles.emptySubtitle}>
                      Private conversations will appear here.
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.emptyTitle}>No conversations found</Text>
                  </>
                )}
              </View>
            }
          />
        </View>
      ) : (
        <FlatList
          data={peers}
          keyExtractor={item => item.peerId}
          renderItem={({ item }) => (
            <PeerRow
              peer={item}
              onPress={() => {
                navigation.navigate('PrivateChat', { peer: item });
              }}
            />
          )}
          contentContainerStyle={styles.peerList}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🔍</Text>
              <Text style={styles.emptyTitle}>Scanning for peers…</Text>
              <Text style={styles.emptySubtitle}>
                Other BitChat devices within Bluetooth range will appear here.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const PURPLE = '#7C3AED';
const PURPLE2 = '#9F67FF';
const BG = '#0f0221';
const BG2 = '#1a0533';
const CARD = '#23104a';
const TEXT = '#f3f0ff';
const MUTED = '#9ca3af';

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: BG },

  // Header
  header: { backgroundColor: BG2, paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center' },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: PURPLE2, letterSpacing: 0.5 },
  headerSub: { fontSize: 12, color: MUTED, marginTop: 2 },
  menuBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  menuBtnText: { fontSize: 22, color: PURPLE2, fontWeight: '700' },

  // Banner
  banner: { backgroundColor: '#7c2d12', paddingHorizontal: 16, paddingVertical: 10 },
  bannerText: { color: '#fed7aa', fontSize: 13, textAlign: 'center' },

  // Search
  searchContainer: { paddingHorizontal: 12, paddingTop: 12 },
  searchInput: { backgroundColor: CARD, color: TEXT, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },

  // Tabs
  tabBar: { flexDirection: 'row', backgroundColor: BG2, borderBottomWidth: 1, borderBottomColor: '#2d1a4a' },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: PURPLE },
  tabText: { color: MUTED, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: PURPLE2, fontSize: 13, fontWeight: '700' },

  // Messages
  messageList: { padding: 12, paddingBottom: 4 },
  bubble: {
    maxWidth: '80%', borderRadius: 16, padding: 12,
    marginBottom: 8, backgroundColor: CARD,
  },
  bubbleOwn: { alignSelf: 'flex-end', backgroundColor: PURPLE },
  bubblePeer: { alignSelf: 'flex-start' },
  bubbleSender: { fontSize: 11, color: PURPLE2, fontWeight: '700', marginBottom: 4 },
  bubbleText: { color: TEXT, fontSize: 15, lineHeight: 20 },
  bubbleTextOwn: { color: '#fff' },
  bubbleTime: { fontSize: 10, color: MUTED, marginTop: 4, textAlign: 'right' },
  bubbleTimeOwn: { color: 'rgba(255,255,255,0.6)' },

  // Composer
  composer: {
    flexDirection: 'row', alignItems: 'flex-end',
    backgroundColor: BG2, padding: 10, borderTopWidth: 1, borderTopColor: '#2d1a4a',
  },
  composerInput: {
    flex: 1, backgroundColor: CARD, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, color: TEXT,
    fontSize: 15, maxHeight: 120, marginRight: 10,
  },
  sendBtn: {
    backgroundColor: PURPLE, borderRadius: 20,
    paddingHorizontal: 18, paddingVertical: 12,
  },
  sendBtnDisabled: { backgroundColor: '#4b2080' },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Peers
  peerList: { padding: 12 },
  peerRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: CARD, borderRadius: 12, padding: 14, marginBottom: 8,
  },
  peerDot: { fontSize: 16, marginRight: 12 },
  peerNick: { color: TEXT, fontSize: 15, fontWeight: '600' },
  peerId: { color: MUTED, fontSize: 11, marginTop: 2 },
  chatRowContent: { flex: 1 },
  chatRowHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  chatRowFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatRowPreview: { color: MUTED, fontSize: 11, marginTop: 2, flex: 1, marginRight: 10 },

  // Empty states
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyIcon: { fontSize: 52, marginBottom: 16 },
  emptyTitle: { color: TEXT, fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySubtitle: { color: MUTED, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  loadingText: { color: MUTED, fontSize: 14, textAlign: 'center', marginTop: 16 },
});
