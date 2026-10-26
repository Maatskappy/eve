---
"eve": patch
---

The `eve/extensions/code` worker subagent can now run read-only `git` commands (`diff`, `log`, `show`, `blame`, `status`, `ls-files`, `rev-parse`), so a fresh-context reviewer can read a staged change and its history. It still has no shell or write access.
