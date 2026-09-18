# Optional test configuration additions

Existing tests continue to work unchanged. New fields are optional.

- `graded`: boolean. Missing means `true` for backward compatibility. Pupils see whether a test is graded, and result history can filter graded/all.
- `closingTime`: optional ISO date/time shown in the teacher dashboard and final-results PDF. `active` still controls whether a test code can be entered.
- `merge_test`: array of two or more existing test IDs. A merge test reuses the exact source questions/directions from those tests.
- `merge_amount`: number of source questions to select deterministically from the combined source pool.
- Vocabulary item `showOnlyEnglish`: boolean. When true, English is always shown as the prompt and Norwegian is the expected answer.

Example merge test (add inside `config/tests.json` when needed):

```json
{
  "id": "revision-1",
  "code": "REV1",
  "label": "Revision 1",
  "active": false,
  "graded": true,
  "merge_test": ["body-anatomy", "symptoms-common-illness"],
  "merge_amount": 20,
  "seed": "revision-1-stable-seed",
  "configVersion": "2026-09-18a",
  "requireFullscreen": true,
  "focusPolicy": "lockImmediately",
  "allowDefinitions": false,
  "grading": { "highSimilarity": 0.9, "uncertainSimilarity": 0.72, "maxHighEditDistance": 1 }
}
```

Do not change an existing test's `seed`, vocabulary pool, merge source list, or `configVersion` while pupils have an active attempt unless you intentionally want a new test configuration.
