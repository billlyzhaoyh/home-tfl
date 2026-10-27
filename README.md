# home-tfl

A small commute board for two people in London: **when to leave, which line, and how the trains look**, using TfL's open data. Lives at <https://billlyzhaoyh.github.io/home-tfl/>.

## What it does

- **Today** shows a big *Leave 08:17 · arrive 08:52* for the best route, a strip of the route coloured by line (segment width = time on that leg), the status of the lines you'll use, and the next trains at your first station with a plain-English note ("Big gap after the next train — catch this one"). Other options sit below it; tap one to swap it in.
- The header pills pick **whose** commute and the **direction** (it defaults to the office before 1pm and home after, and you can tap to flip it).
- **I'm leaving → Arrived** times the real trip. **Trips** shows averages vs plan and a chart of recent trips per person and direction.
- **Setup** holds names, home and offices, transport modes, and a share link to copy everything to your partner's phone.

## When it talks to TfL

Only when you tap a button. There's no polling and nothing fetches on open:

- **Check now** makes about 2–4 requests: journey plan, line status, and arrivals plus crowding for the first station. Live trains are skipped when departure is more than 30 min away.
- **Refresh trains** reloads only the next trains for the selected route (2 requests).

Switching person, direction or "From my location" just shows that combination's last result until you tap Check.

**Next step:** commute times (e.g. "arrive by 09:00"), so the app can plan for when you need to be at work and check once when opened around then.

## Privacy

Everything you enter is kept in `localStorage` in your browser. The repo contains no addresses. Your postcodes are sent only to `api.tfl.gov.uk` as part of journey requests. The share link puts the settings in the URL fragment (`#import=…`), which browsers don't send to servers, but send it privately anyway.

## Development

Plain HTML, CSS and JS with no build step. GitHub Pages serves `docs/` from `main`.

```bash
python3 -m http.server -d docs 8000
open "http://localhost:8000/?now=08:05"   # ?now=HH:MM fakes the clock (direction default, countdowns)
```

Data: Powered by TfL Open Data. Contains OS data © Crown copyright and database rights.
