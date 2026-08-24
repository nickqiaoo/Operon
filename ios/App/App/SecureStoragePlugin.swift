import Foundation
import Capacitor
import Security

/// Keychain-backed storage for the web layer, exposed to JS as `SecureStorage`.
///
/// This stores the 90-day refresh token and per-node remote E2EE private keys.
/// WKWebView cannot use the browser's HttpOnly refresh cookie, and `localStorage`
/// is the wrong place for either kind of long-lived secret.
///
/// Hand-written rather than pulled from a community pod: three methods over
/// `SecItem*` is not worth an unaudited dependency in the auth path.
/// See `src/lib/native.ts` for the JS side.
@objc(SecureStoragePlugin)
public class SecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStoragePlugin"
    public let jsName = "SecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private var service: String {
        Bundle.main.bundleIdentifier ?? "com.operon.app"
    }

    private func query(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        var query = self.query(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            // A miss is "signed out", not an error — rejecting here would turn a
            // fresh install into a hard failure at boot.
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("keychain read failed (\(status))")
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("key and value are required")
            return
        }
        guard let data = value.data(using: .utf8) else {
            call.reject("value is not valid UTF-8")
            return
        }

        // SecItemAdd fails on an existing item, so replace rather than update:
        // one code path, and it also repairs an entry written with different
        // attributes by an older build.
        SecItemDelete(query(for: key) as CFDictionary)

        var attributes = query(for: key)
        attributes[kSecValueData as String] = data
        // The token has to be readable when a notification wakes the app in the
        // background, which rules out `WhenUnlocked`. It stays off backups and
        // off other devices.
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            call.reject("keychain write failed (\(status))")
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        let status = SecItemDelete(query(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("keychain delete failed (\(status))")
            return
        }
        call.resolve()
    }
}
