const { withMainActivity } = require("expo/config-plugins");

/**
 * react-native-screens (used by React Navigation's native stack) requires
 * `RNScreensFragmentFactory` on Android so native fragment state survives
 * Activity recreation. React Navigation's getting-started guide prescribes a
 * manual MainActivity edit; this project generates `android/` with CNG, so the
 * edit is expressed as a config plugin to keep it reproducible across prebuilds.
 *
 * Defensive by design: if the template anchors are absent the plugin leaves the
 * file untouched rather than failing the prebuild.
 */
module.exports = function withRNScreensFragmentFactory(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== "kt") {
      // This project only generates the Kotlin MainActivity template.
      return cfg;
    }

    let contents = cfg.modResults.contents;
    if (contents.includes("RNScreensFragmentFactory")) {
      return cfg;
    }

    const importLine =
      "import com.swmansion.rnscreens.fragment.restoration.RNScreensFragmentFactory";
    if (!contents.includes(importLine)) {
      contents = contents.replace(
        "import com.facebook.react.ReactActivity\n",
        `import com.facebook.react.ReactActivity\n${importLine}\n`,
      );
    }

    // Install the factory as the first onCreate statement, before
    // super.onCreate, leaving the existing splash-screen setTheme call intact.
    contents = contents.replace(
      /(override fun onCreate\(savedInstanceState: Bundle\?\) \{\n)/,
      "$1    supportFragmentManager.fragmentFactory = RNScreensFragmentFactory()\n",
    );

    cfg.modResults.contents = contents;
    return cfg;
  });
};
