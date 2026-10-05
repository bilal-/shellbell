require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'ShellbellNotifications'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.license = package['license']
  s.author = package['author']
  s.homepage = package['homepage']
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { git: package['homepage'] }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.exclude_files = 'Package.swift', 'NotificationService.swift'
  s.frameworks = 'CryptoKit', 'Security', 'UserNotifications'
end
