package com.operon.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keystore-backed storage for the web layer, exposed to JS as `SecureStorage`.
 * The Android half of ios/App/App/SecureStoragePlugin.swift — same plugin name,
 * same three methods, so src/lib/native.ts needs no platform branch.
 *
 * This stores the 90-day refresh token and per-node remote E2EE private keys.
 * The browser build keeps its refresh token in an HttpOnly cookie, which the
 * packaged app cannot use, and localStorage is the wrong place for either kind
 * of long-lived secret.
 *
 * Hand-rolled over AES/GCM with a key that never leaves the AndroidKeyStore,
 * rather than pulling in androidx.security:security-crypto — that library is in
 * maintenance mode, and this is the same shape as the iOS side, which goes
 * straight at SecItem rather than through a wrapper.
 */
@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "operon.secure-storage.v1";
    private static final String PREFS = "operon.secure-storage";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    /** Separates the (non-secret) IV from the ciphertext in one stored string. */
    private static final String SEPARATOR = ":";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * The AES key is generated once and stays inside the keystore — it is never
     * readable by this process, only usable. No user-authentication requirement:
     * the token has to be usable when a notification wakes the app, exactly as
     * on iOS (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly).
     */
    private SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
            generator.init(
                new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build()
            );
            return generator.generateKey();
        }
        return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("key");
        if (name == null) {
            call.reject("key is required");
            return;
        }
        String stored = prefs().getString(name, null);
        JSObject result = new JSObject();
        if (stored == null) {
            // A miss is "signed out", not an error — rejecting here would turn a
            // fresh install into a hard failure at boot.
            result.put("value", JSONObject.NULL);
            call.resolve(result);
            return;
        }

        try {
            int split = stored.indexOf(SEPARATOR);
            if (split < 0) throw new IllegalStateException("malformed entry");
            byte[] iv = Base64.decode(stored.substring(0, split), Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(stored.substring(split + 1), Base64.NO_WRAP);

            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            result.put("value", new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception e) {
            // Undecryptable means the keystore entry was replaced (app data
            // cleared, device restored to new hardware). Drop the row and report
            // a miss, so the user just signs in again instead of getting stuck
            // on an error they cannot clear.
            prefs().edit().remove(name).apply();
            result.put("value", JSONObject.NULL);
            call.resolve(result);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("key");
        String value = call.getString("value");
        if (name == null || value == null) {
            call.reject("key and value are required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            // GCM generates a fresh IV per encryption; it is not secret, but it
            // must be stored to decrypt later.
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String ciphertext = Base64.encodeToString(
                cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),
                Base64.NO_WRAP
            );
            prefs().edit().putString(name, iv + SEPARATOR + ciphertext).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("secure storage write failed", e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = call.getString("key");
        if (name == null) {
            call.reject("key is required");
            return;
        }
        prefs().edit().remove(name).apply();
        call.resolve();
    }
}
