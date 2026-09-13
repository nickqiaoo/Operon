package com.operon.app

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.operon.app.shell.NativeShellPlugin

class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        // Plugins that live in the app project (rather than in a Capacitor
        // package) are not auto-discovered on Android — they must be registered
        // before the bridge starts, or the JS call rejects with
        // "SecureStorage plugin is not implemented".
        registerPlugin(SecureStoragePlugin::class.java)
        registerPlugin(NativeShellPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
