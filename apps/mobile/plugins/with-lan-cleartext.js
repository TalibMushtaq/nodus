const { withAndroidManifest, withDangerousMod, AndroidConfig } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Scope Android cleartext traffic to the local network.
 *
 * The app talks to Storage Nodes over plain HTTP on the LAN (their TLS story is
 * a later phase), so cleartext cannot be disabled outright. A global
 * `usesCleartextTraffic` would also permit cleartext to any remote host, which
 * is exactly how a bearer session leaks. Instead this installs a network
 * security config that denies cleartext by default and re-allows it only for
 * loopback and private LAN ranges, and points the manifest at it.
 *
 * Defensive by design: if the app config has no android section the plugin
 * leaves it untouched rather than failing the prebuild.
 */
const CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Remote hosts must use TLS; only the local network may use cleartext. -->
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">localhost</domain>
        <domain includeSubdomains="true">127.0.0.1</domain>
        <domain includeSubdomains="true">10.0.2.2</domain>
        <!-- RFC1918 private ranges: storage nodes on the LAN. -->
        <domain includeSubdomains="true">10.0.0.0</domain>
        <domain includeSubdomains="true">172.16.0.0</domain>
        <domain includeSubdomains="true">192.168.0.0</domain>
    </domain-config>
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
