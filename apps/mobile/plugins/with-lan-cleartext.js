const { withAndroidManifest, withDangerousMod, AndroidConfig } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Enable cleartext traffic for LAN Storage Nodes.
 *
 * The app talks to Storage Nodes over plain HTTP on the LAN (their TLS story is
 * a later phase), so cleartext must be permitted. Android network security
 * configs match hostnames, never CIDR ranges: an earlier version listed
 * `192.168.0.0`/`10.0.0.0` with `includeSubdomains`, which never matched a real
 * address such as `192.168.1.50`, so Path A signaling and local shard fetches
 * were blocked with `CLEARTEXT communication ... not permitted` on device (the
 * emulator kept working because `10.0.2.2` is an exact entry).
 *
 * Cleartext is therefore allowed globally. The remote-origin guard lives in
 * `src/relay-url.ts`, which rejects plain-HTTP Relay URLs (only loopback and
 * the emulator alias may use `http:`), so the bearer session never travels in
 * the clear. Node traffic carries only signed request headers, never that token.
 *
 * Defensive by design: if the app config has no android section the plugin
 * leaves it untouched rather than failing the prebuild.
 */
const CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- LAN nodes are reached by IP over HTTP; CIDR ranges are not supported by
         Android's domain-config, so cleartext is app-wide. Remote origins are
         pinned to TLS by the relay URL validator. -->
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`;

module.exports = function withLanCleartext(config) {
  config = withDangerousMod(config, [
    "android",
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/res/xml",
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, "network_security_config.xml"), CONFIG_XML);
      return cfg;
    },
  ]);

  config = withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    // The config file is the source of truth; drop the blanket flag so a build
    // that forgets the plugin cannot fall back to "allow everything".
    delete application.$["android:usesCleartextTraffic"];
    application.$["android:networkSecurityConfig"] = "@xml/network_security_config";
    return cfg;
  });

  return config;
};
