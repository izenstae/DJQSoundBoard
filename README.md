# DJ Q Soundboard

A soundboard for live DJ sets, hosted free on GitHub Pages. You can fire pads from the keyboard or a touchscreen, and you can add new sounds from your browser.

## Using it

| Action | How |
| --- | --- |
| Play a sound | Click/tap a pad, or press its key (`1`–`0`, then `Q`–`M`) |
| Stop everything | `Space`, `Esc`, or **■ Stop all** |
| Add sounds | **+ Add sounds**, or drag audio files onto the page |
| Rename a pad | Tap the ✎ on the pad, type a new name, press Enter |
| Recolor / reorder / loop / delete | **Edit**, then tap a pad |
| Master volume | Slider in the top bar |

Pads trigger on press, not release, and several can play at once. Each pad can be set to **restart** or **stop** when you hit it again while it's playing, and it can loop.

## Two ways to add sounds

**1. In the browser (quickest).** Tap **+ Add sounds** or drag files in. They're saved in that browser on that device, and they still work offline. They don't sync between devices, so use **⋯ → Download backup** and **Restore** to copy them to another laptop.

**2. In the repo (permanent, everyone sees them).** On GitHub, open the `sounds/` folder, choose **Add file → Upload files**, drop in your audio, and commit. The site redeploys in about a minute and the new pads show up. Names come from the filename (`air-horn.mp3` becomes "Air Horn"). To set a custom name or color, edit `sounds/sounds.json`.

MP3 works in every browser. WAV, M4A/AAC and OGG work in most.

## Offline at the venue

After you open the site once, it caches itself and the built-in sounds, so it keeps working if the venue wifi drops. On a phone or tablet you can also use **Add to Home Screen** to get a full-screen app.

## One-time GitHub Pages setup

1. Make sure the default branch is named `main`. The deploy workflow runs on pushes to `main`.
2. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Push to `main`, or run the **Deploy soundboard to GitHub Pages** workflow by hand from the Actions tab.

The site will be at `https://<username>.github.io/<repo-name>/`.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```
