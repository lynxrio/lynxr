Pod::Spec.new do |s|
  s.name = 'LynxrShareInbox'
  s.version = '1.0.0'
  s.summary = 'Private URL-only App Group inbox'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Lynxr'
  s.homepage = 'https://lynxr.io'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.swift_version = '5.9'
end
