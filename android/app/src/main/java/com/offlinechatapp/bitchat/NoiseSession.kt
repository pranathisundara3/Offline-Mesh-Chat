package com.offlinechatapp.bitchat

import android.util.Log
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

// ──────────────────────────────────────────────────────────────────────────────
// NoiseSession.kt
//
// Phase 3: Noise_XX_25519_ChaChaPoly_BLAKE2s session manager.
//
// For Phase 1+2 (peer discovery + public broadcast) this file provides
// STUB implementations so the code compiles and runs. The stubs:
//   - initiateHandshake()  → no-op (handshake not yet implemented)
//   - processHandshake()   → returns null (no reply)
//   - encrypt()            → null (no session)
//   - decrypt()            → null (no session)
//   - sendEncrypted()      → false (no session)
//
// Phase 3 will replace these stubs with a real Noise_XX implementation
// using BouncyCastle's X25519 + ChaCha20Poly1305.
// ──────────────────────────────────────────────────────────────────────────────

private const val TAG = "BitChat/Noise"

/** Placeholder session state — expanded in Phase 3 */
private data class SessionState(
    val peerId: String,
    val isEstablished: Boolean = false,
    val sendKey: ByteArray? = null,
    val receiveKey: ByteArray? = null
)

/**
 * Manages Noise protocol sessions with remote peers.
 * Uses [BLEMeshService] to send handshake packets.
 *
 * Currently a stub for Phase 1+2. All methods are safe no-ops.
 */
class NoiseSessionManager(private val bleService: BLEMeshService) {

    private val sessions = ConcurrentHashMap<String, SessionState>()

    // ── Handshake ─────────────────────────────────────────────────────────────

    /**
     * Begin a Noise_XX handshake with [peerId].
     * Phase 1+2 stub: no-op.
     */
    fun initiateHandshake(peerId: String) {
        Log.d(TAG, "initiateHandshake($peerId) — stub, Phase 3 will implement")
        // TODO Phase 3: generate ephemeral key, build handshake message 1, send via bleService
    }

    /**
     * Process an incoming handshake payload from [senderId].
     * Returns a reply payload if we need to send one, otherwise null.
     * Phase 1+2 stub: returns null.
     */
    fun processHandshake(senderId: String, payload: ByteArray): ByteArray? {
        Log.d(TAG, "processHandshake($senderId, ${payload.size}B) — stub, Phase 3 will implement")
        // TODO Phase 3: process handshake msg 1/2/3, derive session keys, reply as needed
        return null
    }

    // ── Encryption / Decryption ───────────────────────────────────────────────

    /**
     * Encrypt [plaintext] for [recipientPeerId] using the established session.
     * Returns null if no session exists yet.
     * Phase 1+2 stub: always returns null.
     */
    fun encrypt(recipientPeerId: String, plaintext: ByteArray): ByteArray? {
        val session = sessions[recipientPeerId] ?: return null
        if (!session.isEstablished || session.sendKey == null) return null
        // TODO Phase 3: ChaCha20-Poly1305 AEAD encrypt
        return null
    }

    /**
     * Decrypt [ciphertext] from [senderId] using the established session.
     * Returns null if no session or decryption fails.
     * Phase 1+2 stub: always returns null.
     */
    fun decrypt(senderId: String, ciphertext: ByteArray): ByteArray? {
        val session = sessions[senderId] ?: return null
        if (!session.isEstablished || session.receiveKey == null) return null
        // TODO Phase 3: ChaCha20-Poly1305 AEAD decrypt
        return null
    }

    /**
     * Encrypt and send a private message to [recipientPeerId].
     * Returns false if no established session (caller should queue or notify user).
     * Phase 1+2 stub: always returns false.
     */
    fun sendEncrypted(recipientPeerId: String, plaintext: ByteArray): Boolean {
        val ciphertext = encrypt(recipientPeerId, plaintext) ?: return false
        return bleService.sendEncryptedMessage(recipientPeerId, ciphertext)
    }

    // ── Session management ────────────────────────────────────────────────────

    fun hasSession(peerId: String): Boolean =
        sessions[peerId]?.isEstablished == true

    fun removeSession(peerId: String) {
        sessions.remove(peerId)
    }

    fun clearAll() {
        sessions.clear()
    }
}
