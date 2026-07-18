package com.offlinechatapp.bitchat

import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.util.zip.DeflaterOutputStream
import java.util.zip.InflaterOutputStream

// ──────────────────────────────────────────────────────────────────────────────
// PacketCodec.kt
//
// Kotlin port of BitFoundation/BinaryProtocol.swift + MessagePadding.swift.
// Every byte offset and flag value matches the Swift source exactly so that
// Android packets can be read by iOS BitChat devices and vice-versa.
// ──────────────────────────────────────────────────────────────────────────────

/** Message type byte constants — mirrors BitFoundation/MessageType.swift */
object MessageType {
    const val ANNOUNCE: Byte        = 0x01
    const val MESSAGE: Byte         = 0x02
    const val LEAVE: Byte           = 0x03
    /** Plain-text addressed direct message (Phase 2). Encrypted in Phase 3. */
    const val DIRECT_MESSAGE: Byte  = 0x05
    const val COURIER_ENVELOPE: Byte = 0x04
    const val NOISE_HANDSHAKE: Byte = 0x10
    const val NOISE_ENCRYPTED: Byte = 0x11
    const val FRAGMENT: Byte        = 0x20
    const val REQUEST_SYNC: Byte    = 0x21
    const val FILE_TRANSFER: Byte   = 0x22
    const val BOARD_POST: Byte      = 0x23
    const val PREKEY_BUNDLE: Byte   = 0x24
    const val GROUP_MESSAGE: Byte   = 0x25
    const val PING: Byte            = 0x26
    const val PONG: Byte            = 0x27
    const val NOSTR_CARRIER: Byte   = 0x28
    const val VOICE_FRAME: Byte     = 0x29
}

/** BLE / protocol constants — mirrors TransportConfig.swift */
object ProtocolConstants {
    /**
     * BLE GATT service UUID — mainnet (iOS RELEASE builds).
     * iOS DEBUG builds use SERVICE_UUID_TESTNET instead.
     * BLEMeshService scans for BOTH.
     */
    const val SERVICE_UUID          = "F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C" // mainnet
    const val SERVICE_UUID_TESTNET  = "F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5A" // testnet / iOS DEBUG
    /** BLE GATT characteristic UUID */
    const val CHAR_UUID             = "A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D"
    /** Default hop TTL for broadcast messages */
    const val DEFAULT_TTL: Byte     = 7
    /** Fragment size in bytes (matches bleDefaultFragmentSize) */
    const val FRAGMENT_SIZE         = 469
    /** Wire protocol version we emit */
    const val VERSION: Byte         = 1

    // Header layout sizes
    const val V1_HEADER_SIZE        = 14
    const val SENDER_ID_SIZE        = 8
    const val RECIPIENT_ID_SIZE     = 8
    const val SIGNATURE_SIZE        = 64

    // Flag bits (BinaryProtocol.Flags)
    const val FLAG_HAS_RECIPIENT: Byte  = 0x01
    const val FLAG_HAS_SIGNATURE: Byte  = 0x02
    const val FLAG_IS_COMPRESSED: Byte  = 0x04
}

/**
 * Decoded representation of a BitChat BLE packet.
 * Mirrors BitFoundation/BitchatPacket.swift
 */
data class BitchatPacket(
    val version: Byte,
    val type: Byte,
    val ttl: Byte,
    val timestamp: Long,          // milliseconds since epoch, UInt64 on wire
    val senderID: ByteArray,      // 8 bytes
    val recipientID: ByteArray?,  // 8 bytes, null = broadcast
    val payload: ByteArray,
    val signature: ByteArray?     // 64 bytes Ed25519
) {
    /** Hex string of senderID — used as peer identifier in JS */
    val senderIDHex: String get() = senderID.toHexString()

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is BitchatPacket) return false
        return version == other.version &&
               type == other.type &&
               senderID.contentEquals(other.senderID) &&
               timestamp == other.timestamp
    }

    override fun hashCode(): Int {
        var result = version.toInt()
        result = 31 * result + type.toInt()
        result = 31 * result + senderID.contentHashCode()
        result = 31 * result + timestamp.hashCode()
        return result
    }
}

/** Extension: ByteArray → lowercase hex string */
fun ByteArray.toHexString(): String = joinToString("") { "%02x".format(it.toInt() and 0xFF) }

/** Extension: hex string → ByteArray (returns null on bad input) */
fun String.hexToByteArray(): ByteArray? {
    if (length % 2 != 0) return null
    return try {
        ByteArray(length / 2) { i ->
            substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
    } catch (e: NumberFormatException) {
        null
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Codec — encode & decode
// ──────────────────────────────────────────────────────────────────────────────

object PacketCodec {

    /**
     * Encode a [BitchatPacket] to the BitChat BLE wire format.
     *
     * Wire layout (v1):
     * ```
     * [1]  version
     * [1]  type
     * [1]  TTL
     * [8]  timestamp (big-endian UInt64, ms since epoch)
     * [1]  flags
     * [2]  payload length (big-endian UInt16)
     * [8]  senderID
     * [8?] recipientID   (only if FLAG_HAS_RECIPIENT)
     * [N]  payload
     * [64?] signature    (only if FLAG_HAS_SIGNATURE)
     * ```
     * After packing, PKCS#7 padding is applied to the nearest block size
     * in {256, 512, 1024, 2048} — matching MessagePadding.swift.
     */
    fun encode(packet: BitchatPacket, applyPadding: Boolean = true): ByteArray? {
        val out = ByteArrayOutputStream()

        var payload = packet.payload
        var isCompressed = false
        var originalSize = 0

        // Compress if payload > 256 bytes (matches CompressionUtil.shouldCompress threshold)
        if (payload.size > 256) {
            val compressed = compress(payload) ?: payload
            if (compressed.size < payload.size) {
                originalSize = payload.size
                payload = compressed
                isCompressed = true
            }
        }

        // Payload length field = compressed size + optional 2-byte originalSize prefix
        val payloadDataSize = payload.size + if (isCompressed) 2 else 0

        if (payloadDataSize > 0xFFFF) return null  // exceeds UInt16

        // Version
        out.write(packet.version.toInt())
        // Type
        out.write(packet.type.toInt())
        // TTL
        out.write(packet.ttl.toInt())
        // Timestamp: 8 bytes big-endian
        val ts = packet.timestamp
        for (shift in 56 downTo 0 step 8) {
            out.write(((ts ushr shift) and 0xFF).toInt())
        }
        // Flags
        var flags: Int = 0
        if (packet.recipientID != null)   flags = flags or ProtocolConstants.FLAG_HAS_RECIPIENT.toInt()
        if (packet.signature != null)     flags = flags or ProtocolConstants.FLAG_HAS_SIGNATURE.toInt()
        if (isCompressed)                 flags = flags or ProtocolConstants.FLAG_IS_COMPRESSED.toInt()
        out.write(flags)
        // Payload length (UInt16 big-endian)
        out.write((payloadDataSize ushr 8) and 0xFF)
        out.write(payloadDataSize and 0xFF)
        // SenderID (exactly 8 bytes, zero-pad if shorter)
        val sender = packet.senderID.copyOf(ProtocolConstants.SENDER_ID_SIZE)
        out.write(sender)
        // RecipientID (optional)
        if (packet.recipientID != null) {
            val recipient = packet.recipientID.copyOf(ProtocolConstants.RECIPIENT_ID_SIZE)
            out.write(recipient)
        }
        // If compressed: prepend original size as UInt16 big-endian, then compressed bytes
        if (isCompressed) {
            out.write((originalSize ushr 8) and 0xFF)
            out.write(originalSize and 0xFF)
        }
        out.write(payload)
        // Signature (optional, 64 bytes)
        if (packet.signature != null) {
            out.write(packet.signature.copyOf(ProtocolConstants.SIGNATURE_SIZE))
        }

        val raw = out.toByteArray()
        return if (applyPadding) MessagePadding.pad(raw) else raw
    }

    /**
     * Decode a raw BLE byte array into a [BitchatPacket].
     * Strips PKCS#7 padding first (matches MessagePadding.unpad).
     * Returns null on any format violation.
     */
    fun decode(data: ByteArray): BitchatPacket? {
        // Try with padding stripped first; fall back to raw bytes
        val unpadded = MessagePadding.unpad(data)
        return decodeCore(unpadded) ?: decodeCore(data)
    }

    private fun decodeCore(data: ByteArray): BitchatPacket? {
        val minSize = ProtocolConstants.V1_HEADER_SIZE + ProtocolConstants.SENDER_ID_SIZE
        if (data.size < minSize) return null

        var offset = 0

        fun readByte(): Byte? {
            if (offset >= data.size) return null
            return data[offset++]
        }

        fun readShortBE(): Int? {
            if (offset + 2 > data.size) return null
            val v = ((data[offset].toInt() and 0xFF) shl 8) or
                    (data[offset + 1].toInt() and 0xFF)
            offset += 2
            return v
        }

        fun readLongBE(): Long? {
            if (offset + 8 > data.size) return null
            var v = 0L
            repeat(8) { v = (v shl 8) or (data[offset++].toLong() and 0xFF) }
            return v
        }

        fun readBytes(n: Int): ByteArray? {
            if (offset + n > data.size) return null
            val b = data.copyOfRange(offset, offset + n)
            offset += n
            return b
        }

        val version = readByte() ?: return null
        if (version != 1.toByte() && version != 2.toByte()) return null

        val type        = readByte() ?: return null
        val ttl         = readByte() ?: return null
        val timestamp   = readLongBE() ?: return null
        val flags       = readByte()?.toInt() ?: return null

        val hasRecipient  = (flags and ProtocolConstants.FLAG_HAS_RECIPIENT.toInt()) != 0
        val hasSignature  = (flags and ProtocolConstants.FLAG_HAS_SIGNATURE.toInt()) != 0
        val isCompressed  = (flags and ProtocolConstants.FLAG_IS_COMPRESSED.toInt()) != 0

        val payloadLength = readShortBE() ?: return null
        if (payloadLength < 0) return null

        val senderID    = readBytes(ProtocolConstants.SENDER_ID_SIZE) ?: return null
        val recipientID = if (hasRecipient) readBytes(ProtocolConstants.RECIPIENT_ID_SIZE) ?: return null else null

        // Decode payload (with optional decompression)
        val payload: ByteArray
        if (isCompressed) {
            if (payloadLength < 2) return null
            val originalSz = readShortBE() ?: return null
            val compressedSz = payloadLength - 2
            if (compressedSz <= 0) return null
            val compressed = readBytes(compressedSz) ?: return null
            // Safety: reject absurd compression ratios
            if (originalSz > 0 && (originalSz.toDouble() / compressedSz) > 50_000.0) return null
            payload = decompress(compressed, originalSz) ?: return null
            if (payload.size != originalSz) return null
        } else {
            payload = readBytes(payloadLength) ?: return null
        }

        val signature = if (hasSignature) readBytes(ProtocolConstants.SIGNATURE_SIZE) else null

        return BitchatPacket(
            version     = version,
            type        = type,
            ttl         = ttl,
            timestamp   = timestamp,
            senderID    = senderID,
            recipientID = recipientID,
            payload     = payload,
            signature   = signature
        )
    }

    // ── Compression (zlib/deflate, matching CompressionUtil.swift) ─────────────

    private fun compress(data: ByteArray): ByteArray? = try {
        val bos = ByteArrayOutputStream()
        DeflaterOutputStream(bos).use { it.write(data) }
        bos.toByteArray()
    } catch (_: Exception) { null }

    private fun decompress(data: ByteArray, originalSize: Int): ByteArray? = try {
        val bos = ByteArrayOutputStream(originalSize)
        InflaterOutputStream(bos).use { it.write(data) }
        bos.toByteArray()
    } catch (_: Exception) { null }
}

// ──────────────────────────────────────────────────────────────────────────────
// MessagePadding — Kotlin port of MessagePadding.swift
// PKCS#7-style padding to block sizes {256, 512, 1024, 2048}
// ──────────────────────────────────────────────────────────────────────────────

object MessagePadding {
    private val BLOCK_SIZES = intArrayOf(256, 512, 1024, 2048)

    fun pad(data: ByteArray): ByteArray {
        val targetSize = optimalBlockSize(data.size)
        if (data.size >= targetSize) return data
        val paddingNeeded = targetSize - data.size
        if (paddingNeeded <= 0 || paddingNeeded > 255) return data
        val padded = data.copyOf(targetSize)
        val padByte = paddingNeeded.toByte()
        for (i in data.size until targetSize) padded[i] = padByte
        return padded
    }

    fun unpad(data: ByteArray): ByteArray {
        if (data.isEmpty()) return data
        val last = data.last().toInt() and 0xFF
        if (last <= 0 || last > data.size) return data
        val start = data.size - last
        // Verify all pad bytes equal `last`
        for (i in start until data.size) {
            if ((data[i].toInt() and 0xFF) != last) return data
        }
        return data.copyOfRange(0, start)
    }

    private fun optimalBlockSize(dataSize: Int): Int {
        val totalSize = dataSize + 16  // +16 encryption overhead estimate
        for (blockSize in BLOCK_SIZES) {
            if (totalSize <= blockSize) return blockSize
        }
        return dataSize
    }
}
