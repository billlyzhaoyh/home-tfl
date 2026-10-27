# home-tfl

A small commute board for two people in London: **when to leave, which line, and how the trains look**, using TfL's open data. Lives at <https://billlyzhaoyh.github.io/home-tfl/>.

## What it does

- **Today** shows a big *Leave by 08:17 · arrive 08:52* for the best route, a strip of the route coloured by line (segment width = time on that leg), the status of the lines you'll use, and the next trains at your first station with a plain-English note ("Big gap after the next train — catch this one"). Other options sit below it; tap one to swap it in.
- **I'm leaving → Arrived** times the real trip. **Trips** shows averages vs plan and a chart of recent trips per person and direction.
- **Setup** holds names, home and offices, commute times, transport modes, and a share link to copy everything to your partner's phone.

## When it talks to TfL

There's no polling. It fetches only:

1. When you tap **Check now** (or switch person, direction or plan and there's no fresh result).
2. **Once on open during a commute window.** That's 45 min before to 15 min after your leave time, on the days you set, and only if the last result is more than 10 min old. Outside a window, the app shows your last result and fetches nothing.
3. When you tap **Refresh trains**, which reloads only the next trains for the selected route.

A full check is about 3–8 requests: journey plan, line status, and arrivals plus crowding for up to 3 first stations. Live trains are skipped when departure is more than 30 min away.

A static page can't wake itself up. To have the board ready when you wake, add an iOS Shortcuts automation, e.g. *Time of day 07:45 → Open URL*.

## Privacy

Everything you enter is kept in `localStorage` in your browser. The repo contains no addresses. Your postcodes are sent only to `api.tfl.gov.uk` as part of journey requests. The share link puts the settings in the URL fragment (`#import=…`), which browsers don't send to servers, but send it privately anyway.

## Development

Plain HTML, CSS and JS with no build step. GitHub Pages serves `docs/` from `main`.

```bash
python3 -m http.server -d docs 8000
open "http://localhost:8000/?now=08:05"   # ?now=HH:MM fakes the clock to test commute windows
```

Data: Powered by TfL Open Data. Contains OS data © Crown copyright and database rights.
