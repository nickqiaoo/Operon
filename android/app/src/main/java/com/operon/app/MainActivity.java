package com.operon.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in the app project (rather than in a Capacitor
        // package) are not auto-discovered on Android — they must be registered
        // before the bridge starts, or the JS call rejects with
        // "SecureStorage plugin is not implemented".
        registerPlugin(SecureStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
