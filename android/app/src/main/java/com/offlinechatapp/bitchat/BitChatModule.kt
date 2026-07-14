package com.offlinechatapp.bitchat

import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule

// ──────────────────────────────────────────────────────────────────────────────
// BitChatModule.kt
//
// React Native NativeModule that bridges BLEMeshService ↔ JavaScript.
// Exposes @ReactMethod functions callable from JS and fires NativeEventEmitter
// events back to JS.
//
// JS usage (via BitChatBridge.ts):
//   NativeModules.BitChatModule.startMesh("alice")
//   NativeModules.BitChatModule.sendMessage("hello mesh")
//   const emitter = new NativeEventEmitter(NativeModules.BitChatModule)
//   emitter.addListener("onMessageReceived", handler)
// ──────────────────────────────────────────────────────────────────────────────

private const val TAG = "BitChat/Module"

/** Event name constants — must match the strings used in BitChatBridge.ts */
object BitChatEvent {
    const val MESSAGE_RECEIVED      = "onMessageReceived"
    const val PEER_CONNECTED        = "onPeerConnected"
    const val PEER_DISCONNECTED     = "onPeerDisconnected"
    const val PEER_LIST_UPDATED     = "onPeerListUpdated"
    const val BLUETOOTH_STATE       = "onBluetoothStateChanged"
    const val NOISE_HANDSHAKE       = "onNoiseHandshakeReceived"
}

@ReactModule(name = BitChatModule.NAME)
class BitChatModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "BitChatModule"
    }

    override fun getName(): String = NAME

    // ── Services ───────────────────────────────────────────────────────────────

    private val peerRegistry = PeerRegistry()
    private val bleService   = BLEMeshService(reactContext.applicationContext, peerRegistry)
    private val noiseSessions = NoiseSessionManager(bleService)  // Phase 3

    init {
        peerRegistry.addListener { peers ->
            emitPeerListUpdated(peers)
        }

        bleService.eventListener = object : MeshEventListener {

            override fun onPublicMessageReceived(
                messageId: String, senderId: String, senderNickname: String,
                content: String, timestampMs: Long
            ) {
                val params = Arguments.createMap().apply {
                    putString("id",             messageId)
                    putString("senderId",       senderId)
                    putString("senderNickname", senderNickname)
                    putString("content",        content)
                    putDouble("timestamp",      timestampMs.toDouble())
                    putBoolean("isPrivate",     false)
                }
                emit(BitChatEvent.MESSAGE_RECEIVED, params)
            }

            override fun onPrivateMessageReceived(
                messageId: String, senderId: String, senderNickname: String,
                encryptedPayload: ByteArray, timestampMs: Long
            ) {
                // Attempt decryption via Noise session
                val plaintext = noiseSessions.decrypt(senderId, encryptedPayload)
                if (plaintext != null) {
                    val params = Arguments.createMap().apply {
                        putString("id",             messageId)
                        putString("senderId",       senderId)
                        putString("senderNickname", senderNickname)
                        putString("content",        plaintext.decodeToString())
                        putDouble("timestamp",      timestampMs.toDouble())
                        putBoolean("isPrivate",     true)
                        putString("recipientId",    bleService.myPeerIDHex)
                    }
                    emit(BitChatEvent.MESSAGE_RECEIVED, params)
                } else {
                    Log.w(TAG, "Could not decrypt private message from $senderId")
                }
            }

            override fun onDirectMessageReceived(
                messageId: String, senderId: String, senderNickname: String,
                recipientId: String, content: String, timestampMs: Long
            ) {
                // recipientId tells the JS hook which conversation bucket to use:
                //   • Echo (we sent):  senderId == myPeerIDHex, recipientId == remote peer
                //   • Received:        senderId == remote peer,  recipientId == myPeerIDHex
                val params = Arguments.createMap().apply {
                    putString("id",             messageId)
                    putString("senderId",       senderId)
                    putString("senderNickname", senderNickname)
                    putString("content",        content)
                    putDouble("timestamp",      timestampMs.toDouble())
                    putBoolean("isPrivate",     true)
                    putString("recipientId",    recipientId)
                }
                emit(BitChatEvent.MESSAGE_RECEIVED, params)
            }

            override fun onNoiseHandshakeReceived(senderId: String, payload: ByteArray) {
                // Process the handshake; if it produces a reply, send it back
                val reply = noiseSessions.processHandshake(senderId, payload)
                if (reply != null) {
                    bleService.sendNoiseHandshake(senderId, reply)
                }
                // Also surface to JS so the UI can show verification state
                val params = Arguments.createMap().apply {
                    putString("peerId",  senderId)
                    putString("payload", payload.toHexString())
                }
                emit(BitChatEvent.NOISE_HANDSHAKE, params)
            }

            override fun onPeerConnected(peerId: String, nickname: String) {
                val params = Arguments.createMap().apply {
                    putString("peerId",   peerId)
                    putString("nickname", nickname)
                }
                emit(BitChatEvent.PEER_CONNECTED, params)
                // Kick off Noise handshake with the new peer
                noiseSessions.initiateHandshake(peerId)
            }

            override fun onPeerDisconnected(peerId: String) {
                val params = Arguments.createMap().apply {
                    putString("peerId", peerId)
                }
                emit(BitChatEvent.PEER_DISCONNECTED, params)
            }

            override fun onPeerListUpdated(peers: List<PeerInfo>) {
                emitPeerListUpdated(peers)
            }

            override fun onBluetoothStateChanged(state: String) {
                val params = Arguments.createMap().apply {
                    putString("state", state)
                }
                emit(BitChatEvent.BLUETOOTH_STATE, params)
            }
        }
    }

    // ── @ReactMethod API ───────────────────────────────────────────────────────

    /**
     * Start the BLE mesh with the given nickname.
     * Must be called from JS after requesting BLUETOOTH_SCAN / BLUETOOTH_ADVERTISE
     * / BLUETOOTH_CONNECT / ACCESS_FINE_LOCATION permissions.
     */
    @ReactMethod
    fun startMesh(nickname: String) {
        Log.i(TAG, "startMesh(nickname=$nickname)")
        bleService.start(nickname)
    }

    /** Stop the BLE mesh cleanly (broadcasts LEAVE, closes all GATT connections). */
    @ReactMethod
    fun stopMesh() {
        Log.i(TAG, "stopMesh()")
        bleService.stop()
    }

    /**
     * Stop then restart the BLE mesh with the given nickname.
     * Called from JS when:
     *   - BLE permissions are granted after the initial startMesh call ran while BT was off.
     *   - The user changes their nickname and a full mesh restart is needed.
     */
    @ReactMethod
    fun restartMesh(nickname: String, promise: Promise) {
        try {
            Log.i(TAG, "restartMesh(nickname=$nickname)")
            bleService.stop()
            bleService.start(nickname)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("RESTART_ERROR", e.message, e)
        }
    }

    /** Change our visible nickname and re-announce to all peers. */
    @ReactMethod
    fun setNickname(nickname: String) {
        bleService.setNickname(nickname)
    }

    /**
     * Send a public broadcast message on the mesh.
     * Returns the generated message ID via the promise.
     */
    @ReactMethod
    fun sendMessage(content: String, promise: Promise) {
        try {
            val msgId = bleService.sendPublicMessage(content)
            promise.resolve(msgId)
        } catch (e: Exception) {
            promise.reject("SEND_ERROR", e.message, e)
        }
    }

    /**
     * Send a plain-text direct message to [peerId].
     * Uses the DIRECT_MESSAGE packet type (0x05) with FLAG_HAS_RECIPIENT.
     * Falls back gracefully if the peer ID is invalid.
     */
    @ReactMethod
    fun sendPrivateMessage(content: String, peerId: String, promise: Promise) {
        try {
            val msgId = bleService.sendDirectMessage(content, peerId)
            if (msgId.isNotEmpty()) {
                promise.resolve(msgId)
            } else {
                promise.reject("SEND_ERROR", "Failed to encode or send direct message to $peerId")
            }
        } catch (e: Exception) {
            promise.reject("SEND_ERROR", e.message, e)
        }
    }

    /** Return the current peer list once. Useful for initial load in JS. */
    @ReactMethod
    fun getPeers(promise: Promise) {
        try {
            val array = Arguments.createArray()
            peerRegistry.all().forEach { peer ->
                val map = Arguments.createMap().apply {
                    putString("peerId",      peer.peerId)
                    putString("nickname",    peer.nickname)
                    putBoolean("isConnected", peer.isConnected)
                }
                array.pushMap(map)
            }
            promise.resolve(array)
        } catch (e: Exception) {
            promise.reject("REGISTRY_ERROR", e.message, e)
        }
    }

    /** Return our own peer ID (hex string). */
    @ReactMethod
    fun getMyPeerId(promise: Promise) {
        promise.resolve(bleService.myPeerIDHex)
    }

    // ── NativeEventEmitter support ─────────────────────────────────────────────

    /** Required for NativeEventEmitter: adds a listener (no-op, managed by Android). */
    @ReactMethod
    fun addListener(eventName: String) { /* required by NativeEventEmitter */ }

    /** Required for NativeEventEmitter: remove listeners. */
    @ReactMethod
    fun removeListeners(count: Int) { /* required by NativeEventEmitter */ }

    // ── Private helpers ────────────────────────────────────────────────────────

    private fun emit(eventName: String, params: WritableMap?) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    private fun emitPeerListUpdated(peers: List<PeerInfo>) {
        val array = Arguments.createArray()
        peers.forEach { peer ->
            val map = Arguments.createMap().apply {
                putString("peerId",      peer.peerId)
                putString("nickname",    peer.nickname)
                putBoolean("isConnected", peer.isConnected)
            }
            array.pushMap(map)
        }
        val params = Arguments.createMap().apply { putArray("peers", array) }
        emit(BitChatEvent.PEER_LIST_UPDATED, params)
    }
}
