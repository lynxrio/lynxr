// Adds a local-only XCUITest target to generated iOS output; never edits app sources.
const xcode=require('xcode');const fs=require('fs');const path=require('path');
const file=path.resolve(__dirname,'../ios/Lynxr.xcodeproj/project.pbxproj');
const p=xcode.project(file);p.parseSync();
if(!p.pbxTargetByName('LynxrUITests')) {
 const t=p.addTarget('LynxrUITests','unit_test_bundle','LynxrUITests','io.lynxr.mobile.uitests');
 t.pbxNativeTarget.productType='"com.apple.product-type.bundle.ui-testing"';
 fs.mkdirSync(path.resolve(__dirname,'../ios/LynxrUITests'),{recursive:true});
 fs.copyFileSync(path.resolve(__dirname,'../native-tests/LynxrUITests.swift'),path.resolve(__dirname,'../ios/LynxrUITests/LynxrUITests.swift'));
 p.addBuildPhase(['LynxrUITests/LynxrUITests.swift'],'PBXSourcesBuildPhase','Sources',t.uuid);
 p.addBuildPhase([],'PBXFrameworksBuildPhase','Frameworks',t.uuid);
 p.addBuildPhase([],'PBXResourcesBuildPhase','Resources',t.uuid);
 const configs=p.pbxXCBuildConfigurationSection();
 const list=p.pbxXCConfigurationList()[t.pbxNativeTarget.buildConfigurationList];
 for(const ref of list.buildConfigurations) Object.assign(configs[ref.value].buildSettings,{
  SWIFT_VERSION:'5.9',IPHONEOS_DEPLOYMENT_TARGET:'16.4',TARGETED_DEVICE_FAMILY:'1',GENERATE_INFOPLIST_FILE:'YES',TEST_TARGET_NAME:'Lynxr',PRODUCT_BUNDLE_IDENTIFIER:'io.lynxr.mobile.uitests',CODE_SIGNING_ALLOWED:'NO',PRODUCT_NAME:'LynxrUITests',FRAMEWORK_SEARCH_PATHS:'"$(inherited) $(PLATFORM_DIR)/Developer/Library/Frameworks"',SWIFT_EMIT_LOC_STRINGS:'NO'
 });
 for(const ref of list.buildConfigurations) delete configs[ref.value].buildSettings.INFOPLIST_FILE;
 fs.writeFileSync(file,p.writeSync());
 const app=p.getFirstTarget();
 const ref=(id,name)=>`<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${id}" BuildableName="${name}" BlueprintName="${name.replace(/\.(app|xctest)$/,'')}" ReferencedContainer="container:Lynxr.xcodeproj"/>`;
 const scheme=`<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">${ref(app.uuid,'Lynxr.app')}</BuildActionEntry><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">${ref(t.uuid,'LynxrUITests.xctest')}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">${ref(t.uuid,'LynxrUITests.xctest')}</TestableReference></Testables></TestAction></Scheme>`;
 fs.writeFileSync(path.resolve(__dirname,'../ios/Lynxr.xcodeproj/xcshareddata/xcschemes/LynxrLocalTests.xcscheme'),scheme);
}

fs.copyFileSync(path.resolve(__dirname,"../native-tests/LynxrUITests.swift"),path.resolve(__dirname,"../ios/LynxrUITests/LynxrUITests.swift"));

if(!p.pbxTargetByName('ShareTestHost')) {
 const t=p.addTarget('ShareTestHost','application','ShareTestHost','io.lynxr.share-test-host');
 const folder=path.resolve(__dirname,'../ios/ShareTestHost'); fs.mkdirSync(folder,{recursive:true});
 fs.copyFileSync(path.resolve(__dirname,'../native-tests/ShareTestHost.swift'),path.join(folder,'ShareTestHost.swift'));
 p.addBuildPhase(['ShareTestHost/ShareTestHost.swift'],'PBXSourcesBuildPhase','Sources',t.uuid);
 p.addBuildPhase([],'PBXFrameworksBuildPhase','Frameworks',t.uuid);
 p.addBuildPhase([],'PBXResourcesBuildPhase','Resources',t.uuid);
 const configs=p.pbxXCBuildConfigurationSection(); const list=p.pbxXCConfigurationList()[t.pbxNativeTarget.buildConfigurationList];
 for(const ref of list.buildConfigurations) {
  const b=configs[ref.value].buildSettings;
  Object.assign(b,{SWIFT_VERSION:'5.9',IPHONEOS_DEPLOYMENT_TARGET:'16.4',TARGETED_DEVICE_FAMILY:'1',GENERATE_INFOPLIST_FILE:'YES',INFOPLIST_KEY_UIApplicationSceneManifest_Generation:'YES',INFOPLIST_KEY_UILaunchScreen_Generation:'YES',PRODUCT_NAME:'ShareTestHost'});
  delete b.INFOPLIST_FILE;
 }
 fs.writeFileSync(file,p.writeSync());
}
