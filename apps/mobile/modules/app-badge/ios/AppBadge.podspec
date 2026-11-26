Pod::Spec.new do |s|
  s.name           = 'AppBadge'
  s.version        = '1.0.0'
  s.summary        = 'Sets the number on the app icon'
  s.description    = 'Asks for the badge permission and sets or clears the app icon badge. No notification is scheduled. Nothing leaves the device.'
  s.author         = 'NorthKeep'
  s.homepage       = 'https://northkeep.ai'
  s.license        = { :type => 'AGPL-3.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'UserNotifications', 'UIKit'
  s.source_files   = '**/*.{h,m,swift}'
end
