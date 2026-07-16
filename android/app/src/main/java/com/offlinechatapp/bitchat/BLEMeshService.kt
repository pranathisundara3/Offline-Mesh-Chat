package com.offlinechatapp.bitchat

import android.bluetooth.*
import android.bluetooth.le.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.LinkedBlockingQueue

// ──────────────────────────────────────────────────────────────────────────────
// BLEMeshService.kt  (debugged rewrite)
//
// Fixed bugs:
//   1. SERVICE_UUID now exposes BOTH mainnet AND testnet so we match iOS
//      Debug builds (testnet) and release builds (mainnet).
//   2. writeDescriptor race — announce is sent ONLY inside onDescriptorWrite,
//      after the CCCD subscription write completes.
//   3. Sequential write queue — each writeCharacteristic waits for
//      onCharacteristicWrite before sending the next chunk.
//   4. Buffer corruption — writeBuffers cleared on decode failure after
//      MAX_BUFFER_BYTES so stale bytes don't corrupt future payloads.
//   5. Announce payload decoding — only packet.payload bytes decoded as
//      nickname, with strict UTF-8 validation.
//   6. Full verbose logging at every lifecycle step for debugging.
// ──────────────────────────────────────────────────────────────────────────────

private const val TAG = "BitChat/BLE"

// ── Protocol UUIDs ──────────────────────────────────────────────────────────
// The iOS app has two UUIDs: one for DEBUG builds (testnet) and one for RELEASE
// (mainnet). We must match whichever the peer is using.
// We advertise MAINNET and scan for BOTH.
private const val SERVICE_UUID_MAINNET = "F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C"
private const val SERVICE_UUID_TESTNET = "F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5A"
private const val CHARACTERISTIC_UUID  = "A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D"
private const val CCCD_UUID            = "00002902-0000-1000-8000-00805f9b34fb"

// Max bytes to accumulate before treating a buffer as corrupted and resetting
private const val MAX_BUFFER_BYTES = 2048

/** Events fired by [BLEMeshService] back to the Native Module. */
interface MeshEventListener {
    fun onPublicMessageReceived(
        messageId: String,
        senderId: String,
        senderNickname: String,
        content: String,
        timestampMs: Long
    )

    fun onPrivateMessageReceived(
        messageId: String,
        senderId: String,
        senderNickname: String,
        encryptedPayload: ByteArray,
        timestampMs: Long
    )

    /** Plain-text direct message addressed specifically to us (Phase 2). */
    fun onDirectMessageReceived(
        messageId: String,
        senderId: String,
        senderNickname: String,
        recipientId: String,
        content: String,
        timestampMs: Long
    )

    fun onNoiseHandshakeReceived(senderId: String, payload: ByteArray)

    fun onPeerConnected(peerId: String, nickname: String)
    fun onPeerDisconnected(peerId: String)
    fun onPeerListUpdated(peers: List<PeerInfo>)
    fun onBluetoothStateChanged(state: String)  // "on" | "off" | "unauthorized"
}

// ── Per-device sequential write queue ─────────────────────────────────────────
// Android BLE requires strictly sequential GATT operations. Each device gets
// its own queue of byte chunks. The next chunk is sent only after
// onCharacteristicWrite fires for the previous one.
private class WriteQueue {
    private val queue = LinkedBlockingQueue<ByteArray>()
    @Volatile var busy = false

    fun enqueue(chunk: ByteArray) { queue.add(chunk) }
    fun poll(): ByteArray? = queue.poll()
    fun clear() { queue.clear(); busy = false }
    val isEmpty: Boolean get() = queue.isEmpty()
}

class BLEMeshService(
    private val context: Context,
    private val peerRegistry: PeerRegistry
) {

    // ── Identity ───────────────────────────────────────────────────────────────

    val myPeerID: ByteArray = generatePeerID()
    val myPeerIDHex: String get() = myPeerID.toHexString()
    var myNickname: String = "anon"

    // ── BLE infrastructure ────────────────────────────────────────────────────

    private val serviceUUIDMainnet    = UUID.fromString(SERVICE_UUID_MAINNET)
    private val serviceUUIDTestnet    = UUID.fromString(SERVICE_UUID_TESTNET)
    private val characteristicUUID    = UUID.fromString(CHARACTERISTIC_UUID)

    private var bluetoothManager:  BluetoothManager?  = null
    private var bluetoothAdapter:  BluetoothAdapter?  = null
    private var leScanner:         BluetoothLeScanner? = null
    private var leAdvertiser:      BluetoothLeAdvertiser? = null
    private var gattServer:        BluetoothGattServer? = null

    /** Connections we opened as central: device-address → BluetoothGatt */
    private val centralConns      = ConcurrentHashMap<String, BluetoothGatt>()
    /** Connections opened to our GATT server (peripheral role): device-address */
    private val peripheralConns   = ConcurrentHashMap.newKeySet<String>()
    /** Characteristic handle per connected peer device */
    private val peerCharacteristics = ConcurrentHashMap<String, BluetoothGattCharacteristic>()
    /** Per-device write queues (address → WriteQueue) */
    private val writeQueues       = ConcurrentHashMap<String, WriteQueue>()
    /** Partial receive buffers: device address → accumulated bytes */
    private val writeBuffers      = ConcurrentHashMap<String, ByteArray>()
    /** Received message-ID dedup set (bounded) */
    private val seenMessages      = LinkedHashSet<String>(512)
    /** Devices for which we have successfully written the CCCD (subscribed) */
    private val subscribedDevices = ConcurrentHashMap.newKeySet<String>()

    /**
     * Maps BLE device MAC address → peerId (hex) so that on GATT disconnect
     * we can mark exactly the right peer as offline instead of marking them all.
     * Populated in handleAnnounce when the peer first identifies itself.
     */
    private val deviceAddressToPeerId = ConcurrentHashMap<String, String>()

    // ── State ─────────────────────────────────────────────────────────────────

    private val running = AtomicBoolean(false)
    var eventListener: MeshEventListener? = null

    private var scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "bitchat-mesh").also { it.isDaemon = true }
        }

    // Handler on the main looper — used only for non-blocking log context
    private val mainHandler = Handler(Looper.getMainLooper())

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    fun start(nickname: String) {
        if (running.getAndSet(true)) {
            Log.w(TAG, "start() called while already running — ignored")
            return
        }
        
        // Recreate the scheduler if it was previously shut down (e.g. by stop())
        if (scheduler.isShutdown) {
            scheduler = Executors.newSingleThreadScheduledExecutor { r ->
                Thread(r, "bitchat-mesh").also { it.isDaemon = true }
            }
        }
        
        myNickname = nickname
        Log.i(TAG, "═══════════════════════════════════════════════")
        Log.i(TAG, "  BLE MESH START  nickname='$nickname'  id=$myPeerIDHex")
        Log.i(TAG, "  Service UUID (mainnet): $SERVICE_UUID_MAINNET")
        Log.i(TAG, "  Service UUID (testnet): $SERVICE_UUID_TESTNET")
        Log.i(TAG, "  Characteristic UUID:    $CHARACTERISTIC_UUID")
        Log.i(TAG, "═══════════════════════════════════════════════")

        bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        bluetoothAdapter = bluetoothManager?.adapter

        if (bluetoothAdapter == null) {
            Log.e(TAG, "❌ BluetoothAdapter is null — device has no Bluetooth")
            eventListener?.onBluetoothStateChanged("off")
            return
        }

        // Always register the BroadcastReceiver so we catch BT toggling.
        val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
        context.registerReceiver(bluetoothStateReceiver, filter)
        Log.i(TAG, "📡 BluetoothStateReceiver registered")

        if (!bluetoothAdapter!!.isEnabled) {
            Log.e(TAG, "❌ Bluetooth is disabled — waiting for STATE_ON")
            eventListener?.onBluetoothStateChanged("off")
            // Don't return — the BroadcastReceiver will call startBleStack() when BT turns on.
            return
        }

        Log.i(TAG, "✅ Bluetooth adapter ready. Starting GATT server, advertising, scanning…")
        setupGattServer()
        startAdvertising()
        startScanning()
        eventListener?.onBluetoothStateChanged("on")

        // Periodic announce every 30 s
        scheduler.scheduleWithFixedDelay({
            try {
                Log.d(TAG, "⏱ Periodic announce (${peerRegistry.connectedPeers().size} peers)")
                broadcastAnnounce()
            } catch (e: Exception) {
                Log.w(TAG, "Announce error: ${e.message}")
            }
        }, 2, 30, TimeUnit.SECONDS)
    }

    /**
     * Starts the BLE mesh services (GATT server, advertising, scanning).
     * Separated so it can be called both from [start] and from the
     * BroadcastReceiver when Bluetooth transitions to STATE_ON.
     */
    private fun startBleStack() {
        if (gattServer != null) return  // already set up
        Log.i(TAG, "▶ startBleStack()")
        setupGattServer()
        startAdvertising()
        startScanning()
        eventListener?.onBluetoothStateChanged("on")
    }

    /**
     * BroadcastReceiver that watches for Bluetooth being turned on or off.
     */
    private val bluetoothStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
            Log.i(TAG, "BT state changed: $state")
            when (state) {
                BluetoothAdapter.STATE_ON -> {
                    if (running.get()) {
                        Log.i(TAG, "BT turned ON while mesh is running — starting BLE stack")
                        startBleStack()
                        // Kick off a periodic announce now that BT is ready
                        scheduler.schedule({ broadcastAnnounce() }, 500, TimeUnit.MILLISECONDS)
                    }
                }
                BluetoothAdapter.STATE_OFF -> {
                    Log.i(TAG, "BT turned OFF — tearing down BLE stack and notifying JS")
                    // Do not change 'running' state or shut down the scheduler.
                    // Just clean up the BLE components so they can be recreated on STATE_ON.
                    stopBleStack()
                    eventListener?.onBluetoothStateChanged("off")
                }
            }
        }
    }

    /**
     * Tears down the GATT server, connections, and advertising/scanning.
     */
    private fun stopBleStack() {
        stopScanning()
        stopAdvertising()

        centralConns.values.forEach { it.disconnect() }
        centralConns.clear()
        peripheralConns.clear()
        peerCharacteristics.clear()
        writeQueues.clear()
        writeBuffers.clear()
        subscribedDevices.clear()
        deviceAddressToPeerId.clear()

        gattServer?.close()
        gattServer = null
        
        // Ensure peers are cleared so we don't hold stale state
        peerRegistry.clear()
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        Log.i(TAG, "BLE mesh stopping")
        try { broadcastLeave() } catch (_: Exception) {}

        scheduler.shutdownNow()
        stopBleStack()

        try { context.unregisterReceiver(bluetoothStateReceiver) } catch (_: Exception) {}
        Log.i(TAG, "📡 BluetoothStateReceiver unregistered")
    }

    fun setNickname(nickname: String) {
        Log.i(TAG, "Nickname changed to '$nickname'")
        myNickname = nickname
        broadcastAnnounce()
    }

    // ── Disconnect Helper ─────────────────────────────────────────────────────

    private fun handleDisconnect(addr: String, role: String) {
        if (role == "central") {
            centralConns.remove(addr)
            peerCharacteristics.remove(addr)
            subscribedDevices.remove(addr)
        } else {
            peripheralConns.remove(addr)
        }

        val macFullyDisconnected = !centralConns.containsKey(addr) && !peripheralConns.contains(addr)

        if (macFullyDisconnected) {
            writeQueues[addr]?.clear()
            writeQueues.remove(addr)
            writeBuffers.remove(addr)
            
            val peerId = deviceAddressToPeerId[addr]
            if (peerId != null) {
                val stillConnected = centralConns.keys.any { deviceAddressToPeerId[it] == peerId } ||
                                     peripheralConns.any { deviceAddressToPeerId[it] == peerId }
                if (!stillConnected) {
                    Log.i(TAG, "  Peer $peerId marked disconnected (all paths gone)")
                    peerRegistry.setConnected(peerId, false)
                    eventListener?.onPeerDisconnected(peerId)
                    eventListener?.onPeerListUpdated(peerRegistry.all())
                } else {
                    Log.d(TAG, "  Peer $peerId remains connected on another path")
                }
            }
        }
    }

    // ── GATT Server (peripheral role) ─────────────────────────────────────────

    private fun setupGattServer() {
        Log.i(TAG, "Setting up GATT server…")
        gattServer = bluetoothManager?.openGattServer(context, gattServerCallback)
        if (gattServer == null) {
            Log.e(TAG, "❌ openGattServer returned null")
            return
        }

        // We advertise MAINNET UUID so release iOS builds can find us.
        // Testnet iOS builds will connect after discovering via scan filter.
        val service = BluetoothGattService(serviceUUIDMainnet, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val characteristic = BluetoothGattCharacteristic(
            characteristicUUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or
                    BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
                    BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        )
        val cccd = BluetoothGattDescriptor(
            UUID.fromString(CCCD_UUID),
            BluetoothGattDescriptor.PERMISSION_WRITE or BluetoothGattDescriptor.PERMISSION_READ
        )
        characteristic.addDescriptor(cccd)
        service.addCharacteristic(characteristic)
        gattServer?.addService(service)
        Log.i(TAG, "✅ GATT server started with service ${SERVICE_UUID_MAINNET}")
    }

    private val gattServerCallback = object : BluetoothGattServerCallback() {

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            val stateStr = if (newState == BluetoothProfile.STATE_CONNECTED) "CONNECTED" else "DISCONNECTED"
            Log.i(TAG, "GATT server: device ${device.address} → $stateStr (status=$status)")
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                peripheralConns.add(device.address)
                val knownPeerId = deviceAddressToPeerId[device.address]
                if (knownPeerId != null) {
                    peerRegistry.setConnected(knownPeerId, true)
                    eventListener?.onPeerConnected(knownPeerId, peerRegistry.nickname(knownPeerId))
                    eventListener?.onPeerListUpdated(peerRegistry.all())
                }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                handleDisconnect(device.address, "peripheral")
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice, requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean, responseNeeded: Boolean,
            offset: Int, value: ByteArray
        ) {
            Log.d(TAG, "← GATT write from ${device.address}: ${value.size}B  responseNeeded=$responseNeeded")
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
            handleIncomingBytes(device.address, value, role = "peripheral")
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice, requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean, responseNeeded: Boolean,
            offset: Int, value: ByteArray
        ) {
            Log.d(TAG, "GATT server: CCCD write from ${device.address}")
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
        }
    }

    // ── GATT Client (central role) ────────────────────────────────────────────

    private fun startScanning() {
        leScanner = bluetoothAdapter?.bluetoothLeScanner
        if (leScanner == null) {
            Log.e(TAG, "❌ bluetoothLeScanner is null — cannot scan")
            return
        }

        // Scan for BOTH mainnet and testnet UUIDs so we find iOS Debug + Release builds
        val filters = listOf(
            ScanFilter.Builder().setServiceUuid(ParcelUuid(serviceUUIDMainnet)).build(),
            ScanFilter.Builder().setServiceUuid(ParcelUuid(serviceUUIDTestnet)).build()
        )
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
            .build()

        leScanner?.startScan(filters, settings, scanCallback)
        Log.i(TAG, "✅ BLE scan started (mainnet + testnet filters)")
    }

    private fun stopScanning() {
        try {
            leScanner?.stopScan(scanCallback)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to stop scan (expected if BT is off): ${e.message}")
        }
        leScanner = null
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            val uuids = result.scanRecord?.serviceUuids?.joinToString { it.uuid.toString() } ?: "none"
            Log.d(TAG, "📡 Scan hit: ${device.address}  rssi=${result.rssi}  uuids=$uuids")

            if (centralConns.containsKey(device.address)) {
                Log.d(TAG, "  Already connected to ${device.address} — skipping")
                return
            }
            Log.i(TAG, "  → Connecting to ${device.address}")
            connectToPeer(device)
        }

        override fun onScanFailed(errorCode: Int) {
            Log.e(TAG, "❌ BLE scan FAILED: errorCode=$errorCode")
            // SCAN_FAILED_APPLICATION_REGISTRATION_FAILED = 2 means BT state issue
            eventListener?.onBluetoothStateChanged("off")
        }
    }

    private fun connectToPeer(device: BluetoothDevice) {
        if (centralConns.size >= 6) {
            Log.w(TAG, "Max connections (6) reached — not connecting to ${device.address}")
            return
        }
        Log.i(TAG, "🔗 Initiating GATT connection to ${device.address}")
        val gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            device.connectGatt(context, false, gattClientCallback, BluetoothDevice.TRANSPORT_LE)
        } else {
            device.connectGatt(context, false, gattClientCallback)
        }
        centralConns[device.address] = gatt
    }

    private val gattClientCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    Log.i(TAG, "✅ GATT connected: ${gatt.device.address}  status=$status")
                    val knownPeerId = deviceAddressToPeerId[gatt.device.address]
                    if (knownPeerId != null) {
                        peerRegistry.setConnected(knownPeerId, true)
                        eventListener?.onPeerConnected(knownPeerId, peerRegistry.nickname(knownPeerId))
                        eventListener?.onPeerListUpdated(peerRegistry.all())
                    }
                    Log.i(TAG, "   → Requesting MTU=512 then discovering services…")
                    // Request maximum MTU before service discovery
                    val mtuRequested = gatt.requestMtu(512)
                    Log.d(TAG, "   requestMtu(512) returned $mtuRequested")
                    if (!mtuRequested) {
                        // MTU request not needed on older devices; discover services directly
                        gatt.discoverServices()
                    }
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    Log.i(TAG, "⚠ GATT disconnected: ${gatt.device.address}  status=$status")
                    handleDisconnect(gatt.device.address, "central")
                    gatt.close()
                }
            }
        }

        // FIX: request MTU before discovering services for fragmentation support
        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            Log.i(TAG, "MTU changed: ${gatt.device.address}  mtu=$mtu  status=$status")
            // Now discover services regardless of MTU result
            val discovering = gatt.discoverServices()
            Log.i(TAG, "   → discoverServices() = $discovering")
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            Log.i(TAG, "Services discovered: ${gatt.device.address}  status=$status")
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.e(TAG, "❌ onServicesDiscovered failed: status=$status")
                return
            }

            val allServices = gatt.services.map { it.uuid.toString() }
            Log.i(TAG, "   All services: $allServices")

            // Try mainnet UUID first, then testnet
            val svc = gatt.getService(serviceUUIDMainnet)
                ?: gatt.getService(serviceUUIDTestnet)
            if (svc == null) {
                Log.e(TAG, "❌ BitChat service NOT found on ${gatt.device.address}. Has neither mainnet nor testnet UUID.")
                return
            }
            Log.i(TAG, "   ✅ Found BitChat service: ${svc.uuid}")

            val char = svc.getCharacteristic(characteristicUUID)
            if (char == null) {
                Log.e(TAG, "❌ BitChat characteristic NOT found on ${gatt.device.address}")
                return
            }
            Log.i(TAG, "   ✅ Found characteristic: ${char.uuid}")
            Log.i(TAG, "   Characteristic properties: ${char.properties} " +
                    "(NOTIFY=${char.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0})")

            peerCharacteristics[gatt.device.address] = char

            // FIX: Subscribe to notifications FIRST. The announce is sent only after
            // onDescriptorWrite fires, to avoid the race condition where writeCharacteristic
            // and writeDescriptor both run at the same time.
            Log.i(TAG, "   → Enabling notifications (writing CCCD)…")
            val notifyEnabled = gatt.setCharacteristicNotification(char, true)
            Log.d(TAG, "   setCharacteristicNotification=$notifyEnabled")

            val cccd = char.getDescriptor(UUID.fromString(CCCD_UUID))
            if (cccd == null) {
                Log.e(TAG, "❌ CCCD descriptor not found — notifications won't work")
                // Send announce anyway since server-side writes will still work
                scheduler.submit { sendAnnounceToDevice(gatt.device.address) }
                return
            }

            cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            val writeOk = gatt.writeDescriptor(cccd)
            Log.i(TAG, "   writeDescriptor(CCCD) = $writeOk  [announce will be sent in onDescriptorWrite]")
        }

        // FIX: Send announce AFTER the CCCD write completes, not before.
        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int
        ) {
            val addr = gatt.device.address
            Log.i(TAG, "✅ CCCD write complete: $addr  status=$status  uuid=${descriptor.uuid}")

            if (status == BluetoothGatt.GATT_SUCCESS) {
                subscribedDevices.add(addr)
                Log.i(TAG, "   → Sending announce to $addr")
                // Small delay to let the peripheral process the CCCD write
                scheduler.schedule({ sendAnnounceToDevice(addr) }, 100, TimeUnit.MILLISECONDS)
            } else {
                Log.e(TAG, "❌ CCCD write FAILED on $addr  status=$status — sending announce anyway")
                scheduler.submit { sendAnnounceToDevice(addr) }
            }
        }

        // FIX: Drain the write queue — send next chunk only after this one completes.
        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            val addr = gatt.device.address
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.e(TAG, "❌ writeCharacteristic FAILED on $addr  status=$status")
            } else {
                Log.d(TAG, "✓ writeCharacteristic ok on $addr")
            }
            // Drain next queued chunk
            drainWriteQueue(addr, gatt, characteristic)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            val value = characteristic.value ?: return
            Log.d(TAG, "← Notification from ${gatt.device.address}: ${value.size}B")
            handleIncomingBytes(gatt.device.address, value, role = "central")
        }

        // API 33+
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            Log.d(TAG, "← Notification (API33) from ${gatt.device.address}: ${value.size}B")
            handleIncomingBytes(gatt.device.address, value, role = "central")
        }
    }

    // ── Advertising ───────────────────────────────────────────────────────────

    private fun startAdvertising() {
        leAdvertiser = bluetoothAdapter?.bluetoothLeAdvertiser
        if (leAdvertiser == null) {
            Log.e(TAG, "❌ bluetoothLeAdvertiser is null — cannot advertise (device may not support peripheral mode)")
            return
        }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setConnectable(true)
            .setTimeout(0)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .build()
        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(serviceUUIDMainnet))
            .setIncludeDeviceName(false)
            .build()
        leAdvertiser?.startAdvertising(settings, data, advertiseCallback)
        Log.i(TAG, "✅ BLE advertising started (mainnet UUID)")
    }

    private fun stopAdvertising() {
        try {
            leAdvertiser?.stopAdvertising(advertiseCallback)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to stop advertising (expected if BT is off): ${e.message}")
        }
        leAdvertiser = null
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            Log.i(TAG, "✅ Advertising active")
        }
        override fun onStartFailure(errorCode: Int) {
            // Common codes: ADVERTISE_FAILED_DATA_TOO_LARGE=1, FEATURE_UNSUPPORTED=5
            Log.e(TAG, "❌ Advertising FAILED: errorCode=$errorCode")
        }
    }

    // ── Incoming packet pipeline ───────────────────────────────────────────────

    private fun handleIncomingBytes(deviceAddress: String, bytes: ByteArray, role: String) {
        Log.d(TAG, "← [$role] ${bytes.size}B from $deviceAddress")

        val accumulated = synchronized(writeBuffers) {
            val prev = writeBuffers[deviceAddress] ?: ByteArray(0)
            val combined = prev + bytes
            // FIX: guard against unbounded buffer growth from corrupted streams
            if (combined.size > MAX_BUFFER_BYTES) {
                Log.w(TAG, "Buffer overflow (${ combined.size}B > $MAX_BUFFER_BYTES) for $deviceAddress — resetting")
                writeBuffers.remove(deviceAddress)
                return
            }
            writeBuffers[deviceAddress] = combined
            combined
        }

        val packet = PacketCodec.decode(accumulated)
        if (packet != null) {
            synchronized(writeBuffers) { writeBuffers.remove(deviceAddress) }
            Log.d(TAG, "  ✅ Decoded packet: type=0x${"%02X".format(packet.type)} " +
                    "ttl=${packet.ttl} sender=${packet.senderIDHex} payload=${packet.payload.size}B")
            dispatchIncomingPacket(packet, deviceAddress)
        } else {
            Log.d(TAG, "  Partial data buffered (${accumulated.size}B) — waiting for more")
        }
    }

    private fun dispatchIncomingPacket(packet: BitchatPacket, fromDeviceAddress: String) {
        if (packet.senderID.contentEquals(myPeerID)) {
            Log.d(TAG, "Dropping own packet")
            return
        }

        val senderId = packet.senderIDHex
        val dedupKey = "$senderId-${packet.timestamp}"
        synchronized(seenMessages) {
            if (seenMessages.contains(dedupKey)) {
                Log.d(TAG, "Duplicate packet dropped: $dedupKey")
                return
            }
            seenMessages.add(dedupKey)
            if (seenMessages.size > 512) seenMessages.remove(seenMessages.first())
        }

        val typeName = when (packet.type) {
            MessageType.ANNOUNCE         -> "ANNOUNCE"
            MessageType.MESSAGE          -> "MESSAGE"
            MessageType.LEAVE            -> "LEAVE"
            MessageType.DIRECT_MESSAGE   -> "DIRECT_MESSAGE"
            MessageType.NOISE_HANDSHAKE  -> "NOISE_HANDSHAKE"
            MessageType.NOISE_ENCRYPTED  -> "NOISE_ENCRYPTED"
            MessageType.FRAGMENT         -> "FRAGMENT"
            else                         -> "0x${"%02X".format(packet.type)}"
        }
        Log.i(TAG, "▶ Dispatch $typeName from $senderId (ttl=${packet.ttl})")

        when (packet.type) {
            MessageType.ANNOUNCE         -> handleAnnounce(packet, fromDeviceAddress)
            MessageType.MESSAGE          -> handlePublicMessage(packet)
            MessageType.LEAVE            -> handleLeave(packet)
            MessageType.DIRECT_MESSAGE   -> handleDirectMessage(packet)
            MessageType.NOISE_HANDSHAKE  -> handleNoiseHandshake(packet)
            MessageType.NOISE_ENCRYPTED  -> handleNoiseEncrypted(packet)
            else -> {
                if (packet.ttl > 1) {
                    Log.d(TAG, "  Relaying $typeName (ttl=${packet.ttl})")
                    relayPacket(packet)
                }
            }
        }
    }

    // ── Packet handlers ────────────────────────────────────────────────────────

    private fun handleAnnounce(packet: BitchatPacket, fromDeviceAddress: String) {
        // FIX: strictly decode payload as UTF-8, not the whole wire packet
        val rawNickname = try {
            packet.payload.toString(Charsets.UTF_8).trim()
        } catch (e: Exception) {
            Log.e(TAG, "❌ Nickname decode failed: ${e.message}  raw=${packet.payload.toHexString()}")
            ""
        }

        // Sanity: reject if it contains control characters / non-printable (indicates binary decode)
        val nickname = if (rawNickname.any { it.code < 32 && it != '\t' && it != '\n' }) {
            Log.w(TAG, "⚠ Nickname contains control characters — likely binary decode. raw hex=${packet.payload.toHexString()}")
            packet.senderIDHex.take(8)  // fall back to peer ID prefix
        } else {
            rawNickname.ifBlank { packet.senderIDHex.take(8) }
        }

        val peerId = packet.senderIDHex
        Log.i(TAG, "👋 ANNOUNCE from $peerId  nickname='$nickname'  payloadHex=${packet.payload.toHexString()}")

        val existing = peerRegistry.get(peerId)
        val wasConnected = existing?.isConnected ?: false

        peerRegistry.upsert(PeerInfo(
            peerId      = peerId,
            nickname    = nickname,
            isConnected = true,
            lastSeenMs  = System.currentTimeMillis()
        ))

        // Record the device-address → peerId mapping so that when this GATT
        // connection drops we can mark exactly this peer as offline (not all peers).
        deviceAddressToPeerId[fromDeviceAddress] = peerId

        if (!wasConnected) {
            Log.i(TAG, "  → New peer registered: $peerId ($nickname)")
            eventListener?.onPeerConnected(peerId, nickname)
        } else {
            Log.d(TAG, "  → Existing peer re-announced: $peerId ($nickname)")
        }
        eventListener?.onPeerListUpdated(peerRegistry.all())
    }

    private fun handlePublicMessage(packet: BitchatPacket) {
        val content  = packet.payload.toString(Charsets.UTF_8)
        val senderId = packet.senderIDHex
        val nickname = peerRegistry.nickname(senderId)
        val msgId    = "$senderId-${packet.timestamp}"

        Log.i(TAG, "💬 MESSAGE from $senderId ($nickname): ${content.take(80)}")

        eventListener?.onPublicMessageReceived(
            messageId      = msgId,
            senderId       = senderId,
            senderNickname = nickname,
            content        = content,
            timestampMs    = packet.timestamp
        )
        if (packet.ttl > 1) relayPacket(packet)
    }

    private fun handleLeave(packet: BitchatPacket) {
        val peerId = packet.senderIDHex
        Log.i(TAG, "👋 LEAVE from $peerId")
        peerRegistry.setConnected(peerId, false)
        eventListener?.onPeerDisconnected(peerId)
        eventListener?.onPeerListUpdated(peerRegistry.all())
    }

    private fun handleNoiseHandshake(packet: BitchatPacket) {
        Log.d(TAG, "🔑 NOISE_HANDSHAKE from ${packet.senderIDHex}")
        eventListener?.onNoiseHandshakeReceived(packet.senderIDHex, packet.payload)
    }

    private fun handleNoiseEncrypted(packet: BitchatPacket) {
        if (packet.recipientID != null && !packet.recipientID.contentEquals(myPeerID)) {
            if (packet.ttl > 1) relayPacket(packet)
            return
        }
        Log.d(TAG, "🔒 NOISE_ENCRYPTED for us from ${packet.senderIDHex}")
        eventListener?.onPrivateMessageReceived(
            messageId        = "${packet.senderIDHex}-${packet.timestamp}",
            senderId         = packet.senderIDHex,
            senderNickname   = peerRegistry.nickname(packet.senderIDHex),
            encryptedPayload = packet.payload,
            timestampMs      = packet.timestamp
        )
    }

    private fun handleDirectMessage(packet: BitchatPacket) {
        // Only deliver if this packet is addressed to us (or is a broadcast fallback).
        // Packets addressed to someone else would have been relayed in dispatchIncomingPacket
        // before reaching here, but we guard defensively.
        if (packet.recipientID != null && !packet.recipientID.contentEquals(myPeerID)) {
            if (packet.ttl > 1) relayPacket(packet)
            return
        }
        val content  = packet.payload.toString(Charsets.UTF_8)
        val senderId = packet.senderIDHex
        val nickname = peerRegistry.nickname(senderId)
        val msgId    = "$senderId-${packet.timestamp}"
        Log.i(TAG, "🔒 DIRECT_MESSAGE from $senderId ($nickname): ${content.take(80)}")
        eventListener?.onDirectMessageReceived(
            messageId      = msgId,
            senderId       = senderId,
            senderNickname = nickname,
            recipientId    = myPeerIDHex,  // receiver IS us
            content        = content,
            timestampMs    = packet.timestamp
        )
    }

    // ── Relay ─────────────────────────────────────────────────────────────────

    private fun relayPacket(packet: BitchatPacket) {
        val relayed = packet.copy(ttl = (packet.ttl - 1).toByte())
        val encoded = PacketCodec.encode(relayed) ?: return
        writeToAllPeers(encoded)
    }

    // ── Outbound helpers ──────────────────────────────────────────────────────

    fun broadcastAnnounce() {
        val packet = buildPacket(MessageType.ANNOUNCE, myNickname.encodeToByteArray())
        val encoded = PacketCodec.encode(packet) ?: return
        Log.d(TAG, "→ Broadcast ANNOUNCE  nickname='$myNickname'  ${encoded.size}B to ${peerCharacteristics.size} peers")
        writeToAllPeers(encoded)
    }

    private fun sendAnnounceToDevice(deviceAddress: String) {
        val packet  = buildPacket(MessageType.ANNOUNCE, myNickname.encodeToByteArray())
        val encoded = PacketCodec.encode(packet) ?: return
        Log.i(TAG, "→ ANNOUNCE to $deviceAddress  nickname='$myNickname'  ${encoded.size}B")
        writeToDevice(deviceAddress, encoded)
    }

    fun sendPublicMessage(content: String): String {
        val tsMs    = System.currentTimeMillis()
        val packet  = buildPacket(MessageType.MESSAGE, content.encodeToByteArray(), tsMs)
        val encoded = PacketCodec.encode(packet) ?: return ""
        Log.i(TAG, "→ MESSAGE '${content.take(50)}'  ${encoded.size}B to ${peerCharacteristics.size} central-peers")
        writeToAllPeers(encoded)
        val msgId = "$myPeerIDHex-$tsMs"
        // Echo the sent message back to the local listener so the sender's own
        // UI shows the message immediately (peers receive it via BLE, but the
        // sender never gets an incoming packet for their own transmission).
        eventListener?.onPublicMessageReceived(
            messageId      = msgId,
            senderId       = myPeerIDHex,
            senderNickname = myNickname,
            content        = content,
            timestampMs    = tsMs
        )
        return msgId
    }

    /**
     * Send a plain-text direct message to a single peer.
     * The packet carries FLAG_HAS_RECIPIENT so only the addressed peer
     * processes the payload; others relay or drop it per TTL rules.
     * Returns the generated message ID, or "" on encoding failure.
     */
    fun sendDirectMessage(content: String, recipientPeerId: String): String {
        val recipientIdBytes = recipientPeerId.hexToByteArray()
        if (recipientIdBytes == null) {
            Log.e(TAG, "sendDirectMessage: invalid recipientPeerId '$recipientPeerId'")
            return ""
        }
        val tsMs = System.currentTimeMillis()
        val packet = BitchatPacket(
            version     = ProtocolConstants.VERSION,
            type        = MessageType.DIRECT_MESSAGE,
            ttl         = ProtocolConstants.DEFAULT_TTL,
            timestamp   = tsMs,
            senderID    = myPeerID,
            recipientID = recipientIdBytes,
            payload     = content.encodeToByteArray(),
            signature   = null
        )
        val encoded = PacketCodec.encode(packet) ?: return ""
        Log.i(TAG, "→ DIRECT_MESSAGE to $recipientPeerId '${content.take(50)}'  ${encoded.size}B")
        writeToAllPeers(encoded)
        val msgId = "$myPeerIDHex-$tsMs"
        // Local echo so the sender's own UI shows the message immediately.
        eventListener?.onDirectMessageReceived(
            messageId      = msgId,
            senderId       = myPeerIDHex,
            senderNickname = myNickname,
            recipientId    = recipientPeerId,  // echo: tells JS which conversation this belongs to
            content        = content,
            timestampMs    = tsMs
        )
        return msgId
    }

    fun sendEncryptedMessage(recipientPeerId: String, payload: ByteArray): Boolean {
        val recipientIdBytes = recipientPeerId.hexToByteArray() ?: return false
        val packet = BitchatPacket(
            version = ProtocolConstants.VERSION, type = MessageType.NOISE_ENCRYPTED,
            ttl = ProtocolConstants.DEFAULT_TTL, timestamp = System.currentTimeMillis(),
            senderID = myPeerID, recipientID = recipientIdBytes,
            payload = payload, signature = null
        )
        val encoded = PacketCodec.encode(packet) ?: return false
        writeToAllPeers(encoded)
        return true
    }

    fun sendNoiseHandshake(recipientPeerId: String, handshakePayload: ByteArray): Boolean {
        val recipientIdBytes = recipientPeerId.hexToByteArray() ?: return false
        val packet = BitchatPacket(
            version = ProtocolConstants.VERSION, type = MessageType.NOISE_HANDSHAKE,
            ttl = ProtocolConstants.DEFAULT_TTL, timestamp = System.currentTimeMillis(),
            senderID = myPeerID, recipientID = recipientIdBytes,
            payload = handshakePayload, signature = null
        )
        val encoded = PacketCodec.encode(packet) ?: return false
        writeToAllPeers(encoded)
        return true
    }

    private fun broadcastLeave() {
        val packet  = buildPacket(MessageType.LEAVE, ByteArray(0), ttl = 1)
        val encoded = PacketCodec.encode(packet) ?: return
        writeToAllPeers(encoded)
    }

    // ── Low-level BLE write (sequential per-device queue) ─────────────────────

    private fun writeToAllPeers(data: ByteArray) {
        // Send to all GATT central connections
        peerCharacteristics.keys.toList().forEach { address: String ->
            writeToDevice(address, data)
        }
        // Notify any GATT server–connected centrals via NOTIFY
        gattServer?.let { server ->
            val service = server.getService(serviceUUIDMainnet) ?: return@let
            val char    = service.getCharacteristic(characteristicUUID) ?: return@let
            char.value  = data
            val connected: List<BluetoothDevice> =
                bluetoothManager?.getConnectedDevices(BluetoothProfile.GATT) ?: emptyList()
            Log.d(TAG, "→ Notifying ${connected.size} GATT-server-connected devices")
            connected.forEach { device: BluetoothDevice ->
                server.notifyCharacteristicChanged(device, char, false)
            }
        }
    }

    /**
     * FIX: Sequential write queue. All data is split into MTU-sized fragments and
     * enqueued. The first fragment is sent immediately; subsequent fragments are
     * sent one-by-one in [onCharacteristicWrite] after each completes.
     */
    private fun writeToDevice(deviceAddress: String, data: ByteArray) {
        val gatt = centralConns[deviceAddress]
        val char = peerCharacteristics[deviceAddress]
        if (gatt == null || char == null) {
            Log.w(TAG, "writeToDevice: no gatt/char for $deviceAddress — skipping")
            return
        }

        val queue = writeQueues.getOrPut(deviceAddress) { WriteQueue() }
        val chunks = data.toList().chunked(ProtocolConstants.FRAGMENT_SIZE)
        Log.d(TAG, "→ Queuing ${chunks.size} fragment(s) to $deviceAddress  total=${data.size}B")

        chunks.forEach { chunk -> queue.enqueue(chunk.toByteArray()) }

        if (!queue.busy) {
            drainWriteQueue(deviceAddress, gatt, char)
        }
    }

    private fun drainWriteQueue(
        address: String,
        gatt: BluetoothGatt,
        char: BluetoothGattCharacteristic
    ) {
        val queue = writeQueues[address] ?: return
        val next  = queue.poll()
        if (next == null) {
            queue.busy = false
            Log.d(TAG, "  Write queue empty for $address")
            return
        }
        queue.busy = true
        char.value = next
        val ok = gatt.writeCharacteristic(char)
        Log.d(TAG, "  → writeCharacteristic ${next.size}B to $address  ok=$ok")
        if (!ok) {
            // Write failed (BT stack busy?) — stop the queue, don't loop
            queue.busy = false
            Log.e(TAG, "  ❌ writeCharacteristic returned false for $address — queue drained early")
        }
    }

    // ── Utilities ──────────────────────────────────────────────────────────────

    private fun buildPacket(
        type: Byte,
        payload: ByteArray,
        timestamp: Long = System.currentTimeMillis(),
        ttl: Byte = ProtocolConstants.DEFAULT_TTL,
        recipientID: ByteArray? = null
    ) = BitchatPacket(
        version     = ProtocolConstants.VERSION,
        type        = type,
        ttl         = ttl,
        timestamp   = timestamp,
        senderID    = myPeerID,
        recipientID = recipientID,
        payload     = payload,
        signature   = null
    )

    private fun generatePeerID(): ByteArray {
        val prefs = context.getSharedPreferences("BitChatPrefs", Context.MODE_PRIVATE)
        val savedHex = prefs.getString("myPeerID", null)
        if (savedHex != null) {
            val bytes = savedHex.hexToByteArray()
            if (bytes != null && bytes.size == ProtocolConstants.SENDER_ID_SIZE) {
                return bytes
            }
        }
        val id = ByteArray(ProtocolConstants.SENDER_ID_SIZE)
        java.security.SecureRandom().nextBytes(id)
        prefs.edit().putString("myPeerID", id.toHexString()).apply()
        return id
    }
}
