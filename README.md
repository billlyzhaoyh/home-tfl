# home-tfl

A small commute board for two people in London: **when to leave, which line, and how the trains look**, using TfL's open data. Lives at <https://billlyzhaoyh.github.io/home-tfl/>.

## What it does

- **Today** shows a big *Leave 08:17 · arrive 08:52* for the best route, a strip of the route coloured by line (segment width = time on that leg), the status of the lines you'll use, and the next trains at your first station with a plain-English note ("Big gap after the next train — catch this one"). Other options sit below it; tap one to swap it in.
- The journey is the headline, **HOME → OFFICE**, with a swap button. It defaults to the office before 1pm and home after. Tap the start point to plan from your current location instead. A **Billy | Erica** switch picks whose commute.
- **Usual busyness** for every station where you'd board or change, at the time you'd be there: a small chart of the hour either side and *quiet / busy / peak*, compared with that station's own busiest time of the week (TfL's typical-week profiles). Each option row names its busiest stop, so similar-speed routes can be compared, with a hint when leaving 15–30 min earlier is usually calmer.
- **Time this trip → Arrived** logs how long the trip really took (on that phone only). **Trips** shows averages vs plan and a chart of recent trips per person and direction.
- **Routes to compare** (Setup): TfL only suggests a few near-identical routes, so you can save your own, e.g. *change at Paddington, then Elizabeth line* or *via Baker Street*. Every Check plans them too and ranks them with TfL's suggestions, so you can ride and time them.
- **Setup** holds names, home and offices, transport modes, routes to compare, and a share link to copy everything to your partner's phone.

## When it talks to TfL

Only when you tap a button. There's no polling and nothing fetches on open:

- **Check now** makes about 2–4 requests: journey plan, line status, and arrivals plus crowding for the first station. Live trains are skipped when departure is more than 30 min away. The first time a station appears it also fetches its typical-week profile, which is then cached for 30 days.
- **Refresh trains** reloads only the next trains for the selected route (2 requests).

Switching person, direction or start point just shows that combination's last result until you tap Check.

**Next step:** commute times (e.g. "arrive by 09:00"), so the app can plan for when you need to be at work and check once when opened around then.

## Where trips are stored

There is no database. Trips, settings and cached results live in each phone's browser storage (`localStorage`), separately on each phone. They survive app updates, but clearing Safari's website data deletes them, and Safari can clear storage for sites not opened for 7 days. Home Screen web apps are exempt from that. So: add the app to your Home Screen, and use **Trips → Back up** now and then (a JSON file you can **Restore** from; it merges without duplicates). The app also asks the browser for persistent storage the first time you time a trip.

## Privacy

Everything you enter is kept in `localStorage` in your browser. The repo contains no addresses. Your postcodes are sent only to `api.tfl.gov.uk` as part of journey requests. The share link puts the settings in the URL fragment (`#import=…`), which browsers don't send to servers, but send it privately anyway.

## Development

Plain HTML, CSS and JS with no build step. GitHub Pages serves `docs/` from `main`.

```bash
python3 -m http.server -d docs 8000
open "http://localhost:8000/?now=08:05"   # ?now=HH:MM fakes the clock (direction default, countdowns)
```

Data: Powered by TfL Open Data. Contains OS data © Crown copyright and database rights.
