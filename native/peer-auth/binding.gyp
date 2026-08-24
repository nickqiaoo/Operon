{
  "targets": [
    {
      "target_name": "operon_peer_auth",
      "sources": ["src/peer_auth.mm"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "OTHER_LDFLAGS": [
          "-framework Security",
          "-framework CoreFoundation"
        ]
      }
    }
  ]
}
