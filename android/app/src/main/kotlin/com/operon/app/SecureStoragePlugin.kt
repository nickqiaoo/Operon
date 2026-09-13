package com.operon.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

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
class SecureStoragePlugin : Plugin() {

    private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * The AES key is generated once and stays inside the keystore — it is never
     * readable by this process, only usable. No user-authentication requirement:
     * the token has to be usable when a notification wakes the app, exactly as
     * on iOS (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly).
     */
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            generator.init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            return generator.generateKey()
        }
        return keyStore.getKey(KEY_ALIAS, null) as SecretKey
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val name = call.getString("key")
        if (name == null) {
            call.reject("key is required")
            return
        }
        val stored = prefs().getString(name, null)
        val result = JSObject()
        if (stored == null) {
            // A miss is "signed out", not an error — rejecting here would turn a
            // fresh install into a hard failure at boot.
            result.put("value", JSONObject.NULL)
            call.resolve(result)
            return
        }

        try {
            val split = stored.indexOf(SEPARATOR)
            check(split >= 0) { "malformed entry" }
            val iv = Base64.decode(stored.substring(0, split), Base64.NO_WRAP)
            val ciphertext = Base64.decode(stored.substring(split + 1), Base64.NO_WRAP)

            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, iv))
            result.put("value", String(cipher.doFinal(ciphertext), Charsets.UTF_8))
            call.resolve(result)
        } catch (_: Exception) {
            // Undecryptable means the keystore entry was replaced (app data
            // cleared, device restored to new hardware). Drop the row and report
            // a miss, so the user just signs in again instead of getting stuck
            // on an error they cannot clear.
            prefs().edit().remove(name).apply()
            result.put("value", JSONObject.NULL)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val name = call.getString("key")
        val value = call.getString("value")
        if (name == null || value == null) {
            call.reject("key and value are required")
            return
        }
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            // GCM generates a fresh IV per encryption; it is not secret, but it
            // must be stored to decrypt later.
            val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
            val ciphertext = Base64.encodeToString(
                cipher.doFinal(value.toByteArray(Charsets.UTF_8)),
                Base64.NO_WRAP,
            )
            prefs().edit().putString(name, iv + SEPARATOR + ciphertext).apply()
            call.resolve()
        } catch (e: Exception) {
            call.reject("secure storage write failed", e)
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val name = call.getString("key")
        if (name == null) {
            call.reject("key is required")
            return
        }
        prefs().edit().remove(name).apply()
        call.resolve()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "operon.secure-storage.v1"
        const val PREFS = "operon.secure-storage"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128

        /** Separates the (non-secret) IV from the ciphertext in one stored string. */
        const val SEPARATOR = ":"
    }
}
