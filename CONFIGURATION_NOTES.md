# Configuration notes

The site remains fully static. Classroom-wide settings therefore live in the checked-in JSON configuration, while the teacher dashboard reads and displays those settings and can generate the appropriate access codes. Existing single-class data and older submissions remain readable.

## Multiple classes

`config/class-roster.json` now uses a `classes` array. Each class needs a stable `id`, a display `label`, and its own pupil list. Pupil IDs only need to be unique inside a class.

```json
{
  "version": 2,
  "classes": [
    {
      "id": "vg1-health-a",
      "label": "VG1 Health A",
      "active": true,
      "pupils": [
        { "id": 0, "name": "Pupil A", "active": true },
        { "id": 1, "name": "Pupil B", "active": true }
      ]
    },
    {
      "id": "vg1-health-b",
      "label": "VG1 Health B",
      "active": true,
      "pupils": [
        { "id": 0, "name": "Pupil C", "active": true }
      ]
    }
  ]
}
```

Pupils choose their class before their name. The teacher dashboard remembers the currently selected class on that browser.

The existing roster in this project was migrated to the class ID `vg1-helse-oppvekst`; keep that ID stable if you add schedule overrides for the current class.

## Per-class opening and late/retake times

Every test can have a `classTimes` object keyed by class ID. These fields are optional:

- `openingTime`: when that class may start the test.
- `countAsRetakeAfter`: after this instant the normal class code stops working and the attempt is automatically recorded as **Taken later**. Pupils must use the hourly late code generated on the teacher dashboard.
- `closingTime`: after this instant neither the normal nor late code starts a new attempt.

Use ISO date/time strings with an explicit offset so the instant is unambiguous, for example:

```json
{
  "id": "test",
  "code": "TEST",
  "label": "Body and Anatomy",
  "active": true,
  "classTimes": {
    "vg1-health-a": {
      "openingTime": "2026-10-05T09:00:00+02:00",
      "countAsRetakeAfter": "2026-10-05T10:00:00+02:00",
      "closingTime": "2026-10-12T16:00:00+02:00"
    },
    "vg1-health-b": {
      "openingTime": "2026-10-06T11:30:00+02:00",
      "countAsRetakeAfter": "2026-10-06T12:30:00+02:00",
      "closingTime": "2026-10-13T16:00:00+02:00"
    }
  }
}
```

For backward compatibility, test-level `openingTime`, `countAsRetakeAfter`/`retakeAfter`, and `closingTime` are still used as fallbacks when a class has no override.

## Five-letter test codes

The `code` field in `config/tests.json` remains the base/original code, so existing configuration does not need to be regenerated. Pupils no longer type that base value directly.

For each class, the site deterministically combines the test's base `code` with the class ID and class label to create a stable five-letter normal code. This means two classes using the same test get different pupil codes. The teacher dashboard shows the normal code for the currently selected class/test.

After `countAsRetakeAfter`, the normal code is rejected. The teacher dashboard can generate the five-letter late code for a selected year-month-date-hour. That late code is derived from the class's normal five-letter code plus the local `YYYYMMDDHH` hour. A late code is accepted only during its matching hour.

Because this is a static site, the teacher dashboard does not pretend to rewrite `config/tests.json` for all pupils. Change schedules in the JSON and publish the site; use the dashboard to inspect the resulting class schedule and generate the hourly code.

## Late-attempt randomization and marking

A late attempt stores a millisecond seed when the pupil actually starts. Question construction combines that millisecond value with the test's original `seed`. The saved millisecond seed is included in the compact submission payload so the teacher dashboard, results page, and history can reconstruct exactly the questions/directions shown to that pupil.

If a vocabulary pool contains more entries than `questionCount`, a late pupil can receive a different subset of words. If the pool size exactly equals `questionCount`, all words necessarily remain in the test, but their direction and pupil order are still independently randomized. To allow genuinely different words, configure a larger `vocabularyIds` pool than `questionCount` (or a larger merge source pool than `merge_amount`).

Late attempts are shown as **Taken later** on the teacher dashboard and are excluded from the normal-session median-duration comparison. Integrity events such as leaving full-screen are still checked normally.

The existing completed-test repeat permission remains separate. If a pupil has already completed the same test, they still need the teacher's request/response permission code. The repeat-permission screen now has a **Back** button so the pupil can leave without obtaining that code.

## Optional test fields already supported

- `graded`: boolean. Missing means `true` for backward compatibility.
- `merge_test`: array of existing test IDs. A merge test reuses source questions/directions.
- `merge_amount`: number of source questions to select from the combined source pool.
- Vocabulary item `showOnlyEnglish`: boolean. When true, English is always shown and Norwegian is expected. In the supplied vocabulary file, items with ID 21 and above now include this flag explicitly and default it to `false`.

Example merge test:

```json
{
  "id": "revision-1",
  "code": "REV1",
  "label": "Revision 1",
  "active": false,
  "graded": true,
  "classTimes": {},
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


## Current sample/version conventions

The completed sample test with ID `test` intentionally keeps `configVersion` `2026-09-16a` so existing completed submissions remain version-compatible. It explicitly shows the newer optional fields (`graded`, class timing keys, fallback timing keys, `merge_test`, and `merge_amount`) using values that do not change its existing question construction.

All other tests are on `configVersion` `2026-09-19a`. `practiceTestId` points to the next test in `tests.json`; the final test uses `null` because no later list element exists.

On the teacher dashboard, interruption unlocks, completed-test repeat permission, and late test access are separate tabs. The Settings control in the header is a dropdown linking directly to backup/restore, cleanup, setup checks, diagnostics, and teacher-access controls.
