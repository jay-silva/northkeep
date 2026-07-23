import ExpoModulesCore
import NaturalLanguage

/**
 * On-device name detection via Apple's NaturalLanguage NLTagger (.nameType).
 *
 * This is the Tier-2/3 name net for cloud chat: the redact() pipeline runs its
 * deterministic dictionary floor first, then hands the dict-masked text to this
 * module as a single strict-gated NER pass (see nltagger-ner.ts). NLTagger is
 * FREE, ships in every iOS, needs NO download and NO Apple Intelligence, and
 * returns structured spans directly (no LLM, no JSON to parse), so it replaces
 * the fragile Apple Foundation Models NER path (retired 2026-07-21).
 *
 * Contract: tagNames(text) -> array of ["text": span, "kind": person|location|
 * org]. It is TOTAL: it never throws, and empty/blank input returns []. The
 * span mapping/validation and the {"entities":[...]} contract live in pure,
 * unit-tested JS (nltagger-spans.ts); this stays a thin native edge.
 *
 * Recognition options mirror the validated proxy run (macOS NLTagger ==
 * iOS NLTagger, same framework): .omitPunctuation, .omitWhitespace, and
 * .joinNames so multi-token names ("Dana Whitfield") come back as one span.
 * personalName -> person, placeName -> location, organizationName -> org;
 * every other tag is ignored.
 */
public class NLTaggerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NlTagger")

    AsyncFunction("tagNames") { (text: String) -> [[String: String]] in
      // Total by construction: blank text yields no spans, never an error.
      if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return []
      }

      let tagger = NLTagger(tagSchemes: [.nameType])
      tagger.string = text
      let opts: NLTagger.Options = [.omitPunctuation, .omitWhitespace, .joinNames]

      var out: [[String: String]] = []
      tagger.enumerateTags(
        in: text.startIndex..<text.endIndex,
        unit: .word,
        scheme: .nameType,
        options: opts
      ) { tag, range in
        if let tag = tag {
          var kind: String? = nil
          switch tag {
          case .personalName: kind = "person"
          case .placeName: kind = "location"
          case .organizationName: kind = "org"
          default: break
          }
          if let k = kind {
            out.append(["text": String(text[range]), "kind": k])
          }
        }
        return true
      }
      return out
    }
  }
}
