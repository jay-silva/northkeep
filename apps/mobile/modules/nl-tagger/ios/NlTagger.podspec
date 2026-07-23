Pod::Spec.new do |s|
  s.name           = 'NlTagger'
  s.version        = '1.0.0'
  s.summary        = 'On-device name detection via Apple NaturalLanguage NLTagger'
  s.description    = 'Recognizes people, organizations, and places entirely on device using NLTagger .nameType (NaturalLanguage). Free, no download, no Apple Intelligence required, runs on every iPhone. The Tier-2/3 name net; nothing leaves the device.'
  s.author         = 'NorthKeep'
  s.homepage       = 'https://northkeep.ai'
  s.license        = { :type => 'AGPL-3.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'NaturalLanguage'
  s.source_files   = '**/*.{h,m,swift}'
end
