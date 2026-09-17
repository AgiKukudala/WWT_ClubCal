# Legacy browser-only calendar

These files are the project's original static calendar. They are kept **only for reference and attribution** and are not used by ClubCal.

`README.original.md` is the original README. The repository also held `WWTProject-main.zip`. It was checked byte-for-byte against these files, contained nothing unique, and was removed from the working tree (it is still in git history).

## Attribution

`script.js` / `student.js` add the credit "A Project By Open Source Coding" linking to https://www.youtube.com/channel/UCiUtBDVaSmMGKxg1HYeK-BQ. The calendar layout follows that tutorial project. No license file came with it, so these files are left unmodified, and the credit is repeated in the ClubCal footer. No code from here was copied into the new application.

## Problems verified in this version

| Finding | Evidence |
|---|---|
| Events live in each browser's `localStorage`, so devices don't share a calendar | `saveEvents()` / `getEvents()` in `script.js` |
| Admin credentials are hard-coded in client JavaScript | `login.js`: `admin` / `adminpass` |
| The "admin" role is set in `localStorage` but never checked, so there is no authorization at all | `login.js` sets `userRole`; no file reads it |
| `student.html` loads `script.js`, which calls `addEventListener` on elements that page doesn't have (`.add-event`, `.event-name`, `.add-event-btn`), so the script throws after the first render | `student.html`, `script.js` |
| Event titles are inserted with `innerHTML` (stored XSS within the browser) | `updateEvents()` |
| Calendar logic is duplicated (`student.js` is identical to `script.js` and is never loaded) | `cmp script.js student.js` |
| Dates and times are display strings (`{day, month, year}` + `"3:30 PM - 5:00 PM"`) with no time zone | `eventsArr` shape |
| "Student View" link points to the admin login page | `index.html` |

## Importing old data

The server cannot read anyone's browser storage. Each person with old data must export it themselves:

1. Open the old `index.html` in the same browser where the events were created.
2. Open the developer console (F12) and run `copy(localStorage.getItem("events"))`.
3. Paste the copied text into **ClubCal → Admin → Import old calendar**.
4. Choose the club and the **time zone** the times were written in (required), then *Preview*.
5. Invalid rows (impossible dates, end before start, unparseable times) and duplicates are listed and skipped. *Import* creates published, room-less events. Importing the same file twice is blocked, and events already imported from another file are flagged as duplicates.
