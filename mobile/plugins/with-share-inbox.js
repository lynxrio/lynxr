const { withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');
module.exports = function withShareInbox(config) {
  if (process.env.LYNXR_PERSONAL_TEAM === '1') return config;
  const bundle = config.ios.bundleIdentifier;
  const group = `group.${bundle}.share`;
  const name = 'LynxrShare';
  config = withEntitlementsPlist(config, c => { c.modResults['com.apple.security.application-groups'] = [group]; return c; });
  config = withInfoPlist(config, c => { c.modResults.LynxrAppGroup = group; return c; });
  return withXcodeProject(config, c => {
    const project = c.modResults;
    const dir = path.join(c.modRequest.platformProjectRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of ['ShareViewController.swift','LinkParser.swift']) fs.copyFileSync(path.join(__dirname, file),path.join(dir,file));
    fs.copyFileSync(path.join(__dirname,'../modules/lynxr-share-inbox/ios/SharedInbox.swift'),path.join(dir,'SharedInbox.swift'));
    const plist = require('@expo/plist').default;
    fs.writeFileSync(path.join(dir,`${name}-Info.plist`),plist.build({
      CFBundleDisplayName: 'Lynxr', CFBundleExecutable: '$(EXECUTABLE_NAME)', CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)', CFBundleName: '$(PRODUCT_NAME)', CFBundlePackageType: 'XPC!', CFBundleShortVersionString: '1.0.0', CFBundleVersion: '1', LynxrAppGroup: group,
      NSExtension: { NSExtensionPointIdentifier: 'com.apple.share-services', NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).ShareViewController', NSExtensionAttributes: { NSExtensionActivationRule: { NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsWebURLWithMaxCount: 1 } } }
    }));
    fs.writeFileSync(path.join(dir,`${name}.entitlements`),plist.build({'com.apple.security.application-groups':[group]}));
    // Refresh authored source/plists on repeated prebuilds too.
    if (project.pbxTargetByName(name)) return c;
    const target = project.addTarget(name,'app_extension',name,`${bundle}.share`);
    project.addBuildPhase([`${name}/ShareViewController.swift`,`${name}/LinkParser.swift`,`${name}/SharedInbox.swift`], 'PBXSourcesBuildPhase','Sources',target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase','Resources',target.uuid);
    const section=project.pbxXCBuildConfigurationSection();
    const list=project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
    for(const ref of list.buildConfigurations) Object.assign(section[ref.value].buildSettings,{
      SWIFT_VERSION:'5.9', IPHONEOS_DEPLOYMENT_TARGET:'16.4', TARGETED_DEVICE_FAMILY:'1', CODE_SIGN_ENTITLEMENTS:`${name}/${name}.entitlements`, APPLICATION_EXTENSION_API_ONLY:'YES', GENERATE_INFOPLIST_FILE:'NO', CODE_SIGN_STYLE:'Automatic', CURRENT_PROJECT_VERSION:'1', MARKETING_VERSION:'1.0.0'
    });
    return c;
  });
};
