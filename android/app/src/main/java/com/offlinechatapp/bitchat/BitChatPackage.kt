package com.offlinechatapp.bitchat

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

// ──────────────────────────────────────────────────────────────────────────────
// BitChatPackage.kt
//
// ReactPackage that registers BitChatModule with the React Native runtime.
// Referenced in MainApplication.kt.
// ──────────────────────────────────────────────────────────────────────────────

class BitChatPackage : ReactPackage {

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(BitChatModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
