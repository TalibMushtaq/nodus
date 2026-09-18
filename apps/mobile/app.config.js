// Expo config wrapper around app.json.
//
// `google-services.json` is intentionally NOT committed (GitHub secret scanning
// flags its Firebase API key). EAS builds receive it through a file environment
// variable named GOOGLE_SERVICES_JSON_FILE, whose value is the path to the
// materialized file — EAS writes the file and sets the variable at build time.
// Locally the checked-out `./google-services.json` from app.json is used.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON_FILE ?? config.android?.googleServicesFile,
  },
});
