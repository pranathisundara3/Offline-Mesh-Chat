import notifee, { AndroidImportance } from '@notifee/react-native';
import { Platform } from 'react-native';

export const CHANNEL_ID = 'bitchat_messages';

export async function requestNotificationPermission() {
  if (Platform.OS === 'android') {
    await notifee.requestPermission();
  }
}

export async function createNotificationChannel() {
  if (Platform.OS === 'android') {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Chat Messages',
      importance: AndroidImportance.HIGH,
      sound: 'default',
    });
  }
}

export async function displayNotification(
  messageId: string,
  title: string,
  body: string,
  data?: Record<string, any>
) {
  await notifee.displayNotification({
    id: messageId,
    title,
    body,
    data,
    android: {
      channelId: CHANNEL_ID,
      pressAction: {
        id: 'default',
      },
    },
  });
}
