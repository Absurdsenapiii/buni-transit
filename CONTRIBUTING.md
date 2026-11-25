# Contributing

BUNI Transit is unfinished and open so people can improve it. Issues and pull requests are welcome.

## Help wanted: live bus arrivals

The arrivals board, the map markers for approaching buses and the Cloudflare Worker proxy (`worker/`) are written and unit-tested, but not connected to a live LTA DataMall key. To try it yourself:

1. Get a free LTA DataMall AccountKey at https://datamall.lta.gov.sg.
2. Deploy `worker/` to your own Cloudflare account (`npx wrangler deploy`) and set the key as the secret `DATAMALL_KEY` (`npx wrangler secret put DATAMALL_KEY`). Add your site's origin to `ALLOWED` in `worker/src/index.js`.
3. Build the site with `VITE_ARRIVALS_URL=https://<your-worker>.workers.dev npm run build`.

Never commit a key. It belongs only in the Worker's secret store.

## Other ideas

- Longer rain history and day-by-day comparison.
- MRT service alerts and station crowding (also DataMall).
- More languages (Chinese, Malay, Tamil).
- Accessibility review of the console.

## Ground rules

- **Real data only.** Every number must come from a published source and carry its time. No predictions shown as observations.
- **No tracking of people or individual vehicles.**
- Run `npm test` and `npm run build` before opening a pull request.
