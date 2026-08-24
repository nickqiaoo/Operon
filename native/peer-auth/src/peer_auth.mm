// operon peer-auth native addon.
//
// codesign peer verification for our Node-hosted unix socket servers (browser-use
// IabBackend / ChromeNativeHost). Node has no pure-JS way to read a peer's audit
// token, so this tiny N-API module does it: read LOCAL_PEERTOKEN off the connected
// socket fd, resolve the SecCode identity from that audit token, and hand back the
// team / signing identifiers. The policy (compare to self's team, honour the
// OPERON_REQUIRE_SIGNED_PEER flag) lives in TypeScript (packages/browser-use/peer-auth.ts).
//
// Security only — deliberately does NOT link AppKit (unlike computer-use-host): this
// must also load inside the headless, Chrome-spawned native-messaging host process.

#include <node_api.h>

#include <sys/socket.h>
#include <sys/un.h>       // SOL_LOCAL, LOCAL_PEERTOKEN
#include <bsm/libbsm.h>   // audit_token_t
#include <mach/message.h>

#import <Security/Security.h>
#import <CoreFoundation/CoreFoundation.h>

namespace {

napi_value CFStringToNapiOrNull(napi_env env, CFStringRef str) {
  napi_value result;
  if (str == NULL) {
    napi_get_null(env, &result);
    return result;
  }
  CFIndex length = CFStringGetLength(str);
  CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  char *buffer = (char *)malloc((size_t)maxSize);
  if (buffer != NULL && CFStringGetCString(str, buffer, maxSize, kCFStringEncodingUTF8)) {
    napi_create_string_utf8(env, buffer, NAPI_AUTO_LENGTH, &result);
  } else {
    napi_get_null(env, &result);
  }
  if (buffer != NULL) free(buffer);
  return result;
}

// Pull team + signing identifiers out of a static code ref. Out params are CFRetained
// (caller releases) and left NULL when the code is unsigned / adhoc (no identifier).
void CopySigningIdentifiers(SecStaticCodeRef code, CFStringRef *outTeam, CFStringRef *outSigning) {
  *outTeam = NULL;
  *outSigning = NULL;
  if (code == NULL) return;
  CFDictionaryRef info = NULL;
  OSStatus st = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
  if (st != errSecSuccess || info == NULL) {
    if (info != NULL) CFRelease(info);
    return;
  }
  CFStringRef team = (CFStringRef)CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
  CFStringRef signing = (CFStringRef)CFDictionaryGetValue(info, kSecCodeInfoIdentifier);
  if (team != NULL) *outTeam = (CFStringRef)CFRetain(team);
  if (signing != NULL) *outSigning = (CFStringRef)CFRetain(signing);
  CFRelease(info);
}

napi_value IdentityObject(napi_env env, CFStringRef team, CFStringRef signing) {
  napi_value obj;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "teamIdentifier", CFStringToNapiOrNull(env, team));
  napi_set_named_property(env, obj, "signingIdentifier", CFStringToNapiOrNull(env, signing));
  return obj;
}

// Resolve identifiers from a dynamic code ref (peer or self), via its static code.
napi_value IdentityFromCode(napi_env env, SecCodeRef code) {
  CFStringRef team = NULL, signing = NULL;
  if (code != NULL) {
    SecStaticCodeRef staticCode = NULL;
    if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &staticCode) == errSecSuccess) {
      CopySigningIdentifiers(staticCode, &team, &signing);
      CFRelease(staticCode);
    }
  }
  napi_value result = IdentityObject(env, team, signing);
  if (team != NULL) CFRelease(team);
  if (signing != NULL) CFRelease(signing);
  return result;
}

// peerAuditIdentity(fd) -> { teamIdentifier, signingIdentifier }
// Both null when the peer is unsigned/adhoc or the fd is not a unix socket peer.
napi_value PeerAuditIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, nullptr, "peerAuditIdentity requires a socket fd");
    return nullptr;
  }

  audit_token_t token;
  socklen_t len = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &len) != 0 || len != sizeof(token)) {
    return IdentityObject(env, NULL, NULL);
  }

  CFDataRef tokenData = CFDataCreate(NULL, (const UInt8 *)&token, sizeof(token));
  const void *keys[] = {kSecGuestAttributeAudit};
  const void *values[] = {tokenData};
  CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1,
                                             &kCFTypeDictionaryKeyCallBacks,
                                             &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  OSStatus st = SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code);
  CFRelease(attrs);
  CFRelease(tokenData);

  napi_value result;
  if (st == errSecSuccess && code != NULL) {
    result = IdentityFromCode(env, code);
  } else {
    result = IdentityObject(env, NULL, NULL);
  }
  if (code != NULL) CFRelease(code);
  return result;
}

// selfAuditIdentity() -> { teamIdentifier, signingIdentifier } for the current process.
napi_value SelfAuditIdentity(napi_env env, napi_callback_info info) {
  SecCodeRef code = NULL;
  napi_value result;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &code) == errSecSuccess && code != NULL) {
    result = IdentityFromCode(env, code);
  } else {
    result = IdentityObject(env, NULL, NULL);
  }
  if (code != NULL) CFRelease(code);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"peerAuditIdentity", nullptr, PeerAuditIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"selfAuditIdentity", nullptr, SelfAuditIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
