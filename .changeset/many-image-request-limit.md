---
"eve": patch
---

Sessions with many images no longer fail on every model call. Once a request carries more than 20 images and PDFs, providers reject any image over 2000 pixels per side, so eve now sends those images as their sandbox label with a note instead of their bytes. Sessions already stuck on this error recover on their next message.
