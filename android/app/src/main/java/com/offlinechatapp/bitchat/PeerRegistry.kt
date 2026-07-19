package com.offlinechatapp.bitchat

import android.util.Log
import java.util.concurrent.ConcurrentHashMap

// ──────────────────────────────────────────────────────────────────────────────
// PeerRegistry.kt
//
// Thread-safe peer state store. Tracks every known BLE peer and fires
// change callbacks consumed by BitChatModule → JS NativeEventEmitter.
// Mirrors the role of BLEPeerRegistry.swift in the Swift source.
// ──────────────────────────────────────────────────────────────────────────────

private const val TAG = "BitChat/PeerRegistry"

/** Snapshot of a single peer's state, passed across the bridge to JS. */
data class PeerInfo(
    val peerId: String,       // hex string, 16 chars (8 bytes)
    val nickname: String,
    val isConnected: Boolean,
    val lastSeenMs: Long,
    /** Raw Noise static public key (32 bytes) once established, else null */
    val noisePublicKey: ByteArray? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PeerInfo) return false
        return peerId == other.peerId &&
               nickname == other.nickname &&
               isConnected == other.isConnected
    }
    
    override fun hashCode(): Int {
        var result = peerId.hashCode()
        result = 31 * result + nickname.hashCode()
        result = 31 * result + isConnected.hashCode()
        return result
    }
}

/**
 * Callback fired on the calling thread whenever the peer list changes.
 * Implementors must be thread-safe.
 */
fun interface PeerChangeListener {
    fun onPeerListChanged(peers: List<PeerInfo>)
}

class PeerRegistry {

    private val peers = ConcurrentHashMap<String, PeerInfo>()
    private val listeners = ConcurrentHashMap.newKeySet<PeerChangeListener>()

    // ── Mutations ──────────────────────────────────────────────────────────────

    /**
     * Upsert a peer. If the peer is new or any field changed the listeners
     * are notified with a full snapshot of the current peer list.
     */
    fun upsert(info: PeerInfo) {
        val prev = peers[info.peerId]
        peers[info.peerId] = info
        if (prev == null || prev != info) {
            Log.d(TAG, "Peer upserted: ${info.peerId} nick=${info.nickname} connected=${info.isConnected}")
            notifyListeners()
        }
    }

    /** Mark a peer as connected (or disconnected) without changing other fields. */
    fun setConnected(peerId: String, connected: Boolean) {
        val existing = peers[peerId] ?: return
        if (existing.isConnected == connected) return
        peers[peerId] = existing.copy(isConnected = connected, lastSeenMs = if (connected) System.currentTimeMillis() else existing.lastSeenMs)
        Log.d(TAG, "Peer ${if (connected) "connected" else "disconnected"}: $peerId")
        notifyListeners()
    }

    /** Update nickname for an already-known peer. */
    fun updateNickname(peerId: String, nickname: String) {
        val existing = peers[peerId] ?: return
        if (existing.nickname == nickname) return
        peers[peerId] = existing.copy(nickname = nickname)
        Log.d(TAG, "Peer nickname updated: $peerId → $nickname")
        notifyListeners()
    }

    /** Store the established Noise static public key for a peer. */
    fun setNoisePublicKey(peerId: String, key: ByteArray) {
        val existing = peers[peerId] ?: return
        peers[peerId] = existing.copy(noisePublicKey = key.clone())
    }

    /** Remove a peer entirely (e.g. after they send a LEAVE packet). */
    fun remove(peerId: String) {
        if (peers.remove(peerId) != null) {
            Log.d(TAG, "Peer removed: $peerId")
            notifyListeners()
        }
    }

    // ── Queries ────────────────────────────────────────────────────────────────

    fun get(peerId: String): PeerInfo? = peers[peerId]

    fun all(): List<PeerInfo> = peers.values.toList()

    fun connectedPeers(): List<PeerInfo> = peers.values.filter { it.isConnected }

    fun nickname(peerId: String): String = peers[peerId]?.nickname ?: peerId.take(8)

    // ── Listeners ─────────────────────────────────────────────────────────────

    fun addListener(listener: PeerChangeListener) { listeners.add(listener) }

    fun removeListener(listener: PeerChangeListener) { listeners.remove(listener) }

    private fun notifyListeners() {
        val snapshot = all()
        listeners.forEach { it.onPeerListChanged(snapshot) }
    }

    /** Remove all peers (e.g. on stopMesh). */
    fun clear() {
        peers.clear()
        notifyListeners()
    }
}
