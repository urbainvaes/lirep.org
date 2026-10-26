# Design and user-experience audit

Reviewed **2026-10-26**. Findings are ordered from high to low priority and describe the current implementation, including intentional choices that could still create friction. Suggested changes are proposals, not claims established by user testing.

## Scope and evidence

Reviewed the desktop home, study editor, Stats, Practice, shared-opening, account and Community flows, plus the mobile Studies, Practice, session and analysis flows. Read the corresponding TypeScript, HTML and CSS and compared them with `design.md`.

Built both applications and inspected local Chromium renders using synthetic accounts/studies. Viewports were **1366 × 900** and **390 × 844** CSS pixels. Checked the editor in light and dark themes, signed-out onboarding, a simulated study-list failure, and first-use/missing-statistics states. Measured control rectangles and page overflow. No real accounts or stored studies were changed.

**Rendered** below means observed in those previews. **Source** means identified from implementation without a complete interactive reproduction. Real phones, browser zoom, screen readers, complete keyboard journeys and users with large repertoires still need testing. This review complements [review.md](review.md); backend correctness and offline replay bugs remain there.

## What is already working well

- The board remains the main focus in the editor, and the desktop layout keeps navigation, the move tree and optional analysis nearby.
- The landing page explains the purpose, shows real interface screenshots and offers a public browsing route before sign-in.
- Stats groups calculation inputs, explains its metrics and shows calculation provenance and stale-result notices.
- Mobile uses a simple labeled bottom navigation, readable study rows and large main session controls.
- Saving status, archive undo, private duplication and theme support provide useful foundations for trust and recovery.

## High priority — P1

### 1. Make public sharing visible before a study is created

**Evidence: Source and rendered first-use editor.** [study.ts](frontend/src/study.ts), [store.py](backend/app/store.py), [main.ts](frontend/src/main.ts).

New studies are shared by default, and naming a study starts autosaving. The sharing control is inside the overflow menu, whose containing links are hidden until the first save. Someone can publish preparation and comments before encountering a visibility choice. Imports from files also use the create endpoint's public default, while duplication and Community imports produce private copies. These different defaults are hard to infer.

**Improve:** Present “Private / Shared with Community” beside the name before the first save, and retain a visible status afterwards. Prefer a private draft with a deliberate sharing action; if public-by-default is a product decision, disclose it before creation and allow changing it there. Explain that sharing includes the repertoire/comments and allows copying.

**Acceptance:** A new user can identify and choose who will see the study without opening a menu or reading the tutorial. Creation, file import, duplication and Community import each state the resulting visibility.

### 2. Fix the new-study header at phone widths

**Evidence: Rendered and measured.** [style.css](frontend/src/style.css), `.study-head__title`, `.study-name-input`, `.study-save-status`; [study.ts](frontend/src/study.ts).

At 390 × 844, the new-study page had a document scroll width of **502 px**. The side selector, name field and single-line autosave message competed for the same header row. The name placeholder was compressed and the save instruction ran off-screen. The existing-study preview did not have the same page overflow, so testing only saved studies would miss this.

**Improve:** Give the name a full row on narrow screens and let the saving instruction wrap below it. Place side and visibility together in a separate compact row. Ensure status text can grow without widening the page.

**Acceptance:** The empty editor, a typed long name and long save-error messages fit at 320–430 px widths without horizontal page scrolling, including with enlarged text.

### 3. Provide recovery for deleting a move and its entire subtree

**Evidence: Source.** [study.ts](frontend/src/study.ts), `deleteCurrentMove()` and keyboard handler; [tree.ts](frontend/src/tree.ts), `deleteSubtree()`.

Deleting a selected move removes all descendants and autosaves immediately. Both Delete and Backspace trigger it outside form fields. There is no move-edit undo/redo or recovery action. In contrast, archiving a study already offers Undo and deleting the whole study asks for confirmation. Losing a large branch through one small action is a disproportionate consequence.

**Improve:** Add edit undo/redo with keyboard support and a visible “Branch deleted — Undo” action. Show the number of affected moves for large branches. Keep recovery available after autosave; reloading should not be the only possible rescue mechanism.

**Acceptance:** An accidental subtree deletion can be restored, with comments and starting-point state, after it has saved.

### 4. Distinguish an empty collection from a failed load

**Evidence: Rendered simulated HTTP 503 and source.** [main.ts](frontend/src/main.ts), [practice.ts](frontend/src/practice.ts), [study.ts](frontend/src/study.ts).

When the study-list request failed, Home rendered only the two new-study cards, exactly as if the account had no studies. Practice similarly falls back to “No studies yet” after loading errors. A failed practice-summary request can make populated studies appear to have no practice moves. The editor also maps unsuccessful study responses to “Study not found.” These messages can suggest that work disappeared.

**Improve:** Give loading, genuinely empty, unavailable, signed-out and not-found states distinct presentations. Keep creation available during an outage, but show “Couldn't load your studies” with Retry. If partial data exists, retain it and label the unavailable section.

**Acceptance:** Simulating a 503 never tells an existing user that they have no studies or no practice moves. Recovery does not require guessing that the page must be refreshed.

### 5. Make the core chess tasks accessible beyond pointer input

**Evidence: Source; assistive-technology testing remains outstanding.** [board.ts](frontend/src/board.ts), [tree.ts](frontend/src/tree.ts), [practice-session.ts](frontend/src/practice-session.ts), [mobile analysis.ts](mobile/src/analysis.ts).

The editor has useful global arrow-key navigation, but individual move entries are clickable spans without selected-state semantics or a focus model. Board move entry has no application-provided keyboard/SAN alternative, which is particularly limiting in practice. Desktop feedback lacks mobile's live announcement region. Mobile analysis is a dynamically inserted layer without dialog semantics, focus containment or explicit focus restoration.

**Improve:** Provide keyboard move entry, accessible position/move descriptions, and a focusable move list with current-position semantics. Announce grading and transitions. Give analysis a named modal/dialog structure and manage focus on entry/exit. Keep the existing shortcut navigation as an additional fast path.

**Acceptance:** A keyboard-only user can create a short line, navigate a variation, answer a practice question and open/close analysis while always knowing the current position and focused control. Verify with a screen reader.

## Medium priority — P2

### 6. Use one evaluation perspective everywhere

**Evidence: Source.** [stat.ts](frontend/src/stat.ts), [scoreTiers.ts](frontend/src/scoreTiers.ts), [studyCard.ts](frontend/src/studyCard.ts).

`formatExpectedEval()` displays evaluations from White's perspective, including for Black studies. Card help and the badge legend describe this convention correctly. The Stats evaluation description instead says the value is from the studied side's perspective. For Black, a negative number can therefore mean an advantage while its nearby explanation implies the opposite.

**Improve:** Keep the familiar White-perspective convention and label it consistently, adding a plain-language phrase such as “−0.40 · Black is better.” Alternatively use the repertoire side throughout, but change all displays, legends and comparisons together. Expected score and evaluation should not silently switch perspectives.

**Acceptance:** A reader can correctly explain whether a displayed evaluation is favorable for a Black repertoire without opening a tooltip.

### 7. Give Studies a consistent destination across desktop and mobile

**Evidence: Rendered and source.** [mobile/src/lists.ts](mobile/src/lists.ts), [studyCard.ts](frontend/src/studyCard.ts), [index.html](frontend/index.html), [opening.ts](frontend/src/opening.ts).

Desktop study cards expose Edit and Practice separately. In mobile, the Studies row now opens the study read-only (its moves, along the prep) and its chart icon a stats screen linking to the website's editor and Stats; the Practice row opens a practice session. Desktop's home/study collection is reached through the logo rather than an explicit Studies navigation item. Signing in from a public opening uses a generic login link and loses the specific import context; mobile already preserves its destination.

**Improve:** Keep Practice explicitly labeled. Add a discoverable Studies/Home destination and preserve the current opening through sign-in.

**Acceptance:** Users can predict where a study title takes them and return to the same opening after authentication. Mobile limitations are explained at the point where a missing action is needed.

### 8. Put the next practice action ahead of the activity dashboard

**Evidence: Rendered desktop Practice and mobile list; source.** [practice.ts](frontend/src/practice.ts), [practiceActivity.ts](frontend/src/practiceActivity.ts), [mobile/src/lists.ts](mobile/src/lists.ts).

Desktop Practice begins with the yearly activity grid and internal rankings, then separates White and Black cards. In the preview, the second repertoire's action fell below the initial viewport. The main practice buttons on those cards are icons. There is no prominent aggregate “Start review” action or default due-first path. Mobile does show a total due count, creating a useful pattern desktop could share.

**Improve:** Start with “4 positions due · Start review,” plus new-position counts when relevant. Prioritize due work or offer a due filter while preserving the user's normal study order elsewhere. Move activity and best-known rankings below the actionable list or into a collapsed progress section. Use “Practice” and “Bullet” labels.

**Acceptance:** A returning user can start the most useful review from the first screen without interpreting icons or choosing among equally emphasized historical metrics.

### 11. Explain missing metrics and simplify the two-dimensional badge

**Evidence: Rendered uncalculated studies and source.** [studyCard.ts](frontend/src/studyCard.ts), [scoreTiers.ts](frontend/src/scoreTiers.ts), [mobile/src/lists.ts](mobile/src/lists.ts).

Home presents “Expected result — / —”; mobile presents “— · —.” The first number is expected score, the second is evaluation, but their names and units are largely left to hover help. A chess piece's color encodes one metric and its rank encodes another. An uncalculated study receives a gray pawn, which resembles a low-performing study rather than an unknown result. Home/mobile cards also omit the freshness context available on Stats.

**Improve:** Use compact visible labels: “Score: not calculated” and “Evaluation: not calculated,” with a direct Calculate/Stats action. Explain badge dimensions on tap/focus and distinguish unknown from low performance. Show stale or incomplete status beside numbers on every surface where they are used to judge a study.

**Acceptance:** A new user can identify both measures and distinguish unknown, stale and current values without a mouse. A badge never makes an uncalculated repertoire look evaluated.

### 12. Introduce tools progressively instead of starting with unexplained controls

**Evidence: Rendered fresh editor and source.** [analysisTools.ts](frontend/src/analysisTools.ts), [study.ts](frontend/src/study.ts), [style.css](frontend/src/style.css).

Explorer and Stockfish both start off in a fresh browser. The empty move list says to play moves, but does not explain the single-prepared-move constraint, how to branch for the opponent or how to use the analysis tools. At widths below 600 px, tool names disappear and leave symbols plus toggles. Settings and suggested moves are also icon-only. Their low visual emphasis makes disabled-looking and available-but-off controls easy to confuse.

**Improve:** Add a short dismissible first-study guide: name/side/visibility → play your move → add opponent replies → practice or calculate. Show text labels for core tools on phones, or reveal a labeled chooser. Explain the one-prepared-move constraint where a conflicting move is attempted. Keep extra complexity optional.

**Acceptance:** A first-time user can add a legal branch and turn on Explorer without consulting the full tutorial. An off tool still looks operable.

### 13. Clarify calculation scope, settings persistence and cancellation

**Evidence: Rendered empty Stats and source.** [stat.ts](frontend/src/stat.ts), [study.ts](frontend/src/study.ts), [explorerClient.ts](frontend/src/explorerClient.ts).

The editor has Calculate for move-tree figures, Stats has a global Recalculate plus two identically labeled per-metric buttons, and the settings panel closes with Done. In Stats, Done only collapses the panel; settings persist through a successful calculation, while editor settings autosave. A new user cannot readily infer these different save/apply rules. Lengthy engine work and rate-limit waits provide progress but no explicit cancellation control. The empty coverage chart also reserves substantial space before there is anything to show.

**Improve:** Label scope explicitly: “Calculate move figures,” “Calculate both,” and “Update score/evaluation.” Use “Close settings” or an explicit Apply model, and state when settings are saved. Expose Cancel with clear handling of already-saved results. Collapse the empty chart to a short explanation/action until data exists.

**Acceptance:** Users know what each action updates, whether their changed settings are saved, and how to stop a long run without leaving the page.

### 14. Increase small touch targets and strengthen primary-button contrast

**Evidence: Measured rendered controls and palette calculation.** [style.css](frontend/src/style.css), [mobile/src/style.css](mobile/src/style.css).

On the responsive desktop Home, archive/duplicate controls measured **22 × 22 px**. Editor folding switches measured about **19 px high**, and the rename control was **24 × 24 px**. Mobile's main controls use a more generous 44 px baseline. White text against the dark-theme primary blue `#3692e7` computes to roughly **3.27:1** contrast; primary buttons use small text, so this deserves attention independently of overall dark-theme readability.

**Improve:** Adopt a shared comfortable touch-target baseline, using padding to enlarge hit areas without oversized icons. Increase separation between destructive and routine actions. Give filled primary buttons a color token chosen for readable text, independently of the token used for links.

**Acceptance:** Core actions remain easy to tap on a phone, and both themes receive explicit text/background contrast checks. These measurements are not a complete accessibility-conformance assessment.

### 15. Make Community useful for discovery as well as competition

**Evidence: Source.** [community.ts](frontend/src/community.ts), [community.py](backend/app/community.py), [landing.ts](frontend/src/landing.ts).

The landing page offers “Browse community openings,” but the main destination emphasizes leaderboards and strongest players. The ranked API returns only a limited set per side and excludes uncalculated studies; the page has no general searchable repertoire catalogue. It also asks readers to compare matching rating bands/time controls even though the ranking combines different settings. Badges and rank can imply greater comparability than that caveat supports.

**Improve:** Separate “Browse openings” from “Leaderboards.” Add search and practical filters such as side, opening, source and comparable player pool. State the active comparison scope beside the rank and expose how much data supports a result when available. Let shared studies without calculated scores be discoverable through the browsing route.

**Acceptance:** Someone following the browse CTA can find a relevant opening without needing it to rank highly. Ranked results make their comparison conditions apparent before the user imports a study.

## Lower priority — P3

### 16. Reveal complete titles and previews on touch and keyboard

**Evidence: Rendered long titles and source.** [studyCard.ts](frontend/src/studyCard.ts), [miniBoard.ts](frontend/src/miniBoard.ts), [mobile/src/style.css](mobile/src/style.css).

Desktop card titles truncate and scroll on mouse hover. Mobile row titles truncate too. Mini-board replay starts only on mouse pointer entry, so touch/keyboard users do not receive the same preview. The full title is available after opening, but that makes comparing similarly named repertoires unnecessarily difficult.

**Improve:** Allow two title lines or a tap/focus disclosure, and offer an explicit preview/play control where replay is useful. Keep reduced-motion preferences respected. Do not rely on hover for identifying content.

### 17. Standardize vocabulary and navigation labels

**Evidence: Source and renders.** [layout.ts](frontend/src/layout.ts), [studyCard.ts](frontend/src/studyCard.ts), [practice.ts](frontend/src/practice.ts), [mobile/src/lists.ts](mobile/src/lists.ts).

The app alternates among study, opening and repertoire; Expected result and Expected score; Knowledge and percent known; Sign in and Log out. Bullet has a compact icon but means a particular training mode, not simply the Lichess time control. None of these choices is inherently wrong, but their combination raises the amount a new user must infer.

**Improve:** Establish a small UI glossary and apply it across desktop, mobile, tooltips, accessible labels and documentation. Define Bullet where it is first offered. Add an explicit Studies destination and consistent breadcrumbs/back links for study-level pages.

### 18. Give the landing page one primary action and disclose access limits earlier

**Evidence: Rendered mobile landing and source.** [landing.ts](frontend/src/landing.ts), [auth.py](backend/app/auth.py), [community.ts](frontend/src/community.ts).

Sign in and Browse community openings have equal primary styling; the public browsing button is visually larger on the narrow preview. The app can also refuse new accounts after the beta user limit is reached, but the landing sign-in promise does not surface that condition before the external OAuth journey. Community/profile expose the limit elsewhere.

**Improve:** Choose the intended first action and style the alternative secondarily. When a user cap is enabled, explain the beta/access condition near sign-in; if capacity information is available, make it visible before sending someone away to authorize access. Retain public browsing as a useful route.

### 19. Consolidate shared design patterns and update the design notes

**Evidence: Source.** [design.md](design.md), [style.css](frontend/src/style.css), [mobile/src/style.css](mobile/src/style.css), [treeViewer.ts](frontend/src/treeViewer.ts).

Desktop/mobile already share chess logic but duplicate palette and component rules. Both themes, button sizing, status wording and analysis behavior can drift. `design.md` also describes older states: it says there are only five media rules, proposes screenshots that now exist, describes mutually exclusive analysis tabs although the current tools can both be enabled, and says the shared viewer still uses the old layout despite its shared editor-style structure.

**Improve:** Extract shared semantic color/spacing/action tokens while allowing distinct desktop and mobile layouts. Keep a compact component/state inventory for buttons, statuses, empty/error states, visibility and metrics. Update `design.md` to distinguish current decisions from completed proposals and unresolved experiments.

## Suggested delivery order

| Pass | Changes | Practical validation |
| --- | --- | --- |
| Trust and recovery | Visible sharing, first-use header fit, accurate failures, branch undo | Create/import a private study, simulate a failed load, delete/restore a branch at phone width. |
| Core task clarity | Accessible move entry, explicit study destinations, due-first practice | Have a new user build a short line and complete a review, including by keyboard. |
| Interpretation | Consistent evaluation signs, labeled metrics, unknown/stale badges, clear calculation scope | Ask users to interpret White and Black study results and identify which need recalculation. |
| Polish and maintenance | Targets/contrast, browsing filters, touch previews, terminology, shared tokens and current notes | Check both themes, enlarged text, real phones and larger collections. |

No design changes were implemented as part of this audit. Both application production builds passed. Priority reflects likely impact on completing tasks, preserving work, understanding results and trusting publication state; suggested behavior changes should be validated with representative users.
