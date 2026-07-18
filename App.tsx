import React, { useState, useEffect } from 'react';
import {

  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Platform,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ChatScreen from './src/screens/ChatScreen';
import PrivateChatScreen from './src/screens/PrivateChatScreen';
import type { RootStackParamList } from './src/navigation/types';
import * as Bridge from './src/native/BitChatBridge';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import notifee, { EventType } from '@notifee/react-native';
import { requestNotificationPermission, createNotificationChannel } from './src/utils/notifications';
import { navigationRef } from './src/navigation/navigationRef';

// Handle background notification presses
notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (type === EventType.PRESS) {
    const { data } = detail.notification || {};
    if (navigationRef.isReady()) {
      if (data?.type === 'private' && data.peer) {
        // Must parse peer because it's passed as a JSON string or object depending on serialization
        const peer = typeof data.peer === 'string' ? JSON.parse(data.peer) : data.peer;
        navigationRef.navigate('PrivateChat', { peer });
      } else if (data?.type === 'public') {
        // Navigate back to Chat. In a real app we might pass params, but Chat is the root
        navigationRef.navigate('Chat', { nickname: '', onChangeNickname: () => {} });
      }
    }
  }
});

const Stack = createNativeStackNavigator<RootStackParamList>();

const NICKNAME_KEY = '@bitchat_nickname';

// ──────────────────────────────────────────────────────────────────────────────
// App.tsx
//
// Entry-point shell.
// - Loads persisted nickname from AsyncStorage on mount.
// - On Android: shows nickname picker only when no nickname is saved,
//   then renders ChatScreen which starts the BLE mesh via useBitChat().
// - Exposes a Change Nickname flow that clears storage, updates the mesh,
//   and notifies nearby peers without requiring an app restart.
// - On other platforms: shows a placeholder (BLE mesh is Android-only for now).
// ──────────────────────────────────────────────────────────────────────────────

interface NicknameGateProps {
  initialValue?: string;
  onReady: (nick: string) => void;
  title?: string;
  submitLabel?: string;
}

function NicknameGate({
  initialValue = '',
  onReady,
  title = 'BitChat',
  submitLabel = 'Join the mesh →',
}: NicknameGateProps) {
  const [nick, setNick] = useState(initialValue);

  return (
    <SafeAreaView style={styles.gate}>
      <Text style={styles.gateIcon}>⚡</Text>
      <Text style={styles.gateTitle}>{title}</Text>
      <Text style={styles.gateSub}>
        Peer-to-peer mesh chat over Bluetooth.{'\n'}No internet required.
      </Text>

      <TextInput
        style={styles.nickInput}
        placeholder="Your nickname"
        placeholderTextColor="#6b7280"
        value={nick}
        onChangeText={setNick}
        maxLength={24}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        onSubmitEditing={() => nick.trim() && onReady(nick.trim())}
      />

      <TouchableOpacity
        style={[styles.joinBtn, !nick.trim() && styles.joinBtnDisabled]}
        onPress={() => nick.trim() && onReady(nick.trim())}
        disabled={!nick.trim()}>
        <Text style={styles.joinBtnText}>{submitLabel}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function App() {
  // null  = still loading from storage
  // ''    = no nickname saved (show NicknameGate)
  // 'xyz' = nickname ready (show chat)
  const [nickname, setNickname] = useState<string | null>(null);
  const [changingNickname, setChangingNickname] = useState(false);

  // ── Load persisted nickname on mount ────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(NICKNAME_KEY)
      .then(saved => setNickname(saved ?? ''))
      .catch(() => setNickname(''));

    // Initialize notifications
    if (Platform.OS === 'android') {
      requestNotificationPermission();
      createNotificationChannel();
    }

    // Handle foreground notification presses
    return notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.PRESS) {
        const { data } = detail.notification || {};
        if (navigationRef.isReady()) {
          if (data?.type === 'private' && data.peer) {
            const peer = typeof data.peer === 'string' ? JSON.parse(data.peer) : data.peer;
            navigationRef.navigate('PrivateChat', { peer });
          } else if (data?.type === 'public') {
            navigationRef.navigate('Chat', { nickname: nickname ?? '', onChangeNickname: handleChangeNickname });
          }
        }
      }
    });
  }, [nickname]);

  if (Platform.OS !== 'android') {
    return (
      <SafeAreaView style={styles.gate}>
        <Text style={styles.gateIcon}>⚡</Text>
        <Text style={styles.gateTitle}>BitChat</Text>
        <Text style={styles.gateSub}>
          BLE mesh is currently Android-only.{'\n'}iOS support coming in Phase 3.
        </Text>
      </SafeAreaView>
    );
  }

  // ── Loading splash while AsyncStorage resolves ────────────────────────────
  if (nickname === null) {
    return (
      <SafeAreaView style={styles.gate}>
        <ActivityIndicator size="large" color="#9F67FF" />
      </SafeAreaView>
    );
  }

  // ── First launch or no saved nickname ────────────────────────────────────
  if (nickname === '') {
    return (
      <NicknameGate
        onReady={async nick => {
          await AsyncStorage.setItem(NICKNAME_KEY, nick);
          setNickname(nick);
        }}
      />
    );
  }

  // ── Change Nickname flow ─────────────────────────────────────────────────
  const handleChangeNickname = () => setChangingNickname(true);

  const handleNicknameChanged = async (newNick: string) => {
    // Persist first so a crash mid-restart still keeps the new nick.
    await AsyncStorage.setItem(NICKNAME_KEY, newNick);
    setChangingNickname(false);
    setNickname(newNick);
    // Update the running mesh — setNickname broadcasts an ANNOUNCE so nearby
    // peers see the change without a full mesh restart.
    Bridge.setNickname(newNick);
  };

  return (
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator
          initialRouteName="Chat"
          screenOptions={{ headerShown: false }}>
          <Stack.Screen
            name="Chat"
            component={ChatScreen}
            initialParams={{ nickname, onChangeNickname: handleChangeNickname }}
          />
          <Stack.Screen
            name="PrivateChat"
            component={PrivateChatScreen}
          />
        </Stack.Navigator>
      </NavigationContainer>

      {/* Change Nickname modal — rendered above the NavigationContainer */}
      <Modal
        visible={changingNickname}
        transparent
        animationType="fade"
        onRequestClose={() => setChangingNickname(false)}>
        <View style={styles.modalOverlay}>
          <NicknameGate
            initialValue={nickname}
            onReady={handleNicknameChanged}
            title="Change Nickname"
            submitLabel="Save →"
          />
        </View>
      </Modal>
    </SafeAreaProvider>
  );
}

const PURPLE = '#7C3AED';
const PURPLE2 = '#9F67FF';
const BG = '#0f0221';
const TEXT = '#f3f0ff';
const MUTED = '#9ca3af';
const CARD = '#23104a';

const styles = StyleSheet.create({
  gate: {
    flex: 1,
    backgroundColor: BG,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  gateIcon: { fontSize: 64, marginBottom: 12 },
  gateTitle: {
    fontSize: 36,
    fontWeight: '900',
    color: PURPLE2,
    letterSpacing: 1,
    marginBottom: 12,
  },
  gateSub: {
    fontSize: 15,
    color: MUTED,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 40,
  },
  nickInput: {
    width: '100%',
    backgroundColor: CARD,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    color: TEXT,
    fontSize: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: PURPLE,
  },
  joinBtn: {
    width: '100%',
    backgroundColor: PURPLE,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  joinBtnDisabled: { backgroundColor: '#4b2080' },
  joinBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
  },
});

export default App;