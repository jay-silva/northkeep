Pod::Spec.new do |s|
  s.name           = 'PdfText'
  s.version        = '1.0.0'
  s.summary        = 'On-device PDF text extraction via PDFKit with Vision OCR fallback'
  s.description    = 'Extracts text from PDFs entirely on device: PDFKit text layer first, Vision OCR for scanned pages. Nothing leaves the device.'
  s.author         = 'NorthKeep'
  s.homepage       = 'https://northkeep.ai'
  s.license        = { :type => 'AGPL-3.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'PDFKit', 'Vision', 'UIKit'
  s.source_files   = '**/*.{h,m,swift}'
end
