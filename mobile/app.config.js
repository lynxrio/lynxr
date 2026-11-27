// Native identity is centralized for the planned rebrand. Bundle ID changes
// affect Keychain/App Groups and should be decided before distribution.
module.exports = ({ config }) => ({
  ...config,
  name: process.env.LYNXR_DISPLAY_NAME || config.name,
  ios: { ...config.ios, infoPlist: { ...config.ios?.infoPlist, NSLocalNetworkUsageDescription: 'Connect to the approved local Lynxr test server on your network.', NSAppTransportSecurity: { NSAllowsLocalNetworking: true } }, bundleIdentifier: process.env.LYNXR_BUNDLE_ID || config.ios.bundleIdentifier },
});
