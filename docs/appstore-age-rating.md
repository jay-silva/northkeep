# App Store age rating questionnaire: answers for Jay to enter

> Jay-enters-in-App-Store-Connect checklist. Apple moved to 4+/9+/13+/16+/18+
> bands in 2025 and added questions on In-App Controls, Capabilities, Medical or
> Wellness, and Violence (all developers had to re-answer by Jan 31, 2026). The
> exact on-screen wording lives in the live questionnaire; enter the answers
> below. Let Apple compute the final band, do not try to force a lower one.
> Not legal advice.

## Content descriptors: all None / does not contain

NorthKeep ships no objectionable content of its own. Answer "None" (or the
lowest frequency / "does not contain") for every content question:

- Cartoon or fantasy violence: **None**
- Realistic / prolonged graphic or sadistic violence: **None**
- Profanity or crude humor: **None**
- Mature/suggestive themes, sexual content, nudity: **None**
- Horror / fear themes: **None**
- Alcohol, tobacco, or drug use or references: **None**
- Medical or wellness information / topics: **None** (NorthKeep is a general
  memory vault; it provides no medical or treatment information itself)
- Gambling, simulated gambling, contests, loot boxes: **None**

## In-App Controls

- Parental controls: **No.**
- Age assurance / age verification: **No.**

## Capabilities: the discriminating section

- **Unrestricted Web Access: No.** NorthKeep has no in-app web browser. It does
  not load arbitrary web pages.
- **User-Generated Content: No.** The user's memories and AI chats are private
  and stay on the device. There is no social feed, no sharing to other users, no
  public or multi-user content. (If the questionnaire's UGC definition is broad,
  see the note below; the honest position is that nothing is shared to other
  users.)
- **Social media / social networking: No.**
- **Messaging or chat between users: No.** The "Chat" tab (Converse) is the user
  talking to an AI model of their own choosing, not person-to-person messaging.
- **Advertising: No.** No ads.

## AI chat / AI-generated content: disclose honestly: Yes

NorthKeep's Converse feature is an AI chat. It connects to an AI model the user
chooses with their own API key (BYOK), and NorthKeep does not filter or moderate
what that third-party model returns. Apple's 2025 update requires developers to
account for AI assistant/chatbot functionality when rating an app.

- Wherever the questionnaire asks whether the app includes an AI chatbot or
  AI-generated content, or asks you to account for content an AI feature could
  produce: **answer Yes / affirmatively**, and treat the possible content
  frequency honestly (an unmoderated general-purpose model can produce mature
  content, so do not answer "None" for AI-surfaced content if the flow asks you
  to rate it).
- Expect this to push the computed band up (commonly into the 13+ to 17+/18+
  range) because of the honest AI disclosure. That is the correct outcome. Do
  not understate it to chase 4+.

## Expected result

With every content descriptor at None but AI chat disclosed honestly, Apple will
compute the band (likely 13+ or higher). Record the band Apple returns; if it is
higher than expected, that reflects the honest AI answer, which is intended.

## Notes / things to verify in the live questionnaire

- The exact labels for the AI questions are only visible in App Store Connect at
  submission time. Answer them affirmatively and describe Converse in the review
  notes (`docs/appstore-review-notes.md`) so the reviewer has context.
- If Apple's UGC question is phrased to include any content the user creates
  (even private, on-device), lean to the honest side and add a note that the
  content is private and never shared with other users. It still is not social
  UGC, but flag it rather than hide it.
