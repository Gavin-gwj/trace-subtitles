# Design QA

**Source visual truth**

- Hero composition: `C:/Users/LENOVO/.codex/visualizations/2026/11/07/01a1b3da-ed36-7581-a5a5-a9e46d5e29b0/output/imagegen/trace-style-01-cinema-trace.png`
- Product demo anatomy: `C:/Users/LENOVO/AppData/Local/Temp/codex-clipboard-927524e1-f889-4f69-ab93-1ae8c59c8f42.png`
- Selected Cinema Trace direction, updated with a creator-led English-learning video frame and the real Trace lookup-card anatomy supplied by the user.

**Implementation**

- Local URL: `http://127.0.0.1:4173/`
- Desktop screenshot: `tools/desktop-cinema.png`
- Laptop screenshot: `tools/laptop-cinema.png`
- Full-view comparison: `tools/comparison-desktop.png`
- Scrolled navigation state: `tools/scrolled-navigation.png`
- Viewport: 1440 x 900 and 1280 x 720
- State: default hero with the `stay` dictionary card visible and autoplay active, plus the fixed navigation at top and scrolled states

**Findings**

- No actionable P0, P1, or P2 findings.
- The large right-side playback panel from the rejected direction is absent. The subtitle and real-product lookup card float directly over the video.
- The lookup card now matches the supplied product reference: white surface, black word heading, blue part-of-speech tag, sample-sentence translation, collapsed original definition, green saved action, and pale-green known action.
- The navigation remains visible after scrolling. It contracts into a dark translucent pill with a fine border and blurred backdrop instead of disappearing with the hero.
- The title, subtext, and primary CTA remain visible without scrolling at both desktop widths.
- The generated creator studio frame reads as an educational YouTube video, with the host on the right and usable dark space on the left.
- The background contains no baked-in captions, player controls, recommendation rail, platform mark, or watermark.
- The generated background has natural hands and face, usable left negative space, and a dark lower region for subtitles.

**Fidelity surfaces reviewed**

- Fonts and typography: display hierarchy, Chinese fallback, subtitle weight, phonetic and small-caption legibility.
- Spacing and layout: left copy block, right visual subject, bottom subtitle position, compact dictionary card, bottom fact row.
- Colors and tokens: locked dark theme, warm ivory type, pale mint interaction accent, neutral charcoal surfaces.
- Image quality: 2048 x 1152 source, sharp face and hands, no visible artifacts, matched crop at both desktop viewports.
- Copy and content: plain Chinese product language, realistic English subtitle example, no fabricated proof or metrics.

**Interaction checks**

- Word lookup opens on the selected inline word.
- Add to vocabulary changes to the saved state.
- Mark as known changes to the known state.
- Original-definition disclosure opens inline.
- Next-subtitle control is present and functional.
- Feature, wordbook, FAQ, and install anchor flows remain functional.
- Wordbook tabs and search return the expected filtered rows.
- FAQ disclosure opens the expected answer.
- Console and page errors: none.
- Horizontal overflow: none.
- Fixed navigation remains visible and switches state after the hero exits at both desktop viewports.

**Focused region check**

The lookup card and subtitle were checked together at 1440 x 900 and 1280 x 720. The card does not cover the headline or CTA, its bottom edge stays connected to the subtitle region, its text hierarchy matches the product reference, and no label wraps.

**Patches made since the previous QA pass**

- Replaced the film-interview frame with a creator-led English-learning video still.
- Updated the hero preload and all video-preview background references.
- Rebalanced the hero scrim for readable left-side copy while preserving the studio image.
- Reduced the immersive dictionary card to a lighter 232px card and tightened its internal spacing.
- Rebuilt the lookup card from the supplied real product reference, with the complete white-card anatomy and both state actions.
- Replaced the absolute hero header with a fixed transparent-to-frosted navigation transition triggered by an IntersectionObserver sentinel.

**Final result: passed**
