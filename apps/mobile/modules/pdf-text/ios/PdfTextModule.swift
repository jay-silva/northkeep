import ExpoModulesCore
import PDFKit
import Vision
import UIKit

/**
 * On-device PDF text extraction (replaces the pdf.js/unpdf path that fatally
 * crashed Hermes on build 13). Two layers, both fully local:
 *
 *   1. PDFKit text layer: `PDFPage.string` for pages that carry real text.
 *   2. Vision OCR fallback: pages with NO text layer (scans/photos) are
 *      rendered to a bitmap and run through VNRecognizeTextRequest.
 *
 * Errors are thrown as coded Exceptions so the JS side maps them to honest
 * user-facing reasons instead of crashing: ERR_PDF_URI / ERR_PDF_READ /
 * ERR_PDF_PROTECTED. An empty result (no text anywhere) is returned as
 * text: "" and handled in JS ('no-text'), not thrown.
 *
 * OCR is capped at OCR_PAGE_LIMIT pages per document (accurate-mode OCR costs
 * roughly a second per page on device); `ocrLimited: true` tells the JS side
 * to say so honestly rather than silently dropping pages.
 */
public class PdfTextModule: Module {
  private static let OCR_PAGE_LIMIT = 30

  public func definition() -> ModuleDefinition {
    Name("PdfText")

    AsyncFunction("extractText") { (uriString: String) -> [String: Any] in
      guard let url = URL(string: uriString), url.isFileURL else {
        throw Exception(name: "ERR_PDF_URI", description: "Expected a file:// URL")
      }
      guard let doc = PDFDocument(url: url) else {
        throw Exception(name: "ERR_PDF_READ", description: "Could not open the PDF")
      }
      if doc.isLocked {
        throw Exception(name: "ERR_PDF_PROTECTED", description: "The PDF is password-protected")
      }

      var parts: [String] = []
      var ocrPages = 0
      var ocrSkipped = 0
      let pageCount = doc.pageCount

      for index in 0..<pageCount {
        guard let page = doc.page(at: index) else { continue }
        let layerText = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !layerText.isEmpty {
          parts.append(layerText)
          continue
        }
        // No text layer: OCR the rendered page.
        if ocrPages >= PdfTextModule.OCR_PAGE_LIMIT {
          ocrSkipped += 1
          continue
        }
        let bounds = page.bounds(for: .mediaBox)
        guard bounds.width > 0, bounds.height > 0 else { continue }
        let scale: CGFloat = 2.0
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        let image = page.thumbnail(of: size, for: .mediaBox)
        guard let cgImage = image.cgImage else { continue }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
          try handler.perform([request])
        } catch {
          continue // one bad page never sinks the document
        }
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        if !lines.isEmpty {
          parts.append(lines.joined(separator: "\n"))
        }
        ocrPages += 1
      }

      return [
        "text": parts.joined(separator: "\n\n"),
        "pages": pageCount,
        "ocrPages": ocrPages,
        "ocrLimited": ocrSkipped > 0,
      ]
    }
  }
}
