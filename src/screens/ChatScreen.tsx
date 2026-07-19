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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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

function Avatar({ name, isConnected, size = 44 }: { name: string; isConnected: boolean; size?: number }) {
  const initial = name ? name.charAt(0).toUpperCase() : '?';
  const colorHash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = colorHash % 360;
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: `hsl(${hue}, 60%, 40%)` }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.45 }]}>{initial}</Text>
      <View style={[styles.statusDot, { backgroundColor: isConnected ? '#10b981' : '#64748b' }]} />
    </View>
  );
}

function MessageBubble({ item, myPeerId }: { item: Message; isOwn: boolean; myPeerId: string }) {
  const isOwn = item.senderId === myPeerId;
  const time = new Date(item.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const colorHash = item.senderNickname.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = colorHash % 360;
  return (
    <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubblePeer]}>
      {!isOwn && (
        <Text style={[styles.bubbleSender, { color: `hsl(${hue}, 80%, 75%)` }]}>{item.senderNickname}</Text>
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
      activeOpacity={0.7}
      onPress={onPress}>
      <Avatar name={peer.nickname} isConnected={peer.isConnected} size={46} />
      <View style={{ marginLeft: 14, flex: 1 }}>
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
    <TouchableOpacity style={styles.peerRow} activeOpacity={0.7} onPress={onPress} onLongPress={onLongPress}>
      <Avatar name={conv.nickname} isConnected={isConnected} size={50} />
      <View style={[styles.chatRowContent, { marginLeft: 14 }]}>
        <View style={styles.chatRowHeader}>
          <Text style={styles.peerNick}>{conv.nickname}</Text>
          <Text style={styles.bubbleTime}>{timeStr}</Text>
        </View>
        <View style={styles.chatRowFooter}>
          <Text style={styles.chatRowPreview} numberOfLines={1}>
            {conv.lastMessage ? conv.lastMessage : 'No messages yet'}
          </Text>
          <View style={styles.chatRowFooterRight}>
            {conv.unreadCount && conv.unreadCount > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                </Text>
              </View>
            ) : null}
          </View>
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
  const insets = useSafeAreaInsets();
  const [_permissionsGranted, setPermissionsGranted] = useState(false);
  const [permissionChecked, setPermissionChecked] = useState(false);

  // Request BLE permissions on first render, then force a mesh restart so the
  // native layer retries if BT was off or permissions weren't ready at mount time.
  React.useEffect(() => {
    requestBLEPermissions().then(async granted => {
      if (!granted) {
        Alert.alert(
          'Bluetooth Permission Required',
          'MeshChat needs Bluetooth to discover nearby peers. Please grant the permission and restart the app.',
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
    
  const { conversations, clearConversationPreview, deleteConversation, markConversationAsRead } = useConversations(myPeerId);

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
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <ActivityIndicator size="large" color="#8B5CF6" style={{ marginTop: 80 }} />
        <Text style={styles.loadingText}>Requesting permissions…</Text>
      </View>
    );
  }

  const connectedCount = peers.filter(p => p.isConnected).length;

  const filteredConversations = conversations.filter(c => 
    c.nickname.toLowerCase().includes(searchQuery.toLowerCase()) || 
    c.peerId.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#0B0410" />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>⚡ MeshChat</Text>
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
            activeOpacity={0.7}
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
                  : 'No peers in range yet. Move closer to another MeshChat device.'}
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
          <View style={[styles.composer, { paddingBottom: insets.bottom > 0 ? insets.bottom + 8 : 12 }]}>
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
                    markConversationAsRead(item.peerId);
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
                            markConversationAsRead(item.peerId);
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
            contentContainerStyle={[styles.peerList, { paddingBottom: insets.bottom > 0 ? insets.bottom + 16 : 16 }]}
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
          contentContainerStyle={[styles.peerList, { paddingBottom: insets.bottom > 0 ? insets.bottom + 16 : 16 }]}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🔍</Text>
              <Text style={styles.emptyTitle}>Scanning for peers…</Text>
              <Text style={styles.emptySubtitle}>
                Other MeshChat devices within Bluetooth range will appear here.
              </Text>
            </View>
          }
        />
      )}
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
  header: { backgroundColor: BG, paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center' },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 24, fontWeight: '900', color: TEXT, letterSpacing: 0.5 },
  headerSub: { fontSize: 13, color: MUTED, marginTop: 2 },
  menuBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  menuBtnText: { fontSize: 22, color: TEXT, fontWeight: '700' },

  // Banner
  banner: { backgroundColor: '#7c2d12', paddingHorizontal: 16, paddingVertical: 10 },
  bannerText: { color: '#fed7aa', fontSize: 13, textAlign: 'center' },

  // Search
  searchContainer: { paddingHorizontal: 12, paddingTop: 12 },
  searchInput: { backgroundColor: CARD, color: TEXT, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },

  // Tabs
  tabBar: { flexDirection: 'row', backgroundColor: BG, borderBottomWidth: 1, borderBottomColor: '#2A1A4A' },
  tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: PURPLE },
  tabText: { color: MUTED, fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: PURPLE, fontSize: 14, fontWeight: '800' },

  // Messages
  messageList: { padding: 16, paddingBottom: 8 },
  bubble: {
    maxWidth: '82%', borderRadius: 18, padding: 14,
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
    backgroundColor: BG, padding: 12, borderTopWidth: 1, borderTopColor: '#2A1A4A',
  },
  composerInput: {
    flex: 1, backgroundColor: CARD, borderRadius: 24,
    paddingHorizontal: 16, paddingVertical: 12, color: TEXT,
    fontSize: 15, maxHeight: 120, marginRight: 10,
  },
  sendBtn: {
    backgroundColor: PURPLE, borderRadius: 24,
    paddingHorizontal: 18, paddingVertical: 14,
  },
  sendBtnDisabled: { backgroundColor: '#4b2080' },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  // Peers & Chats
  peerList: { padding: 16 },
  peerRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: CARD, borderRadius: 16, padding: 16, marginBottom: 12,
    elevation: 2, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }
  },
  avatar: { justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#FFF', fontWeight: '800' },
  statusDot: { position: 'absolute', bottom: -4, right: -4, width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: CARD },
  peerNick: { color: TEXT, fontSize: 16, fontWeight: '700' },
  peerId: { color: MUTED, fontSize: 12, marginTop: 2 },
  chatRowContent: { flex: 1 },
  chatRowHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  chatRowFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatRowPreview: { color: MUTED, fontSize: 13, marginTop: 2, flex: 1, marginRight: 10 },
  chatRowFooterRight: { flexDirection: 'row', alignItems: 'center' },
  badge: { backgroundColor: '#ef4444', borderRadius: 12, paddingHorizontal: 6, paddingVertical: 2, minWidth: 22, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },

  // Empty states
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyIcon: { fontSize: 52, marginBottom: 16 },
  emptyTitle: { color: TEXT, fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySubtitle: { color: MUTED, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  loadingText: { color: MUTED, fontSize: 14, textAlign: 'center', marginTop: 16 },
});
