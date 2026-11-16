# HighScoop editable category masters

Each master contains the existing ten example content pages and the approved common closing page. The closing wording and geometry are defined in `shared/highscoopClosing.ts`.

The ice-cream and lightbulb artwork was extracted from the operator-supplied closing reference. They are bundled as transparent PNG assets in `assets/branding/highscoop-closing-icecream.png` and `assets/branding/highscoop-closing-lightbulb.png`; they are not replacement emoji downloaded from Canva. The original HighScoop color logo remains unchanged.

Run `node --import tsx scripts/update-highscoop-current-closing.mts` from the repository root to update only page 11, its relationships and its dedicated closing artwork. The script verifies that every other existing PPTX entry stays byte identical, and regenerates the six final-page previews and overview sheets. The first ten content pages and their photographs/annotations remain intact.

This script does not contact Canva or change existing design IDs. The resulting PPTX files can be imported as independent Canva masters; the template catalog should point to those copies only after import and visual verification.
